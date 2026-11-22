import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const engine=readFileSync('app/src/main/java/com/dshmobile/shell/EngineManager.kt','utf8')
const activity=readFileSync('app/src/main/java/com/dshmobile/shell/MainActivity.kt','utf8')
const inspector=readFileSync('app/src/main/java/com/dshmobile/shell/WebViewInspector.kt','utf8')
const workflow=readFileSync('.github/workflows/build-arm64-dsh.yml','utf8')
const pluginSection=engine.slice(engine.indexOf('private fun communityPluginClientWarnings('),
 engine.indexOf('private fun pluginMetadataWarnings('))
assert.ok(pluginSection.includes('fun packagedFile(path: String): File?'), 'plugin package file validation missing')
assert.ok(pluginSection.includes('path.isBlank() || path.startsWith("/") || path.contains'),
 'reject absolute and malformed paths')
assert.ok(pluginSection.includes('it.path.startsWith(rootPath) && it.isFile'),
 'plugin path must be canonical and confined to installed package')
assert.ok(!pluginSection.includes('if (!path.startsWith("./")'),
 'npm main and Cordis patch accept legitimate package-local paths without ./')
assert.ok(pluginSection.includes('clientPaths.none { packagedFile(it) != null }') &&
 pluginSection.includes('packagedFile(bundlePatch)') &&
 pluginSection.includes('packagedFile(main)'),
 'client, bundle and host entries must all use canonical containment')

const handler=activity.slice(activity.indexOf('override fun onConsoleMessage('),
 activity.indexOf('    webView.addJavascriptInterface('))
assert.ok(handler.includes('webViewInspector.recordConsole(consoleMessage)'),
 'keep privacy-safe aggregate error metrics')
assert.ok(!handler.includes('consoleMessage.message()'), 'no raw console content in Logcat')
assert.ok(!handler.includes('consoleMessage.sourceId()'), 'source URLs may contain tokens')
assert.ok(handler.includes('FLAG_DEBUGGABLE'), 'logging must be restricted to debug')

const exportRoute=activity.slice(activity.indexOf('private fun isSessionExport('),
 activity.indexOf('private val exportLaunching'))
assert.ok(exportRoute.includes('Uri.parse(url).path == SESSION_EXPORT_PATH'),
 'export routing must match exact URI path')
assert.ok(!exportRoute.includes('url.contains(SESSION_EXPORT_PATH)'),
 'substring route could match a search query or another endpoint')
// Behavioral contract of Android Uri.path matching: path only, no query.
// Node URL semantics are identical for HTTP(S) path selection.
const target='http://127.0.0.1:3080/api/session.export'
const valid=[target,target+'?id=123']
const invalid=['http://127.0.0.1:3080/api/settings?next=/api/session.export',
 'http://127.0.0.1:3080/api/session.export-extra',
 'http://127.0.0.1:3080/foo/api/session.export',
 'http://127.0.0.1:3080/api/session.exported']
for(const url of valid)assert.equal(new URL(url).pathname,'/api/session.export')
for(const url of invalid)assert.notEqual(new URL(url).pathname,'/api/session.export')

assert.ok(inspector.includes('Inspector request exceeds 1024 bytes'),
 'oversize inspector requests must get explicit reply')
assert.ok(inspector.includes('Inspector request file unavailable'),
 'missing request files must get explicit reply')
assert.ok(!inspector.includes('if (!file.isFile || file.length() > 1024L) return'),
 'no silent inspector timeout when input is oversize')

assert.ok(workflow.includes("github.event_name == 'push' && github.ref == 'refs/heads/main'"),
 'automatic Release must use the actual build branch')
assert.ok(!workflow.includes("github.ref == 'refs/heads/feat/upgrade-dsh-"),
 'do not strand Release job behind stale upgrade branch')
assert.ok(workflow.includes('github.event_name == \'workflow_dispatch\' && inputs.publish_release'),
 'manual Release opt-out must be preserved')
console.log('[DSH] Android plugin paths, Logcat, session export, inspector replies, and Release policy: OK')
