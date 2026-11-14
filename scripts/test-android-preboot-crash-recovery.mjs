#!/usr/bin/env node
// Crash-loop regression: a failed normal-Web diagnostic must recover without
// rewriting installed plugins, the user's Web profile, sessions or credentials.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const state = read('app/src/main/java/com/dshmobile/shell/ShellState.kt')
const main = read('app/src/main/java/com/dshmobile/shell/MainActivity.kt')
const engine = read('app/src/main/java/com/dshmobile/shell/EngineManager.kt')
const service = read('app/src/main/java/com/dshmobile/shell/EngineService.kt')
const trial = state.slice(state.indexOf('  fun setNormalPrebootCompatDiagnosticEnabled('), state.indexOf('  /**\n   * Stable private token'))

assert.match(state, /TRIAL_READY = 1/)
assert.match(state, /TRIAL_STARTED = 2/)
assert.match(trial, /putInt\(PREBOOT_TRIAL_PHASE, if \(enabled\) TRIAL_READY else TRIAL_NOT_ARMED\)/)
assert.match(trial, /putInt\(PREBOOT_TRIAL_PHASE, TRIAL_STARTED\)\.commit\(\)/)
assert.match(trial, /trialStartedInThisProcess\.get\(\)/)
assert.match(trial, /TRIAL_READY -> false/)
assert.match(trial, /TRIAL_STARTED -> recoverFailedPrebootTrial\(context, "interrupted-after-trial-start"\)/)
assert.match(trial, /else -> recoverFailedPrebootTrial\(context, "legacy-unguarded-trial"\)/)
assert.match(trial, /putBoolean\(OFFICIAL_ONLY_DIAGNOSTIC, true\)/)
assert.match(trial, /putBoolean\(NORMAL_PREBOOT_COMPAT_DIAGNOSTIC, false\)/)
assert.match(trial, /putBoolean\(NORMAL_MCP_DIAGNOSTIC, false\)/)
assert.match(trial, /putBoolean\(SAFE_MODE, false\)/)
assert.match(trial, /saveInterruptedTrialDiagnostics\(context\)/)
assert.match(trial, /RandomAccessFile\(file, "r"\)/)
assert.match(trial, /"preboot-trial-last-engine.log"/)
assert.match(trial, /"preboot-trial-last-stage.txt"/)
for (const word of ['deleteRecursively(', 'removePlugin(', 'backupAndResetProfilePatch(', 'profiles/web/package.json', 'sessions/']) {
  assert.ok(!trial.includes(word), 'no destructive user-profile mutation: ' + word)
}
const onCreate = main.slice(main.indexOf('  override fun onCreate('),main.indexOf('  override fun onNewIntent('))
const serviceCreate = service.slice(service.indexOf('  override fun onCreate('), service.indexOf('  override fun onStartCommand('))
assert.ok(onCreate.indexOf('ShellState.recoverInterruptedPrebootTrial(this)') < onCreate.indexOf('startEngineFlow()'))
assert.ok(serviceCreate.indexOf('ShellState.recoverInterruptedPrebootTrial(this)') < serviceCreate.indexOf('armWatchdog()'))
const start = engine.slice(engine.indexOf('  fun startEngine('), engine.indexOf('  /** Preserve an actionable reason'))
assert.ok(start.indexOf('ShellState.beginPrebootTrial(context)') < start.indexOf('recordBootStage(if (safeMode)'))
assert.match(engine, /Previous Web trial auto-recovery: /)
const toggle = main.slice(main.indexOf('  private fun switchNormalPrebootCompatDiagnostic('),main.indexOf('  private fun switchRecoverySafeMode('))
assert.match(toggle, /ShellState.recoverFailedPrebootTrial\(this, "gateway-unavailable"\)/)
assert.ok(toggle.indexOf('engineManager.recordGatewayStartupTimeout()') < toggle.indexOf('ShellState.recoverFailedPrebootTrial(this, "gateway-unavailable")'))
console.log('[DSH] interrupted diagnostic rolls back to original-data official-only mode: OK')
