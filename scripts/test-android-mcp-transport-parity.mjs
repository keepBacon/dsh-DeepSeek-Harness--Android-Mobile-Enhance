#!/usr/bin/env node
/**
 * Regression for the Android-managed MCP transport configuration boundary.
 * This checks source contracts, not a fabricated MCP result. Published DSH
 * MCP Client behavior is verified by the real upstream runtime-family gate;
 * Android app-UID end-to-end transport testing remains a separate gate.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
const manager = source('app/src/main/java/com/dshmobile/shell/McpConfigManager.kt')
const secrets = source('app/src/main/java/com/dshmobile/shell/SecureCredentialStore.kt')
const activity = source('app/src/main/java/com/dshmobile/shell/MainActivity.kt')
const host = source('app/src/main/java/com/dshmobile/shell/EngineManager.kt')

for (const key of ['envKeys', 'headerKeys']) {
  assert.match(manager, new RegExp('val ' + key + ': List<String>'))
  assert.match(manager, new RegExp('readSecretKeys\\(obj, "' + key + '"\\)'))
  assert.match(manager, new RegExp('JSONArray\\(server\\.' + key + '\\)'))
}
assert.match(secrets, /fun saveMcpField\(/)
assert.match(secrets, /fun mcpField\(/)
assert.match(secrets, /fun clearMcpFields\(/)
assert.match(secrets, /putString\(mcpFieldKey\(id, kind, name\), encrypt\(value\)\)/)
assert.match(host, /SecureCredentialStore\.saveMcpField\(context, server\.id, "env"/)
assert.match(host, /SecureCredentialStore\.saveMcpField\(context, server\.id, "header"/)
assert.match(host, /SecureCredentialStore\.clearMcpFields\(context, id\)/)

const extraSecretRows = manager.slice(manager.indexOf('private fun serverRow('),
  manager.indexOf('companion object {', manager.indexOf('private fun serverRow(')))
assert.match(extraSecretRows, /for \(key in server\.envKeys\)/)
assert.match(extraSecretRows, /for \(key in server\.headerKeys\)/)
assert.match(extraSecretRows, /fieldEnvName\(server\.id, "env", key\)/)
assert.match(extraSecretRows, /fieldEnvName\(server\.id, "header", key\)/)
assert.ok(!extraSecretRows.includes('mcpField(context,'),
  'decrypted secret values must not be interpolated into the persisted YAML patch')
assert.match(manager, /Bearer credential missing in Android Keystore/)
assert.match(manager, /HTTP header credential missing/)
assert.match(manager, /environment credential missing/)
assert.match(activity, /parseExtras\(env, '='\)/)
assert.match(activity, /parseExtras\(headers, ':'\)/)
assert.match(activity, /engineManager\.saveMcpServer\(server, bearerToken, envValues, headerValues\)/)
assert.match(host, /env\.putAll\(mcpConfigManager\.secretEnvironment\(\)\)/)
console.log('[DSH] Android MCP env and HTTP header secrets: configuration/Keystore/patch contract OK')
