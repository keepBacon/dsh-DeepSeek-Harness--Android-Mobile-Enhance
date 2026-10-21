package com.dshmobile.shell

import android.content.Context
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Genuine Luau CLI only; missing binary returns an error.
 * The CLI is NOT a security sandbox: callers must supply trusted test code.
 */
object LuauTestRunner {
  private const val OUTPUT_LIMIT = 16_384
  private const val TIMEOUT_SECONDS = 3L

  private fun error(message: String): String =
    JSONObject().put("ok", false).put("error", message).toString()

  fun run(context: Context, source: String): String {
    if (source.length !in 1..64_000)
      return error("代码长度必须在 1..64000 之间")
    val binary = File(context.filesDir, "usr/bin/luau")
    if (!binary.isFile || !binary.canExecute())
      return error("尚未打包真正的 Luau CLI（usr/bin/luau），不可使用普通 Lua 或 JavaScript 代替")
    val script = try {
      File.createTempFile("dsh-luau-", ".luau", context.cacheDir)
    } catch (e: Exception) {
      return error("无法创建测试脚本：" + e.javaClass.simpleName)
    }
    var process: Process? = null
    var drainer: Thread? = null
    val capture = ByteArrayOutputStream(OUTPUT_LIMIT)
    val truncated = AtomicBoolean(false)
    return try {
      script.writeText(source, Charsets.UTF_8)
      val child = ProcessBuilder(binary.absolutePath, script.absolutePath)
        .directory(context.cacheDir)
        .redirectErrorStream(true)
        .start()
      process = child
      // Pipe is drained continuously so chat/UI cannot be blocked by a full
      // pipe and the child cannot fill the filesystem with an unbounded log.
      // Bytes past OUTPUT_LIMIT are discarded without retaining them.
      drainer = Thread({
        try {
          child.inputStream.use { stream ->
            val buf = ByteArray(4096)
            while (true) {
              val n = stream.read(buf)
              if (n < 0) break
              if (n == 0) continue
              synchronized(capture) {
                val free = OUTPUT_LIMIT - capture.size()
                val accepted = minOf(free, n)
                if (accepted > 0) capture.write(buf, 0, accepted)
                if (accepted < n) truncated.set(true)
              }
            }
          }
        } catch (_: Exception) {
          // Stream closure after a timeout is expected.
        }
      }, "dsh-luau-output").apply {
        isDaemon = true
        start()
      }
      val completed = child.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)
      if (!completed) {
        child.destroyForcibly()
        child.waitFor(1, TimeUnit.SECONDS)
        child.inputStream.close()
      }
      drainer?.join(500)
      val output = synchronized(capture) { capture.toString(Charsets.UTF_8.name()) }
      JSONObject()
        .put("ok", completed && child.exitValue() == 0)
        .put("exitCode", if (completed) child.exitValue() else -2)
        .put("timedOut", !completed)
        .put("outputTruncated", truncated.get())
        .put("output", output)
        .put("note", "可信代码的 Luau CLI 限时测试；不是 Roblox Studio，也不是安全沙箱")
        .toString()
    } catch (t: Exception) {
      runCatching { process?.destroyForcibly() }
      error(t.javaClass.simpleName)
    } finally {
      runCatching { process?.inputStream?.close() }
      runCatching { drainer?.join(500) }
      script.delete()
    }
  }
}
