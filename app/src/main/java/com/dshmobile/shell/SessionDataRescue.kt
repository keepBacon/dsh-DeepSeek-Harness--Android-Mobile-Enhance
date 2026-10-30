package com.dshmobile.shell

import android.content.Context
import android.net.Uri
import java.io.File
import java.io.IOException
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Emergency read-only export, independent of the DSH Host/WebView.
 *
 * Export private and public *physical* trees separately. Never follow a
 * symlink: a surviving public directory will be exported from its own source
 * and an orphaned migration backup remains separately identifiable.
 *
 * This does not restore, rewrite, migrate, initialize or delete any DSH data.
 * It intentionally excludes credentials and profile configuration files.
 */
object SessionDataRescue {
  private const val MAX_FILES = 150_000
  private const val MAX_BYTES = 8L * 1024L * 1024L * 1024L
  private const val MAX_DEPTH = 64

  data class Result(val files: Int, val bytes: Long, val sources: Int) {
    fun describe() = "已导出 " + files + " 个文件（" + bytes + " 字节），来自 " +
      sources + " 个原始数据目录。请妥善保存 ZIP；其中可能包含私人聊天与附件。"
  }

  private data class Source(val dir: File, val label: String)

  private fun physicalDirectory(dir: File): Boolean =
    !java.nio.file.Files.isSymbolicLink(dir.toPath()) && dir.isDirectory

  private fun sources(context: Context): List<Source> {
    val privateRoot = File(context.filesDir, "home/.dsh")
    val publicRoot = File(
      android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS),
      "dshdata",
    )
    val found = mutableListOf<Source>()
    val selectedNames = listOf("sessions", "storages", "attachments", "skills")
    for ((root, label) in listOf(privateRoot to "private", publicRoot to "public")) {
      if (!physicalDirectory(root)) continue
      for (name in selectedNames) {
        val dir = File(root, name)
        if (physicalDirectory(dir)) found.add(Source(dir, label + "/" + name))
      }
      // A previous interrupted migration can have preserved original files
      // under one of these private backup names.
      root.listFiles()?.filter { child ->
        selectedNames.any { name ->
          child.name.startsWith("." + name + ".migration-backup-") ||
            child.name.startsWith("." + name + ".migrate-")
        } && physicalDirectory(child)
      }?.sortedBy { it.name }?.forEach {
        found.add(Source(it, label + "/migration-backups/" + it.name))
      }
    }
    return found
  }

  /** Does not create a file, directory, database or migration marker. */
  fun describeSources(context: Context): String {
    val privateRoot = File(context.filesDir, "home/.dsh")
    val publicRoot = File(
      android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS),
      "dshdata",
    )
    val found = sources(context)
    val sourceNames = found.joinToString("\n") { "  - " + it.label }
    return "应用私有 DSH_HOME：" + (if (physicalDirectory(privateRoot)) "存在" else "不存在或无法访问") +
      "\n公共 dshdata：" + (if (physicalDirectory(publicRoot)) "存在" else "不存在或无法访问") +
      "\n找到可导出目录：" + found.size +
      (if (found.isNotEmpty()) "\n" + sourceNames else "") +
      "\n不包含凭据、API Key 或 Profile 配置。不修改现有数据。"
  }

  /**
   * Direct SAF streaming avoids storing a second unencrypted archive inside
   * the app. Failure may leave a partial ZIP at the user-selected destination,
   * which must not be mistaken for a complete backup.
   */
  fun export(context: Context, destination: Uri): Result {
    val roots = sources(context)
    if (roots.isEmpty()) throw IOException("未找到可读取的原始会话、附件或存储目录；未创建新目录")
    val output = context.contentResolver.openOutputStream(destination, "w")
      ?: throw IOException("无法写入选中的备份文件")
    var files = 0
    var bytes = 0L
    val buffer = ByteArray(64 * 1024)
    ZipOutputStream(output.buffered()).use { zip ->
      val notice = ("DSH 离线数据救援备份\n" +
        "private/ = 应用私有 HOME，public/ = Documents/dshdata。\n" +
        "migration-backups/ = 旧版迁移中遗留的目录，原样保留以供人工核对。\n" +
        "此 ZIP 包含私人聊天内容与附件；请勿公开分享。\n" +
        "此功能只读取源文件，不会自动恢复、删除或覆盖任何数据。\n")
      zip.putNextEntry(ZipEntry("RECOVERY_README.txt"))
      zip.write(notice.toByteArray(Charsets.UTF_8))
      zip.closeEntry()
      for (root in roots) {
        val stack = ArrayDeque<Pair<File, Pair<String, Int>>>()
        stack.add(root.dir to (root.label to 0))
        while (stack.isNotEmpty()) {
          val (entry, info) = stack.removeLast()
          val (name, depth) = info
          if (java.nio.file.Files.isSymbolicLink(entry.toPath())) continue
          if (entry.isDirectory) {
            if (depth >= MAX_DEPTH) throw IOException("救援目录层级超过上限：" + name)
            val children = entry.listFiles() ?: throw IOException("无法读取目录：" + name)
            for (child in children.sortedByDescending { it.name }) {
              if (java.nio.file.Files.isSymbolicLink(child.toPath())) continue
              val safeName = child.name.replace('\\', '_')
              stack.add(child to (name + "/" + safeName to depth + 1))
            }
          } else if (entry.isFile) {
            if (files >= MAX_FILES) throw IOException("导出文件超过 " + MAX_FILES + " 个")
            val length = entry.length()
            if (length > MAX_BYTES - bytes) throw IOException("备份文件总大小超过安全上限")
            zip.putNextEntry(ZipEntry(name))
            entry.inputStream().buffered().use { input ->
              while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                if (bytes > MAX_BYTES - n) throw IOException("备份超过安全上限")
                zip.write(buffer, 0, n)
                bytes += n
              }
            }
            zip.closeEntry()
            files++
          }
        }
      }
    }
    if (files == 0) throw IOException("目录存在但未发现可导出的普通文件")
    return Result(files, bytes, roots.size)
  }
}
