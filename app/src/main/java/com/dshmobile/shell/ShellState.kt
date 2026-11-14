package com.dshmobile.shell

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** Small process-independent shell state shared by Activity and foreground service. */
object ShellState {
  private const val PREFS = "dsh-shell"
  private const val PICK_TOKEN = "pick-token"
  private const val LAST_WORKSPACE_PATH = "last-workspace-path"
  private const val INTERFACE_MODE = "interface-mode"
  private const val SAFE_MODE = "safe-mode"
  private const val NORMAL_MCP_DIAGNOSTIC = "normal-mcp-diagnostic-disabled"
  private const val OFFICIAL_ONLY_DIAGNOSTIC = "official-only-diagnostic-web"
  private const val NORMAL_PREBOOT_COMPAT_DIAGNOSTIC = "normal-preboot-compat-diagnostic-disabled"
  private const val PREBOOT_TRIAL_PHASE = "normal-preboot-trial-phase"
  private const val PREBOOT_TRIAL_RECOVERY = "normal-preboot-trial-last-recovery"
  private const val TRIAL_NOT_ARMED = 0
  private const val TRIAL_READY = 1
  private const val TRIAL_STARTED = 2
  private val trialStartedInThisProcess = AtomicBoolean(false)

  const val UI_MODE_MOBILE = "mobile"
  const val UI_MODE_NATIVE = "native"

  /** Last real filesystem workspace picked through the Android directory flow. */
  fun lastWorkspacePath(context: Context): String? {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(LAST_WORKSPACE_PATH, null)
      ?.takeIf { it.startsWith("/") }
  }

  /** Remember only absolute filesystem paths; opaque SAF URIs are not writable by the embedded shell. */
  fun rememberWorkspacePath(context: Context, path: String) {
    if (!path.startsWith("/")) return
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(LAST_WORKSPACE_PATH, path)
      .apply()
  }


  /** Persistent Android shell layout choice. */
  fun interfaceMode(context: Context): String {
    val value = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(INTERFACE_MODE, UI_MODE_MOBILE)
    return if (value == UI_MODE_NATIVE) UI_MODE_NATIVE else UI_MODE_MOBILE
  }

  fun setInterfaceMode(context: Context, mode: String) {
    val normalized = if (mode == UI_MODE_NATIVE) UI_MODE_NATIVE else UI_MODE_MOBILE
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(INTERFACE_MODE, normalized)
      .apply()
  }

  /** Safe mode is a persisted Host launch choice, never a plugin manifest mutation. */
  fun safeModeEnabled(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(SAFE_MODE, false)

  /** Synchronous commit: the foreground service may relaunch the Host immediately. */
  fun setSafeModeEnabled(context: Context, enabled: Boolean): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(SAFE_MODE, enabled).commit()

  /** Diagnostic launch preference. Changes only Android-managed MCP overlay,
   * never the user\'s persisted server definitions or plugin manifests.
   * Synchronous commit survives the system force-stop needed for a stuck Host. */
  fun normalMcpDiagnosticEnabled(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(NORMAL_MCP_DIAGNOSTIC, false)

  fun setNormalMcpDiagnosticEnabled(context: Context, enabled: Boolean): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(NORMAL_MCP_DIAGNOSTIC, enabled).commit()

  /** Use the actual DSH_HOME with an app-owned official-bundles-only profile.
   * This never changes the user's normal web profile or its patch. */
  fun officialOnlyDiagnosticEnabled(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(OFFICIAL_ONLY_DIAGNOSTIC, false)

  fun setOfficialOnlyDiagnosticEnabled(context: Context, enabled: Boolean): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(OFFICIAL_ONLY_DIAGNOSTIC, enabled).commit()

  /** One-launch normal-Web comparison: keep every installed bundle and MCP,
   * but skip Android's optional preboot plugin compatibility rewrites. */
  fun normalPrebootCompatDiagnosticEnabled(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(NORMAL_PREBOOT_COMPAT_DIAGNOSTIC, false)

  /**
   * Mark the *next* launch as the sole comparison attempt. An upgraded APK may
   * encounter an enabled flag from the older unguarded release (phase 0); that
   * legacy flag is recovered to official-only at process entry.
   */
  @Synchronized
  fun setNormalPrebootCompatDiagnosticEnabled(context: Context, enabled: Boolean): Boolean {
    val ok = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putBoolean(NORMAL_PREBOOT_COMPAT_DIAGNOSTIC, enabled)
      .putInt(PREBOOT_TRIAL_PHASE, if (enabled) TRIAL_READY else TRIAL_NOT_ARMED)
      .putString(PREBOOT_TRIAL_RECOVERY, if (enabled) "" else lastPrebootTrialRecovery(context))
      .commit()
    if (ok) trialStartedInThisProcess.set(false)
    return ok
  }

  private fun saveInterruptedTrialDiagnostics(context: Context) {
    // Stored privately. A subsequent official-only launch truncates engine.log.
    // Bound the copy so even a runaway third-party plugin cannot allocate
    // an unbounded string during Android process recovery.
    for ((name, output, maxBytes) in listOf(
      Triple("engine.log", "preboot-trial-last-engine.log", 16384),
      Triple("engine-boot-stage.txt", "preboot-trial-last-stage.txt", 2048),
    )) {
      try {
        val file = File(context.filesDir, name)
        if (!file.isFile) continue
        val bytes = RandomAccessFile(file, "r").use { stream ->
          val n = minOf(stream.length(), maxBytes.toLong()).toInt()
          stream.seek(stream.length() - n)
          ByteArray(n).also { stream.readFully(it) }
        }
        File(context.filesDir, output).writeBytes(bytes)
      } catch (_: Exception) {
        // Diagnostic preservation must never break the user's recovery path.
      }
    }
  }

  /** Restore the *known working* official-only profile after an interrupted
   * normal-Web comparison, without modifying Web manifests or user data. */
  @Synchronized
  fun recoverFailedPrebootTrial(context: Context, reason: String): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean(NORMAL_PREBOOT_COMPAT_DIAGNOSTIC, false)) return false
    val ok = prefs.edit()
      .putBoolean(NORMAL_PREBOOT_COMPAT_DIAGNOSTIC, false)
      .putInt(PREBOOT_TRIAL_PHASE, TRIAL_NOT_ARMED)
      .putBoolean(OFFICIAL_ONLY_DIAGNOSTIC, true)
      .putBoolean(NORMAL_MCP_DIAGNOSTIC, false)
      .putBoolean(SAFE_MODE, false)
      .putString(PREBOOT_TRIAL_RECOVERY, reason.take(80))
      .commit()
    if (ok) {
      trialStartedInThisProcess.set(false)
      saveInterruptedTrialDiagnostics(context)
    }
    return ok
  }

  /** Called at entry of both the Activity and sticky foreground Service,
   * before either can start a Node Host. This catches crashes/OS kills AND
   * pre-existing unsafe flags from the previously installed APK. */
  @Synchronized
  fun recoverInterruptedPrebootTrial(context: Context): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean(NORMAL_PREBOOT_COMPAT_DIAGNOSTIC, false)) return false
    if (trialStartedInThisProcess.get()) return false // Activity recreation
    return when (prefs.getInt(PREBOOT_TRIAL_PHASE, TRIAL_NOT_ARMED)) {
      TRIAL_READY -> false // First attempt not yet started (e.g. force-stop after selecting).
      TRIAL_STARTED -> recoverFailedPrebootTrial(context, "interrupted-after-trial-start")
      else -> recoverFailedPrebootTrial(context, "legacy-unguarded-trial")
    }
  }

  /** One-shot arm happens just before launch; a second Host attempt in the
   * same process rolls back rather than re-running a potentially fatal plugin. */
  @Synchronized
  fun beginPrebootTrial(context: Context): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean(NORMAL_PREBOOT_COMPAT_DIAGNOSTIC, false)) return false
    if (prefs.getInt(PREBOOT_TRIAL_PHASE, TRIAL_NOT_ARMED) != TRIAL_READY) {
      if (!recoverFailedPrebootTrial(context, "repeated-trial-prevented"))
        throw java.io.IOException("无法恢复已尝试的 Web 诊断模式")
      return false
    }
    if (!prefs.edit().putInt(PREBOOT_TRIAL_PHASE, TRIAL_STARTED).commit())
      throw java.io.IOException("无法持久化 Web 诊断启动标记，已停止该测试")
    trialStartedInThisProcess.set(true)
    return true
  }

  fun lastPrebootTrialRecovery(context: Context): String =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(PREBOOT_TRIAL_RECOVERY, "") ?: ""


  /**
   * Stable private token used by the Android directory-picker bridge and the
   * embedded Host. Persisting it prevents EngineService restarts from losing
   * the bridge credential while the Activity is recreated or absent.
   */
  fun pickToken(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val existing = prefs.getString(PICK_TOKEN, null)
    if (!existing.isNullOrBlank()) return existing
    val created = UUID.randomUUID().toString()
    prefs.edit().putString(PICK_TOKEN, created).apply()
    return created
  }
}
