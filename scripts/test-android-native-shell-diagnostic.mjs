#!/usr/bin/env node
// The user-visible native diagnostic must work when the model Shell is down,
// must not depend on API keys or profiles, and must bound each subprocess.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const manager = read('app/src/main/java/com/dshmobile/shell/EngineManager.kt')
const activity = read('app/src/main/java/com/dshmobile/shell/MainActivity.kt')
const diag = manager.slice(manager.indexOf('  fun nativeShellDiagnostics(): String {'), manager.indexOf('  /** Last useful engine diagnostics', manager.indexOf('  fun nativeShellDiagnostics(): String {')))
assert.ok(diag.length > 2000, 'diagnostic implementation must exist')
assert.match(diag, /ProcessBuilder\(argv\)/)
assert.match(diag, /waitFor\(4500, TimeUnit\.MILLISECONDS\)/)
assert.match(diag, /destroyForcibly\(\)/)
assert.match(diag, /reader\.isDaemon = true/)
for (const stage of ['01 system-sh', '02 linker-bash', '03 sandbox-bash', '04 node-child-sandbox']) assert.ok(diag.includes(stage), 'missing '+stage)
assert.match(diag, /"\/system\/bin\/sh", bridge, bash/)
assert.match(diag, /"\/system\/bin\/sh", sandbox, "read-only"/)
assert.match(diag, /const \{ spawn \} = require\('node:child_process'\)/)
assert.match(diag, /nodeDetachedProbe = nodeSubprocessProbe/)
assert.match(diag, /detached:true,stdio:/)
assert.match(diag, /05 node-detached-sandbox/)
assert.ok(!diag.includes('engineManager.stopEngine()'))
assert.ok(!diag.includes('backupAndResetProfilePatch('))
assert.ok(!diag.includes('deleteRecursively('))
assert.match(activity, /Shell 启动链路自检（只读，不依赖模型）/)
assert.match(activity, /engineManager\.nativeShellDiagnostics\(\)/)
assert.match(activity, /ClipData\.newPlainText\("DSH shell diagnostic", report\)/)
console.log('[DSH] native Shell stage diagnostic is read-only, bounded and available without model Shell: OK')
