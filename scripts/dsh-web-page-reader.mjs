// Complete, paginated HTTP page reader for the Android MCP toolbox.
// Unlike upstream web_fetch, the response is saved before an excerpt is rendered.
// The complete original response remains available in the app-private cache.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_PAGE_BYTES = 32 * 1024 * 1024
const CACHE_TTL_MS = 20 * 60 * 1000
const CACHE_MAX_FILES = 12
const CACHE_MAX_BYTES = 128 * 1024 * 1024
const PAGE_TIMEOUT_MS = 30000
const inFlight = new Map() // Deduplicate concurrent reads of the same URL/cache key.

function checkedUrl(input) {
  if (typeof input !== 'string' || input.length > 16384) throw new Error('url must be a string <= 16384 chars')
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('read_page supports HTTP(S) only')
  if (url.username || url.password) throw new Error('credentials in read_page URL are not supported')
  return url
}
function cacheRoot() {
  return resolve(process.env.HOME || process.cwd(), '.cache/dsh-web-pages')
}
function htmlText(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:p|div|h[1-6]|li|ul|ol|pre|blockquote|section|article|header|footer|tr|table)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, value) => {
      const name = value.toLowerCase()
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
      if (Object.hasOwn(named, name)) return named[name]
      const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : all
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
async function trimCache(root) {
  try {
    const files = (await readdir(root)).filter(name => /^[0-9a-f]{64}\.body$/.test(name))
    const entries = []
    for (const name of files) {
      try {
        const s = await stat(resolve(root, name))
        entries.push({name, mtime: s.mtimeMs, size: s.size})
      } catch {}
    }
    entries.sort((a, b) => b.mtime - a.mtime)
    let bytes = 0
    for (let i = 0; i < entries.length; i++) {
      bytes += entries[i].size
      if (i < CACHE_MAX_FILES && bytes <= CACHE_MAX_BYTES) continue
      const key = entries[i].name.slice(0, 64)
      await Promise.all([
        rm(resolve(root, key + '.body'), {force: true}),
        rm(resolve(root, key + '.json'), {force: true})
      ])
    }
  } catch { /* Cache pruning is best effort and must never mask a successful fetch. */ }
}
async function fetchComplete(url, bodyPath, metaPath) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
  const temp = bodyPath + '.tmp-' + process.pid + '-' + randomBytes(5).toString('hex')
  let handle = null, received = 0
  try {
    const response = await fetch(url, {signal: controller.signal, redirect: 'follow', headers: {'User-Agent': 'DSH-Mobile-ReadPage/1.0'}})
    if (!response.ok) throw new Error('HTTP_PAGE_ERROR: upstream returned status '+response.status)
    const type = response.headers.get('content-type') || ''
    if (type && !/^(text\/|application\/(?:json|xml|javascript|xhtml\+xml)|[^;]+\+(?:json|xml))/i.test(type)) {
      throw new Error('unsupported page content type: ' + type)
    }
    const expected = Number(response.headers.get('content-length') || 0)
    if (expected > MAX_PAGE_BYTES) throw new Error('PAGE_TOO_LARGE: response Content-Length exceeds 32 MiB')
    handle = await open(temp, 'wx', 0o600)
    if (response.body) {
      for await (const chunk of response.body) {
        const part = Buffer.from(chunk)
        received += part.length
        if (received > MAX_PAGE_BYTES) throw new Error('PAGE_TOO_LARGE: downloaded content exceeds 32 MiB; no silent truncation')
        await handle.writeFile(part)
      }
    }
    await handle.close(); handle = null
    const meta = {url: response.url, status: response.status, contentType: type, fetchedBytes: received}
    await rename(temp, bodyPath)
    const metadataHandle = await open(metaPath, 'w', 0o600)
    try { await metadataHandle.writeFile(JSON.stringify(meta)) } finally { await metadataHandle.close() }
    return meta
  } finally {
    clearTimeout(timer)
    if (handle) await handle.close().catch(() => {})
    await rm(temp, {force: true}).catch(() => {})
  }
}
export async function readWebPage(args = {}) {
  const url = checkedUrl(args.url)
  const offset = Number.isInteger(args.offsetChars) && args.offsetChars >= 0 ? args.offsetChars : 0
  const limit = Number.isInteger(args.maxChars) ? Math.max(1, Math.min(200000, args.maxChars)) : 12000
  const format = args.format === 'html' ? 'html' : 'text'
  const root = cacheRoot()
  await mkdir(root, {recursive: true, mode: 0o700})
  const key = createHash('sha256').update(url.href).digest('hex')
  const bodyPath = resolve(root, key + '.body')
  const metaPath = resolve(root, key + '.json')
  let meta = null, fromCache = false
  if (args.refresh !== true) {
    try {
      const s = await stat(bodyPath)
      if (Date.now() - s.mtimeMs <= CACHE_TTL_MS && s.size <= MAX_PAGE_BYTES) {
        meta = JSON.parse(await readFile(metaPath, 'utf8'))
        if (Number.isInteger(meta.fetchedBytes) && meta.fetchedBytes === s.size) fromCache = true
        else meta = null
      }
    } catch { /* Missing/incomplete cache entry means fetch again. */ }
  }
  if (!meta) {
    // Many workers may request the same page concurrently. Publish the full
    // response once; all waiters then read a single verified body/meta pair.
    let pending = inFlight.get(key)
    if (!pending) {
      pending = fetchComplete(url.href, bodyPath, metaPath)
      inFlight.set(key, pending)
      pending.finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key)
      }).catch(() => {}) // Do not create an unhandled rejecting cleanup promise.
    }
    meta = await pending
  }
  const bytes = await readFile(bodyPath)
  const charset = /charset\s*=\s*["']?([A-Za-z0-9._-]+)/i.exec(meta.contentType || '')?.[1] || 'utf-8'
  let raw
  try { raw = new TextDecoder(charset).decode(bytes) }
  catch { raw = bytes.toString('utf8') }
  const sourceIsHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(meta.contentType || '')
  const full = format === 'text' && sourceIsHtml ? htmlText(raw) : raw
  const end = Math.min(full.length, offset + limit)
  const result = {
    url: meta.url, status: meta.status, contentType: meta.contentType,
    fetchedBytes: bytes.length, cached: fromCache, format,
    offsetChars: offset, nextOffsetChars: end, totalChars: full.length,
    hasMore: end < full.length, content: full.slice(offset, end),
    completeSource: true, storedPath: bodyPath
  }
  if (!fromCache) await trimCache(root)
  return result
}
export const readPageTool = {
  name: 'read_page',
  description: 'Read complete HTTP(S) pages in stable, repeatable character windows. Caches the FULL response (up to 32 MiB) in app-private storage before paging, never silently clips the source like web_fetch. Call again with nextOffsetChars while hasMore=true; use format=html for exact source.',
  inputSchema: {type:'object', properties: {
    url:{type:'string'}, offsetChars:{type:'integer',minimum:0,default:0},
    maxChars:{type:'integer',minimum:1,maximum:200000,default:12000},
    format:{type:'string',enum:['text','html'],default:'text'},
    refresh:{type:'boolean',default:false}
  },required:['url'],additionalProperties:false}
}
