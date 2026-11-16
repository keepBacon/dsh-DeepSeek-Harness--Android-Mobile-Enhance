// Shared bounded child-process lifecycle for Android DSH MCP and code tools.
// Controls the process group on timeout/cancel, not just the direct child.
// No shell interpolation; argv boundaries are preserved.
import { spawn } from 'node:child_process'

export function boundedSpawn(command, args = [], opts = {}) {
  const started = Date.now()
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30000
  const outputCap = Number.isFinite(opts.maxOutputBytes) && opts.maxOutputBytes > 0
    ? opts.maxOutputBytes : 192 * 1024
  const drainMs = 350

  return new Promise(resolve => {
    let child, finished = false, timedOut = false, cancelled = false, truncated = false
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), spawnError = null
    let timer = null, drainTimer = null, hardStopTimer = null
    const grouped = opts.killTree !== false && process.platform !== 'win32'
    const signal = opts.signal
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(drainTimer)
      clearTimeout(hardStopTimer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    function finish(code, sig) {
      if (finished) return
      finished = true
      cleanup()
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      resolve({
        exitCode: typeof code === 'number' ? code : null,
        signal: sig || null,
        stdout: stdout.toString('utf8'),
        stderr: (spawnError ? String(spawnError) + '\n' : '') + stderr.toString('utf8'),
        timedOut, cancelled, truncated,
        durationMs: Date.now() - started,
      })
    }
    function killChild() {
      if (!child || !child.pid) return
      // detached:true creates a separate process group on POSIX, including
      // the compiler/linker descendants. A process may leave its group; the
      // tool never claims to kill arbitrary re-parented daemons.
      if (grouped) {
        try { process.kill(-child.pid, 'SIGKILL'); return } catch {}
      }
      try { child.kill('SIGKILL') } catch (error) { spawnError = error }
    }
    function interrupt(kind) {
      if (finished) return
      if (kind === 'timeout') timedOut = true
      else cancelled = true
      killChild()
      if (!hardStopTimer) hardStopTimer = setTimeout(() => finish(null, 'SIGKILL'), drainMs)
    }
    function onAbort() { interrupt('cancel') }
    if (signal?.aborted) {
      cancelled = true
      finish(null, 'SIGKILL')
      return
    }
    try {
      child = spawn(command, args, {
        cwd: opts.cwd || process.cwd(),
        env: opts.env || process.env,
        shell: false,
        detached: grouped,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      spawnError = error
      finish(null, null)
      return
    }
    function capture(part, chunk) {
      const current = part === 'stdout' ? stdout : stderr
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const room = Math.max(0, outputCap - current.length)
      if (bytes.length > room) truncated = true
      if (room > 0) {
        const slice = bytes.subarray(0, room)
        const next = Buffer.concat([current, slice])
        if (part === 'stdout') stdout = next
        else stderr = next
      }
      try { opts.onData?.(part, bytes.subarray(0, Math.max(0,room))) } catch {}
    }
    child.stdout?.on('data', chunk => capture('stdout', chunk))
    child.stderr?.on('data', chunk => capture('stderr', chunk))
    child.on('error', error => {
      spawnError = error
      finish(null, null)
    })
    child.on('exit', (code, sig) => {
      drainTimer = setTimeout(() => finish(code, sig), drainMs)
    })
    child.on('close', (code, sig) => finish(code, sig))
    timer = setTimeout(() => interrupt('timeout'), timeoutMs)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
