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
import android.util.Log

/**
 * Foreground service owning the embedded Host lifecycle. The Activity may be
 * destroyed/backgrounded without interrupting long-running DSH tasks.
 */
class EngineService : Service() {

  private lateinit var engineManager: EngineManager
  private var watchdog: ScheduledExecutorService? = null
  private val restartInFlight = java.util.concurrent.atomic.AtomicBoolean(false)
  private val ensureInFlight = java.util.concurrent.atomic.AtomicBoolean(false)
  private val stopRequested = java.util.concurrent.atomic.AtomicBoolean(false)
  private var failedAliveProbes = 0
  private var degradedNotificationVisible = false
  private val degradedProbeThreshold = 12 // One minute at 5-second intervals.
  private val notificationManager by lazy {
    getSystemService(NOTIFICATION_SERVICE) as NotificationManager
  }

  private fun clearProbeFailures() {
    failedAliveProbes = 0
    if (degradedNotificationVisible) {
      degradedNotificationVisible = false
      notificationManager.notify(NOTIFICATION_ID, buildNotification())
    }
  }

  private fun markUnresponsiveHost() {
    failedAliveProbes = (failedAliveProbes + 1).coerceAtMost(degradedProbeThreshold)
    if (failedAliveProbes == degradedProbeThreshold && !degradedNotificationVisible) {
      degradedNotificationVisible = true
      // No forced kill: a long-running tool can block HTTP transiently.
      // Give the user an explicit, reversible choice to restart the Host.
      notificationManager.notify(NOTIFICATION_ID, buildNotification(unresponsive = true))
      Log.w("DSH-Watchdog", "DSH Host has not answered 12 consecutive probes")
    }
  }

  private fun restartOnUserRequest() {
    if (!restartInFlight.compareAndSet(false, true)) return
    Thread({
      try {
        EngineManager.beginMaintenance()
        val stopped = try {
          engineManager.stopEngine()
        } catch (t: Throwable) {
          Log.e("DSH-Watchdog", "Explicit restart failed during stop", t)
          false
        } finally {
          EngineManager.endMaintenance()
        }
        if (stopped && !stopRequested.get()) {
          try {
            engineManager.startEngine(runtimeAlreadyChecked = true)
          } catch (t: Throwable) {
            Log.e("DSH-Watchdog", "Explicit restart failed during boot", t)
          }
        } else if (!stopped) {
          Log.w("DSH-Watchdog", "Explicit restart blocked: old Host is still alive")
        }
      } finally {
        clearProbeFailures()
        restartInFlight.set(false)
      }
    }, "dsh-user-host-restart").start()
  }

  override fun onCreate() {
    super.onCreate()
    // A sticky foreground service may start before MainActivity after a crash.
    ShellState.recoverInterruptedPrebootTrial(this)
    engineManager = EngineManager(this, ShellState.pickToken(this))
    startForeground(NOTIFICATION_ID, buildNotification())
    armWatchdog()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // stopEngine can wait for graceful/forced Node shutdown for several
      // seconds. Never block the Android service main thread or the notification
      // action while waiting for a potentially unresponsive Host.
      stopRequested.set(true)
      watchdog?.shutdownNow()
      watchdog = null
      Thread({
        try {
          EngineManager.beginMaintenance()
          try {
            if (!engineManager.stopEngine()) {
              Log.w("DSH-Watchdog", "Explicit stop did not terminate every Host process")
            }
          } finally {
            EngineManager.endMaintenance()
          }
        } catch (t: Throwable) {
          Log.e("DSH-Watchdog", "Explicit Host stop failed", t)
        } finally {
          android.os.Handler(android.os.Looper.getMainLooper()).post {
            // A later START may have requested continued service ownership.
            if (stopRequested.get()) {
              stopForeground(STOP_FOREGROUND_REMOVE)
              stopSelf(startId)
            }
          }
        }
      }, "dsh-user-host-stop").start()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_RESTART) {
      restartOnUserRequest()
      return START_STICKY
    }
    stopRequested.set(false)
    ensureEngine()
    armWatchdog()
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    stopRequested.set(true)
    watchdog?.shutdownNow()
    watchdog = null
    // Do not kill the Host here: Android may recreate a foreground service.
    // Explicit user stop goes through ACTION_STOP above.
    super.onDestroy()
  }

  /** Start the engine if it is not listening yet. */
  private fun ensureEngine() {
    if (stopRequested.get() || !ensureInFlight.compareAndSet(false, true)) return
    // Both the localhost probe and a cold Node startup can block. Lifecycle
    // callbacks run on Android's main thread, so perform this work off-thread.
    Thread({
      try {
        if (stopRequested.get() || EngineManager.isMaintenanceMode()) return@Thread
        if (EngineProbe.check(350).optBoolean("running", false)) return@Thread
        if (stopRequested.get() || EngineManager.isMaintenanceMode()) return@Thread
        if (engineManager.isEngineProcessAlive()) return@Thread
        if (engineManager.engineReady && !stopRequested.get() &&
            !EngineManager.isMaintenanceMode()) {
          engineManager.startEngine(runtimeAlreadyChecked = true)
        }
      } catch (t: Throwable) {
        Log.e("DSH-Watchdog", "Foreground Host ensure failed", t)
      } finally {
        ensureInFlight.set(false)
      }
    }, "dsh-service-host-ensure").start()
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
          if (stopRequested.get() || EngineManager.isMaintenanceMode() || restartInFlight.get()) {
            clearProbeFailures()
            return@scheduleWithFixedDelay
          }
          val probe = EngineProbe.check(650)
          if (stopRequested.get()) return@scheduleWithFixedDelay
          if (probe.optBoolean("running", false)) {
            clearProbeFailures()
            return@scheduleWithFixedDelay
          }
          if (!engineManager.engineReady) {
            clearProbeFailures()
            return@scheduleWithFixedDelay
          }
          // A living Node process can be temporarily blocked by expensive
          // tool execution or an overloaded Gateway. Do not spawn a duplicate
          // Host or kill active sessions simply because HTTP timed out.
          if (engineManager.isEngineProcessAlive()) {
            markUnresponsiveHost()
            // Avoid logging the possibly sensitive HTTP error body every 5 s.
            return@scheduleWithFixedDelay
          }
          clearProbeFailures()
          if (!stopRequested.get() && !EngineManager.isMaintenanceMode()) {
            engineManager.startEngine(runtimeAlreadyChecked = true)
          }
        } catch (_: Throwable) {
        }
      }, 5, 5, TimeUnit.SECONDS)
    }
  }

  private fun buildNotification(unresponsive: Boolean = false): android.app.Notification {
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
    val restart = PendingIntent.getService(
      this, 2, Intent(this, EngineService::class.java).setAction(ACTION_RESTART),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, "engine")
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle("DeepSeek Harness")
      .setContentText(if (unresponsive) "Host 长期无响应；可手动重启（保留数据）" else "本机 DSH 引擎运行中")
      .setContentIntent(open)
      .apply { if (unresponsive) addAction(0, "重启引擎", restart) }
      .addAction(0, "停止", stop)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val NOTIFICATION_ID = 2
    const val ACTION_STOP = "com.dshmobile.shell.action.STOP_ENGINE"
    const val ACTION_RESTART = "com.dshmobile.shell.action.RESTART_ENGINE"
  }
}
