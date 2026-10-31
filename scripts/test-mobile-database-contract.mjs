#!/usr/bin/env node
// DSH Android database integration regression (source contract only).
// A successful result does not replace Android SQLite / WebView device tests.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const db=read('app/src/main/java/com/dshmobile/shell/database/MobileDatabase.kt');
const index=read('app/src/main/java/com/dshmobile/shell/database/MobileIndexService.kt');
const backup=read('app/src/main/java/com/dshmobile/shell/database/DatabaseBackup.kt');
const bridge=read('app/src/main/java/com/dshmobile/shell/AndroidBridge.kt');
const activity=read('app/src/main/java/com/dshmobile/shell/MainActivity.kt');
const engine=read('app/src/main/java/com/dshmobile/shell/EngineManager.kt');
const monitor=read('app/src/main/assets/dsh-tool-call-monitor.js');
const basicTools=read('scripts/dsh-basic-toolbox-mcp.mjs');
const nativeBuild=read('scripts/ci-assemble-github-runtime.py');
assert.match(basicTools,/function archiveBinary\(\)/);
assert.match(basicTools,/bin\/7zz/);
assert.match(basicTools,/function fileMagicEnv\(\)/);
assert.match(basicTools,/env:opts\.env\|\|process\.env/);
assert.match(nativeBuild,/"gzip"/);
assert.match(nativeBuild,/file is packaged without the magic\.mgc database/);
assert.match(nativeBuild,/standalone archive codec 7zz missing/);
const runtimePatch=read('scripts/android-runtime-patch.mjs');
assert.match(runtimePatch,/patchPtcMcpStartupBarrier/);
assert.match(runtimePatch,/MCP tool binding not registered/);
assert.match(runtimePatch,/Date\.now\(\) \+ 4000/);
assert.match(runtimePatch,/runController\.signal\.throwIfAborted/);
assert.match(runtimePatch,/tools\.schemas\(exec\.agent, exec\.toolSet\)/);

const classifier=read('app/src/main/java/com/dshmobile/shell/database/ToolErrorClassifier.kt');
const dispatcher=read('app/src/main/java/com/dshmobile/shell/database/ToolObservationDispatcher.kt');
execFileSync(process.execPath,['--check',new URL('../app/src/main/assets/dsh-tool-call-monitor.js',import.meta.url).pathname]);
for(const table of ['registry_snapshots','registry_entries','tool_observations','extension_inventory','session_index','audit_events']){
 assert.ok(db.includes('CREATE TABLE '+table),'missing database table '+table);
}
assert.match(db,/setWriteAheadLoggingEnabled\(true\)/);
assert.match(db,/setForeignKeyConstraintsEnabled\(true\)/);
assert.match(db,/if \(existingId >= 0\) return existingId/);
assert.match(db,/ORDER BY first_seen DESC/);
assert.match(db,/OFFSET 10000/);
assert.match(db,/event_key=\? AND status='running'/);
assert.match(db,/digest\(item\.sessionKey/);
assert.match(db,/fun observeBatch\(batch: List<ToolObservation>\)/);
assert.match(db,/batch\.size <= 128/);
assert.match(db,/if \(inserted != -1L\) insertedRows\+\+/);
assert.match(db,/if \(insertedRows > 0 && observations \+ insertedRows >= RETENTION_INTERVAL\)/);
assert.match(db,/observations = if \(trimmed\) 0 else observations \+ insertedRows/);
assert.match(dispatcher,/runCatching \{ onError\(error\) \}/);
assert.match(dispatcher,/worker\.shutdown\(\)/);
assert.match(dispatcher,/private const val BATCH_SIZE = 64/);
assert.match(backup,/VACUUM INTO/);
assert.match(backup,/SELECT sqlite_version\(\)/);
assert.match(backup,/PRAGMA wal_checkpoint\(TRUNCATE\)/);
assert.match(backup,/store\.close\(\)/);
assert.match(backup,/WAL is not empty after checkpoint/);
assert.match(backup,/PRAGMA integrity_check/);
assert.match(index,/SELECT relative_path, modified_at, byte_size FROM session_index/);
assert.match(index,/if \(previous != null && previous\.first == modified && previous\.second == bytes\) continue/);
assert.match(index,/batch\.size < 400/);
assert.match(index,/previousExtensions\.keys\.asSequence\(\)/);
assert.match(db,/private val HEX =/);
assert.match(db,/CharArray\(bytes\.size \* 2\)/);
assert.match(index,/if \(sessions\.second && staleSessions\.isNotEmpty\(\)\)/);
assert.match(index,/complete = false\s+continue/);
assert.equal((bridge.match(/fun recordToolObservation\(/g)||[]).length,1,'duplicate Android bridge method');
assert.equal((bridge.match(/private val onRecordToolObservation:/g)||[]).length,1,'duplicate callback');
assert.match(activity,/onRecordToolObservation =/);
assert.match(activity,/databaseWriter\.offer/);
assert.match(activity,/databaseWriter\.close\(\)/);
assert.match(activity,/DatabaseBackup\.create/);
const sessionRecovery=read('app/src/main/assets/dsh-session-ui-recovery.js');
assert.match(sessionRecovery,/api\/session\/list/);
assert.match(sessionRecovery,/reportSessionUiMismatch/);
assert.match(sessionRecovery,/setInterval\(verify, 30000\)/);
assert.match(sessionRecovery,/state\.consecutive < 2/);
assert.match(sessionRecovery,/new URL\('\/api\/session\/list', location\.origin\)/);
assert.match(activity,/handleSessionUiMismatch\(count\)/);
assert.match(activity,/sessionUiRecoveryAttempts >= 2/);
assert.match(activity,/now - lastSessionUiRecoveryAt < 120_000L/);
assert.match(activity,/webView\.reload\(\)/);
assert.match(bridge,/fun reportSessionUiMismatch\(/);
assert.match(activity,/probeHostSessionsReadOnly\(\)/);
assert.match(activity,/request\.isForMainFrame/);
assert.match(activity,/首次失败（回滚前）/);
assert.match(activity,/rollbackOnBootFailure == null/);
assert.match(activity,/旧 DSH 进程未能完全退出/);
assert.ok(!activity.includes('override fun onReceivedError(view: WebView, errorCode: Int'),
  'legacy WebView error callback must not restart on subresource failure');
assert.match(activity,/reportHostSessionDiagnostic/);
assert.match(bridge,/fun reportHostSessionDiagnostic\(/);
assert.match(engine,/Preserved migration rollback generation/);
assert.match(engine,/无法完整读取源目录，禁止继续迁移/);

assert.match(activity,/MobileIndexService\(engineManager, db\)\.refresh/);
assert.match(activity,/script\.replace\(marker, "const MONITOR_CAP = "/);
assert.match(monitor,/\/\*__DSH_MONITOR_CAP__\*\//);
assert.match(monitor,/bridge\.recordToolObservation\(/);
assert.match(monitor,/old\.status !== status/);
assert.match(monitor,/pendingCalls = new Set\(\)/);
assert.match(monitor,/if \(queued\) return/);
assert.match(monitor,/scanTimer = setTimeout/);
assert.match(monitor,/\.slice\(-MAX_ROWS\)/);
assert.match(monitor,/observeDom\(scanAll \? null : work\)/);
assert.match(monitor,/if \(changed\) draw\(\)/);
assert.match(monitor,/target\?\.closest\('#dsh-pcm-panel,#dsh-pcm-pill'\)/);
assert.ok(!monitor.includes("requestAnimationFrame(()=>{queued=false;mount();observeDom();draw();})"),
  'full rescans per animation frame must never return');
assert.match(classifier,/MCP_SCHEMA_REQUIRED/);
for(const forbidden of [/fetch\(/,/XMLHttpRequest/,/sendBeacon/,/localStorage/,/sessionStorage/]){
 assert.ok(!forbidden.test(monitor),'monitor unexpectedly uses a network/storage API: '+forbidden);
}
// Tool settings must expose more than the MCP editor alone.
assert.match(activity,/private fun showExtendedToolManager\(\)/);
assert.match(activity,/private fun showToolCatalogSection\(/);
assert.match(activity,/showExtendedToolManager\(\)/);
for(const key of ['protocolTools','reverseTools','cliProtocol','cliReverse','basicTools','otherMobileTools']){
 assert.ok(engine.includes('.put("'+key+'",'),'tool catalog missing '+key);
 assert.ok(activity.includes('"'+key+'"'),'tool manager section missing '+key);
}
assert.match(engine,/JSONObject\(mobileToolCatalogJson\(\)\)/);
assert.match(engine,/declaredTools\("toolbox-mcp\.mjs"/);
assert.match(engine,/declaredTools\("basic-toolbox-mcp\.mjs"/);
const mcpConfig=read('app/src/main/java/com/dshmobile/shell/McpConfigManager.kt');
assert.match(mcpConfig,/externalStdioLaunchIssue\(server\)/);
assert.match(mcpConfig,/File\(path\)\.isFile/);
assert.match(mcpConfig,/Skipping unavailable MCP/);
assert.match(mcpConfig,/fun unavailableExternalServers\(/);
assert.match(activity,/engineManager\.runMobileToolRequest\("terminal"/);
console.log('[DSH] Database integration source-contract regression: OK');
