package com.dshmobile.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Foreground service owning the embedded Host lifecycle. The Activity may be
 * destroyed/backgrounded without interrupting long-running DSH tasks.
 */
class EngineService : Service() {

  private lateinit var engineManager: EngineManager
  private var watchdog: ScheduledExecutorService? = null

  override fun onCreate() {
    super.onCreate()
    engineManager = EngineManager(this, ShellState.pickToken(this))
    startForeground(NOTIFICATION_ID, buildNotification())
    armWatchdog()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      watchdog?.shutdownNow()
      watchdog = null
      engineManager.stopEngine()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    ensureEngine()
    armWatchdog()
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    watchdog?.shutdownNow()
    watchdog = null
    // Do not kill the Host here: Android may recreate a foreground service.
    // Explicit user stop goes through ACTION_STOP above.
    super.onDestroy()
  }

  /** Start the engine if it is not listening yet. */
  private fun ensureEngine() {
    if (EngineManager.isMaintenanceMode()) return
    if (EngineProbe.check(350).optBoolean("running", false)) return
    if (engineManager.engineReady) engineManager.startEngine(runtimeAlreadyChecked = true)
  }

  /**
   * Always arm the watchdog, even when MainActivity started the Host before
   * this service. The old implementation returned early in that case and had
   * no watchdog at all.
   */
  private fun armWatchdog() {
    if (watchdog != null) return
    watchdog = Executors.newSingleThreadScheduledExecutor().also { exec ->
      exec.scheduleWithFixedDelay({
        try {
          if (!EngineManager.isMaintenanceMode() &&
            !EngineProbe.check(500).optBoolean("running", false) && engineManager.engineReady) {
            engineManager.startEngine(runtimeAlreadyChecked = true)
          }
        } catch (_: Throwable) {
        }
      }, 5, 5, TimeUnit.SECONDS)
    }
  }

  private fun buildNotification(): android.app.Notification {
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel("engine", "dsh 引擎", NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val stop = PendingIntent.getService(
      this, 1, Intent(this, EngineService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, "engine")
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle("DeepSeek Harness")
      .setContentText("本机 DSH 引擎运行中")
      .setContentIntent(open)
      .addAction(0, "停止", stop)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val NOTIFICATION_ID = 2
    const val ACTION_STOP = "com.dshmobile.shell.action.STOP_ENGINE"
  }
}
