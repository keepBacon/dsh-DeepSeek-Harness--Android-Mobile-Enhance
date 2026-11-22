// Android native curl transport for DSH model discovery and SenseNova streaming.
//
// Termux curl uses a transport independent of embedded Node's undici and
// node:https stack. This is an optional, scoped transport, not a global fetch
// or TLS override. Only model listing GET or explicitly admitted SenseNova
// Chat Completions POST callers use it; proxies are screened by those callers.
//
// Secrets and request bodies travel over process pipes, NEVER argv or logs.
// Config is fed to curl --config -; POST bodies use an inherited fd 3.
// A failure is reported by a stable, credential-free exit code.
// No -k, no redirects, no automatic POST retries.

function androidCurlConfigQuote(value) {
  const text = String(value)
  if (/[\r\n\0]/.test(text)) throw Object.assign(new Error('invalid HTTP option'), {
    code: 'DSH_CURL_INVALID_OPTION',
  })
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

export async function androidCurlAvailable() {
  const executable = process.env.DSH_ANDROID_CURL_BINARY
  if (!executable || !executable.startsWith('/')) return false
  if (process.env.DSH_ANDROID_STANDALONE === '1' &&
      !process.env.DSH_ANDROID_EXEC_BRIDGE?.startsWith('/')) return false
  try {
    const { stat } = await import('node:fs/promises')
    return (await stat(executable)).isFile()
  } catch { return false }
}

export async function androidCurlRequest(input, options = {}) {
  const url = input instanceof URL ? input : new URL(input)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('unsupported model endpoint'), { code: 'DSH_CURL_INVALID_URL' })
  }
  const method = String(options.method || 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method) ||
      (method === 'POST' && typeof options.body !== 'string' &&
        !(options.body instanceof Uint8Array))) {
    throw Object.assign(new Error('unsupported model request'), { code: 'DSH_CURL_INVALID_REQUEST' })
  }
  if (options.signal?.aborted) {
    throw Object.assign(new Error('model request cancelled'), { code: 'ABORT_ERR' })
  }
  if (!await androidCurlAvailable()) {
    throw Object.assign(new Error('Android curl unavailable'), { code: 'DSH_CURL_UNAVAILABLE' })
  }

  const [{ spawn }, { PassThrough, Readable }, zlib] = await Promise.all([
    import('node:child_process'), import('node:stream'), import('node:zlib'),
  ])
  const headers = new Headers(options.headers)
  headers.set('accept-encoding', 'identity')
  const config = [
    'silent', 'no-buffer', 'include', 'http1.1',
    'connect-timeout = 15', 'retry = 0',
    'proto = "=http,https"',
    ...(method === 'GET' ? ['max-time = 25'] : []),
    'request = ' + androidCurlConfigQuote(method),
    'url = ' + androidCurlConfigQuote(url.href),
    ...[...headers].map(([name, value]) =>
      'header = ' + androidCurlConfigQuote(name + ': ' + value)),
    ...(method === 'POST' ? ['data-binary = "@/proc/self/fd/3"'] : []),
  ].join('\n') + '\n'

  const standalone = process.env.DSH_ANDROID_STANDALONE === '1'
  const binary = process.env.DSH_ANDROID_CURL_BINARY
  const command = standalone ? '/system/bin/sh' : binary
  const argv = standalone
    ? [process.env.DSH_ANDROID_EXEC_BRIDGE, binary, '-q', '--config', '-']
    : ['-q', '--config', '-']
  // The native process inherits only the explicit environment, not a
  // per-request proxy override or a shell with the secret in its arguments.
  const child = spawn(command, argv, {
    stdio: ['pipe', 'pipe', 'pipe', ...(method === 'POST' ? ['pipe'] : [])],
    windowsHide: true,
  })
  // Do not log curl stderr: a gateway may print secret-bearing response
  // details or query parameters there.
  child.stderr.resume()
  child.stdin.on('error', () => {})
  if (method === 'POST') child.stdio[3].on('error', () => {})

  return await new Promise((resolve, reject) => {
    let decided = false
    let headerDone = false
    let prefix = Buffer.alloc(0)
    let bytes = 0
    const output = new PassThrough({ highWaterMark: 64 * 1024 })
    output.on('error', () => {})
    const fail = error => {
      if (decided) output.destroy(error)
      else { decided = true; reject(error) }
    }
    const sanitizedFailure = code => Object.assign(
      new Error('Android curl model transport failed'), { code })
    const stop = () => {
      try { child.kill('SIGTERM') } catch {}
    }
    const abort = () => {
      const error = sanitizedFailure('ABORT_ERR')
      stop()
      fail(error)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.once('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) { abort(); return }
      if (code !== 0) {
        fail(sanitizedFailure(
          Number.isInteger(code) ? 'DSH_CURL_EXIT_' + code : 'DSH_CURL_INTERRUPTED'))
      } else if (!headerDone) {
        fail(sanitizedFailure('DSH_CURL_NO_HEADERS'))
      } else {
        output.end()
      }
    })
    child.once('error', error => {
      fail(sanitizedFailure(error?.code === 'ENOENT'
        ? 'DSH_CURL_UNAVAILABLE' : 'DSH_CURL_LAUNCH_FAILED'))
    })
    const sendBody = chunk => {
      if (!chunk?.length) return
      bytes += chunk.length
      if (method === 'GET' && bytes > 2 * 1024 * 1024) {
        stop()
        fail(sanitizedFailure('DSH_CURL_MODEL_LIST_TOO_LARGE'))
        return
      }
      if (!output.write(chunk)) child.stdout.pause()
    }
    output.on('drain', () => child.stdout.resume())
    output.on('close', () => {
      if (!child.killed && !child.exitCode) stop()
    })
    child.stdout.on('data', chunk => {
      if (headerDone) { sendBody(chunk); return }
      if (decided) return
      prefix = Buffer.concat([prefix, chunk])
      if (prefix.length > 64 * 1024) {
        stop()
        fail(sanitizedFailure('DSH_CURL_HEADERS_TOO_LARGE'))
        return
      }
      for (;;) {
        let boundary = prefix.indexOf('\r\n\r\n')
        let skip = 4
        if (boundary < 0) {
          boundary = prefix.indexOf('\n\n')
          skip = 2
        }
        if (boundary < 0) break
        const text = prefix.subarray(0, boundary).toString('latin1')
        const remaining = prefix.subarray(boundary + skip)
        const lines = text.split(/\r?\n/)
        const match = /^HTTP\/[\d.]+\s+(\d{3})(?:\s|$)/i.exec(lines.shift() || '')
        if (!match) {
          stop()
          fail(sanitizedFailure('DSH_CURL_BAD_HTTP_RESPONSE'))
          return
        }
        const status = Number(match[1])
        if (status >= 100 && status < 200) {
          prefix = remaining
          continue
        }
        const responseHeaders = new Headers()
        for (const line of lines) {
          const colon = line.indexOf(':')
          if (colon > 0) responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim())
        }
        const encoding = responseHeaders.get('content-encoding')?.toLowerCase() || ''
        let content = output
        if (encoding && encoding !== 'identity') {
          const decoder = encoding === 'gzip' ? zlib.createGunzip()
            : encoding === 'deflate' ? zlib.createInflate()
            : encoding === 'br' ? zlib.createBrotliDecompress() : null
          if (!decoder) {
            stop(); fail(sanitizedFailure('DSH_CURL_BAD_ENCODING')); return
          }
          decoder.on('error', () => { stop(); fail(sanitizedFailure('DSH_CURL_BAD_ENCODING')) })
          content = output.pipe(decoder)
          responseHeaders.delete('content-encoding')
        }
        responseHeaders.delete('content-length')
        responseHeaders.delete('transfer-encoding')
        headerDone = true
        decided = true
        try {
          if (status === 304) resolve({ status, ok: false, headers: responseHeaders })
          else resolve(new Response(
            [204,205].includes(status) ? null : Readable.toWeb(content),
            { status, headers: responseHeaders },
          ))
        } catch {
          stop()
          fail(sanitizedFailure('DSH_CURL_BAD_STATUS'))
          return
        }
        prefix = Buffer.alloc(0)
        sendBody(remaining)
        return
      }
    })
    child.stdin.end(config)
    if (method === 'POST') {
      const body = options.body
      child.stdio[3].end(typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body))
    }
  })
}
