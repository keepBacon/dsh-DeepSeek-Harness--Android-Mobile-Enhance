#!/usr/bin/env node
// Read-only registration contract. The Android linker smoke test exercises
// actual shell/ELF behavior; this test protects the Kotlin-generated MCP YAML.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = p => readFileSync(new URL('../' + p, import.meta.url),'utf8')
const manager = read('app/src/main/java/com/dshmobile/shell/McpConfigManager.kt')
const execBridge = read('scripts/dsh-android-exec.sh')
const host = read('app/src/main/java/com/dshmobile/shell/EngineManager.kt')
const mobile = read('scripts/dsh-mobile-toolbox-mcp.mjs')
assert.match(execBridge,/exec "\$linker" "\$target" "\$@"/)
assert.match(manager,/private fun missingToolboxModules\(\)/)
assert.match(manager,/pending\.add\(toolboxFile\)/)
assert.match(manager,/pending\.add\(basicToolboxFile\)/)
assert.match(manager,/pending\.add\(File\(entry\.parentFile, match\.groupValues\[1\]\)\)/)
assert.match(manager,/if \(!bridge\.isFile\) missing \+= bridge\.name/)
for (const [name,entry] of [['toolboxRow','toolboxFile'],['basicToolboxRow','basicToolboxFile']]) {
 const start=manager.indexOf('private fun '+name+'()')
 const end=manager.indexOf('\n  private fun ',start+20)
 assert.ok(start>=0,name+' generator missing')
 const row=manager.slice(start,end<0?manager.length:end)
 assert.match(row,/JSONObject\.quote\("\/system\/bin\/sh"\)/,name+' must use system shell')
 assert.match(row,/libexec\/dsh-mobile\/android-exec\.sh/,name+' bridge path missing')
 assert.match(row,/File\(usrDir, "bin\/node"\)\.absolutePath/,name+' embedded Node path missing')
 assert.ok(row.includes(entry+'.absolutePath'),name+' script argv missing')
 assert.match(row,/TERMUX__PREFIX/,name+' must export prefix')
}
assert.match(host,/"DSH_ANDROID_EXEC_BRIDGE"/)
assert.match(host,/"DSH_ANDROID_STANDALONE" to "1"/)
assert.match(mobile,/androidToolLaunch\(toolWrapped\('frida'\),args,process\.env\)/)
assert.match(mobile,/androidToolLaunch\(bin,args,process\.env\)/)
assert.match(mobile,/Frida launch error:/)
console.log('[DSH] Both MCP rows are linker-routed; transitive imports checked')
