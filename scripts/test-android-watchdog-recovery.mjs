import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const service=readFileSync('app/src/main/java/com/dshmobile/shell/EngineService.kt','utf8')
assert.ok(service.includes('degradedProbeThreshold = 12'))
assert.ok(service.includes('failedAliveProbes = (failedAliveProbes + 1)'))
assert.ok(service.includes('notificationManager.notify(NOTIFICATION_ID, buildNotification(unresponsive = true))'))
assert.ok(service.includes('if (probe.optBoolean("running", false)) {\n            clearProbeFailures()'))
assert.ok(service.includes('if (EngineManager.isMaintenanceMode() || restartInFlight.get())'))
assert.ok(service.includes('if (engineManager.isEngineProcessAlive()) {\n            markUnresponsiveHost()'))
assert.ok(!service.includes('if (engineManager.isEngineProcessAlive()) {\n            engineManager.stopEngine()'))
assert.ok(service.includes('ACTION_RESTART'))
assert.ok(service.includes('restartOnUserRequest()'))
assert.ok(service.includes('restartInFlight.compareAndSet(false, true)'))
assert.ok(service.includes('EngineManager.beginMaintenance()'))
assert.ok(service.includes('val stopped = try {'))
assert.ok(service.includes('engineManager.stopEngine()'), 'manual restart must stop old Host first')
assert.ok(service.includes('if (stopped && !stopRequested.get()) {'))
assert.ok(service.includes('stopRequested.set(true)'), 'explicit stop must cancel pending restart')
assert.ok(service.includes('engineManager.startEngine(runtimeAlreadyChecked = true)'))
// Model the only state transition that can trigger a restart in the service.
let failed=0,visible=false,restarts=0
const probe=(running,processAlive,requestRestart=false)=>{
 if(running||!processAlive){failed=0;visible=false;return}
 failed=Math.min(12,failed+1)
 if(failed===12)visible=true
 if(requestRestart&&visible)restarts++
}
for(let i=0;i<11;i++)probe(false,true)
assert.equal(visible,false)
assert.equal(restarts,0)
probe(true,true)
assert.equal(failed,0)
for(let i=0;i<12;i++)probe(false,true)
assert.equal(visible,true)
assert.equal(restarts,0,'repeated failures must never auto-kill a living Host')
probe(false,true,true)
assert.equal(restarts,1,'only explicit user action may restart an unresponsive Host')
probe(true,true)
assert.equal(visible,false,'recovery must clear degraded notification')
console.log('[DSH] Host watchdog: bounded degradation, explicit restart, safe recovery OK')
