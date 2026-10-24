package com.dshmobile.shell.database

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import com.dshmobile.shell.EngineManager
import java.io.File
import java.nio.file.Files
import java.util.ArrayDeque

/**
 * Read-only projection of DSH-owned files into the Android metadata index.
 * A partial/inaccessible scan never deletes previously indexed entries.
 */
class MobileIndexService(private val engine: EngineManager, private val store: MobileDatabase) {
  data class Report(
    val indexedSessions: Int, val indexedExtensions: Int,
    val bundledTools: Int, val sessionScanComplete: Boolean,
  )

  private data class Extension(val kind: String, val id: String, val version: String, val enabled: Boolean)

  fun refresh(): Report {
    val home = engine.ensureDshDataHome()
    val sessions = collectSessions(File(home, "sessions"))
    val extensions = collectExtensions(home)
    val now = System.currentTimeMillis()
    synchronized(store) {
      val db = store.writableDatabase
      db.beginTransaction()
      try {
        // Read the previous index in one cursor pass. Unchanged files must
        // cause ZERO database writes; this matters for 10k+ session folders.
        val staleSessions = HashMap<String, Pair<Long, Long>>()
        db.rawQuery("SELECT relative_path, modified_at, byte_size FROM session_index", null).use { c ->
          while (c.moveToNext()) staleSessions[c.getString(0)] = c.getLong(1) to c.getLong(2)
        }
        for ((path, file) in sessions.first) {
          val modified = file.lastModified()
          val bytes = file.length()
          val previous = staleSessions.remove(path)
          if (previous?.first == modified && previous.second == bytes) continue
          val v = ContentValues().apply {
            put("relative_path", path)
            put("modified_at", modified)
            put("byte_size", bytes)
            put("observed_at", now)
          }
          db.insertWithOnConflict("session_index", null, v, SQLiteDatabase.CONFLICT_REPLACE)
        }
        if (sessions.second && staleSessions.isNotEmpty()) {
          // SQLite host-variable limits differ across Android versions.
          // Delete stale entries in bounded batches instead of one giant IN.
          val keys = staleSessions.keys.iterator()
          while (keys.hasNext()) {
            val batch = ArrayList<String>(400)
            while (keys.hasNext() && batch.size < 400) batch += keys.next()
            val slots = List(batch.size) { "?" }.joinToString(",")
            db.delete("session_index", "relative_path IN ($slots)", batch.toTypedArray())
          }
        }
        for (entry in extensions.first) {
          db.insertWithOnConflict("extension_inventory", null, ContentValues().apply {
            put("kind", entry.kind)
            put("stable_id", entry.id)
            put("version", entry.version)
            put("configured_enabled", if (entry.enabled) 1 else 0)
            put("source", "filesystem/configured")
            put("observed_at", now)
          }, SQLiteDatabase.CONFLICT_REPLACE)
        }
        for (kind in extensions.second) {
          db.delete("extension_inventory", "kind=? AND observed_at != ?",
            arrayOf(kind, now.toString()))
        }
        db.setTransactionSuccessful()
      } finally { db.endTransaction() }
    }

    // Separate complete *script declarations*, not the full live DSH registry.
    var bundled = 0
    for ((scope, path) in listOf(
      "declared.mcp.mobile_tools" to "toolbox-mcp.mjs",
      "declared.mcp.basic_tools" to "basic-toolbox-mcp.mjs",
    )) {
      val file = File(engine.usrDir, "libexec/dsh-mobile/$path")
      if (!file.isFile || file.length() !in 1..2_000_000) continue
      val text = try { file.readText() } catch (_: Exception) { continue }
      if (!text.contains("const tools=[")) continue
      val names = Regex("""\{name:'([A-Za-z0-9_-]{1,160})'""")
        .findAll(text).map { it.groupValues[1] }.toList()
      if (names.isEmpty() || names.size != names.distinct().size) continue
      store.saveSnapshot(scope, engine.dshVersion(),
        names.map { MobileDatabase.ToolEntry(it, scope) }, complete = true)
      bundled += names.size
    }
    return Report(sessions.first.size, extensions.first.size, bundled, sessions.second)
  }

  private fun collectSessions(root: File): Pair<List<Pair<String, File>>, Boolean> {
    // DSH deliberately symlinks its *session root* to public Documents/dshdata.
    // Resolve only that entry point, while rejecting links below the root.
    val canonical = try { root.canonicalFile } catch (_: Exception) { return emptyList<Pair<String,File>>() to false }
    val publicSessionRoot = File(engine.dshDataDir, "sessions")
    val allowed = (canonical == publicSessionRoot.canonicalFile &&
      !Files.isSymbolicLink(publicSessionRoot.toPath())) ||
      (!Files.isSymbolicLink(root.toPath()) &&
        canonical.toPath().startsWith(File(engine.homeDir, ".dsh").canonicalFile.toPath()))
    if (!allowed || !canonical.isDirectory) return emptyList<Pair<String,File>>() to false
    val found = ArrayList<Pair<String, File>>()
    val queue = ArrayDeque<Pair<File, Int>>()
    queue.add(canonical to 0)
    var complete = true
    while (queue.isNotEmpty()) {
      val (dir, depth) = queue.removeFirst()
      val files = dir.listFiles()
      if (files == null) { complete = false; continue }
      for (f in files) {
        if (Files.isSymbolicLink(f.toPath())) {
          // A skipped subtree makes the scan incomplete; do not prune metadata
          // that may be behind the link or held from a previous complete scan.
          complete = false
          continue
        }
        if (f.isDirectory && depth < 5) queue.add(f to depth + 1)
        else if (f.isDirectory) complete = false
        else if (f.isFile) {
          val relative = canonical.toPath().relativize(f.toPath()).toString()
          if (relative.length <= 512) found += relative to f else complete = false
        }
        if (found.size + queue.size >= 20000) { complete = false; break }
      }
      if (!complete && found.size + queue.size >= 20000) break
    }
    return found to complete
  }

  private fun collectExtensions(home: File): Pair<List<Extension>, Set<String>> {
    val items = mutableListOf<Extension>()
    val fullKinds = mutableSetOf<String>()
    val profile = File(engine.homeDir, ".dsh/profiles/web/package.json")
    if (profile.isFile) {
      // A broken package.json must not wipe the previous plugin inventory.
      val manifest = runCatching { org.json.JSONObject(profile.readText()) }.getOrNull()
      if (manifest?.optJSONObject("dependencies") != null) {
        engine.listPluginBundles().forEach { p ->
          items += Extension("plugin", p.name, p.version, p.enabled)
        }
        fullKinds += "plugin"
      }
    }
    val root = File(home, "skills")
    if (root.isDirectory && !Files.isSymbolicLink(root.toPath())) {
      val files = root.listFiles()
      if (files != null && files.size <= 20000) {
        for (f in files) {
          if (Files.isSymbolicLink(f.toPath()) || f.name.startsWith(".")) continue
          val valid = if (f.isDirectory) File(f, "SKILL.md").isFile
            else f.isFile && f.extension.equals("md", true)
          if (valid && f.name.length <= 160) items += Extension("skill", f.name, "", true)
        }
        fullKinds += "skill"
      }
    }
    if (engine.mcpConfigurationIssue() == null) {
      engine.listMcpServers().forEach { s ->
        items += Extension("mcp", s.id, s.transport, s.enabled)
      }
      items += Extension("mcp", "mobile_tools", "builtin", engine.mcpToolboxEnabled())
      items += Extension("mcp", "basic_tools", "builtin", engine.mcpToolboxEnabled())
      fullKinds += "mcp"
    }
    return items to fullKinds
  }
}
