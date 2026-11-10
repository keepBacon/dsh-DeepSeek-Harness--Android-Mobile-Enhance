#!/usr/bin/env node
// Safeguard the Android Host stop/restart contract; real signal handling is
// verified on-device because Java/Android Process is unavailable in Node CI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = p => readFileSync(new URL('../'+p,import.meta.url),'utf8')
const manager = source('app/src/main/java/com/dshmobile/shell/EngineManager.kt')
const activity = source('app/src/main/java/com/dshmobile/shell/MainActivity.kt')
const service = source('app/src/main/java/com/dshmobile/shell/EngineService.kt')
const extract = (src,a,b) => {
  const start=src.indexOf(a); assert.ok(start>=0,'missing '+a)
  const end=src.indexOf(b,start+a.length); assert.ok(end>start,'missing '+b)
  return src.slice(start,end)
}
const stop=extract(manager,'  fun stopEngine(','\n\n  companion object {')
assert.match(stop,/synchronized\(PROCESS_LIFECYCLE_LOCK\)/)
assert.match(stop,/STOP_GENERATION\.incrementAndGet\(\)/)
assert.match(stop,/process\.destroy\(\)/)
assert.match(stop,/process\.destroyForcibly\(\)/)
assert.match(stop,/if \(process\.isAlive\)/)
assert.match(stop,/ACTIVE_PROCESS\.compareAndSet\(process, null\)/)
assert.ok(!stop.includes('ACTIVE_PROCESS.getAndSet(null)'), 'never discard a live Host handle')
assert.ok(!stop.includes('engineProcess = null\n    val shared'), 'never clear handle before waiting')
const launch=extract(manager,'  fun startEngine(','  /** Preserve an actionable reason')
assert.match(launch,/val stopGeneration = STOP_GENERATION\.get\(\)/)
assert.match(launch,/synchronized\(PROCESS_LIFECYCLE_LOCK\)/)
assert.match(launch,/if \(stopGeneration != STOP_GENERATION\.get\(\)\)/)
assert.match(launch,/if \(previous\?\.isAlive == true\)/)
assert.ok(launch.indexOf('engineLogFile.writeText("")')>launch.indexOf('if (stopGeneration != STOP_GENERATION.get())'))
const runtime=extract(manager,'  fun clearBrokenRuntime()','  /**\n   * Token-bearing')
assert.match(runtime,/if \(isEngineProcessAlive\(\)\)/)
assert.ok(runtime.indexOf('if (isEngineProcessAlive())')<runtime.indexOf('runtimeIdMarker.delete()'))
const recovery=extract(activity,'  private fun startEngineFlow(','  /**\n   * Wait for the verified DSH HTTP listener')
assert.match(recovery,/if \(!engineManager\.stopEngine\(\)\) \{[\s\S]*?已取消自动运行时修复/)
const manual=extract(activity,'  private fun repairRuntimeFlow()','  /** Show the actual runtime')
assert.match(manual,/if \(!engineManager\.stopEngine\(\)\) \{/)
assert.match(manual,/if \(safeToRestart\) runOnUiThread \{ startEngineFlow\(\) \}/)
assert.match(service,/EngineManager\.isMaintenanceMode\(\)/)
console.log('[DSH] engine shutdown: preserve live handles, cancel stale launches, protect runtime files OK')
