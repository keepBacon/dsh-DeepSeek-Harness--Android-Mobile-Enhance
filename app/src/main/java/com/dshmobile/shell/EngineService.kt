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
  // Service lifecycle operations are serialized: a delayed Stop cannot kill
  // a newer Start, and a queued Restart cannot run after explicit Stop.
  private val lifecycleExecutor = Executors.newSingleThreadExecutor()
  private val lifecycleGeneration = java.util.concurrent.atomic.AtomicLong(0L)
  private val restartInFlight = java.util.concurrent.atomic.AtomicBoolean(false)
  private val stopRequested = java.util.concurrent.atomic.AtomicBoolean(false)
  private var failedAliveProbes = 0
  private var degradedNotificationVisible = false
  // A failed explicit stop must remain visible even if the old Host still
  // answers HTTP. The probe-success path must not erase that diagnosis.
  @Volatile private var stopFailureVisible = false
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

  private fun restartOnUserRequest(generation: Long) {
    lifecycleExecutor.execute {
      try {
        if (stopRequested.get() || lifecycleGeneration.get() != generation) return@execute
        EngineManager.beginMaintenance()
        try {
          val stopped = try {
            engineManager.stopEngine()
          } catch (t: Throwable) {
            Log.e("DSH-Watchdog", "Explicit restart failed during stop", t)
            false
          }
          if (stopped && !stopRequested.get()) {
            // Stop and Start both invalidate queued restarts. Keep maintenance
            // active until the replacement Host has finished launching.
            if (lifecycleGeneration.get() == generation) {
              try {
                if (engineManager.startEngine(runtimeAlreadyChecked = true)) {
                  stopFailureVisible = false
                  notificationManager.notify(NOTIFICATION_ID, buildNotification())
                }
              } catch (t: Throwable) {
                Log.e("DSH-Watchdog", "Explicit restart failed during boot", t)
              }
            }
          } else if (!stopped) {
            Log.w("DSH-Watchdog", "Explicit restart blocked: old Host is still alive")
          }
        } finally {
          EngineManager.endMaintenance()
        }
      } finally {
        // Keep the degraded Host warning until a subsequent verified probe
        // succeeds. A failed manual stop or failed relaunch is not recovery.
        restartInFlight.set(false)
      }
    }
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
      stopRequested.set(true)
      val generation = lifecycleGeneration.incrementAndGet()
      watchdog?.shutdownNow()
      watchdog = null
      // Queue the stop after any in-flight Start/Restart. It is important
      // that Stop is serialized, not merely moved to another independent thread.
      lifecycleExecutor.execute {
        val stopped = try {
          EngineManager.beginMaintenance()
          try {
            engineManager.stopEngine().also { success ->
              if (!success) Log.w("DSH-Watchdog",
                "Explicit stop failed: retain foreground owner and live Host handle")
            }
          } finally {
            EngineManager.endMaintenance()
          }
        } catch (t: Throwable) {
          Log.e("DSH-Watchdog", "Explicit Host stop failed", t)
          false
        }
        android.os.Handler(android.os.Looper.getMainLooper()).post {
          // An older stop cannot remove a newer START/RESTART owner.
          if (stopRequested.get() && lifecycleGeneration.get() == generation) {
            if (stopped) {
              stopForeground(STOP_FOREGROUND_REMOVE)
              stopSelf(startId)
            } else {
              // stopEngine() intentionally keeps handles when SIGTERM/SIGKILL
              // fails. Removing this service would orphan that live process,
              // hide the stop failure and prevent the watchdog from recovering.
              stopFailureVisible = true
              stopRequested.set(false)
              notificationManager.notify(NOTIFICATION_ID, buildNotification())
              armWatchdog()
            }
          }
        }
      }
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_RESTART) {
      // STOP wins if a restart notification is delivered during teardown.
      if (stopRequested.get()) return START_NOT_STICKY
      if (restartInFlight.compareAndSet(false, true)) {
        val generation = lifecycleGeneration.incrementAndGet()
        restartOnUserRequest(generation)
      }
      return START_STICKY
    }
    stopRequested.set(false)
    if (stopFailureVisible) {
      stopFailureVisible = false
      notificationManager.notify(NOTIFICATION_ID, buildNotification())
    }
    val generation = lifecycleGeneration.incrementAndGet()
    ensureEngine(generation)
    armWatchdog()
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    stopRequested.set(true)
    lifecycleGeneration.incrementAndGet()
    watchdog?.shutdownNow()
    watchdog = null
    lifecycleExecutor.shutdown()
    // Do not kill the Host here: Android may recreate a foreground service.
    // Explicit user stop goes through ACTION_STOP above.
    super.onDestroy()
  }

  /** Start the engine if it is not listening yet. */
  private fun ensureEngine(generation: Long) {
    // Probe, runtime validation, and cold startup all run off the main thread.
    // Newer lifecycle requests invalidate any queued older ensure task.
    lifecycleExecutor.execute {
      try {
        if (stopRequested.get() || lifecycleGeneration.get() != generation ||
            EngineManager.isMaintenanceMode()) return@execute
        if (EngineProbe.check(350).optBoolean("running", false)) return@execute
        if (stopRequested.get() || lifecycleGeneration.get() != generation ||
            EngineManager.isMaintenanceMode()) return@execute
        if (engineManager.isEngineProcessAlive()) return@execute
        if (engineManager.engineReady && !stopRequested.get() &&
            lifecycleGeneration.get() == generation && !EngineManager.isMaintenanceMode()) {
          engineManager.startEngine(runtimeAlreadyChecked = true)
        }
      } catch (t: Throwable) {
        Log.e("DSH-Watchdog", "Foreground Host ensure failed", t)
      }
    }
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
            // A pending restart does not prove the Host recovered. Preserve
            // the actionable warning until a live Host responds again.
            return@scheduleWithFixedDelay
          }
          val generation = lifecycleGeneration.get()
          val probe = EngineProbe.check(650)
          if (stopRequested.get() || generation != lifecycleGeneration.get()) return@scheduleWithFixedDelay
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
            if (stopRequested.get() || generation != lifecycleGeneration.get()) return@scheduleWithFixedDelay
            markUnresponsiveHost()
            // Avoid logging the possibly sensitive HTTP error body every 5 s.
            return@scheduleWithFixedDelay
          }
          clearProbeFailures()
          if (!stopRequested.get() && generation == lifecycleGeneration.get() &&
              !EngineManager.isMaintenanceMode() && !restartInFlight.get()) {
            // Queue behind an in-flight lifecycle action; never start a Host
            // directly on the independent watchdog executor.
            lifecycleExecutor.execute {
              if (!stopRequested.get() && generation == lifecycleGeneration.get() &&
                  !EngineManager.isMaintenanceMode() && !restartInFlight.get() &&
                  !engineManager.isEngineProcessAlive()) {
                engineManager.startEngine(runtimeAlreadyChecked = true)
              }
            }
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
      .setContentText(when {
        stopFailureVisible -> "停止失败：旧 Host 仍在运行；请重试停止或强行停止应用（勿清除数据）"
        unresponsive -> "Host 长期无响应；可手动重启（保留数据）"
        else -> "本机 DSH 引擎运行中"
      })
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
