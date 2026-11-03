// Advanced Lua/Luau analysis tools. Offline fixture execution, not Roblox emulation.
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, open, realpath, mkdir, writeFile, lstat } from 'node:fs/promises'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import { LIMITS, hash, analyzeLua, instrumentLua, summarizeTrace, compareTraces, liftTrace } from './dsh-lua-analysis-core.mjs'
import { luaCaseTools, luaCaseCall } from './dsh-lua-case.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME_VERSION = '1.5.1'
const str = { type: 'string' }, integer = (minimum, maximum, defaultValue) => ({ type: 'integer', minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) })
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const hints = object({ pc: str, opcode: str, registers: str, instruction: str })
const input = { source: { type: 'string', maxLength: LIMITS.sourceBytes }, path: str, hints, expectedSha256:{type:'string',pattern:'^[a-f0-9]{64}$'} }
const dynamic = {
  fixtures: object({ http: { type: 'object', additionalProperties: str }, services: { type: 'object', additionalProperties: true } }),
  globals: { type: 'object', additionalProperties: true }, timeoutMs: integer(250, 15000, 5000),
  maxEvents: integer(16, 2047, 512), maxSteps: integer(1, 100000, 10000), seed: integer(0, 2147483647, 1),
  instrument: { type: 'boolean', default: false }, dispatcher: integer(0, 15, 0),
  probeOffset:integer(0,LIMITS.sourceBytes),
}
const traceInput = { events: { type: 'array', maxItems: LIMITS.events, items: { type: 'object' } }, tracePath: str }
export const luaTools = [
 ...luaCaseTools,
 {name:'lua_analysis_capabilities',description:'Report actual availability of pinned Luau WASM execution, static VM dispatch extraction, offline fixtures and trace analysis; no network probes.',inputSchema:object({})},
 {name:'lua_vm_analyze',description:'Find numeric VM dispatch trees, opcode predicates, fetch/PC/register roles, handler evidence and constant loadstring layers in Lua/Luau without executing it. Roles and semantic hints are hypotheses.',inputSchema:object(input)},
 {name:'lua_vm_instrument',description:'Preview the source and hash/offset map used by lua_dynamic_run with instrument=true, or use a reviewed manual token offset for table/custom VMs. Does not modify files or execute code.',inputSchema:object({...input,dispatcher:integer(0,15,0),probeOffset:integer(0,LIMITS.sourceBytes)})},
 {name:'lua_dynamic_run',description:'Execute actual Luau in a disposable WASM process with fixture-only HttpGet/request, loadstring capture, API events and optional VM-step probes. Hard wall timeout; no guest Node/file/network APIs. Missing Roblox APIs remain unsupported.',inputSchema:object({...input,...dynamic})},
 {name:'lua_trace_analyze',description:'Analyze bounded VM-step events/JSON traces: observed CFG, opcode frequencies, consecutive register deltas and partial coverage. Does not invent unvisited instructions or full devirtualization.',inputSchema:object({...traceInput,...input})},
 {name:'lua_vm_lift',description:'Lift observed VM instructions into operand-resolved register IR, correlate predicted scalar effects with subsequent snapshots, and optionally backward-slice one register. Unknown opcodes, guards and side effects remain explicit.',inputSchema:object({...traceInput,...input,dispatcher:integer(0,15,0),maxInstructions:integer(1,512,256),register:str,atStep:integer(0,511)})},
 {name:'lua_trace_compare',description:'Compare two observed VM traces and locate the first PC/opcode/register divergence for differential analysis. Matching traces do not prove program equivalence.',inputSchema:object({before:{type:'array',maxItems:LIMITS.events,items:{type:'object'}},after:{type:'array',maxItems:LIMITS.events,items:{type:'object'}}},['before','after'])},
 {name:'lua_analysis_workflow',description:'Run a bounded offline Lua/Luau investigation: static VM analysis, real dynamic fixture execution, captured loadstring layers, observed trace CFG and provenance report. Optionally save all evidence in a NEW directory; never fetch remote payloads automatically.',inputSchema:object({...input,...dynamic,dynamic:{type:'boolean',default:true},followCaptured:{type:'boolean',default:true},maxLayers:integer(1,6,3),outputDir:str})},
]

function range(value, fallback, min, max, label) { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < min || value > max) throw Error(label + ' outside allowed range'); return value }
function jsonBudget(value, bytes, label) { if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > bytes) throw Error(label + ' must be a bounded JSON object') }
async function textFile(path, max) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw Error('invalid input path')
  const canonical = await realpath(resolve(path)), handle = await open(canonical, 'r')
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) throw Error('input is not a bounded regular file')
    const data = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(data, 0, data.length, 0)
    if (bytesRead !== stat.size || bytesRead > max) throw Error('input changed or exceeded size limit')
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, bytesRead)), path: canonical }
  } finally { await handle.close() }
}
async function sourceInput(args) {
  if ((args.source !== undefined) === (args.path !== undefined)) throw Error('provide exactly one of source or path')
  const result = args.path !== undefined ? await textFile(args.path, LIMITS.sourceBytes) : { text: args.source, path: null }
  if (typeof result.text !== 'string' || Buffer.byteLength(result.text) > LIMITS.sourceBytes || result.text.includes('\0')) throw Error('source must be UTF-8 Lua text of at most 1 MiB without NUL')
  if (args.expectedSha256 !== undefined && args.expectedSha256 !== hash(result.text)) throw Error('source SHA-256 mismatch')
  if (args.hints !== undefined) { jsonBudget(args.hints, 2048, 'hints'); if (Object.keys(args.hints).some(k => !['pc','opcode','registers','instruction'].includes(k))) throw Error('unknown role hint') }
  return result
}
async function runtime() {
  const candidates = [process.env.DSH_LUAU_WEB_PATH, resolve(HERE, '../../lib/dsh-dev-tools/node_modules/luau-web/src/index.js')].filter(Boolean)
  try { candidates.push(createRequire(import.meta.url).resolve('luau-web')) } catch {}
  for (const path of candidates) {
    try {
      const full = await realpath(path), meta = JSON.parse(await readFile(resolve(dirname(full), '../package.json'), 'utf8'))
      if (meta.name !== 'luau-web' || meta.version !== RUNTIME_VERSION) throw Error('expected luau-web@' + RUNTIME_VERSION)
      for (const file of [full, resolve(dirname(full),'lib/Luau.Web.Asyncify.js'), resolve(dirname(full),'lib/Luau.Web.JSPI.js')]) if (!(await lstat(file)).isFile()) throw Error('Luau WASM runtime file missing')
      return { available: true, path: full, version: meta.version }
    } catch (error) { if (path === process.env.DSH_LUAU_WEB_PATH) return { available: false, reason: 'configured Luau runtime unusable: ' + error.message } }
  }
  return { available: false, reason: 'Install pinned luau-web@' + RUNTIME_VERSION + ' in usr/lib/dsh-dev-tools/node_modules, or set DSH_LUAU_WEB_PATH to its src/index.js.' }
}
function runOptions(args) {
  const fixtures = args.fixtures ?? {}, globals = args.globals ?? {}
  jsonBudget(fixtures, 512 * 1024, 'fixtures'); jsonBudget(globals, 64 * 1024, 'globals')
  for (const field of Object.keys(fixtures)) if (!['http','services'].includes(field)) throw Error('unknown fixture kind: ' + field)
  if (fixtures.http !== undefined) { jsonBudget(fixtures.http, 512 * 1024, 'HTTP fixtures'); if (Object.values(fixtures.http).some(v => typeof v !== 'string' || Buffer.byteLength(v) > LIMITS.captureBytes)) throw Error('HTTP fixtures must contain bounded strings') }
  if (fixtures.services !== undefined) jsonBudget(fixtures.services, 64 * 1024, 'service fixtures')
  range(args.dispatcher, 0, 0, 15, 'dispatcher')
  if (args.instrument !== undefined && typeof args.instrument !== 'boolean') throw Error('instrument must be a boolean')
  return { fixtures, globals, seed: range(args.seed, 1, 0, 2147483647, 'seed'),
    timeoutMs: range(args.timeoutMs, 5000, 250, 15000, 'timeoutMs'), maxEvents: range(args.maxEvents, 512, 16, 2047, 'maxEvents'),
    maxSteps: range(args.maxSteps, 10000, 1, 100000, 'maxSteps'), maxCaptureBytes: LIMITS.captureBytes }
}

async function execute(source, args, analysis) {
  const options = runOptions(args), installed = await runtime()
  if (!installed.available) return { ok: false, phase: 'capability', error: installed.reason, events: [], captures: [], partial: true, execution: 'not-run' }
  let map = null
  if (args.instrument === true) {
    const instrumented = instrumentLua(source, analysis, args)
    source = instrumented.source; options.hook = instrumented.hook; map = instrumented.map
    if (!map.roles.pc) throw Error('VM instrumentation requires a PC role; provide hints.pc')
  }
  const started = Date.now(), events = []
  const result = await new Promise(done => {
    let child, outcome = null, timedOut = false, errorOutput = '', bytes = 0, settled = false, timer
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); done(value) }
    // Preserve loader/library selectors needed by Android Node, not credentials.
    const env = { LANG: 'C.UTF-8', TZ: 'UTC' }
    for (const k of ['PATH','LD_LIBRARY_PATH','LD_PRELOAD','TMPDIR','ANDROID_ROOT','ANDROID_DATA']) if (process.env[k]) env[k] = process.env[k]
    try { child = fork(resolve(HERE, 'dsh-luau-runner.mjs'), [], { execArgv: ['--max-old-space-size=128'], env, stdio: ['ignore','ignore','pipe','ipc'] }) }
    catch (error) { finish({ ok: false, phase: 'startup', error: error.message }); return }
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
    child.stderr.on('data', b => { if (errorOutput.length < 4096) errorOutput += b.toString().slice(0, 4096 - errorOutput.length) })
    child.on('error', error => { child.kill('SIGKILL'); finish({ ok: false, phase: 'startup', error: error.message }) })
    child.on('message', message => {
      if (message?.type === 'event') {
        bytes += Buffer.byteLength(JSON.stringify(message.event))
        if (events.length >= LIMITS.events || bytes > 2 * 1024 * 1024) { outcome = { ok: false, phase: 'limit', error: 'trace byte/event limit' }; child.kill('SIGKILL') }
        else {
          const event = message.event
          if (event.kind === 'loadstring') {
            if (typeof event.sourceHex !== 'string' || event.sourceHex.length > LIMITS.captureBytes * 2 || !/^(?:[a-f0-9]{2})*$/.test(event.sourceHex)) { outcome = { ok: false, phase: 'capture', error: 'invalid captured bytes' }; child.kill('SIGKILL'); return }
            const raw = Buffer.from(event.sourceHex, 'hex'); event.sha256 = hash(raw)
            try { event.source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) } catch { event.binaryBase64 = raw.toString('base64') }
            delete event.sourceHex
          }
          events.push(event)
        }
      } else if (message?.type === 'result') outcome = message.result
    })
    child.on('exit', (code, signal) => finish(timedOut ? { ok: false, phase: 'timeout', timedOut: true } : outcome || { ok: false, phase: 'child-exit', exitCode: code, signal, error: errorOutput }))
    child.send({ source, options, runtimePath: installed.path }, error => { if (error) { child.kill('SIGKILL'); finish({ ok: false, phase: 'startup', error: error.message }) } })
  })
  const captures = events.filter(e => e.kind === 'loadstring').map(e => ({ source: e.source ?? null, binaryBase64: e.binaryBase64, sha256: e.sha256, bytes: e.bytes, capture: e.capture,
    invoked: events.some(call => call.kind === 'captured_call' && call.capture === e.capture), provenance: 'observed loadstring argument; body was not executed in this stage' }))
  return { ...result, execution: 'luau-wasm', runtimeVersion: installed.version, sourceSha256: analysis.sha256, durationMs: Date.now() - started,
    events, captures, instrumentation: map, partial: !result.ok || events.some(e => ['limit','unsupported'].includes(e.kind)),
    environment: { network: 'offline-fixtures-only', filesystem: 'not exposed to guest', roblox: 'partial explicit fixtures; no live game', clock: 'fixed zero',
      isolation: 'WASM guest with no Node imports; disposable process and wall timeout. V8 heap limit is not a strict WASM/OS memory quota.' },
    limitations: ['loadstring is intercepted and returns an inert callable; dependent return values can change behavior.', 'Unknown Roblox/executor APIs are not silently emulated.', 'Instrumentation is observable and not an anti-tamper bypass.'] }
}
async function trace(args) {
  if ((args.events !== undefined) === (args.tracePath !== undefined)) throw Error('provide exactly one of events or tracePath')
  let events = args.events, sourceSha256 = null, execution = null
  if (args.tracePath !== undefined) { const parsed = JSON.parse((await textFile(args.tracePath, 4 * 1024 * 1024)).text); events = Array.isArray(parsed) ? parsed : parsed.events; sourceSha256 = parsed.sourceSha256 ?? null; execution = parsed.execution ?? null }
  if (Buffer.byteLength(JSON.stringify(events) || '') > 4 * 1024 * 1024) throw Error('trace exceeds 4 MiB')
  summarizeTrace(events); return { events, sourceSha256, execution }
}

function report(workflow) {
  const lines = ['# Lua/Luau VM 辅助分析报告', '', '状态：' + workflow.status, '', '所有动态结果来自真实 Luau WASM 的离线夹具运行；不代表 Roblox 实际行为或完整源码还原。', '']
  for (const layer of workflow.layers) {
    lines.push('## Layer ' + layer.index, '', '- SHA-256: `' + layer.analysis.sha256 + '`', '- 来源：' + layer.provenance,
      '- VM 分发候选：' + layer.analysis.dispatchers.length, '- 动态状态：' + (layer.dynamic ? layer.dynamic.ok ? 'completed' : layer.dynamic.phase || layer.dynamic.result || layer.dynamic.error : 'not-run'),
      '- 观察 VM 步数：' + (layer.trace?.steps || 0), '- 捕获 loadstring：' + (layer.dynamic?.captures.length || 0), '')
    for (const d of layer.analysis.dispatchers) for (const h of d.handlers) lines.push('- Handler ' + d.id + '/' + h.id + ' @L' + h.line + ' opcode=' + JSON.stringify(h.opcodes || h.constraints) + ' 候选语义=' + h.semantics.join(','))
    if (layer.lift?.instructions.length) { lines.push('', '```text'); for (const ins of layer.lift.instructions.slice(0, 64)) lines.push('PC=' + ins.pc + ' OP=' + ins.opcode + ' ' + (ins.operations.map(op => op.text).join('; ') || '<unknown-handler>')); lines.push('```', '') }
  }
  lines.push('', '## 下一步与边界', '', ...workflow.nextActions.map(s => '- ' + s), '', '- 未访问路径、缺失夹具和加密 opcode 语义均保留未知。', '- layer-N.luau、probe-N.luau 与动态捕获是分析数据，不应直接在真实游戏执行。', '')
  return lines.join('\n')
}
async function artifacts(outputDir, workflow, sources) {
  if (typeof outputDir !== 'string' || !outputDir || outputDir.includes('\0')) throw Error('invalid outputDir')
  const requested = resolve(outputDir), parent = await realpath(dirname(requested)), target = resolve(parent, basename(requested))
  // Existing paths (including symlinks) are never reused or overwritten.
  try { await lstat(target); throw Error('outputDir already exists; use a new directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(target, { mode: 0o700 })
  const files = []
  async function put(name, content) { await writeFile(resolve(target, name), content, { flag: 'wx', mode: 0o600 }); files.push({ name, bytes: Buffer.byteLength(content), sha256: hash(content) }) }
  for (const [i, source] of sources.entries()) await put('layer-' + i + '.luau', source)
  await put('analysis.json', JSON.stringify(workflow, null, 2) + '\n')
  await put('report.md', report(workflow))
  for (const layer of workflow.layers) if (layer.dynamic) await put('trace-' + layer.index + '.json', JSON.stringify({ sourceSha256: layer.analysis.sha256, execution: { ok: layer.dynamic.ok, partial: layer.dynamic.partial, phase: layer.dynamic.phase ?? null }, events: layer.dynamic.events }) + '\n')
  for (const layer of workflow.layers) if (layer.lift) await put('lift-' + layer.index + '.json', JSON.stringify(layer.lift, null, 2) + '\n')
  for (const layer of workflow.layers) if (layer.dynamic?.instrumentation) {
    const map = layer.dynamic.instrumentation
    const probe = instrumentLua(sources[layer.index], layer.analysis, { probeOffset: map.offset, hints: map.roles })
    if (hash(probe.source) !== map.instrumentedSha256) throw Error('instrumented artifact hash mismatch')
    await put('probe-' + layer.index + '.luau', probe.source)
  }
  await put('manifest.json', JSON.stringify({ schemaVersion: 1, files: [...files], execution: 'offline', completeDevirtualization: false }, null, 2) + '\n')
  return { directory: target, files }
}
async function workflow(args) {
  for (const key of ['dynamic','followCaptured']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw Error(key + ' must be a boolean')
  const input = await sourceInput(args), maxLayers = range(args.maxLayers, 3, 1, 6, 'maxLayers')
  const layers = [], sources = [], seen = new Set(), queue = [{ source: input.text, provenance: input.path ? 'file: ' + input.path : 'provided source' }], nextActions = new Set()
  let truncated = false
  while (queue.length && layers.length < maxLayers) {
    const entry = queue.shift(), digest = hash(entry.source)
    if (seen.has(digest)) { nextActions.add('Repeated captured source detected; recursive stage was not re-executed.'); continue }
    seen.add(digest)
    const analysis = analyzeLua(entry.source, args.hints || {}), layer = { index: layers.length, provenance: entry.provenance, analysis, dynamic: null, trace: null, lift: null }
    sources.push(entry.source); layers.push(layer)
    if (args.dynamic !== false) {
      const selected = analysis.dispatchers[args.dispatcher ?? 0]
      const probeOffset = layer.index === 0 ? args.probeOffset : undefined
      const instrument = args.instrument !== false && (probeOffset !== undefined || (selected?.pc != null && !analysis.diagnostics.length))
      if (args.instrument === true && !instrument) nextActions.add('Layer ' + layer.index + ': no instrumentable dispatcher/PC role; dynamic capture ran without VM probes.')
      layer.dynamic = await execute(entry.source, { ...args, instrument, probeOffset }, analysis)
      layer.trace = summarizeTrace(layer.dynamic.events, analysis)
      layer.trace.incomplete = layer.dynamic.partial || layer.trace.incomplete
      if (analysis.dispatchers[args.dispatcher ?? 0] && layer.trace.steps) layer.lift = liftTrace(analysis, layer.dynamic.events, args)
      if (!layer.dynamic.ok) nextActions.add('Layer ' + layer.index + ': inspect dynamic error/partial trace; do not treat the result as recovered source.')
      for (const e of layer.dynamic.events) if (e.kind === 'http_get' && !e.fixture) nextActions.add('Supply a locally acquired fixtures.http entry for ' + e.url + '; no HTTP request was made.')
      if (args.followCaptured !== false) for (const captured of layer.dynamic.captures) {
        if (captured.invoked && typeof captured.source === 'string' && !captured.source.includes('\0')) queue.push({ source: captured.source, provenance: 'loadstring called in layer ' + layer.index + ', SHA-256 ' + digest })
        else if (captured.binaryBase64 || captured.source?.includes('\0')) nextActions.add('Binary/NUL-containing capture preserved; not passed off as Luau source or automatically executed.')
      }
    } else if (args.followCaptured !== false) for (const captured of analysis.loads) if (captured.kind === 'constant-source') queue.push({ source: captured.source, provenance: 'static loadstring argument in layer ' + layer.index + ' (invocation not verified)' })
  }
  if (queue.length) { truncated = true; nextActions.add('Layer limit reached; inspect remaining captured sources separately.') }
  if (!layers.some(l => l.trace?.steps)) nextActions.add('For a VM trace, select a dispatcher and review hints.pc/opcode/registers/instruction before instrumenting it.')
  nextActions.add('Compare runs with different explicit fixtures using lua_trace_compare; validate handler hypotheses against observed register effects.')
  const result = { schemaVersion: 1, status: args.dynamic === false ? 'static-only' : truncated || layers.some(l => l.dynamic?.partial || l.dynamic?.ok === false) ? 'partial' : 'observed',
    completeDevirtualization: false, truncated, layers, nextActions: [...nextActions] }
  if (args.outputDir !== undefined) {
    const saved = await artifacts(args.outputDir, result, sources)
    return { schemaVersion: 1, status: result.status, completeDevirtualization: false, truncated, artifacts: saved,
      layers: layers.map(l => ({ index: l.index, sha256: l.analysis.sha256, dispatchers: l.analysis.dispatchers.length, dynamicOk: l.dynamic?.ok ?? null, steps: l.trace?.steps || 0, captured: l.dynamic?.captures.length || 0 })), nextActions: result.nextActions }
  }
  return result
}

async function caseEngineFingerprint() {
  const files=['dsh-lua-tools.mjs','dsh-lua-case.mjs','dsh-lua-analysis-core.mjs','dsh-luau-runner.mjs']
  const entries=await Promise.all(files.map(async file=>({file,sha256:hash(await readFile(resolve(HERE,file)))})))
  return hash(JSON.stringify(entries))
}

export async function luaCall(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('tool arguments must be an object')
  if (luaCaseTools.some(t=>t.name===name)) return luaCaseCall(name,args,{sourceInput,runOptions,analyze:analyzeLua,execute,engineFingerprint:caseEngineFingerprint})
  if (name === 'lua_analysis_capabilities') {
    const installed = await runtime()
    return { staticAnalysis: true, dynamic: { ...installed, probe: 'not-run; use lua_dynamic_run to verify execution' }, engine: 'actual Luau via luau-web@' + RUNTIME_VERSION, limits: LIMITS,
      supported: ['numeric dispatch trees', 'role hints and source-mapped probes', 'offline HttpGet/request fixtures', 'loadstring capture', 'VM register snapshots and observed CFG', 'operand-resolved instruction IR', 'candidate backward register slices', 'trace differential', 'multi-layer evidence workflow', 'checkpointed cases and input scenarios', 'instrumentation baseline validation'],
      unavailable: ['live Roblox engine', 'automatic Luarmor/key/authentication bypass', 'universal VM devirtualization', 'strict OS memory sandbox'] }
  }
  if (name === 'lua_trace_compare') return compareTraces(args.before, args.after)
  if (name === 'lua_analysis_workflow') return workflow(args)
  if (name === 'lua_trace_analyze' || name === 'lua_vm_lift') {
    const { events, sourceSha256, execution } = await trace(args)
    const analysis = args.source !== undefined || args.path !== undefined ? analyzeLua((await sourceInput(args)).text, args.hints || {}) : null
    if (analysis && sourceSha256 && analysis.sha256 !== sourceSha256) throw Error('trace/source SHA-256 mismatch')
    if (name === 'lua_vm_lift') { if (!analysis) throw Error('lifting requires source or path'); return { ...liftTrace(analysis, events, args), provenanceVerified: sourceSha256 === analysis.sha256 } }
    const summary = summarizeTrace(events, analysis)
    if (execution?.partial) summary.incomplete = true
    return summary
  }
  if (['lua_vm_analyze','lua_vm_instrument','lua_dynamic_run'].includes(name)) {
    const { text } = await sourceInput(args), analysis = analyzeLua(text, args.hints || {})
    if (name === 'lua_vm_analyze') return analysis
    if (name === 'lua_vm_instrument') { range(args.dispatcher, 0, 0, 15, 'dispatcher'); return instrumentLua(text, analysis, args) }
    return execute(text, args, analysis)
  }
  throw Error('unknown Lua analysis tool: ' + name)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, argsFile, ...extra] = process.argv.slice(2)
  Promise.resolve().then(async () => {
    if (!luaTools.some(t => t.name === name) || !argsFile || extra.length) throw Error('Usage: node dsh-lua-tools.mjs <tool-name> <arguments.json>')
    const args = JSON.parse((await textFile(argsFile, 4 * 1024 * 1024)).text)
    const result = await luaCall(name, args)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (result.ok === false || result.status === 'partial') process.exitCode = 2
  }).catch(error => { process.stderr.write('[dsh-lua-analysis] ' + String(error.message || error) + '\n'); process.exitCode = 1 })
}
