import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source=readFileSync('app/src/main/java/com/dshmobile/shell/WebViewInspector.kt','utf8')
const script=source.slice(source.indexOf('private val SCRIPT ='),source.indexOf('""".trimIndent()',source.indexOf('private val SCRIPT =')))
assert.ok(script.includes('modelDiscovery:modelDiscovery'), 'safe model discovery diagnostic missing')
for(const state of ['buttonPresent:','buttonDisabled:','buttonVisible:','askingProvider:','pickerOpen:'])
 assert.ok(script.includes(state),'missing model UI state: '+state)
for(const label of ['获取可用模型','Fetch available models','利用可能なモデルを取得',
 '正在询问提供商…','Asking the provider…','选择模型','Choose models'])
 assert.ok(script.includes(label),'upstream locale missing: '+label)
assert.ok(!script.includes('.value'),'inspector must not read field values')
assert.ok(!script.includes('localStorage'),'inspector must not read browser storage')
assert.ok(!script.includes('cookie'),'inspector must not access cookies')
assert.ok(!script.includes('apiKey'),'inspector must not access API credentials')
assert.ok(!script.includes('JSON.stringify(modelFetchButton)'),'inspector must only expose whitelisted scalar booleans')
console.log('[DSH] Read-only model discovery UI telemetry (no credentials or labels exported): OK')
