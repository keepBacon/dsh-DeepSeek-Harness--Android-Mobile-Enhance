// Bounded subprocess capture for the Android MCP toolboxes.
//
// A shell/PTY may exit while a grandchild retains its inherited stdout/stderr
// pipe. Waiting only for ChildProcess 'close' can then hang the model tool
// forever, including after the timeout SIGKILL. Observe 'exit' separately and
// unconditionally finish after a bounded drain interval.
import { spawn } from 'node:child_process'

export function boundedSpawn(command, args = [], opts = {}) {
  const started = Date.now()
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30000
  const outputCap = Number.isFinite(opts.maxOutputBytes) && opts.maxOutputBytes > 0
    ? opts.maxOutputBytes : 192 * 1024
  const drainMs = 350

  return new Promise(resolve => {
    let child
    let finished = false
    let timedOut = false
    let truncated = false
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let spawnError = null
    let timer = null
    let drainTimer = null
    let hardStopTimer = null

    function finish(code, signal) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(drainTimer)
      clearTimeout(hardStopTimer)
      // Descendants can retain these pipes after the direct child exits.
      // Destroying them prevents the caller from waiting for EOF forever.
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      resolve({
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        stdout: stdout.toString('utf8'),
        stderr: (spawnError ? String(spawnError) + '\n' : '') + stderr.toString('utf8'),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      })
    }

    try {
      child = spawn(command, args, {
        cwd: opts.cwd || process.cwd(),
        env: opts.env || process.env,
        shell: false,
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
        const next = Buffer.concat([current, bytes.subarray(0, room)])
        if (part === 'stdout') stdout = next
        else stderr = next
      }
    }

    child.stdout?.on('data', chunk => capture('stdout', chunk))
    child.stderr?.on('data', chunk => capture('stderr', chunk))
    child.on('error', error => {
      spawnError = error
      finish(null, null)
    })
    child.on('exit', (code, signal) => {
      // Prefer close to drain buffered output, but do not depend on it.
      drainTimer = setTimeout(() => finish(code, signal), drainMs)
    })
    child.on('close', (code, signal) => finish(code, signal))
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch (error) { spawnError = error }
      // A process in uninterruptible sleep or an inherited pipe can block
      // 'close' indefinitely. The model tool must receive a bounded failure.
      hardStopTimer = setTimeout(() => finish(null, 'SIGKILL'), drainMs)
    }, timeoutMs)
  })
}
