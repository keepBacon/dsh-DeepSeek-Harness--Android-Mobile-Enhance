#!/usr/bin/env node
// Regression contracts for DSH 0.2.2 Host stop, MCP degradation and
// overlapping WebView file chooser callbacks. Physical Android smoke pending.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8')
const service=read('app/src/main/java/com/dshmobile/shell/EngineService.kt')
const activity=read('app/src/main/java/com/dshmobile/shell/MainActivity.kt')
const mcp=read('app/src/main/java/com/dshmobile/shell/McpConfigManager.kt')
const slice=(src,start,end)=>{
 const a=src.indexOf(start)
 const b=src.indexOf(end,a+start.length)
 assert.ok(a>=0&&b>a,'missing section: '+start)
 return src.slice(a,b)
}
const stop=slice(service,'    if (intent?.action == ACTION_STOP) {',
 '    if (intent?.action == ACTION_RESTART) {')
assert.match(stop,/val stopped = try \{/)
assert.match(stop,/engineManager\.stopEngine\(\)/)
assert.match(stop,/if \(stopped\) \{[\s\S]*?stopForeground\(STOP_FOREGROUND_REMOVE\)[\s\S]*?stopSelf\(startId\)/,
 'only a verified stop may terminate foreground ownership')
assert.match(stop,/stopFailureVisible = true/)
assert.match(stop,/stopRequested\.set\(false\)/,
 'failed stop must allow an explicit retry and a live watchdog')
assert.match(stop,/armWatchdog\(\)/)
assert.match(service,/stopFailureVisible -> "停止失败/,
 'surface failed stop rather than an incorrect running notification')
const chooser=slice(activity,'      override fun onShowFileChooser(', '      override fun onJsAlert(')
assert.match(chooser,/if \(this@MainActivity\.filePathCallback != null\) \{[\s\S]*?filePathCallback\.onReceiveValue\(null\)[\s\S]*?return true/,
 'reject only the overlapping browser request, preserving the prior callback')
assert.ok(!chooser.includes('this@MainActivity.filePathCallback?.onReceiveValue(null)'),
 'overlapping file chooser must not silently cancel the first request')
const destroy=slice(activity,'  override fun onDestroy() {','  override fun onConfigurationChanged(')
assert.match(destroy,/finishWorkspaceFileChooser\(null\)/)
assert.ok(destroy.indexOf('finishWorkspaceFileChooser(null)') <
 destroy.indexOf('webView.destroy()'))
assert.match(destroy,/pendingExternalChooserAccepts = null/)
const patch=slice(mcp,'  @Synchronized fun ensureRuntimePatch(', '  private fun externalStdioLaunchIssue(')
assert.match(patch,/if \(missing\.isEmpty\(\)\)/)
assert.match(patch,/rows \+= toolboxRow\(\)/)
assert.match(patch,/rows \+= basicToolboxRow\(\)/)
assert.ok(!patch.includes('throw java.io.IOException("内置 MCP'),
 'bundled tooling failure must not abort Host gateway startup')
assert.match(patch,/readServersForRuntime\(root\)\.filter \{ it.enabled \}/,
 'external MCP tools must remain registered when bundled tools are missing')
const external=slice(mcp,'  private fun externalStdioLaunch(', '  private fun serverRow(')
assert.ok(external.includes("command.contains('/') -> File(server.cwd.ifBlank { homeDir.absolutePath }, command)"))
assert.ok(external.includes('it.canonicalFile.toPath().startsWith(privateRoot)'),
 'never route outside app-private binaries through this private-runtime bridge')
console.log('[DSH] 0.2.2 Host stop recovery, nonfatal MCP, relative stdio, and picker lifecycle: OK')
