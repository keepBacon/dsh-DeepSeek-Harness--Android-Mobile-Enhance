package com.dshmobile.shell

import android.content.Context
import rikka.shizuku.Shizuku
import android.os.IBinder
import android.os.Parcel
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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

  /**
   * Bind only after the user granted Shizuku access. This is a diagnostic-only
   * bridge and does not expose a general shell or an IPC endpoint to WebView.
   */
  fun inspect(operation: String, packageName: String? = null): JSONObject {
    if (operation !in setOf("identity", "packages", "processes", "package")) {
      return JSONObject().put("ok", false).put("error", "operation not allowed")
    }
    if (!isAvailable()) return JSONObject().put("ok", false).put("error", "Shizuku is unavailable or not authorized")
    val latch = CountDownLatch(1)
    var binder: IBinder? = null
    val args = Shizuku.UserServiceArgs(android.content.ComponentName(
      "com.dshmobile.shell", "com.dshmobile.shell.ShizukuInspectorService"
    )).daemon(false).processNameSuffix("inspector").debuggable(false).version(1)
    val connection = object : android.content.ServiceConnection {
      override fun onServiceConnected(name: android.content.ComponentName?, service: IBinder?) {
        binder = service
        latch.countDown()
      }
      override fun onServiceDisconnected(name: android.content.ComponentName?) {
        binder = null
        latch.countDown()
      }
    }
    return try {
      Shizuku.bindUserService(args, connection)
      if (!latch.await(8, TimeUnit.SECONDS) || binder == null) {
        JSONObject().put("ok", false).put("error", "Shizuku UserService binding timed out")
      } else {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        try {
          data.writeInterfaceToken("com.dshmobile.shell.ShizukuInspectorService")
          data.writeString(operation)
          data.writeString(packageName)
          if (binder!!.transact(IBinder.FIRST_CALL_TRANSACTION, data, reply, 0)) {
            reply.readException()
            JSONObject(reply.readString() ?: "{}")
          } else JSONObject().put("ok", false).put("error", "Shizuku inspector IPC rejected")
        } finally {
          data.recycle()
          reply.recycle()
        }
      }
    } catch (error: Throwable) {
      JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName)
    } finally {
      try { Shizuku.unbindUserService(args, connection, false) } catch (_: Throwable) {}
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
