// Bounded, non-executing Lua/Luau lexical and VM-dispatch analysis.
import { createHash } from 'node:crypto'

export const LIMITS = Object.freeze({ sourceBytes: 1024 * 1024, tokens: 120000, handlers: 256, events: 2048, captureBytes: 262144 })
export const hash = s => createHash('sha256').update(s).digest('hex')
const id = /^[A-Za-z_][A-Za-z0-9_]*$/
export function identifier(s) { if (typeof s !== 'string' || !id.test(s) || s.length > 128) throw Error('expected a Lua identifier'); return s }

export function lexLua(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > LIMITS.sourceBytes) throw Error('Lua source exceeds 1 MiB or is not text')
  const tokens = [], diagnostics = []
  let i = 0, line = 1
  function advance(end) { for (; i < end; i++) if (source[i] === '\n') line++ }
  function long(at) { const m = source.slice(at, at + 128).match(/^\[(=*)\[/); return m && { open: m[0], close: ']' + m[1] + ']' } }
  function add(kind, start, startLine, value) {
    if (tokens.length >= LIMITS.tokens) throw Error('Lua token limit exceeded')
    tokens.push({ kind, text: source.slice(start, i), value, start, end: i, line: startLine })
  }
  while (i < source.length) {
    const start = i, startLine = line, c = source[i]
    if (/\s/.test(c)) { advance(i + 1); continue }
    if (source.startsWith('--', i)) {
      const block = long(i + 2)
      if (block) {
        const end = source.indexOf(block.close, i + 2 + block.open.length)
        if (end < 0) diagnostics.push({ line, message: 'unterminated long comment' })
        advance(end < 0 ? source.length : end + block.close.length)
      } else { const end = source.indexOf('\n', i); advance(end < 0 ? source.length : end) }
      continue
    }
    if (c === '`') {
      i++; let closed = false
      while (i < source.length) { const ch = source[i]; advance(i + 1); if (ch === '\\' && i < source.length) advance(i + 1); else if (ch === '`') { closed = true; break } }
      diagnostics.push({ line: startLine, message: closed ? 'interpolated string skipped by static analyzer' : 'unterminated interpolated string' })
      add('interpolation', start, startLine); continue
    }
    if (c === '"' || c === "'") {
      i++; let value = '', valid = true, closed = false
      while (i < source.length) {
        const ch = source[i++]
        if (ch === c) { closed = true; break }
        if (ch === '\n' || ch === '\r') { valid = false; if (ch === '\n') line++ }
        if (ch !== '\\') { value += ch; continue }
        const esc = source[i++]
        const simple = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" }
        if (Object.hasOwn(simple, esc)) value += simple[esc]
        else if (esc === '\n') { value += '\n'; line++ }
        else if (esc === 'z') { while (i < source.length && /\s/.test(source[i])) advance(i + 1) }
        else if (esc === 'x' && /^[\da-f]{2}$/i.test(source.slice(i, i + 2))) { value += String.fromCharCode(parseInt(source.slice(i, i + 2), 16)); i += 2 }
        else if (/\d/.test(esc || '')) { const m = (esc + source.slice(i, i + 2)).match(/^\d{1,3}/)[0]; i += m.length - 1; const n = +m; if (n > 255) valid = false; else value += String.fromCharCode(n) }
        else if (esc === 'u' && source[i] === '{') {
          const m = source.slice(i).match(/^\{([\da-f]{1,6})\}/i)
          if (m && parseInt(m[1], 16) <= 0x10ffff) { value += String.fromCodePoint(parseInt(m[1], 16)); i += m[0].length } else valid = false
        } else valid = false
      }
      if (!closed || !valid) diagnostics.push({ line: startLine, message: 'invalid or unterminated quoted string' })
      add('string', start, startLine, valid && closed ? value : undefined); continue
    }
    const block = c === '[' && long(i)
    if (block) {
      const content = i + block.open.length, end = source.indexOf(block.close, content)
      if (end < 0) diagnostics.push({ line, message: 'unterminated long string' })
      const value = end < 0 ? undefined : source.slice(content, end).replace(/^\r?\n/, '')
      advance(end < 0 ? source.length : end + block.close.length); add('string', start, startLine, value); continue
    }
    if (/[A-Za-z_]/.test(c)) { i++; while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++; add('id', start, startLine); continue }
    const number = source.slice(i, i + 256).match(/^(?:0[xX][\da-fA-F]+(?:\.[\da-fA-F]*)?(?:[pP][+-]?\d+)?|0[bB][01_]+|(?:\d[\d_]*(?:\.(?!\.)[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/)
    if (number) { i += number[0].length; const n = Number(number[0].replaceAll('_', '')); add('number', start, startLine, Number.isFinite(n) ? n : undefined); continue }
    const op = ['...', '..=', '==', '~=', '<=', '>=', '//', '<<', '>>', '+=', '-=', '*=', '/=', '..', '::', '->'].find(op => source.startsWith(op, i)) || c
    i += op.length; add('symbol', start, startLine)
  }
  return { tokens, diagnostics }
}

// Pure constant expressions only. No eval, function execution or variable guessing.
const precedence = { '..': 1, '+': 2, '-': 2, '*': 3, '/': 3, '//': 3, '%': 3, '^': 5 }
export function constantAt(tokens, start, end = tokens.length, depth = 0) {
  let pos = start
  function expr(min = 0, level = depth) {
    if (level > 32 || pos - start > 4096) throw Error('constant expression budget')
    let t = tokens[pos++], v
    if (!t || pos > end) throw Error('incomplete expression')
    if (t.kind === 'string' || t.kind === 'number') { if (t.value === undefined) throw Error('unknown literal'); v = t.value }
    else if (t.text === '-' || t.text === '+') { v = expr(4, level + 1); if (typeof v !== 'number') throw Error('not numeric'); v = t.text === '-' ? -v : v }
    else if (t.text === '(') { v = expr(0, level + 1); if (tokens[pos++]?.text !== ')') throw Error('unclosed expression') }
    else if (t.text === 'string' && tokens[pos]?.text === '.' && tokens[pos + 1]?.text === 'char' && tokens[pos + 2]?.text === '(') {
      pos += 3; const bytes = []
      while (tokens[pos]?.text !== ')') { const n = expr(0, level + 1); if (!Number.isInteger(n) || n < 0 || n > 255 || bytes.length >= 4096) throw Error('invalid char'); bytes.push(n); if (tokens[pos]?.text !== ',') break; pos++ }
      if (tokens[pos++]?.text !== ')') throw Error('char call not closed'); v = String.fromCharCode(...bytes)
    } else throw Error('not a pure constant')
    while (pos < end && Object.hasOwn(precedence, tokens[pos]?.text) && precedence[tokens[pos].text] >= min) {
      const op = tokens[pos++].text, rhs = expr(precedence[op] + (op === '^' || op === '..' ? 0 : 1), level + 1)
      if (op === '..') {
        if (!['string', 'number'].includes(typeof v) || !['string', 'number'].includes(typeof rhs)) throw Error('unknown concat')
        v = String(v) + String(rhs)
      } else {
        if (typeof v !== 'number' || typeof rhs !== 'number') throw Error('unknown arithmetic')
        v = op === '+' ? v + rhs : op === '-' ? v - rhs : op === '*' ? v * rhs : op === '/' ? v / rhs : op === '//' ? Math.floor(v / rhs) : op === '%' ? v - Math.floor(v / rhs) * rhs : v ** rhs
        if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) throw Error('non-finite/inexact arithmetic')
      }
      if (typeof v === 'string' && Buffer.byteLength(v) > LIMITS.captureBytes) throw Error('constant size budget')
    }
    return v
  }
  try { const value = expr(); return { known: true, value, next: pos } } catch { return { known: false, next: start } }
}

// Build block boundaries without interpreting identifier names in strings/comments.
function blocks(tokens, diagnostics) {
  const stack = [], branches = [], loops = []
  const closeBranch = (frame, end) => { if (frame.branch) frame.branch.end = end }
  for (let i = 0; i < tokens.length; i++) {
    if (stack.length > 128 || branches.length > 2048 || loops.length > 128) throw Error('Lua block analysis budget exceeded')
    const w = tokens[i].text
    if (w === 'if') {
      const frame = { kind: 'if', start: i, parent: stack.at(-1), branches: [] }
      const branch = { conditionStart: i + 1, start: i, frame }; frame.branch = branch; frame.branches.push(branch); branches.push(branch); stack.push(frame)
    } else if (w === 'elseif' || w === 'else') {
      const frame = stack.at(-1)
      if (frame?.kind !== 'if') { diagnostics.push({ line: tokens[i].line, message: 'unmatched ' + w }); continue }
      closeBranch(frame, i)
      const branch = { conditionStart: w === 'else' ? null : i + 1, body: w === 'else' ? i + 1 : undefined, start: i, frame }
      frame.branch = branch; frame.branches.push(branch); branches.push(branch)
    } else if (w === 'then') { const f = stack.at(-1); if (f?.kind === 'if' && f.branch.body === undefined) { f.branch.conditionEnd = i; f.branch.body = i + 1 } }
    else if (w === 'while' || w === 'for') { const f = { kind: w, start: i, parent: stack.at(-1), awaitingDo: true }; stack.push(f); loops.push(f) }
    else if (w === 'do') { const f = stack.at(-1); if (f?.awaitingDo) { f.awaitingDo = false; f.body = i + 1 } else stack.push({ kind: 'do', start: i, parent: f }) }
    else if (w === 'function' || w === 'repeat') { const f = { kind: w, start: i, parent: stack.at(-1) }; stack.push(f); if (w === 'repeat') { f.body = i + 1; loops.push(f) } }
    else if (w === 'end' || w === 'until') {
      const f = stack.pop()
      if (!f || (w === 'until') !== (f.kind === 'repeat')) { diagnostics.push({ line: tokens[i].line, message: 'unmatched block terminator' }); continue }
      closeBranch(f, i); f.end = i
    }
  }
  if (stack.length) diagnostics.push({ line: tokens.at(-1)?.line || 1, message: 'unclosed blocks; VM extraction is partial' })
  return { branches, loops }
}

function comparison(tokens, branch) {
  if (branch.conditionStart === null) return null
  let start = branch.conditionStart, end = branch.conditionEnd
  if (end === undefined) return null
  while (tokens[start]?.text === '(' && tokens[end - 1]?.text === ')') { start++; end-- }
  const a = tokens[start], op = tokens[start + 1]?.text
  if (a?.kind !== 'id' || !['==', '~=', '<', '>', '<=', '>='].includes(op)) return null
  const c = constantAt(tokens, start + 2, end)
  return c.known && c.next === end && Number.isInteger(c.value) ? { variable: a.text, operator: op, value: c.value } : null
}
const testComparison = (op, a, b) => op === '==' ? a === b : op === '~=' ? a !== b : op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b
function evidence(tokens, start, end, source) { return { line: tokens[start]?.line, start: tokens[start]?.start, end: tokens[end - 1]?.end, excerpt: source.slice(tokens[start]?.start, tokens[end - 1]?.end).slice(0, 640) } }
function assignmentRoles(tokens, start, end) {
  const out = []
  for (let i = start; i < end - 5; i++) {
    if (tokens[i].kind === 'id' && tokens[i + 1]?.text === '=' && tokens[i + 2]?.kind === 'id' && tokens[i + 3]?.text === '[') {
      const index = tokens[i + 4], close = tokens[i + 5]
      if (close?.text === ']') out.push({ target: tokens[i].text, table: tokens[i + 2].text, index: index.text, indexKind: index.kind, at: i, end: i + 6 })
    }
  }
  return out
}

export function analyzeLua(source, hints = {}) {
  const { tokens, diagnostics } = lexLua(source), structure = blocks(tokens, diagnostics)
  for (const key of ['pc', 'opcode', 'registers', 'instruction']) if (hints[key] !== undefined) identifier(hints[key])
  const loads = [], urls = [], constants = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'string' && t.value !== undefined && /^https?:\/\//.test(t.value)) urls.push({ value: t.value.slice(0, 4096), ...evidence(tokens, i, i + 1, source), authority: 'literal-only; no request made' })
    if (t.text === 'loadstring' && tokens[i + 1]?.text === '(') {
      const c = constantAt(tokens, i + 2)
      const pure = c.known && tokens[c.next]?.text === ')' && typeof c.value === 'string'
      loads.push({ ...evidence(tokens, i, Math.min(tokens.length, pure ? c.next + 1 : i + 3), source), kind: pure ? 'constant-source' : 'runtime-source', ...(pure ? { source: c.value, sha256: hash(c.value) } : {}) })
    }
    if (['HttpGet', 'HttpGetAsync'].includes(t.text) && tokens[i + 1]?.text === '(') {
      const c = constantAt(tokens, i + 2)
      if (c.known && typeof c.value === 'string' && [')', ','].includes(tokens[c.next]?.text)) urls.push({ value: c.value, ...evidence(tokens, i, c.next, source), authority: 'constant call argument; no request made' })
    }
    if (t.text === 'string' && tokens[i + 1]?.text === '.' && tokens[i + 2]?.text === 'char' && constants.length < 64) {
      const c = constantAt(tokens, i); if (c.known) constants.push({ value: c.value, ...evidence(tokens, i, c.next, source) })
    }
  }
  const dispatchers = []
  for (const loop of structure.loops) {
    if (loop.end === undefined || loop.body === undefined) continue
    const candidates = structure.branches.filter(b => b.start >= loop.body && b.end <= loop.end && !hasIntermediateFunction(b.frame, loop))
    const groups = new Map()
    for (const b of candidates) {
      const c = comparison(tokens, b); if (!c || (hints.opcode && c.variable !== hints.opcode)) continue
      const list = groups.get(c.variable) || []; list.push({ b, c }); groups.set(c.variable, list)
    }
    for (const [opcode, rows] of groups) {
      if (rows.length < 2 && !hints.opcode) continue
      if (dispatchers.length >= 16) break
      const first = rows[0].b.frame.start, roles = assignmentRoles(tokens, loop.body, first)
      const opRole = roles.filter(x => x.target === opcode).at(-1)
      const instRole = opRole && roles.filter(x => x.target === opRole.table).at(-1)
      const pc = hints.pc || (instRole?.indexKind === 'id' ? instRole.index : null)
      const instruction = hints.instruction || opRole?.table || null
      const touched = new Map()
      for (let j = first; j < loop.end - 1; j++) if (tokens[j].kind === 'id' && tokens[j + 1].text === '[' && tokens[j].text !== instruction) touched.set(tokens[j].text, (touched.get(tokens[j].text) || 0) + 1)
      const registers = hints.registers || [...touched].sort((a, b) => b[1] - a[1])[0]?.[0] || null
      const handlers = []
      const relevantFrames = new Set(rows.map(x => x.b.frame))
      for (const frame of relevantFrames) for (const b of frame.branches) {
        if (b.body === undefined || b.end === undefined) continue
        // Internal nodes of binary decision trees are predicates, not handlers.
        if (rows.some(row => row.b.frame !== frame && row.b.frame.start >= b.body && row.b.frame.start < b.end)) continue
        const constraints = []
        let current = b, valid = true
        while (current) {
          const siblings = current.frame.branches, at = siblings.indexOf(current)
          for (let j = 0; j < at; j++) { const c = comparison(tokens, siblings[j]); if (!c || c.variable !== opcode) { valid = false; break } constraints.push({ ...c, negate: true }) }
          if (current.conditionStart !== null) { const c = comparison(tokens, current); if (!c || c.variable !== opcode) valid = false; else constraints.push({ ...c, negate: false }) }
          const parent = current.frame.parent
          current = parent?.kind === 'if' ? parent.branches.find(p => current.frame.start >= p.body && current.frame.start < p.end) : null
        }
        if (!valid || !constraints.length) continue
        const eq = constraints.find(c => c.operator === '==' && !c.negate)
        const matches = value => constraints.every(c => testComparison(c.operator, value, c.value) !== c.negate)
        const opcodes = eq ? (matches(eq.value) ? [eq.value] : []) : null
        const bodyTokens = tokens.slice(b.body, b.end), semantics = semanticHints(bodyTokens, { registers, pc })
        handlers.push({ id: 'h' + handlers.length, opcodes, constraints, ...evidence(tokens, b.body, b.end, source), semantics,
          ir: liftHandler(bodyTokens, { registers, pc }), certainty: 'structural candidate; semantics require trace validation' })
        if (handlers.length >= LIMITS.handlers) break
      }
      dispatchers.push({ id: 'vm' + dispatchers.length, line: tokens[loop.start].line, loop: loop.kind, opcode, pc, instruction, registers,
        rolesInferred: ['pc','opcode','instruction','registers'].some(key => hints[key] === undefined),
        roleSources: Object.fromEntries(['pc','opcode','instruction','registers'].map(key => [key, hints[key] === undefined ? 'inferred-or-unknown' : 'provided'])), instructionTable: instRole?.table || null,
        probeOffset: tokens[first].start, handlers, confidence: opRole && pc ? 'dispatch-and-fetch' : 'numeric-dispatch-only',
        scope: 'candidate loop; not a confirmed commercial VM family' })
    }
  }
  return { schemaVersion: 1, sha256: hash(source), bytes: Buffer.byteLength(source), tokens: tokens.length, syntaxValidated: false,
    diagnostics, urls: urls.slice(0, 128), loads: loads.slice(0, 32), constants, dispatchers,
    limitations: ['Lexical analysis is not a complete Luau parser.', 'Encrypted opcode maps and VM families are not guessed.', 'No remote source was fetched or executed.'] }
}
function hasIntermediateFunction(frame, loop) { for (let f = frame.parent; f && f !== loop; f = f.parent) if (['function','while','for','repeat'].includes(f.kind)) return true; return false }
function semanticHints(tokens, { registers, pc }) {
  const hints = [], text = tokens.map(t => t.text).join(' ')
  if (tokens.some(t => t.text === 'return')) hints.push('RETURN')
  if (tokens.some(t => t.text === 'function')) hints.push('CLOSURE')
  if (tokens.some(t => t.text === '..')) hints.push('CONCAT')
  for (const [op, name] of [['+', 'ADD'], ['-', 'SUB'], ['*', 'MUL'], ['/', 'DIV'], ['%', 'MOD'], ['^', 'POW']]) {
    // Exclude PC-only updates from arithmetic opcode candidates.
    if (tokens.some((t, i) => t.text === op && tokens.slice(Math.max(0, i - 8), i).some(x => x.text === registers))) hints.push(name)
  }
  if (registers && text.includes(registers + ' [')) hints.push('REGISTER_ACCESS')
  if (pc && tokens.some((t, i) => t.text === pc && ['=', '+=', '-='].includes(tokens[i + 1]?.text))) hints.push('PC_UPDATE')
  return [...new Set(hints)]
}

// Small expression IR, deliberately preserving unknown constructs instead of
// turning heuristic semantic names into fabricated decompiled Lua.
function expressionIR(tokens, start) {
  let pos = start, operations = 0
  const powers = { or: 1, and: 2, '==': 3, '~=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, '..': 4, '+': 5, '-': 5, '*': 6, '/': 6, '//': 6, '%': 6, '^': 8 }
  function expr(min = 0, depth = 0) {
    if (depth > 24 || operations++ > 512) throw Error('IR expression budget')
    const token = tokens[pos++]; if (!token) throw Error('missing operand')
    let node
    if (token.kind === 'number' || token.kind === 'string') node = { kind: 'literal', value: token.value ?? null }
    else if (['true','false','nil'].includes(token.text)) node = { kind: 'literal', value: token.text === 'nil' ? null : token.text === 'true' }
    else if (['-','#','not'].includes(token.text)) node = { kind: 'unary', operator: token.text, argument: expr(7, depth + 1) }
    else if (token.text === '(') { node = expr(0, depth + 1); if (tokens[pos++]?.text !== ')') throw Error('missing )') }
    else if (token.kind === 'id' && !['end','else','elseif','then','return','local','if','function','while','do'].includes(token.text)) node = { kind: 'variable', name: token.text }
    else throw Error('unsupported operand')
    while (pos < tokens.length) {
      const t = tokens[pos].text
      if (t === '[') { pos++; const index = expr(0, depth + 1); if (tokens[pos++]?.text !== ']') throw Error('missing ]'); node = { kind: 'index', table: node, index } }
      else if (t === '.' && tokens[pos + 1]?.kind === 'id') { node = { kind: 'index', table: node, index: { kind: 'literal', value: tokens[pos + 1].text } }; pos += 2 }
      else if (t === '(') {
        pos++; const args = []
        while (tokens[pos]?.text !== ')') { args.push(expr(0, depth + 1)); if (args.length > 32) throw Error('call arity budget'); if (tokens[pos]?.text !== ',') break; pos++ }
        if (tokens[pos++]?.text !== ')') throw Error('missing call )'); node = { kind: 'call', callee: node, arguments: args }
      } else if (Object.hasOwn(powers, t) && powers[t] >= min) { pos++; node = { kind: 'binary', operator: t, left: node, right: expr(powers[t] + (t === '^' || t === '..' ? 0 : 1), depth + 1) } }
      else break
    }
    return node
  }
  try { return { node: expr(), next: pos } } catch { return null }
}
function liftHandler(tokens, roles) {
  const instructions = [], unknown = []
  for (let i = 0; i < tokens.length && instructions.length < 64; i++) {
    const t = tokens[i]
    if (t.text === 'return') {
      const value = expressionIR(tokens, i + 1)
      instructions.push({ effect: 'return', value: value?.node || { kind: 'unknown' }, line: t.line, guarded: tokens.slice(0,i).some(x=>x.text==='if') }); if (value) i = value.next - 1
    } else if (t.text === roles.pc || t.text === roles.registers) {
      const lhs = expressionIR(tokens, i)
      if (!lhs || !['=','+=','-=','*=','/='].includes(tokens[lhs.next]?.text)) continue
      const rhs = expressionIR(tokens, lhs.next + 1), op = tokens[lhs.next].text
      if (!rhs) { unknown.push({ line: t.line, reason: 'unsupported assignment expression' }); continue }
      instructions.push({ effect: t.text === roles.pc ? 'pc-write' : 'register-write', target: lhs.node,
        value: op === '=' ? rhs.node : { kind: 'binary', operator: op[0], left: lhs.node, right: rhs.node }, line: t.line,
        guarded: tokens.slice(0, i).some(x => x.text === 'if') })
      i = rhs.next - 1
    } else if (t.kind === 'id' && tokens[i+1]?.text === '(') unknown.push({ line:t.line, reason:'call side effects not lowered' })
    if (['if','for','while','repeat','function'].includes(t.text)) unknown.push({ line:t.line, reason:'nested control/function effects not lowered' })
  }
  return { instructions, unknown, completeness: 'partial-expression-IR; control-flow guards and multi-assignment are not lowered' }
}

export function instrumentLua(source, analysis, options = {}) {
  const manual = options.probeOffset !== undefined
  if (manual && (!Number.isInteger(options.probeOffset) || !lexLua(source).tokens.some(t=>t.start===options.probeOffset))) throw Error('probeOffset must be a token boundary in UTF-16 code units')
  const dispatcher = manual ? { id:'manual', probeOffset:options.probeOffset, pc:options.hints?.pc, opcode:options.hints?.opcode, registers:options.hints?.registers, instruction:options.hints?.instruction } : analysis.dispatchers[options.dispatcher ?? 0]
  if (!dispatcher) throw Error('no dispatcher candidate; provide source with numeric dispatch and/or explicit role hints')
  if (manual && (!dispatcher.pc || !dispatcher.opcode)) throw Error('manual probes require hints.pc and hints.opcode')
  if (!manual && analysis.diagnostics.length) throw Error('static structure is incomplete; use uninstrumented capture or a reviewed manual probeOffset')
  if (analysis.sha256 !== hash(source)) throw Error('source hash changed before instrumentation')
  const hook = '__dsh_probe_' + hash(source).slice(0, 12)
  if (lexLua(source).tokens.some(t => t.text === hook)) throw Error('probe name collision')
  const names = [dispatcher.pc, dispatcher.opcode, dispatcher.registers, dispatcher.instruction].map(v => v ? identifier(v) : 'nil')
  const insertion = ' ' + hook + '(' + names.join(',') + '); '
  const instrumented = source.slice(0, dispatcher.probeOffset) + insertion + source.slice(dispatcher.probeOffset)
  return { source: instrumented, hook,
    map: { originalSha256: analysis.sha256, instrumentedSha256: hash(instrumented), hook, offset: dispatcher.probeOffset, offsetEncoding: 'UTF-16 code units', insertedCharacters: insertion.length, dispatcher: dispatcher.id, roles: { pc: dispatcher.pc ?? null, opcode: dispatcher.opcode ?? null, registers: dispatcher.registers ?? null, instruction: dispatcher.instruction ?? null }, note: 'Probe records state BEFORE each dispatch. Role inference must be reviewed; no bytecode hooks or anti-tamper bypass.' } }
}

export function summarizeTrace(events, analysis = null) {
  if (!Array.isArray(events) || events.length > LIMITS.events) throw Error('trace must be an array of at most ' + LIMITS.events + ' events')
  if (Buffer.byteLength(JSON.stringify(events)) > 4 * 1024 * 1024) throw Error('trace exceeds 4 MiB')
  const steps = events.filter(e => e?.kind === 'vm_step'), frequency = new Map(), edgeCounts = new Map(), effects = []
  let previous = null
  const scalar = v => typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 128
  for (let i = 0; i < steps.length; i++) {
    const event = steps[i]
    if (!scalar(event.pc) || !scalar(event.opcode)) throw Error('vm_step requires finite numeric or short string pc/opcode')
    if (event.registers !== undefined && (!event.registers || typeof event.registers !== 'object' || Array.isArray(event.registers) || Object.keys(event.registers).length > 64)) throw Error('invalid register snapshot')
    const key = String(event.opcode); frequency.set(key, (frequency.get(key) || 0) + 1)
    if (previous) {
      const edge = JSON.stringify([previous.pc, event.pc]); edgeCounts.set(edge, (edgeCounts.get(edge) || 0) + 1)
      if (effects.length < 256) {
        const before = previous.registers || {}, after = event.registers || {}
        const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).slice(0, 32).map(register => ({ register, before: before[register] ?? null, after: after[register] ?? null }))
        effects.push({ step: i - 1, pc: previous.pc, opcode: previous.opcode, changes, evidence: 'difference between consecutive pre-dispatch snapshots; not a proven isolated handler effect' })
      }
    }
    previous = event
  }
  const dispatch = analysis?.dispatchers?.[0], known = new Set(dispatch?.handlers.flatMap(h => h.opcodes || []) || [])
  return { schemaVersion: 1, steps: steps.length, opcodeFrequency: [...frequency].map(([opcode, count]) => ({ opcode, count })),
    cfg: [...edgeCounts].map(([key, count]) => { const [from, to] = JSON.parse(key); return { from, to, count, evidence: 'observed transition only' } }), effects,
    coverage: { observedOpcodes: frequency.size, staticExactOpcodes: known.size, observedKnownOpcodes: [...known].filter(k => frequency.has(String(k))).length, fullProgramCoverage: 'unknown' },
    missingFinalState: steps.length > 0, incomplete: events.some(e => e.kind === 'limit') ? true : null, effectsTruncated: Math.max(0, steps.length - 1) > effects.length,
    limitations: ['Trace is input-specific; unvisited branches are unknown.', 'The last handler has no subsequent snapshot.', 'Snapshots can be partial and instrumentation can affect anti-tamper code.'] }
}

export function compareTraces(before, after) {
  summarizeTrace(before); summarizeTrace(after)
  const a = before.filter(e => e.kind === 'vm_step'), b = after.filter(e => e.kind === 'vm_step')
  const projection = e => e && { pc: e.pc, opcode: e.opcode, registers: Object.fromEntries(Object.entries(e.registers || {}).sort(([a],[b]) => a.localeCompare(b))) }
  let i = 0
  while (i < Math.min(a.length, b.length) && JSON.stringify(projection(a[i])) === JSON.stringify(projection(b[i]))) i++
  return { equal: i === a.length && i === b.length, commonPrefixSteps: i, beforeSteps: a.length, afterSteps: b.length,
    firstDivergence: i === a.length && i === b.length ? null : { step: i, before: projection(a[i]) ?? null, after: projection(b[i]) ?? null },
    note: 'Positional comparison of observed dispatches; equal traces do not prove semantic equivalence.' }
}

// Lift observed virtual instructions into a trace-specific IR. Constant-fold
// instruction operands, preserve register expressions, and correlate only the
// effects for which both an expression and a following snapshot are available.
export function liftTrace(analysis, events, options = {}) {
  summarizeTrace(events, analysis)
  const dispatcher = analysis.dispatchers[options.dispatcher ?? 0]
  if (!dispatcher) throw Error('no selected dispatcher for lifting')
  const steps = events.filter(e => e.kind === 'vm_step'), max = options.maxInstructions ?? 256, lifted = []
  if (!Number.isInteger(max) || max < 1 || max > 512) throw Error('maxInstructions must be 1..512')
  const unknown = () => ({ known: false })
  for (let i = 0; i < Math.min(steps.length, max); i++) {
    const step = steps[i], next = steps[i + 1]
    const matches = dispatcher.handlers.filter(h => typeof step.opcode === 'number' && h.constraints.every(c => testComparison(c.operator, step.opcode, c.value) !== c.negate))
    if (matches.length !== 1) { lifted.push({ step: i, pc: step.pc, opcode: step.opcode, handler: null, operations: [], status: 'ambiguous-or-unknown-opcode' }); continue }
    const handler = matches[0]
    function value(node, depth = 0) {
      if (!node || depth > 24) return unknown()
      if (node.kind === 'literal') return { known: true, value: node.value }
      if (node.kind === 'variable') {
        if (node.name === dispatcher.pc) return { known: true, value: step.pc }
        if (node.name === dispatcher.opcode) return { known: true, value: step.opcode }
        return unknown()
      }
      if (node.kind === 'index' && node.table.kind === 'variable') {
        const index = value(node.index, depth + 1)
        const table = node.table.name === dispatcher.registers ? step.registers : node.table.name === dispatcher.instruction ? step.instruction : null
        if (!index.known || !table || !Object.hasOwn(table, String(index.value))) return unknown()
        const v = table[String(index.value)]
        return typeof v === 'string' && (/^<.*>$/.test(v) || v.length >= 256) ? unknown() : { known: true, value: v }
      }
      if (node.kind === 'unary') {
        const a = value(node.argument, depth + 1)
        if (!a.known) return unknown()
        if (node.operator === '-' && typeof a.value === 'number') return { known: true, value: -a.value }
        if (node.operator === 'not') return { known: true, value: a.value === false || a.value === null }
      }
      if (node.kind === 'binary') {
        const a = value(node.left, depth + 1), b = value(node.right, depth + 1)
        if (!a.known || !b.known) return unknown()
        if (node.operator === '..' && ['string','number'].includes(typeof a.value) && ['string','number'].includes(typeof b.value)) return { known: true, value: (String(a.value) + String(b.value)).slice(0, 256) }
        if (typeof a.value !== 'number' || typeof b.value !== 'number') return unknown()
        const x = a.value, y = b.value
        const result = node.operator === '+' ? x + y : node.operator === '-' ? x - y : node.operator === '*' ? x * y : node.operator === '/' ? x / y : node.operator === '//' ? Math.floor(x / y) : node.operator === '%' ? x - Math.floor(x / y) * y : node.operator === '^' ? x ** y : NaN
        if (Number.isFinite(result)) return { known: true, value: result }
      }
      return unknown()
    }
    function render(node, reads = new Set(), depth = 0) {
      if (!node || depth > 24) return { text: '<?>' , reads, unresolved: true }
      if (node.kind === 'literal') return { text: node.value === null ? 'nil' : JSON.stringify(node.value), reads }
      if (node.kind === 'variable') return { text: node.name === dispatcher.registers ? 'R' : node.name === dispatcher.pc ? 'PC' : node.name === dispatcher.opcode ? 'OP' : node.name, reads, unresolved: ![dispatcher.pc,dispatcher.opcode].includes(node.name) }
      if (node.kind === 'index') {
        const index = value(node.index)
        if (node.table.kind === 'variable' && node.table.name === dispatcher.instruction) {
          const folded = value(node); if (folded.known) return { text: JSON.stringify(folded.value), reads }
        }
        if (node.table.kind === 'variable' && node.table.name === dispatcher.registers) {
          if (index.known) reads.add(String(index.value))
          const r = render(node.index, reads, depth + 1)
          return { text: 'R[' + (index.known ? JSON.stringify(index.value) : r.text) + ']', reads, unresolved: !index.known || !!r.unresolved }
        }
        const a = render(node.table, reads, depth + 1), b = render(node.index, reads, depth + 1)
        return { text: a.text + '[' + b.text + ']', reads, unresolved: true }
      }
      if (node.kind === 'binary') { const a = render(node.left, reads, depth + 1), b = render(node.right, reads, depth + 1); return { text: '(' + a.text + ' ' + node.operator + ' ' + b.text + ')', reads, unresolved: !!a.unresolved || !!b.unresolved } }
      if (node.kind === 'unary') { const a = render(node.argument, reads, depth + 1); return { text: node.operator + ' ' + a.text, reads, unresolved: a.unresolved } }
      return { text: '<' + node.kind + '>', reads, unresolved: true }
    }
    const operations = handler.ir.instructions.map(ir => {
      const rhs = render(ir.value), lhs = ir.target ? render(ir.target) : null
      const addressReads = ir.target?.kind === 'index' ? render(ir.target.index) : {reads:new Set()}
      const target = ir.effect === 'register-write' && ir.target?.kind === 'index' ? value(ir.target.index) : unknown()
      const expected = value(ir.value), observed = target.known && next?.registers && Object.hasOwn(next.registers, String(target.value)) ? { known: true, value: next.registers[String(target.value)] } : unknown()
      return { effect: ir.effect, text: ir.effect === 'return' ? 'RETURN ' + rhs.text : (lhs?.text || '<?>') + ' := ' + rhs.text,
        reads: [...new Set([...rhs.reads,...addressReads.reads])], writes: target.known ? [String(target.value)] : [], guarded: ir.guarded || false, unresolved: !!rhs.unresolved || !!addressReads.unresolved || ir.guarded || (ir.effect === 'register-write' && !target.known),
        correlation: !next ? 'no-next-snapshot' : ir.guarded || step.registersTruncated || step.instructionTruncated || next.registersTruncated || !expected.known || !observed.known ? 'unknown' : JSON.stringify(expected.value) === JSON.stringify(observed.value) ? 'consistent-with-next-snapshot' : 'different-from-next-snapshot' }
    })
    lifted.push({ step: i, pc: step.pc, opcode: step.opcode, handler: handler.id, line: handler.line, operations, unknown: handler.ir.unknown, status: 'partial-observed-IR' })
  }
  let slice = null
  if (options.register !== undefined) {
    if (typeof options.register !== 'string' || options.register.length > 128) throw Error('register must be a short snapshot key')
    const at = options.atStep ?? lifted.length - 1
    if (!Number.isInteger(at) || at < 0 || at >= lifted.length) throw Error('atStep must select a lifted pre-dispatch snapshot')
    const pending = new Set([options.register]), contributors = [], gaps = []
    for (let i = at - 1; i >= 0; i--) {
      const instruction = lifted[i]
      if (!instruction.operations.length) { gaps.push(i); continue }
      if (instruction.operations.some(op => op.unresolved) || instruction.unknown?.length) gaps.push(i)
      for (const op of [...instruction.operations].reverse()) if (op.writes.some(r => pending.has(r))) {
        contributors.push({ step: i, pc: instruction.pc, text: op.text, unresolved: op.unresolved })
        if (op.unresolved) gaps.push(i)
        else { for (const r of op.writes) pending.delete(r); for (const r of op.reads) pending.add(r) }
      }
    }
    slice = { register: options.register, atStep: at, contributors: contributors.reverse(), unresolvedInitialRegisters: [...pending], gaps,
      scope: 'trace-specific candidate data slice; control dependencies and unlowered side effects are unknown' }
  }
  return { schemaVersion: 1, sourceSha256: analysis.sha256, dispatcher: dispatcher.id, instructions: lifted, slice,
    truncated: steps.length > lifted.length, completeDevirtualization: false,
    limitations: ['Only observed instructions are lifted.', 'Handler IR is partial; snapshot correlation is not semantic equivalence.', 'Absent/unknown effects and guard dependencies remain unknown.'] }
}
