// Android DSH 0.2.2 SenseNova inference transport compatibility.
//
// pi-ai's OpenAI Chat Completions adapter accepts a per-request fetch option.
// Do not alter global fetch, the provider config, TLS verification or the
// DSH HTTP proxy. Only transport failures of an idempotence-guarded initial
// POST to the exact SenseNova OpenAI endpoint may use a second connection.
// The API invocation is retried only when fetch rejected before a Response
// was received; never retry HTTP 4xx, HTTP 5xx, or an interrupted SSE stream.

function androidSenseNovaEligible(input, init) {
  if (process.env.DSH_ANDROID_STANDALONE !== '1') return false
  if (init?.signal?.aborted) return false
  if (String(init?.method || 'GET').toUpperCase() !== 'POST') return false
  // Preserve the upstream single-proxy transport decision. It is not safe
  // to send a credential-bearing request directly around a configured proxy.
  if (['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy',
    'ALL_PROXY','all_proxy'].some(k => String(process.env[k] || '').trim())) return false
  if (typeof init?.body !== 'string' && !(init?.body instanceof Uint8Array)) return false
  try {
    const url = new URL(input instanceof Request ? input.url : input)
    return url.protocol === 'https:' && url.hostname === 'token.sensenova.cn'
      && (url.port === '' || url.port === '443')
      && url.pathname.replace(/\/+$/, '') === '/v1/chat/completions'
      && !url.username && !url.password
  } catch { return false }
}

export async function androidSenseNovaCompletionsFetch(input, init) {
  try {
    return await fetch(input, init)
  } catch (originalError) {
    if (!androidSenseNovaEligible(input, init) ||
        originalError?.name === 'AbortError') throw originalError
    try {
      const url = new URL(input instanceof Request ? input.url : input)
      return await androidNativeModelStreamingFetch(url, init)
    } catch (nativeError) {
      // Do not expose credentials, request body or URLs in diagnostics.
      const codes = [nativeError?.code,nativeError?.cause?.code]
      const code = codes.find(c => typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,48}$/.test(c))
      throw Object.assign(new TypeError(
        'SenseNova Android transport failed' + (code ? ': ' + code : '')), {
        code: code || 'DSH_SENSENOVA_TRANSPORT_FAILED',
      })
    }
  }
}

// Native HTTP(S) streaming transport used after the above strict admission
// check. The fixture can call this function against a local loopback server.
// It never performs redirect following or disables certificate validation.
export async function androidNativeModelStreamingFetch(target, init) {
  const url = target instanceof URL ? target : new URL(target)
  const module = await import(url.protocol === 'https:' ? 'node:https' : 'node:http')
  const { Readable } = await import('node:stream')
  const headers = new Headers(init.headers)
  // Native Node HTTP does not automatically decompress HTTP response bodies.
  // Request identity; if a gateway ignores it, decode streaming below.
  headers.set('accept-encoding', 'identity')
  const body = init.body
  return await new Promise((resolve,reject) => {
    const req = module.request(url, {
      method: 'POST',
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal,
    }, async res => {
      try {
        const status = res.statusCode || 502
        const responseHeaders = new Headers()
        for (const [key,value] of Object.entries(res.headers)) {
          if (value !== undefined && key !== 'content-length' &&
              key !== 'content-encoding' && key !== 'transfer-encoding')
            responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value))
        }
        let stream = res
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase()
        if (encoding && encoding !== 'identity') {
          const zlib = await import('node:zlib')
          const decoder = encoding === 'gzip' ? zlib.createGunzip()
            : encoding === 'deflate' ? zlib.createInflate()
            : encoding === 'br' ? zlib.createBrotliDecompress() : null
          if (!decoder) throw Object.assign(new Error('unsupported encoding'),
            { code:'DSH_SENSENOVA_UNSUPPORTED_ENCODING' })
          stream = res.pipe(decoder)
        }
        // Preserve streaming: do not wait for, log, or buffer the complete SSE.
        // A non-2xx response is returned to the OpenAI SDK for its own error
        // normalization; it must never trigger a retry of this POST.
        const noBody = [204,205,304].includes(status)
        if (status === 304) {
          resolve({status,ok:false,headers:responseHeaders,body:null,text:async()=>''})
          return
        }
        resolve(new Response(noBody ? null : Readable.toWeb(stream),
          {status,headers:responseHeaders}))
      } catch (error) { res.destroy(); reject(error) }
    })
    req.setTimeout(25_000, () => req.destroy(Object.assign(
      new Error('SenseNova connection timed out'),{code:'ETIMEDOUT'})))
    req.on('error',reject)
    req.end(body)
  })
}
