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
    // Large UI/documentation Skills commonly contain thousands of small
    // reference/assets files. Keep explicit anti-zip-bomb bounds, but do not
    // reject normal ~60-100 MB bundles merely because they exceed 4096 entries.
    private const val MAX_ZIP_INPUT_BYTES = 512L * 1024 * 1024
    private const val MAX_EXTRACTED_BYTES = 2L * 1024 * 1024 * 1024
    private const val MAX_ENTRY_BYTES = 512L * 1024 * 1024
    private const val MAX_ENTRIES = 50_000
    private const val MAX_FLAT_SKILL_BYTES = 16L * 1024 * 1024
    private const val MAX_FRONTMATTER_BYTES = 256 * 1024
    private val SKILL_NAME = Regex("""^[a-z0-9]+(?:-[a-z0-9]+)*$""")
  }

  private data class Metadata(
    val name: String,
    val originalName: String,
    val description: String,
    val userInvocable: Boolean,
    val modelInvocable: Boolean,
  )

  private data class Candidate(
    val metadata: Metadata,
    val source: File,
    val directoryBundle: Boolean,
  )

  private data class Discovery(
    val candidates: List<Candidate>,
    val duplicatesSkipped: Int,
    val namesNormalized: Int = 0,
    val invalidSkipped: Int = 0,
  )

  private data class ReconcileResult(
    val moved: Int = 0,
    val backupDir: File? = null,
  )

  private val skillRoot: File
    get() = File(engineManager.ensureDshDataHome(), "skills")

  /**
   * Collection folders are management metadata, not Skill discovery roots.
   * DSH's filesystem provider discovers direct children of DSH_HOME/skills;
   * nested recursive SKILL.md discovery is intentionally unsupported. Active
   * Skills therefore remain top-level while each imported ZIP gets a real
   * collection folder here that references all installed entries.
   */
  private val collectionRoot: File
    get() = File(engineManager.ensureDshDataHome(), "skill-collections")

  fun listJson(): String {
    return try {
      val root = ensureRoot()
      val repairedNames = repairLegacySkillNames(root)
      val reconciled = reconcileExistingDuplicates(root)
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
                .put("storageKey", entry.name)
                .put("modifiedAt", entry.lastModified()),
            )
          } catch (t: Throwable) {
            rows.put(
              JSONObject()
                .put("name", entry.name.removeSuffix(".md"))
                .put("description", "")
                .put("storageKey", entry.name)
                .put("invalid", true)
                .put("error", t.message ?: t.javaClass.simpleName),
            )
          }
        }
      JSONObject()
        .put("ok", true)
        .put("skills", rows)
        .put("collections", listCollectionsJson())
        .put("duplicatesQuarantined", reconciled.moved)
        .put("duplicateBackupDir", reconciled.backupDir?.absolutePath)
        .put("namesNormalized", repairedNames)
        .toString()
    } catch (t: Throwable) {
      errorJson(t)
    }
  }

  fun deleteJson(storageKey: String): String {
    if (!validStorageKey(storageKey)) {
      return JSONObject().put("ok", false).put("error", "Skill 存储名称非法").toString()
    }
    return try {
      val root = ensureRoot().canonicalFile
      val target = File(root, storageKey)
      requireDirectChild(root, target)
      if (!Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) {
        return JSONObject().put("ok", false).put("error", "Skill 不存在：$storageKey").toString()
      }
      val acceptable =
        Files.isDirectory(target.toPath(), LinkOption.NOFOLLOW_LINKS) ||
          Files.isSymbolicLink(target.toPath()) ||
          (Files.isRegularFile(target.toPath(), LinkOption.NOFOLLOW_LINKS) && target.extension.equals("md", ignoreCase = true))
      if (!acceptable) {
        return JSONObject().put("ok", false).put("error", "拒绝删除非 Skill 条目：$storageKey").toString()
      }
      deleteTreeNoFollow(target.toPath())
      removeMemberFromCollections(storageKey)
      JSONObject().put("ok", true).put("storageKey", storageKey).toString()
    } catch (t: Throwable) {
      errorJson(t)
    }
  }

  fun deleteCollectionJson(collectionId: String): String {
    if (!validCollectionId(collectionId)) {
      return JSONObject().put("ok", false).put("error", "Skill 集合名称非法").toString()
    }
    return try {
      val root = ensureCollectionRoot().canonicalFile
      val dir = File(root, collectionId)
      requireDirectChild(root, dir)
      if (!dir.isDirectory) {
        return JSONObject().put("ok", false).put("error", "Skill 集合不存在：$collectionId").toString()
      }
      val manifest = readCollectionManifest(dir)
      val members = manifest.optJSONArray("members") ?: JSONArray()
      val referencedElsewhere = collectionMemberReferences(excludeCollectionId = collectionId)
      var deleted = 0
      var keptShared = 0
      val skills = ensureRoot().canonicalFile

      for (i in 0 until members.length()) {
        val storageKey = members.optString(i).trim()
        if (!validStorageKey(storageKey)) continue
        if (storageKey in referencedElsewhere) {
          keptShared++
          continue
        }
        val target = File(skills, storageKey)
        requireDirectChild(skills, target)
        if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) {
          deleteTreeNoFollow(target.toPath())
          deleted++
        }
      }

      deleteTreeNoFollow(dir.toPath())
      JSONObject()
        .put("ok", true)
        .put("collectionId", collectionId)
        .put("deletedSkills", deleted)
        .put("sharedSkillsKept", keptShared)
        .toString()
    } catch (t: Throwable) {
      errorJson(t)
    }
  }

  private fun validStorageKey(storageKey: String): Boolean =
    storageKey.isNotBlank() &&
      storageKey.length <= 120 &&
      !storageKey.startsWith(".") &&
      !storageKey.contains('/') &&
      !storageKey.contains('\\')

  private fun ensureCollectionRoot(): File {
    val root = collectionRoot
    if (Files.isSymbolicLink(root.toPath())) throw IOException("Skill 集合根目录不能是符号链接")
    if (!root.exists() && !root.mkdirs()) throw IOException("无法创建 Skill 集合目录")
    if (!root.isDirectory) throw IOException("Skill 集合路径不是目录")
    return root
  }

  private fun validCollectionId(value: String): Boolean =
    value.length in 1..96 && Regex("""^[a-z0-9]+(?:-[a-z0-9]+)*$""").matches(value)

  private fun collectionIdFromDisplayName(displayName: String): String {
    val base = displayName
      .substringBeforeLast('.', displayName)
      .lowercase(java.util.Locale.ROOT)
      .replace(Regex("""[^a-z0-9]+"""), "-")
      .trim('-')
      .replace(Regex("""-+"""), "-")
      .take(80)
      .trimEnd('-')
    return base.takeIf { validCollectionId(it) }
      ?: "skill-pack-" + java.lang.Integer.toUnsignedString(displayName.hashCode(), 16)
  }

  private fun collectionManifestFile(dir: File): File = File(dir, "collection.json")

  private fun readCollectionManifest(dir: File): JSONObject {
    val file = collectionManifestFile(dir)
    if (!file.isFile) return JSONObject()
    return try { JSONObject(file.readText()) } catch (_: Throwable) { JSONObject() }
  }

  private fun writeCollectionManifest(
    collectionId: String,
    displayName: String,
    members: List<String>,
  ): File {
    val root = ensureCollectionRoot().canonicalFile
    val dir = File(root, collectionId)
    requireDirectChild(root, dir)
    if (!dir.exists() && !dir.mkdirs()) throw IOException("无法创建 Skill 集合：$collectionId")
    if (!dir.isDirectory || Files.isSymbolicLink(dir.toPath())) throw IOException("Skill 集合目录非法：$collectionId")

    val previous = readCollectionManifest(dir)
    val previousMembers = previous.optJSONArray("members")
    val merged = LinkedHashSet<String>()
    if (previousMembers != null) {
      for (i in 0 until previousMembers.length()) {
        previousMembers.optString(i).takeIf { validStorageKey(it) }?.let { merged += it }
      }
    }
    members.filter { validStorageKey(it) }.forEach { merged += it }

    val json = JSONObject()
      .put("id", collectionId)
      .put("displayName", displayName)
      .put("updatedAt", System.currentTimeMillis())
      .put("members", JSONArray(merged.toList()))
    val file = collectionManifestFile(dir)
    val temp = File(dir, ".collection-" + UUID.randomUUID() + ".tmp")
    try {
      temp.writeText(json.toString(2))
      try {
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
      } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
      }
    } finally {
      try { Files.deleteIfExists(temp.toPath()) } catch (_: Throwable) {}
    }
    return dir
  }

  private fun listCollectionsJson(): JSONArray {
    val rows = JSONArray()
    val root = ensureCollectionRoot()
    root.listFiles()
      ?.filter { it.isDirectory && !it.name.startsWith(".") && validCollectionId(it.name) }
      ?.sortedBy { it.name }
      ?.forEach { dir ->
        val manifest = readCollectionManifest(dir)
        val members = manifest.optJSONArray("members") ?: JSONArray()
        val live = JSONArray()
        for (i in 0 until members.length()) {
          val key = members.optString(i)
          if (!validStorageKey(key)) continue
          val target = File(skillRoot, key)
          if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) live.put(key)
        }
        rows.put(
          JSONObject()
            .put("id", dir.name)
            .put("displayName", manifest.optString("displayName", dir.name))
            .put("members", live)
            .put("count", live.length())
            .put("updatedAt", manifest.optLong("updatedAt", dir.lastModified())),
        )
      }
    return rows
  }

  private fun collectionMemberReferences(excludeCollectionId: String? = null): Set<String> {
    val refs = LinkedHashSet<String>()
    val root = ensureCollectionRoot()
    root.listFiles()
      ?.filter { it.isDirectory && it.name != excludeCollectionId }
      ?.forEach { dir ->
        val members = readCollectionManifest(dir).optJSONArray("members") ?: return@forEach
        for (i in 0 until members.length()) {
          members.optString(i).takeIf { validStorageKey(it) }?.let { refs += it }
        }
      }
    return refs
  }

  private fun removeMemberFromCollections(storageKey: String) {
    val root = ensureCollectionRoot()
    root.listFiles()?.filter { it.isDirectory }?.forEach { dir ->
      val manifest = readCollectionManifest(dir)
      val members = manifest.optJSONArray("members") ?: return@forEach
      val kept = mutableListOf<String>()
      var changed = false
      for (i in 0 until members.length()) {
        val key = members.optString(i)
        if (key == storageKey) changed = true else if (validStorageKey(key)) kept += key
      }
      if (!changed) return@forEach
      val displayName = manifest.optString("displayName", dir.name)
      if (kept.isEmpty()) {
        try { deleteTreeNoFollow(dir.toPath()) } catch (_: Throwable) {}
      } else {
        writeCollectionManifest(dir.name, displayName, kept)
      }
    }
  }

  fun importUri(uri: Uri): String {
    val tempRoot = File(context.cacheDir, "skill-import/${UUID.randomUUID()}").apply { mkdirs() }
    return try {
      val displayName = queryDisplayName(uri) ?: "skill"
      val lower = displayName.lowercase()
      val isZip = lower.endsWith(".zip")
      val discovery = if (isZip) {
        queryContentSize(uri)?.let { size ->
          if (size > MAX_ZIP_INPUT_BYTES) throw IOException("Skill ZIP 超过 512 MB 导入上限")
        }
        val extracted = File(tempRoot, "archive").apply { mkdirs() }
        context.contentResolver.openInputStream(uri)?.use { input ->
          extractZip(input, extracted)
        } ?: throw IOException("无法读取所选 Skill ZIP")
        discoverZipCandidates(extracted)
      } else {
        val source = File(tempRoot, "selected.md")
        context.contentResolver.openInputStream(uri)?.use { input ->
          source.outputStream().use { output -> copyWithLimit(input, output, MAX_FLAT_SKILL_BYTES) }
        } ?: throw IOException("无法读取所选 Skill 文件")
        val metadata = parseMetadata(source)
        Discovery(
          listOf(Candidate(metadata, source, false)),
          duplicatesSkipped = 0,
          namesNormalized = if (metadata.originalName != metadata.name) 1 else 0,
          invalidSkipped = 0,
        )
      }

      if (discovery.candidates.isEmpty()) throw IOException("没有找到有效的 Skill")
      val installed = installCandidates(discovery.candidates)
      val reconciled = reconcileExistingDuplicates(ensureRoot())
      val collectionId = if (isZip) collectionIdFromDisplayName(displayName) else null
      if (collectionId != null) {
        writeCollectionManifest(
          collectionId,
          displayName.substringBeforeLast('.', displayName),
          installed,
        )
      }

      JSONObject()
        .put("ok", true)
        .put("imported", JSONArray(installed))
        .put("collectionId", collectionId)
        .put("duplicatesSkipped", discovery.duplicatesSkipped)
        .put("namesNormalized", discovery.namesNormalized)
        .put("invalidSkipped", discovery.invalidSkipped)
        .put("duplicatesQuarantined", reconciled.moved)
        .put("duplicateBackupDir", reconciled.backupDir?.absolutePath)
        .put(
          "message",
          buildString {
            append("已安装 ${installed.size} 个 Skill")
            if (collectionId != null) append("，已创建集合文件夹 ").append(collectionId)
            if (discovery.namesNormalized > 0) append("，已规范化 ${discovery.namesNormalized} 个旧式 Skill 名")
            if (discovery.duplicatesSkipped > 0) append("，已自动合并 ${discovery.duplicatesSkipped} 个重复 Skill 名")
            if (discovery.invalidSkipped > 0) append("，已跳过 ${discovery.invalidSkipped} 个无法安全修复的无效条目")
            if (reconciled.moved > 0) append("，并备份隔离 ${reconciled.moved} 个旧重复项")
          },
        )
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
    // Discovery already selects one canonical candidate per name. Keep this
    // defensive distinctBy so future callers can never fail the whole import
    // just because the source bundle repeats a Skill name.
    val uniqueCandidates = candidates.distinctBy { it.metadata.name }

    val installed = mutableListOf<String>()
    for (candidate in uniqueCandidates) {
      val name = candidate.metadata.name
      if (!validName(name)) throw IOException("Skill 名称非法：$name")

      val directoryTarget = File(root, name)
      val fileTarget = File(root, "$name.md")
      requireDirectChild(root, directoryTarget)
      requireDirectChild(root, fileTarget)

      if (candidate.directoryBundle) {
        val incoming = File(root, ".incoming-$name-${UUID.randomUUID()}")
        copyTreeNoFollow(candidate.source.toPath(), incoming.toPath())
        val incomingSkill = File(incoming, "SKILL.md")
        rewriteSkillMetadata(incomingSkill, name, candidate.metadata.description)
        parseMetadata(incomingSkill)
        replaceTarget(root, directoryTarget, fileTarget, incoming)
      } else {
        val incoming = File(root, ".incoming-$name-${UUID.randomUUID()}.md")
        candidate.source.copyTo(incoming, overwrite = true)
        rewriteSkillMetadata(incoming, name, candidate.metadata.description)
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

  /**
   * Discover Skill roots and collapse duplicate frontmatter names.
   *
   * Large community collections often vendor the same Skill through several
   * mirrors (for example top-level skills/, repository copies, contrib/, embed/).
   * DSH identifies Skills by frontmatter name, so installing every physical
   * copy would create an ambiguous duplicate-name set. Prefer the canonical
   * source deterministically and keep exactly one active Skill per name.
   */
  private fun discoverZipCandidates(extracted: File): Discovery {
    val skillFiles = mutableListOf<File>()
    extracted.walkTopDown()
      .onEnter { dir ->
        val rel = extracted.toPath().relativize(dir.toPath()).nameCount
        rel <= 8
      }
      .forEach { file ->
        if (file.isFile && file.name == "SKILL.md") skillFiles += file
      }

    // If a parent Skill bundle is found, nested SKILL.md files are resources,
    // not separate install roots.
    val roots = skillFiles
      .map { it.parentFile.canonicalFile }
      .sortedBy { it.toPath().nameCount }
      .filter { candidate ->
        skillFiles.none { other ->
          val parent = other.parentFile.canonicalFile
          parent != candidate && candidate.toPath().startsWith(parent.toPath())
        }
      }

    var invalidSkipped = 0
    val raw = roots.mapNotNull { dir ->
      try {
        val metadata = parseMetadata(File(dir, "SKILL.md"))
        Candidate(metadata, dir, true)
      } catch (_: Throwable) {
        invalidSkipped++
        null
      }
    }

    val selected = raw
      .groupBy { it.metadata.name }
      .values
      .map { group ->
        group.minWithOrNull(
          compareBy<Candidate> { candidatePenalty(extracted, it) }
            .thenBy { extracted.toPath().relativize(it.source.toPath()).nameCount }
            .thenBy { extracted.toPath().relativize(it.source.toPath()).toString() },
        ) ?: group.first()
      }
      .sortedBy { it.metadata.name }

    return Discovery(
      candidates = selected,
      duplicatesSkipped = (raw.size - selected.size).coerceAtLeast(0),
      namesNormalized = raw.count { it.metadata.originalName != it.metadata.name },
      invalidSkipped = invalidSkipped,
    )
  }

  /**
   * Lower is better. Prefer curated top-level skills/ trees and avoid mirrors,
   * vendored copies, tests, backups and embedded/contrib replicas.
   */
  private fun candidatePenalty(extracted: File, candidate: Candidate): Int {
    val relative = try {
      extracted.toPath().relativize(candidate.source.toPath())
    } catch (_: Throwable) {
      candidate.source.toPath()
    }
    val segments = relative.map { it.toString().lowercase() }.toList()
    val mirrorSegments = setOf(
      "repo", "repos", "vendor", "vendors", "node_modules", "backup", "backups",
      "example", "examples", "test", "tests", "contrib", "embed", "embedded",
    )
    var penalty = segments.count { it in mirrorSegments } * 100
    if (!candidate.source.name.equals(candidate.metadata.name, ignoreCase = true)) penalty += 25
    if (candidate.source.parentFile?.name.equals("skills", ignoreCase = true)) penalty -= 40
    return penalty
  }

  /**
   * Repair duplicate names left by older builds without deleting user data.
   * One canonical entry stays active under skills/; extra physical entries are
   * moved outside the watched Skill root into a timestamped backup directory.
   */
  private fun reconcileExistingDuplicates(root: File): ReconcileResult {
    val valid = root.listFiles()
      ?.filter { !it.name.startsWith(".") }
      ?.mapNotNull { entry ->
        try {
          val skillFile = when {
            entry.isDirectory -> File(entry, "SKILL.md").takeIf { it.isFile }
            entry.isFile && entry.extension.equals("md", ignoreCase = true) -> entry
            else -> null
          } ?: return@mapNotNull null
          Triple(entry, parseMetadata(skillFile), entry.lastModified())
        } catch (_: Throwable) {
          null
        }
      }
      .orEmpty()

    val duplicates = valid.groupBy { it.second.name }.values.filter { it.size > 1 }
    if (duplicates.isEmpty()) return ReconcileResult()

    val backupRoot = File(
      engineManager.ensureDshDataHome(),
      "skill-duplicates-backup/${System.currentTimeMillis()}",
    ).apply { mkdirs() }
    var moved = 0

    for (group in duplicates) {
      val name = group.first().second.name
      val keep = group.minWithOrNull(
        compareBy<Triple<File, Metadata, Long>> {
          when {
            it.first.name == name -> 0
            it.first.name == "$name.md" -> 1
            else -> 10
          }
        }.thenByDescending { it.third }
          .thenBy { it.first.name },
      ) ?: group.first()

      for (item in group) {
        if (item.first == keep.first) continue
        val source = item.first
        requireDirectChild(root.canonicalFile, source)
        var target = File(backupRoot, source.name)
        var suffix = 2
        while (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) {
          target = File(backupRoot, "${source.name}.${suffix++}")
        }
        move(source.toPath(), target.toPath())
        moved++
      }
    }

    return ReconcileResult(moved = moved, backupDir = backupRoot.takeIf { moved > 0 })
  }

  /**
   * Repair legacy frontmatter names such as read_data -> read-data in place.
   * Storage entries are not deleted or replaced; only the name field is
   * canonicalized, then normal duplicate reconciliation handles collisions.
   */
  private fun repairLegacySkillNames(root: File): Int {
    var repaired = 0
    root.listFiles()
      ?.filter { !it.name.startsWith(".") }
      ?.forEach { entry ->
        try {
          val skillFile = when {
            entry.isDirectory -> File(entry, "SKILL.md").takeIf { it.isFile }
            entry.isFile && entry.extension.equals("md", ignoreCase = true) -> entry
            else -> null
          } ?: return@forEach
          val metadata = parseMetadata(skillFile)
          val hasExplicitName = skillFile.inputStream().bufferedReader().useLines { lines ->
            lines.take(80).any { Regex("""^\s*name\s*:""").containsMatchIn(it) }
          }
          if (!hasExplicitName || metadata.originalName != metadata.name) {
            rewriteSkillMetadata(skillFile, metadata.name, metadata.description)
            repaired++
          }
        } catch (_: Throwable) {
          // Truly invalid/non-ASCII names remain visible as invalid instead of
          // being guessed into a potentially wrong identity.
        }
      }
    return repaired
  }

  /**
   * Convert common legacy Skill identifiers to the DSH kebab-case contract.
   * Underscores, spaces, dots and other ASCII punctuation collapse to '-'.
   * Non-ASCII identifiers are not transliterated because doing so can silently
   * merge unrelated Skills.
   */
  /**
   * Legacy/community Skill packs may omit the frontmatter name.
   * Derive a deterministic identity from the bundle directory first, then
   * from the first Markdown H1. Installation writes the canonical name back.
   */
  private fun deriveSkillDescription(text: String, canonicalName: String, frontmatterEnd: Int): String {
    val body = if (frontmatterEnd >= 0) text.substring(frontmatterEnd + 4) else text
    val first = body.lineSequence()
      .map { it.trim() }
      .filter { it.isNotBlank() }
      .filterNot { it.startsWith("#") || it.startsWith("```") || it == "---" }
      .firstOrNull()
      ?.replace(Regex("""[*_\x60]+"""), "")
      ?.trim()
      .orEmpty()
    return first.takeIf { it.isNotBlank() }?.take(240)
      ?: "Imported Skill: $canonicalName"
  }

  private fun deriveSkillName(file: File, text: String): String {
    val parent = file.parentFile?.name.orEmpty()
      .removeSuffix(".skill")
      .removeSuffix("-skill")
      .trim()
    val parentNormalized = normalizeSkillName(parent)
    if (validName(parentNormalized) && parentNormalized !in setOf("skills", "skill", "src", "docs")) {
      return parent
    }

    val h1 = Regex("""(?m)^#\s+(.+?)\s*$""")
      .find(text)
      ?.groupValues
      ?.getOrNull(1)
      ?.replace(Regex("""[\x60*_~]"""), "")
      ?.trim()
      .orEmpty()
    if (h1.isNotBlank() && validName(normalizeSkillName(h1))) return h1

    throw IOException("Skill 缺少 name，且无法从目录名或一级标题推导")
  }

  private fun normalizeSkillName(raw: String): String {
    val trimmed = raw.trim().lowercase(java.util.Locale.ROOT)
    if (validName(trimmed)) return trimmed
    val normalized = trimmed
      .replace(Regex("""[^a-z0-9]+"""), "-")
      .trim('-')
      .replace(Regex("""-+"""), "-")
    if (normalized.length <= 80) return normalized
    return normalized.take(80).trimEnd('-')
  }

  /** Rewrite only the YAML frontmatter name field using an atomic replace. */
  private fun rewriteSkillMetadata(file: File, canonicalName: String, description: String) {
    if (!file.isFile) throw IOException("缺少 SKILL.md")
    val text = file.readText()
    if (!text.startsWith("---")) {
      val prefix = buildString {
        append("---\n")
        append("name: ").append(canonicalName).append('\n')
        append("description: ").append(JSONObject.quote(description)).append('\n')
        append("---\n\n")
      }
      writeSkillTextAtomic(file, prefix + text)
      return
    }
    val end = text.indexOf("\n---", startIndex = 3)
    if (end < 0) throw IOException("${file.name} frontmatter 未闭合")

    val header = text.substring(0, end)
    val pattern = Regex("""(?m)^(\s*name\s*:\s*).*$""")
    val match = pattern.find(header)
    val updatedHeader = if (match == null) {
      val prefix = if (header.endsWith("\n")) header else header + "\n"
      prefix + "name: " + canonicalName
    } else {
      val current = unquote(match.value.substringAfter(':').substringBefore(" #").trim())
      if (current == canonicalName) return
      val replacement = match.groupValues[1] + canonicalName
      header.substring(0, match.range.first) +
        replacement +
        header.substring(match.range.last + 1)
    }
    val descriptionPattern = Regex("""(?m)^(\s*description\s*:\s*).*$""")
    val withDescription = if (descriptionPattern.containsMatchIn(updatedHeader)) {
      updatedHeader
    } else {
      updatedHeader + "\ndescription: " + JSONObject.quote(description)
    }
    val updated = withDescription + text.substring(end)

    writeSkillTextAtomic(file, updated)
  }

  private fun writeSkillTextAtomic(file: File, text: String) {
    val temp = File(file.parentFile, ".${file.name}.metadata-${UUID.randomUUID()}.tmp")
    try {
      temp.writeText(text)
      try {
        Files.move(
          temp.toPath(),
          file.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING,
        )
      } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
      }
    } finally {
      try { Files.deleteIfExists(temp.toPath()) } catch (_: Throwable) {}
    }
  }

  private fun parseMetadata(file: File): Metadata {
    if (!file.isFile) throw IOException("缺少 SKILL.md")
    val text = file.inputStream().buffered().use { input ->
      val bytes = ByteArray(MAX_FRONTMATTER_BYTES)
      val count = input.read(bytes)
      if (count <= 0) "" else String(bytes, 0, count, Charsets.UTF_8)
    }
    val hasFrontmatter = text.startsWith("---")
    val end = if (hasFrontmatter) text.indexOf("\n---", startIndex = 3) else -1
    if (hasFrontmatter && end < 0) throw IOException("${file.name} frontmatter 未闭合")
    val header = if (hasFrontmatter) text.substring(3, end) else ""

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

    val originalName = field("name")?.takeIf { it.isNotBlank() }
      ?: deriveSkillName(file, text)
    val name = normalizeSkillName(originalName)
    if (!validName(name)) {
      throw IOException("Skill name 无法安全转换为 kebab-case：$originalName")
    }
    val description = field("description")?.takeIf { it.isNotBlank() && it !in setOf("|", ">") }
      ?: deriveSkillDescription(text, name, end)

    return Metadata(
      name = name,
      originalName = originalName,
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
        if (entries > MAX_ENTRIES) throw IOException("Skill ZIP 文件数量超过 $MAX_ENTRIES 个上限")

        val normalized = entry.name.replace('\\', '/').trimStart('/')
        if (normalized.isBlank()) {
          zip.closeEntry()
          continue
        }
        val relative = java.nio.file.Paths.get(normalized).normalize()
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
              if (entryBytes > MAX_ENTRY_BYTES) throw IOException("Skill ZIP 单文件超过 512 MB")
              if (total > MAX_EXTRACTED_BYTES) throw IOException("Skill ZIP 解压后超过 2 GB")
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
      if (total > limit) throw IOException("单文件 Skill 超过 16 MB")
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

  private fun queryContentSize(uri: Uri): Long? {
    return try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst() || cursor.isNull(0)) null else cursor.getLong(0)
      }
    } catch (_: Throwable) {
      null
    }
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
