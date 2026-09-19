package com.dshmobile.shell

import android.content.Context
import java.util.UUID

/** Small process-independent shell state shared by Activity and foreground service. */
object ShellState {
  private const val PREFS = "dsh-shell"
  private const val PICK_TOKEN = "pick-token"
  private const val LAST_WORKSPACE_PATH = "last-workspace-path"
  private const val INTERFACE_MODE = "interface-mode"

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
