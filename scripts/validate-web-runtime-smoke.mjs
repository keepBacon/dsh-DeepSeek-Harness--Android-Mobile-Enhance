#!/usr/bin/env node
import fs from 'node:fs'

const [logFile] = process.argv.slice(2)
if (!logFile) throw new Error('usage: validate-web-runtime-smoke.mjs <web-log>')

const output = fs.readFileSync(logFile, 'utf8')
const prefix = 'dsh web: '
const launchCandidates = output
  .split(/\r?\n/u)
  .flatMap((line) => {
    const at = line.indexOf(prefix)
    if (at < 0) return []
    const tail = line.slice(at + prefix.length).trim()
    const token = tail.split(/\s+/u, 1)[0]
    return token === undefined || token.length === 0 ? [] : [token]
  })
  .filter((candidate) => candidate.startsWith('http://127.0.0.1:') && candidate.includes('/?token='))

if (launchCandidates.length === 0) {
  throw new Error('authenticated dsh web launch URL missing from readiness log')
}

const launchUrl = launchCandidates.at(-1)
const parsedLaunch = new URL(launchUrl)
if (parsedLaunch.protocol !== 'http:' || parsedLaunch.hostname !== '127.0.0.1') {
  throw new Error('unexpected dsh web launch authority: ' + parsedLaunch.origin)
}
if (parsedLaunch.pathname !== '/') {
  throw new Error('unexpected dsh web launch path: ' + parsedLaunch.pathname)
}
const launchTokens = parsedLaunch.searchParams.getAll('token')
if (launchTokens.length !== 1 || !/^[A-Za-z0-9_-]+$/u.test(launchTokens[0] ?? '')) {
  throw new Error('malformed dsh web launch token')
}
if ([...parsedLaunch.searchParams.keys()].some((key) => key !== 'token')) {
  throw new Error('unexpected query parameter in dsh web launch URL')
}

const origin = parsedLaunch.origin
const base = origin + '/'
const timedFetch = (input, init = {}) => fetch(input, {
  ...init,
  signal: AbortSignal.timeout(10_000),
})

// Browser-auth is fail-closed. A bare root request must not become a silent
// public bypass just to make the packaging smoke test pass.
const denied = await timedFetch(base, { redirect: 'manual' })
if (denied.status !== 401) {
  throw new Error('unauthenticated index expected HTTP 401, got ' + String(denied.status))
}

// Exchange the process launch token exactly once for the authority-bound
// browser cookie. This mirrors DSH's real browser e2e contract.
const exchange = await timedFetch(launchUrl, { redirect: 'manual' })
const setCookie = exchange.headers.get('set-cookie')
const location = exchange.headers.get('location')
if (exchange.status !== 303 || setCookie === null || location !== '/') {
  throw new Error(
    'launch-token exchange invalid: HTTP ' + String(exchange.status)
      + ', location=' + JSON.stringify(location)
      + ', cookie=' + (setCookie === null ? 'missing' : 'present'),
  )
}

const cookie = setCookie.split(';', 1)[0]
const cookieAt = cookie.indexOf('=')
if (cookieAt <= 0 || cookieAt === cookie.length - 1) {
  throw new Error('launch-token exchange returned a malformed cookie')
}

const page = await timedFetch(base, {
  redirect: 'manual',
  headers: { cookie },
})
if (page.status !== 200) {
  throw new Error('authenticated index expected HTTP 200, got ' + String(page.status))
}

const html = await page.text()
const marker = 'globalThis["__DSH_BOOT__"] = '
const start = html.indexOf(marker)
if (start < 0) throw new Error('window.__DSH_BOOT__ injection missing')
const scriptEnd = html.indexOf('</script>', start)
if (scriptEnd < 0) throw new Error('window.__DSH_BOOT__ script terminator missing')
const raw = html.slice(start + marker.length, scriptEnd).trim().replace(/;\s*$/u, '')
const graph = JSON.parse(raw)

if (!Array.isArray(graph.entries) || graph.entries.length === 0) {
  throw new Error('client boot graph has no entries')
}
if (!Array.isArray(graph.batches) || graph.batches.length === 0) {
  throw new Error('client boot graph has no batches')
}

for (const batch of graph.batches) {
  if (batch === null || typeof batch !== 'object' || typeof batch.url !== 'string') {
    throw new Error('malformed client boot batch')
  }
  const batchUrl = new URL(batch.url, base)
  if (batchUrl.origin !== origin) {
    throw new Error('client batch escaped local Web origin: ' + batchUrl.href)
  }
  if (batch.url.includes('/??')) {
    throw new Error('Android client bootstrap still advertises a combo URL: ' + batch.url)
  }
}

const uniqueResources = new Map()
for (const row of graph.entries) {
  if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.url !== 'string') {
    throw new Error('malformed client boot row')
  }
  if (row.url.includes('/??')) {
    throw new Error(row.id + ': Android single-resource URL unexpectedly contains /??')
  }
  const url = new URL(row.url, base)
  if (url.origin !== origin) {
    throw new Error(row.id + ': client resource escaped local Web origin: ' + url.href)
  }
  uniqueResources.set(url.href, row.id)
}

for (const [href, id] of uniqueResources) {
  const url = new URL(href)
  const response = await timedFetch(url, {
    cache: 'no-store',
    headers: { cookie },
  })
  if (response.status !== 200) {
    throw new Error(id + ': HTTP ' + String(response.status) + ' for ' + url.pathname + url.search)
  }
  const body = await response.text()
  if (body.length < 32 || !body.includes('__ModuleLoader__')) {
    throw new Error(id + ': client bundle response is empty/truncated/invalid')
  }
}

console.log('[DSH] Web browser auth: OK (401 -> token exchange 303 -> authenticated index 200)')
console.log('[DSH] Web launch URL parsing: OK (structured URL validation, no eval/heredoc regex)')
console.log('[DSH] Web client bundles: OK (' + String(uniqueResources.size) + ' unique single-resource scripts)')
