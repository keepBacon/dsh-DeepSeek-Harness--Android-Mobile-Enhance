#!/usr/bin/env node
/**
 * Read-only reverse engineering and deobfuscation helpers.
 * Never evaluates supplied JS/Luau, calls external processes, or writes input files.
 * All content capture is bounded; ambiguous recognition is reported as a heuristic.
 */
import { createHash } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const SOURCE_LIMIT = 1024 * 1024
const MAP_LIMIT = 2 * 1024 * 1024
const BINARY_LIMIT = 256 * 1024 * 1024
const preview = (s, n = 180) => String(s).slice(0, n)
const number = (n, fallback, low, high) => Number.isInteger(n) ? Math.max(low, Math.min(high, n)) : fallback
function fail(what) { throw new Error(what) }
function validateText(value, label = 'text', max = SOURCE_LIMIT) {
  if (typeof value !== 'string') fail(label + ' must be a string')
  if (Buffer.byteLength(value) > max) fail(label + ' exceeds ' + max + ' bytes')
  return value
}
async function checkFile(raw, max) {
  const name = validateText(raw, 'path', 16384)
  if (name.includes('\0')) fail('path contains NUL')
  const path = await realpath(resolve(process.cwd(), name))
  const info = await stat(path)
  if (!info.isFile()) fail('path must be a regular file')
  if (info.size > max) fail('file exceeds ' + max + '-byte limit')
  return { path, size: info.size }
}
async function loadSource(a, limit = SOURCE_LIMIT) {
  if (Boolean(a.path !== undefined) === Boolean(a.source !== undefined)) {
    fail('provide exactly one of path or source')
  }
  if (a.source !== undefined) return { source: validateText(a.source, 'source', limit), path: null }
  const f = await checkFile(a.path, limit)
  return { source: await readFile(f.path, 'utf8'), path: f.path }
}
function lineAt(src, at) {
  let line = 1
  for (let i = 0; i < at; i++) if (src.charCodeAt(i) === 10) line++
  return line
}
function recordMatches(source, re, kind, severity, max) {
  const found = []
  for (const m of source.matchAll(re)) {
    if (found.length >= max) break
    found.push({ kind, severity, offset: m.index, line: lineAt(source, m.index), evidence: preview(m[0].replace(/\s+/g, ' '), 130) })
  }
  return found
}
function entropy(buffer) {
  if (!buffer.length) return 0
  const hist = new Uint32Array(256)
  for (const byte of buffer) hist[byte]++
  let e = 0
  for (const count of hist) {
    if (count) { const p = count / buffer.length; e -= p * Math.log2(p) }
  }
  return Math.round(e * 1000) / 1000
}
function decodeLiteral(a) {
  const mode = validateText(a.encoding, 'encoding', 24)
  const input = validateText(a.text, 'text', 131072)
  let data
  switch (mode) {
    case 'hex':
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(input)) fail('invalid hex input')
      data = Buffer.from(input, 'hex')
      break
    case 'base64':
    case 'base64url': {
      const base = mode === 'base64url' ? input.replace(/-/g, '+').replace(/_/g, '/') : input
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/.test(base)) fail('invalid base64 input')
      data = Buffer.from(base, 'base64')
      if (data.toString('base64').replace(/=+$/, '') !== base.replace(/=+$/, '')) fail('noncanonical base64 input')
      break
    }
    case 'percent':
      try { data = Buffer.from(decodeURIComponent(input), 'utf8') }
      catch { fail('invalid percent escape sequence') }
      break
    case 'js-escape': {
      const out = input.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|([nrt0\\'"bvf]))/g, (_whole, hex, long, short, simple) => {
        if (hex) return String.fromCharCode(parseInt(hex, 16))
        if (long) {
          const v = parseInt(long, 16)
          if (v > 0x10ffff) fail('invalid Unicode scalar')
          return String.fromCodePoint(v)
        }
        if (short) return String.fromCharCode(parseInt(short, 16))
        return { n: '\n', r: '\r', t: '\t', 0: '\0', b: '\b', v: '\v', f: '\f', '\\': '\\', '"': '"', "'": "'" }[simple]
      })
      data = Buffer.from(out, 'utf8')
      break
    }
    case 'luau-decimal': {
      // Lua numeric escapes are decimal (up to three digits), unlike JS octal.
      const out = input.replace(/\\([0-9]{1,3})/g, (_all, digits) => {
        const v = Number(digits)
        if (v > 255) fail('Lua decimal escape exceeds byte range')
        return String.fromCharCode(v)
      })
      data = Buffer.from(out, 'latin1')
      break
    }
    case 'charcodes': {
      const m = /^\s*(?:string\.char\s*\(|String\.fromCharCode\s*\()?([\d,\s]+)\)?\s*$/.exec(input)
      if (!m) fail('charcodes requires comma-separated byte values')
      const parts = m[1].split(',').map(x => x.trim())
      if (parts.length > 32768 || parts.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) fail('charcodes outside byte range')
      data = Buffer.from(parts.map(Number))
      break
    }
    default: fail('unsupported decoding mode: ' + mode)
  }
  if (data.length > 131072) fail('decoded content too large')
  const limit = number(a.maxOutputBytes, 8192, 64, 32768)
  const clipped = data.subarray(0, limit)
  return { encoding: mode, bytes: data.length, truncated: data.length > clipped.length,
    utf8: clipped.toString('utf8'), hex: clipped.toString('hex'), executed: false }
}

export const reverseAssistTools = [
  { name:'reverse_scan_obfuscation', description:'Read-only JavaScript/Luau obfuscation indicators with line evidence. Heuristic, not proof of malicious behavior.', inputSchema:{ type:'object',properties:{path:{type:'string'},source:{type:'string'},language:{type:'string',enum:['auto','js','luau'],default:'auto'},maxFindings:{type:'integer',minimum:1,maximum:200,default:60}},additionalProperties:false} },
  { name:'reverse_decode_literal', description:'Decode literal hex, base64, base64url, percent, JS Unicode escapes, Lua decimal escapes or byte charcodes. No eval or file writes.', inputSchema:{ type:'object',properties:{text:{type:'string'},encoding:{type:'string',enum:['hex','base64','base64url','percent','js-escape','luau-decimal','charcodes']},maxOutputBytes:{type:'integer',minimum:64,maximum:32768,default:8192}},required:['text','encoding'],additionalProperties:false} },
  { name:'reverse_extract_strings', description:'Extract likely encoded JS/Luau string literals and decode static candidates without execution. Does not parse arbitrary dynamic expressions.', inputSchema:{ type:'object',properties:{path:{type:'string'},source:{type:'string'},maxResults:{type:'integer',minimum:1,maximum:120,default:60}},additionalProperties:false} },
  { name:'reverse_identifier_profile', description:'Estimate source identifier obfuscation (short names, _0x patterns, generated names) without AST execution.', inputSchema:{ type:'object',properties:{path:{type:'string'},source:{type:'string'},maxExamples:{type:'integer',minimum:1,maximum:80,default:25}},additionalProperties:false} },
  { name:'reverse_file_entropy', description:'Sample bounded regions of a local binary and report Shannon entropy, printable ratio and sample digest. No external CLI.', inputSchema:{ type:'object',properties:{path:{type:'string'},windows:{type:'integer',minimum:1,maximum:32,default:16},windowBytes:{type:'integer',minimum:256,maximum:65536,default:16384}},required:['path'],additionalProperties:false} },
  { name:'reverse_sourcemap_inspect', description:'Read a local source map JSON and list original sources, optional bounded embedded source previews. Does not fetch remote files.', inputSchema:{ type:'object',properties:{path:{type:'string'},includeSourcePreviews:{type:'boolean',default:false},maxSources:{type:'integer',minimum:1,maximum:100,default:40}},required:['path'],additionalProperties:false} }
]
export async function reverseAssistCall(name, a = {}) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('arguments must be an object')
  if (name === 'reverse_decode_literal') return decodeLiteral(a)
  if (name === 'reverse_file_entropy') {
    const f = await checkFile(a.path, BINARY_LIMIT)
    const windows = number(a.windows, 16, 1, 32)
    const bytesPerWindow = number(a.windowBytes, 16384, 256, 65536)
    const sample = []
    const hash = createHash('sha256')
    let total = 0, printable = 0
    const handle = await open(f.path, 'r')
    try {
      for (let i = 0; i < windows; i++) {
        const offset = Math.floor(Math.max(0, f.size - bytesPerWindow) * i / Math.max(1, windows - 1))
        const buf = Buffer.alloc(Math.min(bytesPerWindow, Math.max(0, f.size - offset)))
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
        const chunk = buf.subarray(0, bytesRead)
        hash.update(chunk)
        for (const b of chunk) if (b >= 32 && b < 127) printable++
        total += chunk.length
        sample.push({ offset, bytes: bytesRead, entropy: entropy(chunk) })
      }
    } finally { await handle.close() }
    return { path:f.path,size:f.size,sampleBytes:total,printableRatio:total?Math.round(printable/total*1000)/1000:0,
      sampleSha256:hash.digest('hex'),windows:sample,note:'Sample digest is NOT a full-file SHA256; high entropy alone does not prove packing.' }
  }
  if (name === 'reverse_sourcemap_inspect') {
    const f = await checkFile(a.path, MAP_LIMIT)
    const obj = JSON.parse(await readFile(f.path, 'utf8'))
    if (obj?.version !== 3 || !Array.isArray(obj.sources)) fail('not a valid v3 source map')
    const max = number(a.maxSources, 40, 1, 100)
    const sources = obj.sources.slice(0, max).map((s, i) => {
      const row = { index:i,name:preview(String(s), 1024) }
      if (a.includeSourcePreviews === true && typeof obj.sourcesContent?.[i] === 'string')
        row.preview = preview(obj.sourcesContent[i], 512)
      return row
    })
    return { path:f.path,version:obj.version,file:obj.file??null,sourceRoot:obj.sourceRoot??null,
      totalSources:obj.sources.length,sources,truncated:obj.sources.length>max,hasEmbeddedSources:obj.sourcesContent?.some(x=>typeof x==='string')??false,
      mappingsBytes:typeof obj.mappings==='string'?obj.mappings.length:0 }
  }
  const {source, path} = await loadSource(a)
  if (name === 'reverse_scan_obfuscation') {
    const limit = number(a.maxFindings, 60, 1, 200)
    const rules = [
      [/\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){2,}/g,'hex-escaped-literal','medium'],
      [/\\(?:u[0-9a-fA-F]{4}){3,}/g,'unicode-escaped-literal','medium'],
      [/\\[0-9]{2,3}(?:\\[0-9]{2,3}){3,}/g,'lua-decimal-string','medium'],
      [/\b(?:eval|Function)\s*\(|\bnew\s+Function\s*\(/g,'dynamic-evaluation','high'],
      [/\b(?:loadstring|load)\s*\(/g,'lua-dynamic-load','high'],
      [/\b(?:atob|fromCharCode|decodeURIComponent)\s*\(/g,'runtime-decoding','medium'],
      [/\bstring\.char\s*\(/g,'lua-charcodes','medium'],
      [/\b_0x[a-fA-F0-9]{4,}\b/g,'hex-like-identifier','low'],
      [/\b(?:while\s*\(\s*true\s*\)|while\s+true\s+do)\b/g,'loop-control-flow','low'],
    ]
    const findings=rules.flatMap(([re,kind,level])=>recordMatches(source,re,kind,level,limit))
      .sort((x,y)=>x.offset-y.offset).slice(0,limit)
    const lines = source.split(/\r?\n/)
    const longLines = lines.map((s,i)=>({line:i+1,length:s.length})).filter(x=>x.length>500).slice(0,20)
    const density = source.length ? Math.round((1-source.replace(/\s/g,'').length/source.length)*1000)/1000 : 0
    return { path,language:a.language||'auto',bytes:Buffer.byteLength(source),lineCount:lines.length,whitespaceRatio:density,
      longLines,findings,truncated:findings.length>=limit,heuristic:true }
  }
  if (name === 'reverse_extract_strings') {
    const max = number(a.maxResults,60,1,120)
    const rows = []
    // Strings are lexed approximately; backtick expressions and long brackets are excluded.
    const re= /"(?:\\.|[^"\\\r\n]){0,2048}"|'(?:\\.|[^'\\\r\n]){0,2048}'/g
    for (const m of source.matchAll(re)) {
      if (rows.length >= max) break
      const literal=m[0].slice(1,-1)
      let encoding=null, payload=literal
      if (/(?:\\x[0-9a-fA-F]{2}){2,}/.test(literal)) encoding='js-escape'
      else if (/(?:\\[0-9]{2,3}){3,}/.test(literal)) encoding='luau-decimal'
      else if (/^(?:[A-Za-z0-9+/]{4}){3,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(literal)) encoding='base64'
      else if (/(?:%[0-9a-fA-F]{2}){3,}/.test(literal)) encoding='percent'
      if (!encoding) continue
      let decoded
      try { decoded=decodeLiteral({encoding,text:payload,maxOutputBytes:2048}) }
      catch { continue }
      rows.push({line:lineAt(source,m.index),offset:m.index,encoding,rawPreview:preview(literal,130),
        decodedPreview:decoded.utf8.slice(0,300),decodedBytes:decoded.bytes,truncated:decoded.truncated})
    }
    return {path,results:rows,truncated:rows.length>=max,heuristic:true,executed:false}
  }
  if (name === 'reverse_identifier_profile') {
    const tokens=source.match(/[A-Za-z_$][A-Za-z0-9_$]*/g)||[]
    const skip=new Set(['const','let','var','true','false','null','nil','local','function','end','return','if','else','elseif','for','while','do','then','new','class','import','export','from','this','async','await','string','table','math','Number','String','Object','Array','Buffer','undefined'])
    const distinct=[...new Set(tokens)].filter(t=>!skip.has(t))
    const short=distinct.filter(x=>x.length<=2)
    const hex=distinct.filter(x=>/^_0x[a-f0-9]{4,}$/i.test(x))
    const auto=distinct.filter(x=>/^(?:_?tmp|_?var|_?func|_?arg|v)\d{3,}$/i.test(x))
    const long=distinct.filter(x=>x.length>=40)
    const max=number(a.maxExamples,25,1,80)
    return {path,tokenCount:tokens.length,distinctIdentifiers:distinct.length,shortCount:short.length,hexStyleCount:hex.length,generatedCount:auto.length,longCount:long.length,
      examples:{short:short.slice(0,max),hexStyle:hex.slice(0,max),generated:auto.slice(0,max),long:long.slice(0,max)},
      note:'Lexical estimates include identifiers from comments and strings; use an AST for authoritative renaming.'}
  }
  fail('unknown reverse assist tool: ' + name)
}
