package com.dshmobile.shell

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** User-selected SAF text only; application-private, removable, bounded. */
class McpSafBridge(private val context: Context) {
  private val dir = File(context.filesDir, "mcp/saf")
  private val index = File(dir, "index.json")
  private val maxFiles = 12
  private val maxBytes = 128 * 1024

  private fun records(): JSONArray {
    if (!index.exists()) return JSONArray()
    require(index.isFile && index.length() <= 32768) { "MCP SAF 索引无效" }
    val root = JSONObject(index.readText(Charsets.UTF_8))
    require(root.optInt("schema") == 1) { "MCP SAF 索引版本不支持" }
    return root.getJSONArray("documents")
  }
  private fun sha(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it.toInt() and 255) }

  private fun writeIndex(documents: JSONArray) {
    dir.mkdirs()
    val payload = JSONObject().put("schema", 1).put("documents", documents).toString()
    require(payload.toByteArray(Charsets.UTF_8).size <= 32768)
    val tmp = File(dir, ".index-" + UUID.randomUUID().toString() + ".tmp")
    tmp.writeText(payload, Charsets.UTF_8)
    if (!tmp.renameTo(index)) {
      tmp.delete()
      throw java.io.IOException("MCP SAF 索引提交失败")
    }
  }

  @Synchronized fun importSelected(uri: Uri): String {
    require(uri.scheme == "content") { "只允许 Android 文件选择器提供的 content URI" }
    val old = records()
    require(old.length() < maxFiles) { "MCP 文档数量达到上限（12 个）" }
    val name = try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "SAF 文档"
    } catch (_: Exception) { "SAF 文档" }
    val displayName = name.take(100).replace(Regex("[\\p{Cntrl}]"), "")
    val buffer = ByteArrayOutputStream()
    context.contentResolver.openInputStream(uri)?.use { input ->
      val chunk = ByteArray(8192)
      while (true) {
        val count = input.read(chunk)
        if (count < 0) break
        if (count == 0) continue
        require(buffer.size() + count <= maxBytes) { "只支持不超过 128 KiB 的文本文件" }
        buffer.write(chunk, 0, count)
      }
    } ?: throw java.io.IOException("无法读取选中的文件")
    val bytes = buffer.toByteArray()
    require(bytes.isNotEmpty() && bytes.none { it == 0.toByte() }) { "空文件或二进制文件不支持" }
    StandardCharsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(bytes))
    dir.mkdirs()
    val id = "saf-" + UUID.randomUUID().toString().replace("-", "")
    val target = File(dir, id + ".txt")
    require(target.createNewFile()) { "MCP 文档目标文件已存在" }
    try {
      target.writeBytes(bytes)
      val item = JSONObject().put("id", id).put("name", displayName)
        .put("sizeBytes", bytes.size).put("sha256", sha(bytes))
        .put("addedAt", System.currentTimeMillis())
      old.put(item)
      writeIndex(old)
    } catch (error: Throwable) {
      target.delete()
      throw error
    }
    return displayName
  }

  @Synchronized fun count(): Int = records().length()
  @Synchronized fun clear(): Int {
    val saved = records()
    for (i in 0 until saved.length()) {
      val id = saved.getJSONObject(i).getString("id")
      require(Regex("^saf-[0-9a-f]{32}$").matches(id)) { "SAF 索引包含无效 ID" }
      File(dir, id + ".txt").delete()
    }
    writeIndex(JSONArray())
    return saved.length()
  }
}
