#!/usr/bin/env node
// Source-contract regression for DSH Android's MCP reconnection generation.
// Run by GitHub Actions; device background/foreground verification remains separate.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../app/src/main/java/com/dshmobile/shell/McpConfigManager.kt',import.meta.url),'utf8')
const method=/private fun (toolboxRow|basicToolboxRow|serverRow)\([^]*?(?=\n  private fun |\n  companion object)/g
const pieces=[...source.matchAll(method)]
assert.equal(pieces.length,3,'all three MCP connection rows must be generated')
for(const [_,name] of pieces){
 const row=pieces.find(m=>m[1]===name)?.[0]
 assert.ok(row,'missing MCP row '+name)
 for(const entry of ['reconnect:','enabled: true','initialDelayMs: 1000','maxDelayMs: 30000','maxAttempts: 1000000']){
  assert.ok(row.includes('append("    '+entry+'\\n")')||row.includes('append("      '+entry+'\\n")'),'missing '+entry+' in '+name)
 }
 assert.ok(row.indexOf('maxAttempts: 1000000')<row.indexOf('toolCallTimeoutMs:'),'reconnect belongs inside config for '+name)
 assert.ok(row.includes('failOnStartupError: false'),'keep non-fatal startup for '+name)
}
assert.equal((source.match(/append\("      maxAttempts: 1000000\\n"\)/g)||[]).length,3)
for (const name of ['toolboxRow','basicToolboxRow']) {
 const row=pieces.find(m=>m[1]===name)?.[0]
 assert.ok(row.includes('command: \\"/system/bin/linker64\\"'),'builtin MCP '+name+' must use Android linker64')
 assert.ok(row.includes('JSONObject.quote(File(usrDir, "bin/node").absolutePath)'),'linker must receive bundled Node as argv[1]')
 assert.ok(row.includes('append(", ").append(JSONObject.quote('),'linker must receive script as argv[2]')
 assert.ok(!row.includes('append("    command: ").append(JSONObject.quote(File(usrDir, "bin/node")'),'must not directly exec app-private Node')
}

assert.ok(source.includes('writeFileAtomically(patchFile, text)'),'MCP config must still be atomically written')
assert.ok(source.includes('externalStdioLaunchIssue(server)'),'do not silently start invalid third-party paths')
console.log('[DSH] MCP long-lived reconnection config source regression: OK (mobile/basic/external)')
