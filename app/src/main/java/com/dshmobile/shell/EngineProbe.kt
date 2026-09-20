package com.dshmobile.shell

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** Probes the local DSH Host and rejects unrelated processes that merely own port 3080. */
object EngineProbe {

  const val ENGINE_URL = "http://127.0.0.1:3080"
  private const val AUTH_CHALLENGE = "dsh web authentication required;"
  private const val MAX_PROBE_BODY = 16 * 1024

  /**
   * One-shot DSH identity + reachability probe. Safe on any background thread.
   * DSH 0.1.5-rc.2 answers an unauthenticated root GET with a distinctive 401
   * challenge. Older builds may answer the actual HTML; those are accepted
   * only when the body contains DSH-specific markers.
   */
  fun check(timeoutMs: Int = 800): JSONObject {
    return try {
      val conn = URL(ENGINE_URL).openConnection() as HttpURLConnection
      conn.connectTimeout = timeoutMs
      conn.readTimeout = timeoutMs
      conn.requestMethod = "GET"
      conn.instanceFollowRedirects = false
      conn.setRequestProperty("Accept", "text/html,text/plain;q=0.9")
      conn.setRequestProperty("Cache-Control", "no-store")
      val start = System.currentTimeMillis()
      val code = conn.responseCode
      val contentType = conn.contentType.orEmpty()
      val stream = if (code >= 400) conn.errorStream else conn.inputStream
      val body = try {
        stream?.use { input ->
          val buffer = ByteArray(MAX_PROBE_BODY)
          var offset = 0
          while (offset < buffer.size) {
            val n = input.read(buffer, offset, buffer.size - offset)
            if (n <= 0) break
            offset += n
          }
          String(buffer, 0, offset, Charsets.UTF_8)
        }.orEmpty()
      } catch (_: Throwable) { "" }
      conn.disconnect()

      val authenticatedChallenge = code == 401 && body.startsWith(AUTH_CHALLENGE)
      val legacyHtml = code == 200 && contentType.contains("text/html", ignoreCase = true) &&
        (body.contains("DeepSeek Harness", ignoreCase = true) ||
          body.contains("dsh-client", ignoreCase = true) || body.contains("@deepseek-ai", ignoreCase = true))
      val running = authenticatedChallenge || legacyHtml
      JSONObject()
        .put("running", running)
        .put("verifiedDsh", running)
        .put("httpCode", code)
        .put("latencyMs", System.currentTimeMillis() - start)
        .apply { if (!running) put("error", "port 3080 responded but did not identify as DSH") }
    } catch (e: Exception) {
      JSONObject().put("running", false).put("verifiedDsh", false).put("error", e.message ?: "unknown")
    }
  }
}
