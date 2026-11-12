#!/usr/bin/env node
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const path=new URL('../app/src/main/java/com/dshmobile/shell/McpConfigManager.kt',import.meta.url)
const source=readFileSync(path,'utf8')
const sections=[
  ['mobile_tools',source.slice(source.indexOf('private fun toolboxRow()'),source.indexOf('private fun basicToolboxRow()'))],
  ['basic_tools',source.slice(source.indexOf('private fun basicToolboxRow()'),source.indexOf('private fun serverRow('))],
  ['external',source.slice(source.indexOf('private fun serverRow('),source.indexOf('companion object {',source.indexOf('private fun serverRow(')))]
]
for(const [name,row] of sections){
 assert.match(row,/append\("    startupTimeoutMs: 12000\\n"\)/,name+' missing initial handshake/tools sync limit')
 assert.match(row,/append\("    failOnStartupError: false"\)/,name+' failed MCP server must not fail the entire Host')
 assert.ok(row.indexOf('startupTimeoutMs: 12000')<row.indexOf('failOnStartupError: false'),name+' malformed YAML generation')
 assert.match(row,/toolCallTimeoutMs:/,name+' independent per-tool deadline must remain')
}
assert.equal((source.match(/startupTimeoutMs: 12000/g)||[]).length,3)
console.log('[DSH] built-in and external MCP initial handshakes bounded (12s), reconnect still enabled')
