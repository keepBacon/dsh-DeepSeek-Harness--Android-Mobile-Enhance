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
assert.ok(manager.includes(String.raw`import\s+`),
 'side-effect import dependencies must be included in closure verification')
const patch=manager.slice(manager.indexOf('  @Synchronized fun ensureRuntimePatch('),
 manager.indexOf('  private fun externalStdioLaunchIssue('))
assert.match(patch,/if \(missing\.isEmpty\(\)\)/,
 'do not abort Web Gateway startup when a bundled MCP dependency is unavailable')
assert.match(patch,/Log\.e\(tag, "Skipping unavailable built-in MCP toolboxes:/)
assert.ok(!patch.includes('throw java.io.IOException("内置 MCP'),
 'missing built-in tools must not block unrelated Host and external MCP services')

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
const external=manager.slice(manager.indexOf('  private fun externalStdioLaunch('),
 manager.indexOf('  companion object {'))
assert.match(external,/private fun externalStdioLaunch\(server: McpServerConfig\)/)
assert.match(external,/command\.contains\('\/'\) -> File\(server\.cwd\.ifBlank \{ homeDir\.absolutePath \}, command\)/,
 'relative app-private MCP commands must resolve against their configured cwd')
assert.match(external,/File\(usrDir, "bin\/\$command"\)/,
 'bare Node/Python executables must resolve to the embedded runtime')
assert.match(external,/it\.canonicalFile\.toPath\(\)\.startsWith\(privateRoot\)/,
 'only app-private binaries may be rewritten to Android shell bridge')
assert.match(external,/return "\/system\/bin\/sh" to/,
 'app-private executables must launch through the system shell')
assert.match(external,/listOf\(bridge\.absolutePath, local\.absolutePath\) \+ server\.args/,
 'preserve every stdio argument boundary without shell interpolation')
assert.match(external,/val \(launchCommand, launchArgs\) = externalStdioLaunch\(server\)/)
assert.match(external,/JSONObject\.quote\(launchCommand\)/)
assert.match(external,/JSONArray\(launchArgs\)/)
assert.match(external,/append\("      TERMUX__PREFIX: "\)/,
 'external stdio MCP must inherit the embedded Android runtime')
assert.match(external,/append\("      LD_LIBRARY_PATH: "\)/)
assert.match(external,/append\("      PATH: "\)/)
assert.match(external,/append\("      TMPDIR: "\)/)
assert.match(external,/append\("      SSL_CERT_FILE: "\)/)
assert.match(external,/append\("      NODE_EXTRA_CA_CERTS: "\)/)
assert.match(external,/append\("      GIT_CONFIG_SYSTEM: "\)/)
assert.ok(!external.includes('append("    env: {}\\n")'),
 'external stdio must not launch with missing runtime environment')
assert.match(manager,/embedded Android executable bridge missing/)
assert.match(host,/"DSH_ANDROID_EXEC_BRIDGE"/)
assert.match(host,/"DSH_ANDROID_STANDALONE" to "1"/)
assert.match(mobile,/androidToolLaunch\(toolWrapped\('frida'\),args,process\.env\)/)
assert.match(mobile,/androidToolLaunch\(bin,args,process\.env\)/)
assert.match(mobile,/Frida launch error:/)
console.log('[DSH] Both MCP rows are linker-routed; transitive imports checked')
