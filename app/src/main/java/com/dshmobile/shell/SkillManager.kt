package com.dshmobile.shell

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.zip.ZipInputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android-side manager for the user DSH skill root.
 *
 * The manager only owns `$DSH_HOME/skills`. It never touches sessions,
 * credentials, settings, plugins or profile composition.
 */
class SkillManager(
  private val context: Context,
  private val engineManager: EngineManager,
) {
  companion object {
    private const val MAX_ARCHIVE_BYTES = 64L * 1024 * 1024
    private const val MAX_ENTRY_BYTES = 32L * 1024 * 1024
    private const val MAX_ENTRIES = 4096
    private const val MAX_FRONTMATTER_BYTES = 256 * 1024
    private val SKILL_NAME = Regex("""^[a-z0-9]+(?:-[a-z0-9]+)*$""")
  }

  private data class Metadata(
    val name: String,
    val description: String,
    val userInvocable: Boolean,
    val modelInvocable: Boolean,
  )

  private data class Candidate(
    val metadata: Metadata,
    val source: File,
    val directoryBundle: Boolean,
  )

  private val skillRoot: File
    get() = File(engineManager.ensureDshDataHome(), "skills")

  fun listJson(): String {
    return try {
      val root = ensureRoot()
      val rows = JSONArray()
      root.listFiles()
        ?.filter { !it.name.startsWith(".") }
        ?.sortedBy { it.name.lowercase() }
        ?.forEach { entry ->
          try {
            val skillFile = when {
              entry.isDirectory -> File(entry, "SKILL.md").takeIf { it.isFile }
              entry.isFile && entry.extension.equals("md", ignoreCase = true) -> entry
              else -> null
            } ?: return@forEach
            val metadata = parseMetadata(skillFile)
            rows.put(
              JSONObject()
                .put("name", metadata.name)
                .put("description", metadata.description)
                .put("userInvocable", metadata.userInvocable)
                .put("modelInvocable", metadata.modelInvocable)
                .put("format", if (entry.isDirectory) "bundle" else "file")
                .put("modifiedAt", entry.lastModified()),
            )
          } catch (t: Throwable) {
            rows.put(
              JSONObject()
                .put("name", entry.name.removeSuffix(".md"))
                .put("description", "")
                .put("invalid", true)
                .put("error", t.message ?: t.javaClass.simpleName),
            )
          }
        }
      JSONObject().put("ok", true).put("skills", rows).toString()
    } catch (t: Throwable) {
      errorJson(t)
    }
  }

  fun deleteJson(name: String): String {
    if (!validName(name)) {
      return JSONObject().put("ok", false).put("error", "Skill 名称非法").toString()
    }
    return try {
      val root = ensureRoot().canonicalFile
      val directory = File(root, name)
      val flat = File(root, "$name.md")
      val target = when {
        Files.exists(directory.toPath(), LinkOption.NOFOLLOW_LINKS) -> directory
        Files.exists(flat.toPath(), LinkOption.NOFOLLOW_LINKS) -> flat
        else -> return JSONObject().put("ok", false).put("error", "Skill 不存在：$name").toString()
      }
      requireDirectChild(root, target)
      deleteTreeNoFollow(target.toPath())
      JSONObject().put("ok", true).put("name", name).toString()
    } catch (t: Throwable) {
      errorJson(t)
    }
  }

  fun importUri(uri: Uri): String {
    val tempRoot = File(context.cacheDir, "skill-import/${UUID.randomUUID()}").apply { mkdirs() }
    return try {
      val displayName = queryDisplayName(uri) ?: "skill"
      val lower = displayName.lowercase()
      val imported = if (lower.endsWith(".zip")) {
        val extracted = File(tempRoot, "archive").apply { mkdirs() }
        context.contentResolver.openInputStream(uri)?.use { input ->
          extractZip(input, extracted)
        } ?: throw IOException("无法读取所选 Skill ZIP")
        val candidates = discoverZipCandidates(extracted)
        if (candidates.isEmpty()) throw IOException("ZIP 中没有找到有效的 SKILL.md")
        installCandidates(candidates)
      } else {
        val source = File(tempRoot, "selected.md")
        context.contentResolver.openInputStream(uri)?.use { input ->
          source.outputStream().use { output -> copyWithLimit(input, output, MAX_ARCHIVE_BYTES) }
        } ?: throw IOException("无法读取所选 Skill 文件")
        val metadata = parseMetadata(source)
        installCandidates(listOf(Candidate(metadata, source, false)))
      }

      JSONObject()
        .put("ok", true)
        .put("imported", JSONArray(imported))
        .put("message", "已安装 ${imported.size} 个 Skill")
        .toString()
    } catch (t: Throwable) {
      errorJson(t)
    } finally {
      try { deleteTreeNoFollow(tempRoot.toPath()) } catch (_: Throwable) {}
    }
  }

  private fun ensureRoot(): File {
    val root = skillRoot
    val path = root.toPath()
    if (Files.isSymbolicLink(path)) throw IOException("DSH Skill 根目录不能是符号链接")
    if (!root.exists() && !root.mkdirs()) throw IOException("无法创建 DSH Skill 目录")
    if (!root.isDirectory) throw IOException("DSH Skill 路径不是目录")
    return root
  }

  private fun installCandidates(candidates: List<Candidate>): List<String> {
    val root = ensureRoot().canonicalFile
    val names = candidates.map { it.metadata.name }
    if (names.distinct().size != names.size) throw IOException("导入包包含重复 Skill 名称")

    val installed = mutableListOf<String>()
    for (candidate in candidates) {
      val name = candidate.metadata.name
      if (!validName(name)) throw IOException("Skill 名称非法：$name")

      val directoryTarget = File(root, name)
      val fileTarget = File(root, "$name.md")
      requireDirectChild(root, directoryTarget)
      requireDirectChild(root, fileTarget)

      if (candidate.directoryBundle) {
        val incoming = File(root, ".incoming-$name-${UUID.randomUUID()}")
        copyTreeNoFollow(candidate.source.toPath(), incoming.toPath())
        parseMetadata(File(incoming, "SKILL.md"))
        replaceTarget(root, directoryTarget, fileTarget, incoming)
      } else {
        val incoming = File(root, ".incoming-$name-${UUID.randomUUID()}.md")
        candidate.source.copyTo(incoming, overwrite = true)
        parseMetadata(incoming)
        replaceTarget(root, fileTarget, directoryTarget, incoming)
      }
      installed += name
    }
    return installed
  }

  private fun replaceTarget(root: File, preferred: File, alternate: File, incoming: File) {
    val backups = mutableListOf<Pair<File, File>>()
    try {
      for (target in listOf(preferred, alternate)) {
        if (!Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) continue
        requireDirectChild(root, target)
        val backup = File(root, ".backup-${target.name}-${UUID.randomUUID()}")
        move(target.toPath(), backup.toPath())
        backups += target to backup
      }
      move(incoming.toPath(), preferred.toPath())
      for ((_, backup) in backups) deleteTreeNoFollow(backup.toPath())
    } catch (t: Throwable) {
      try {
        if (Files.exists(preferred.toPath(), LinkOption.NOFOLLOW_LINKS)) {
          deleteTreeNoFollow(preferred.toPath())
        }
      } catch (_: Throwable) {}
      for ((target, backup) in backups.asReversed()) {
        try {
          if (Files.exists(backup.toPath(), LinkOption.NOFOLLOW_LINKS)) move(backup.toPath(), target.toPath())
        } catch (_: Throwable) {}
      }
      try { if (Files.exists(incoming.toPath(), LinkOption.NOFOLLOW_LINKS)) deleteTreeNoFollow(incoming.toPath()) } catch (_: Throwable) {}
      throw t
    }
  }

  private fun discoverZipCandidates(extracted: File): List<Candidate> {
    val skillFiles = mutableListOf<File>()
    extracted.walkTopDown()
      .onEnter { dir ->
        val rel = extracted.toPath().relativize(dir.toPath()).nameCount
        rel <= 4
      }
      .forEach { file ->
        if (file.isFile && file.name == "SKILL.md") skillFiles += file
      }

    val roots = skillFiles
      .map { it.parentFile.canonicalFile }
      .sortedBy { it.toPath().nameCount }
      .filter { candidate ->
        skillFiles.none { other ->
          val parent = other.parentFile.canonicalFile
          parent != candidate && candidate.toPath().startsWith(parent.toPath())
        }
      }

    return roots.map { dir ->
      val metadata = parseMetadata(File(dir, "SKILL.md"))
      Candidate(metadata, dir, true)
    }
  }

  private fun parseMetadata(file: File): Metadata {
    if (!file.isFile) throw IOException("缺少 SKILL.md")
    val text = file.inputStream().buffered().use { input ->
      val bytes = ByteArray(MAX_FRONTMATTER_BYTES)
      val count = input.read(bytes)
      if (count <= 0) "" else String(bytes, 0, count, Charsets.UTF_8)
    }
    if (!text.startsWith("---")) throw IOException("${file.name} 缺少 YAML frontmatter")
    val end = text.indexOf("\n---", startIndex = 3)
    if (end < 0) throw IOException("${file.name} frontmatter 未闭合")
    val header = text.substring(3, end)

    fun field(name: String): String? {
      val match = Regex("""(?m)^\s*${Regex.escape(name)}\s*:\s*(.*?)\s*$""").find(header) ?: return null
      return unquote(match.groupValues[1].substringBefore(" #").trim())
    }
    fun boolField(name: String, default: Boolean): Boolean {
      return when (field(name)?.lowercase()) {
        null, "" -> default
        "true", "yes", "on", "1" -> true
        "false", "no", "off", "0" -> false
        else -> throw IOException("$name 必须是布尔值")
      }
    }

    val name = field("name") ?: throw IOException("Skill 缺少 name")
    if (!validName(name)) throw IOException("Skill name 必须使用 kebab-case：$name")
    val description = field("description")?.takeIf { it.isNotBlank() }
      ?: throw IOException("Skill 缺少 description")

    return Metadata(
      name = name,
      description = description,
      userInvocable = boolField("user-invocable", true),
      modelInvocable = !boolField("disable-model-invocation", false),
    )
  }

  private fun extractZip(input: java.io.InputStream, dest: File) {
    var entries = 0
    var total = 0L
    val root = dest.canonicalFile.toPath()

    ZipInputStream(input.buffered()).use { zip ->
      while (true) {
        val entry = zip.nextEntry ?: break
        entries++
        if (entries > MAX_ENTRIES) throw IOException("Skill ZIP 文件数量超过上限")

        val normalized = entry.name.replace('\\', '/').trimStart('/')
        if (normalized.isBlank()) {
          zip.closeEntry()
          continue
        }
        val relative = Path.of(normalized).normalize()
        if (relative.isAbsolute || relative.startsWith("..") || relative.nameCount > 32) {
          throw IOException("Skill ZIP 包含不安全路径：${entry.name}")
        }
        val target = root.resolve(relative).normalize()
        if (!target.startsWith(root)) throw IOException("Skill ZIP 路径越界：${entry.name}")

        if (entry.isDirectory) {
          Files.createDirectories(target)
        } else {
          Files.createDirectories(target.parent)
          var entryBytes = 0L
          Files.newOutputStream(target).use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val read = zip.read(buffer)
              if (read < 0) break
              if (read == 0) continue
              entryBytes += read
              total += read
              if (entryBytes > MAX_ENTRY_BYTES) throw IOException("Skill ZIP 单文件超过 32 MB")
              if (total > MAX_ARCHIVE_BYTES) throw IOException("Skill ZIP 解压后超过 64 MB")
              output.write(buffer, 0, read)
            }
          }
        }
        zip.closeEntry()
      }
    }
  }

  private fun copyWithLimit(input: java.io.InputStream, output: java.io.OutputStream, limit: Long) {
    var total = 0L
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      if (read == 0) continue
      total += read
      if (total > limit) throw IOException("Skill 文件超过 64 MB")
      output.write(buffer, 0, read)
    }
  }

  private fun copyTreeNoFollow(source: Path, target: Path) {
    Files.walkFileTree(source, object : SimpleFileVisitor<Path>() {
      override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
        if (Files.isSymbolicLink(dir)) throw IOException("Skill 包不能包含目录符号链接")
        val rel = source.relativize(dir)
        Files.createDirectories(target.resolve(rel))
        return FileVisitResult.CONTINUE
      }

      override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
        if (Files.isSymbolicLink(file)) throw IOException("Skill 包不能包含符号链接")
        val rel = source.relativize(file)
        Files.copy(file, target.resolve(rel), StandardCopyOption.REPLACE_EXISTING)
        return FileVisitResult.CONTINUE
      }
    })
  }

  private fun deleteTreeNoFollow(path: Path) {
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return
    if (Files.isSymbolicLink(path) || !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
      Files.deleteIfExists(path)
      return
    }
    Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
      override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
        Files.deleteIfExists(file)
        return FileVisitResult.CONTINUE
      }

      override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
        if (exc != null) throw exc
        Files.deleteIfExists(dir)
        return FileVisitResult.CONTINUE
      }
    })
  }

  private fun move(source: Path, target: Path) {
    try {
      Files.move(source, target, StandardCopyOption.ATOMIC_MOVE)
    } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
      Files.move(source, target)
    }
  }

  private fun requireDirectChild(root: File, child: File) {
    val parent = child.parentFile?.canonicalFile ?: throw IOException("Skill 路径无父目录")
    if (parent != root.canonicalFile) throw IOException("Skill 路径越界")
  }

  private fun queryDisplayName(uri: Uri): String? {
    return try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) null else cursor.getString(0)
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun validName(name: String): Boolean =
    name.length in 1..80 && SKILL_NAME.matches(name)

  private fun unquote(value: String): String {
    if (value.length >= 2) {
      val first = value.first()
      val last = value.last()
      if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
        return value.substring(1, value.length - 1)
      }
    }
    return value
  }

  private fun errorJson(t: Throwable): String =
    JSONObject().put("ok", false).put("error", t.message ?: t.javaClass.simpleName).toString()
}
