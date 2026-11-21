#!/usr/bin/env node
// Guard against blocking the Android service main thread during Host lifecycle
// operations; device instrumentation remains necessary for ANR verification.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const service = readFileSync(new URL('../app/src/main/java/com/dshmobile/shell/EngineService.kt', import.meta.url), 'utf8')
function between(start, end) {
  const a = service.indexOf(start)
  const b = service.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, 'missing EngineService section: ' + start)
  return service.slice(a, b)
}
const onStart = between('  override fun onStartCommand(', '  override fun onBind(')
const stop = between('    if (intent?.action == ACTION_STOP) {', '    if (intent?.action == ACTION_RESTART) {')
const ensure = between('  private fun ensureEngine() {', '  /**\n   * Always arm the watchdog')
const watchdog = between('  private fun armWatchdog() {', '  private fun buildNotification(')
assert.ok(stop.includes('stopRequested.set(true)'))
assert.ok(stop.includes('lifecycleExecutor.execute {'))
assert.ok(stop.indexOf('lifecycleExecutor.execute {') < stop.indexOf('engineManager.stopEngine()'),
  'stopEngine must execute on a worker, not the service main thread')
assert.ok(stop.includes('Handler(android.os.Looper.getMainLooper()).post'))
assert.ok(stop.includes('if (stopRequested.get())'))
assert.ok(stop.includes('stopSelf(startId)'),
  'an older stop must not terminate service ownership from a later START')
assert.ok(!onStart.includes('engineManager.stopEngine()\n      stopForeground'),
  'synchronous shutdown on the service main thread is forbidden')
assert.ok(ensure.includes('lifecycleGeneration.get() != generation'))
assert.ok(ensure.includes('lifecycleExecutor.execute {'))
assert.ok(ensure.indexOf('lifecycleExecutor.execute {') < ensure.indexOf('EngineProbe.check(350)'),
  'localhost health probes must run in a worker')
assert.ok(ensure.indexOf('lifecycleExecutor.execute {') < ensure.indexOf('engineManager.startEngine('),
  'cold Host startup must run in a worker')
assert.ok(ensure.includes('lifecycleGeneration.get() == generation'))
assert.ok(ensure.includes('stopRequested.get()'))
assert.ok(watchdog.includes('generation != lifecycleGeneration.get()'))
assert.ok(watchdog.includes('lifecycleExecutor.execute {'),
  'watchdog must re-check Stop before launching a new Host')
const restart = between('  private fun restartOnUserRequest(', '  override fun onCreate()')
assert.ok(restart.includes('lifecycleExecutor.execute {'))
assert.ok(restart.includes('lifecycleGeneration.get() != generation'))
assert.ok(service.includes('lifecycleGeneration.incrementAndGet()'))
assert.ok(service.includes('if (stopRequested.get() && lifecycleGeneration.get() == generation)'))
assert.ok(service.includes('lifecycleExecutor.shutdown()'))
console.log('[DSH] serialized Host lifecycle / stale generation / off-main-thread operations OK')
