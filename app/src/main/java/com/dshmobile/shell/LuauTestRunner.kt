package com.dshmobile.shell

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/** Runs only a genuine Luau CLI. This is not Roblox Studio. */
object LuauTestRunner {
  private fun error(message: String): String =
    JSONObject().put("ok", false).put("error", message).toString()

  fun run(context: Context, source: String): String {
    if (source.length !in 1..64_000) return error("代码长度必须在 1..64000 之间")
    val binary = File(context.filesDir, "usr/bin/luau")
    if (!binary.isFile || !binary.canExecute())
      return error("未安装真正的 Luau CLI（usr/bin/luau）。请在编译运行时快照时纳入解释器。")
    val script = File.createTempFile("dsh-luau-", ".luau", context.cacheDir)
    val log = File.createTempFile("dsh-luau-result-", ".txt", context.cacheDir)
    var process: Process? = null
    return try {
      script.writeText(source)
      process = ProcessBuilder(binary.absolutePath, script.absolutePath)
        .directory(context.cacheDir).redirectErrorStream(true).redirectOutput(log).start()
      val done = process.waitFor(3, TimeUnit.SECONDS)
      if (!done) {
        process.destroyForcibly()
        process.waitFor(1, TimeUnit.SECONDS)
      }
      val result = log.inputStream().bufferedReader().use { it.readText().take(16_384) }
      JSONObject().put("ok",done&&process.exitValue()==0)
        .put("exitCode",if(done)process.exitValue() else -2)
        .put("output",result)
        .put("note","Luau CLI 离线测试，不包含 Roblox Studio 引擎 API").toString()
    } catch (t: Throwable) {
      try { process?.destroyForcibly() } catch (_: Throwable) {}
      error(t.message ?: t.javaClass.simpleName)
    } finally {
      script.delete()
      log.delete()
    }
  }
}
