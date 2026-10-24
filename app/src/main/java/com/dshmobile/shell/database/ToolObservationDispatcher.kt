package com.dshmobile.shell.database

import java.util.LinkedHashMap
import java.util.concurrent.Executors

/**
 * Coalesces high-frequency WebView observations. Exactly one background
 * worker drains the queue; each batch becomes one SQLite transaction.
 *
 * This is only diagnostic telemetry. It does not gate tools or affect their
 * execution. Terminal events replace earlier running events for the same call.
 */
class ToolObservationDispatcher(
  private val store: () -> MobileDatabase,
  private val onError: (Throwable) -> Unit,
) {
  private val lock = Any()
  private val pending = LinkedHashMap<String, MobileDatabase.ToolObservation>()
  private val worker = Executors.newSingleThreadExecutor { task ->
    Thread(task, "dsh-database-observations").apply { isDaemon = true }
  }
  private var scheduled = false
  private var closed = false

  fun offer(session: String, callId: String, name: String, status: String, error: String?) {
    synchronized(lock) {
      if (closed) return
      val key = session + "\u0000" + callId
      val previous = pending[key]
      // A later DOM scan must not overwrite a pending success/failure state.
      if (previous != null && previous.status != "running" && status == "running") return
      if (!pending.containsKey(key) && pending.size >= MAX_PENDING) {
        // Under heavy load preserve completed calls preferentially.
        val iterator = pending.entries.iterator()
        var removed = false
        while (iterator.hasNext()) {
          if (iterator.next().value.status == "running") {
            iterator.remove()
            removed = true
            break
          }
        }
        if (!removed) pending.remove(pending.keys.first())
      }
      pending[key] = MobileDatabase.ToolObservation(session, callId, name, status, error)
      if (!scheduled) {
        scheduled = true
        worker.execute { drain() }
      }
    }
  }

  private fun drain() {
    while (true) {
      val batch = synchronized(lock) {
        if (pending.isEmpty()) {
          scheduled = false
          return
        }
        val result = ArrayList<MobileDatabase.ToolObservation>(BATCH_SIZE)
        val iterator = pending.values.iterator()
        while (iterator.hasNext() && result.size < BATCH_SIZE) {
          result += iterator.next()
          iterator.remove()
        }
        result
      }
      try {
        store().observeBatch(batch)
      } catch (error: Throwable) {
        // Diagnostics must be fail-open: even a broken logging callback must
        // not kill the drain loop and strand future observations in the queue.
        runCatching { onError(error) }
      }
    }
  }

  fun close() {
    synchronized(lock) { closed = true }
    // Drain already-accepted events before releasing the Activity instance.
    worker.shutdown()
  }

  companion object {
    private const val MAX_PENDING = 4096
    private const val BATCH_SIZE = 64
  }
}
