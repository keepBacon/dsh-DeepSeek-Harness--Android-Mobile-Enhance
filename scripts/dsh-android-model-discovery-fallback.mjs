// Android-only fallback for the DSH 0.2.2 model-listing GET request.
//
// This function is embedded into the published llm-pi-ai discovery bundle by
// android-runtime-patch.mjs. Keep it self-contained: no local imports, no
// external dependency, no global dispatcher changes and no secret-bearing logs.
export async function androidModelDiscoveryFetch(url, options = {}) {
  try {
    return await fetch(url, options)
  } catch (originalError) {
    if (process.env.DSH_ANDROID_STANDALONE !== '1' ||
        options.method && String(options.method).toUpperCase() !== 'GET' ||
        options.signal?.aborted ||
        originalError?.name === 'AbortError') throw originalError

    // An explicitly configured DSH proxy policy must never be bypassed by
    // a native direct request. The regular fetch already uses that policy.
    const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
      'ALL_PROXY', 'all_proxy'].some(name => String(process.env[name] || '').trim())
    if (hasProxy) throw originalError

    const target = new URL(url)
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw originalError

    // Only model listing is allowed to retry: it is an idempotent GET and
    // the upstream caller has already selected /models. Other model calls
    // and every SDK keep the original transport.
    if (!target.pathname.replace(/\/+$/, '').endsWith('/models')) throw originalError

    const maximum = 2 * 1024 * 1024
    try {
      const mod = await import(target.protocol === 'https:' ? 'node:https' : 'node:http')
      const requestHeaders = Object.fromEntries(new Headers(options.headers).entries())
      // Node http(s).request does not automatically inflate responses.
      requestHeaders['accept-encoding'] = 'identity'
      return await new Promise((resolve, reject) => {
        const req = mod.request(target, {
          method: 'GET',
          headers: requestHeaders,
          signal: options.signal,
        }, res => {
          const sizeHint = Number(res.headers['content-length'] || 0)
          if (sizeHint > maximum) {
            res.destroy(Object.assign(new Error('model listing exceeds limit'),
              { code: 'DSH_MODEL_LIST_TOO_LARGE' }))
            return
          }
          const chunks = []
          let size = 0
          res.on('data', chunk => {
            size += chunk.length
            if (size > maximum) {
              res.destroy(Object.assign(new Error('model listing exceeds limit'),
                { code: 'DSH_MODEL_LIST_TOO_LARGE' }))
            } else chunks.push(chunk)
          })
          res.on('error', reject)
          res.on('end', async () => {
            try {
              let body = Buffer.concat(chunks)
              const encoding = String(res.headers['content-encoding'] || '').toLowerCase()
              if (encoding && encoding !== 'identity') {
                const zlib = await import('node:zlib')
                const decode = encoding === 'gzip' ? zlib.gunzipSync
                  : encoding === 'deflate' ? zlib.inflateSync
                  : encoding === 'br' ? zlib.brotliDecompressSync : null
                if (!decode) throw Object.assign(new Error('unsupported response encoding'),
                  { code: 'DSH_MODEL_LIST_ENCODING' })
                body = decode(body, { maxOutputLength: maximum })
              }
              if (body.length > maximum) throw Object.assign(
                new Error('model listing exceeds limit'), { code: 'DSH_MODEL_LIST_TOO_LARGE' })
              const headers = new Headers()
              for (const [key, value] of Object.entries(res.headers)) {
                if (value === undefined || key === 'content-length' ||
                    key === 'content-encoding') continue
                headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
              }
              const status = res.statusCode || 502
              // Response() rejects status 304 even though the upstream
              // discovery caller needs to report its actual HTTP status.
              if (status === 304) {
                resolve({ ok: false, status, headers })
              } else {
                resolve(new Response(
                  status === 204 || status === 205 ? null : body,
                  { status, headers },
                ))
              }
            } catch (error) { reject(error) }
          })
        })
        req.setTimeout(15_000, () => req.destroy(Object.assign(
          new Error('model discovery transport timed out'), { code: 'ETIMEDOUT' })))
        req.on('error', reject)
        req.end()
      })
    } catch (nativeError) {
      // A request may have failed before DNS/TLS/connection. On Android,
      // Termux curl uses an independent transport stack and can recover a
      // genuine Node failure. Restrict this *third* option to SenseNova's
      // idempotent GET /v1/models; never retry a returned HTTP error.
      const exactSenseNova = target.protocol === 'https:'
        && target.hostname === 'token.sensenova.cn'
        && (target.port === '' || target.port === '443')
        && target.pathname.replace(/\/+$/, '') === '/v1/models'
        && !target.username && !target.password
      if (exactSenseNova && typeof androidCurlRequest === 'function'
          && await androidCurlAvailable()) {
        try {
          return await androidCurlRequest(target, options)
        } catch (curlError) {
          const error = new Error('Android model discovery curl transport failed')
          error.code = typeof curlError?.code === 'string' ? curlError.code : 'DSH_CURL_FAILED'
          throw error
        }
      }
      // Do not serialize url, request headers, API keys or raw error messages.
      const failure = new Error('Android native model discovery transport failed',
        { cause: nativeError })
      failure.code = 'DSH_ANDROID_MODEL_DISCOVERY_FALLBACK_FAILED'
      throw failure
    }
  }
}

// A short, credential-free cause label for the existing DSH discovery error.
// Upstream catches every transport failure as "could not reach <url>" and
// hides the actual cause; this helper never echoes raw URLs, header values,
// stack traces, or third-party error messages.
export function androidModelDiscoveryFailureHint(error) {
  const causes = [error, error?.cause, error?.cause?.cause]
  const codes = causes.map(value => value?.code)
    .filter(value => typeof value === 'string' &&
      /^[A-Z][A-Z0-9_]{1,60}$/.test(value))
  if (codes.includes('DSH_ANDROID_MODEL_DISCOVERY_FALLBACK_FAILED')) {
    const nativeCode = codes.find(code =>
      code !== 'DSH_ANDROID_MODEL_DISCOVERY_FALLBACK_FAILED')
    return nativeCode ? 'Android HTTP fallback: ' + nativeCode
      : 'Android HTTP fallback failed'
  }
  if (codes.length) return 'Node transport: ' + codes[0]
  if (causes.some(value => /WebAssembly|Wasm/i.test(String(value?.message || ''))))
    return 'Node HTTP WebAssembly initialization failed'
  return 'Node HTTP transport failed; verify Android app VPN, DNS, TLS and proxy settings'
}
