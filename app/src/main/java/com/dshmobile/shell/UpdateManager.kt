package com.dshmobile.shell

import android.content.Context
import android.content.Intent
import android.util.Base64
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import org.json.JSONObject

/**
 * Fail-closed runtime updater. Runtime replacement is privileged code, so the
 * updater accepts only HTTPS manifests carrying an exact size, SHA-256 and an
 * Ed25519 signature verified by the app-bundled public key.
 */
class UpdateManager(private val context: Context) {

  var manifestUrl: String = DEFAULT_MANIFEST_URL

  fun checkAndApply(onStatus: (String) -> Unit) {
    Thread {
      val engine = EngineManager(context, ShellState.pickToken(context))
      var maintenance = false
      var shouldRestart = false
      try {
        val manifestEndpoint = manifestUrl.trim()
        requireHttps(manifestEndpoint, "更新清单")
        val publicKey = loadUpdatePublicKey()

        onStatus("检查更新…")
        val manifest = JSONObject(fetchText(manifestEndpoint, MAX_MANIFEST_BYTES))
        val url = manifest.getString("url").trim()
        val expectedSha = manifest.getString("sha256").trim().lowercase()
        val expectedSize = manifest.getLong("size")
        val version = manifest.getString("version").trim()
        val signature = manifest.getString("signature").trim()
        requireHttps(url, "运行时下载")
        if (!Regex("^[0-9a-f]{64}$").matches(expectedSha)) throw IllegalStateException("更新清单缺少有效 SHA-256")
        if (expectedSize <= 0 || expectedSize > MAX_UPDATE_BYTES) throw IllegalStateException("更新包大小超出安全范围")
        if (version.isBlank()) throw IllegalStateException("更新清单缺少 version")
        verifyManifestSignature(publicKey, version, url, expectedSha, expectedSize, signature)

        onStatus("下载快照（${expectedSize / 1024 / 1024} MB）…")
        val tmp = File(context.filesDir, "update.tar.xz")
        downloadExact(url, tmp, expectedSize)

        onStatus("校验…")
        val actual = sha256(tmp)
        if (!actual.equals(expectedSha, ignoreCase = true)) {
          tmp.delete()
          throw IllegalStateException("SHA256 不匹配: ${actual.take(12)}…")
        }

        onStatus("解压新快照…")
        val stage = File(context.filesDir, "update-stage")
        deleteRecursively(stage)
        SnapshotExtractor.extract(tmp.inputStream(), expectedSize, stage) { _, _ -> }
        tmp.delete()
        val newUsr = File(stage, "usr")
        val required = listOf(
          File(newUsr, "bin/node") to "node",
          File(newUsr, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js") to "DSH CLI",
          File(newUsr, "lib/libtermux-exec-ld-preload.so") to "termux-exec preload",
        )
        val missing = required.filterNot { it.first.isFile }.map { it.second }
        if (missing.isNotEmpty()) throw IllegalStateException("新快照不完整，缺少：${missing.joinToString(", ")}")

        // The engine may continue reading executable/code files after startup.
        // Enter maintenance before the directory swap so the foreground-service
        // watchdog cannot relaunch it while profile/runtime files are changing.
        shouldRestart = EngineProbe.check().optBoolean("running", false)
        EngineManager.beginMaintenance()
        maintenance = true
        try { context.stopService(Intent(context, EngineService::class.java)) } catch (_: Throwable) {}
        if (!engine.stopEngine()) throw IllegalStateException("旧 DSH 引擎未能完全退出，已取消 Runtime 更新")

        onStatus("切换运行时…")
        val usr = File(context.filesDir, "usr")
        val old = File(context.filesDir, "usr-old")
        val runtimeMarker = File(context.filesDir, "runtime-version.txt")
        val previousMarker = if (runtimeMarker.isFile) runtimeMarker.readText() else null
        deleteRecursively(old)
        var movedOld = false
        try {
          if (usr.exists()) {
            if (!usr.renameTo(old)) throw IllegalStateException("无法备份当前运行时")
            movedOld = true
          }
          if (!newUsr.renameTo(usr)) throw IllegalStateException("无法启用新运行时")
          writeRuntimeMarkerAtomic(
            runtimeMarker,
            version = version,
            sha256 = expectedSha,
            baseBundleId = engine.bundledRuntimeIdentity(),
          )

          // Smoke-test the runtime in its final absolute path before deleting
          // usr-old. Any linker/module/CLI failure rolls the whole swap back.
          onStatus("验证新运行时…")
          val smoke = engine.smokeTestRuntime()
          if (!smoke.ok) {
            throw IllegalStateException("新 Runtime 启动校验失败：${smoke.output.takeLast(2000)}")
          }

          deleteRecursively(stage)
          deleteRecursively(old)
        } catch (t: Throwable) {
          if (usr.exists()) deleteRecursively(usr)
          var rollbackFailure: Throwable? = null
          if (movedOld && old.exists() && !old.renameTo(usr)) {
            rollbackFailure = IllegalStateException("无法恢复旧 Runtime 目录")
          }
          try {
            if (previousMarker == null) runtimeMarker.delete() else writeTextAtomic(runtimeMarker, previousMarker)
          } catch (markerError: Throwable) {
            if (rollbackFailure == null) rollbackFailure = markerError else rollbackFailure?.addSuppressed(markerError)
          }
          deleteRecursively(stage)
          rollbackFailure?.let { failure ->
            val combined = IllegalStateException("Runtime 更新失败且回滚不完整", t)
            combined.addSuppressed(failure)
            throw combined
          }
          throw t
        }

        onStatus("更新完成；正在恢复 DSH 引擎…")
      } catch (t: Throwable) {
        onStatus("更新失败：${t.message ?: t.javaClass.simpleName}")
      } finally {
        if (maintenance) EngineManager.endMaintenance()
        if (shouldRestart && engine.runtimeHealth().ok) {
          try {
            engine.startEngine()
            context.startForegroundService(Intent(context, EngineService::class.java))
          } catch (_: Throwable) {
          }
        }
      }
    }.start()
  }

  private fun writeRuntimeMarkerAtomic(file: File, version: String, sha256: String, baseBundleId: String) {
    val marker = JSONObject()
      .put("schema", 1)
      .put("kind", "ota")
      .put("version", version)
      .put("sha256", sha256)
      .put("baseBundleId", baseBundleId)
      .toString()
    writeTextAtomic(file, marker + "\n")
  }

  private fun writeTextAtomic(file: File, text: String) {
    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, file.name + ".tmp-" + System.nanoTime())
    tmp.writeText(text)
    if (!tmp.renameTo(file)) {
      tmp.copyTo(file, overwrite = true)
      tmp.delete()
    }
  }

  private fun requireHttps(value: String, label: String) {
    if (value.isBlank()) throw IllegalStateException("在线更新未配置")
    val parsed = URL(value)
    if (!parsed.protocol.equals("https", ignoreCase = true)) {
      throw SecurityException("$label 必须使用 HTTPS")
    }
  }

  private fun loadUpdatePublicKey(): java.security.PublicKey {
    val encoded = try {
      context.assets.open("runtime-update-public-key.txt").bufferedReader().use { it.readText().trim() }
    } catch (_: Throwable) { "" }
    if (encoded.isBlank()) throw SecurityException("更新签名公钥未配置；已拒绝在线 Runtime 更新")
    val der = try { Base64.decode(encoded, Base64.DEFAULT) }
    catch (_: Throwable) { throw SecurityException("更新签名公钥格式无效") }
    return try {
      KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(der))
    } catch (t: Throwable) {
      throw SecurityException("设备不支持 Ed25519 更新签名验证", t)
    }
  }

  private fun verifyManifestSignature(
    key: java.security.PublicKey,
    version: String,
    url: String,
    sha256: String,
    size: Long,
    encodedSignature: String,
  ) {
    val signatureBytes = try { Base64.decode(encodedSignature, Base64.DEFAULT) }
    catch (_: Throwable) { throw SecurityException("更新签名格式无效") }
    val canonical = "version:$version\nurl:$url\nsha256:$sha256\nsize:$size\n".toByteArray(Charsets.UTF_8)
    val verifier = Signature.getInstance("Ed25519")
    verifier.initVerify(key)
    verifier.update(canonical)
    if (!verifier.verify(signatureBytes)) throw SecurityException("更新清单签名验证失败")
  }

  private fun fetchText(url: String, maxBytes: Int): String {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 10_000
    conn.readTimeout = 30_000
    conn.instanceFollowRedirects = false
    val code = conn.responseCode
    if (code != 200) throw IllegalStateException("manifest HTTP $code")
    val length = conn.contentLengthLong
    if (length > maxBytes) throw IllegalStateException("更新清单过大")
    return conn.inputStream.use { input ->
      val out = java.io.ByteArrayOutputStream()
      val buf = ByteArray(8192)
      var total = 0
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        total += n
        if (total > maxBytes) throw IllegalStateException("更新清单过大")
        out.write(buf, 0, n)
      }
      out.toString(Charsets.UTF_8.name())
    }.also { conn.disconnect() }
  }

  private fun downloadExact(url: String, dest: File, expectedSize: Long) {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 10_000
    conn.readTimeout = 60_000
    conn.instanceFollowRedirects = false
    val code = conn.responseCode
    if (code != 200) throw IllegalStateException("下载 HTTP $code")
    val contentLength = conn.contentLengthLong
    if (contentLength > 0 && contentLength != expectedSize) {
      throw IllegalStateException("下载大小与签名清单不一致")
    }
    var total = 0L
    conn.inputStream.use { input ->
      dest.outputStream().use { out ->
        val buf = ByteArray(64 * 1024)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          total += n
          if (total > expectedSize || total > MAX_UPDATE_BYTES) {
            throw IllegalStateException("下载数据超过签名清单大小")
          }
          out.write(buf, 0, n)
        }
      }
    }
    conn.disconnect()
    if (total != expectedSize) {
      dest.delete()
      throw IllegalStateException("下载未完成：$total / $expectedSize bytes")
    }
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(64 * 1024)
      var n = input.read(buf)
      while (n >= 0) {
        if (n > 0) digest.update(buf, 0, n)
        n = input.read(buf)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun deleteRecursively(file: File) {
    if (!file.exists()) return
    file.walkBottomUp().forEach { it.delete() }
  }

  companion object {
    // Empty by default: release builders must opt in to a real HTTPS endpoint
    // and bundle its matching Ed25519 public key in runtime-update-public-key.txt.
    const val DEFAULT_MANIFEST_URL = ""
    const val MAX_MANIFEST_BYTES = 64 * 1024
    const val MAX_UPDATE_BYTES = 1024L * 1024 * 1024
  }
}
