package com.dshmobile.shell

import android.content.Context
import rikka.shizuku.Shizuku

/**
 * Optional Shizuku integration. This build only detects authorization; it does
 * not claim to have applied appops/UserService keep-alive changes. Everything
 * degrades gracefully when Shizuku is absent.
 */
object ShizukuSupport {

  /** True when the Shizuku server binder is reachable. */
  fun isAvailable(): Boolean {
    return try {
      Shizuku.pingBinder() && Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED
    } catch (_: Throwable) {
      false
    }
  }

  /** Status text for the UI; never throws. */
  fun status(context: Context): String {
    return if (isAvailable()) {
      "Shizuku 已授权（v" + Shizuku.getVersion() + "）；当前仅检测状态，未应用额外保活策略"
    } else {
      "Shizuku 未运行（可选组件；当前版本不依赖 Shizuku 保活）"
    }
  }
}
