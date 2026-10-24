package com.dshmobile.shell.database

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import android.database.sqlite.SQLiteOpenHelper
import java.security.MessageDigest

/**
 * App-private *metadata* index. DSH owns sessions and extension files.
 * No prompts, tool arguments/results, API tokens or secrets are persisted.
 */
class MobileDatabase private constructor(context: Context) :
  SQLiteOpenHelper(context.applicationContext, FILE_NAME, null, 1) {

  data class ToolEntry(val name: String, val provider: String, val schemaHash: String = "")

  init { setWriteAheadLoggingEnabled(true) }

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    db.setForeignKeyConstraintsEnabled(true)
  }

  override fun onCreate(db: SQLiteDatabase) {
    DDL.forEach(db::execSQL)
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    throw SQLiteException("Missing explicit migration: $oldVersion to $newVersion")
  }

  override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    throw SQLiteException("Database downgrade not supported")
  }

  /** One *scoped* registry snapshot, never a claim about all live DSH tools. */
  @Synchronized fun saveSnapshot(
    scope: String, runtime: String, entries: List<ToolEntry>, complete: Boolean,
  ): Long {
    require(scope.matches(Regex("[A-Za-z0-9_.:-]{1,96}")))
    require(entries.size <= 2048)
    require(entries.map { it.name }.distinct().size == entries.size)
    require(entries.all {
      it.name.length in 1..160 && it.provider.length in 1..160 && it.schemaHash.length <= 128 &&
        it.name.none(Char::isISOControl) && it.provider.none(Char::isISOControl)
    })
    val normalized = entries.sortedBy { it.name }
    val hash = digest(normalized.joinToString("\n") { "${it.name}\t${it.provider}\t${it.schemaHash}" })
    val db = writableDatabase
    // Skip identical successive snapshots: repeated settings refreshes are
    // extremely common and should not rewrite thousands of registry entries.
    var existingId = -1L
    db.rawQuery(
      "SELECT id,registry_hash,runtime_version,is_complete FROM registry_snapshots WHERE scope=? ORDER BY id DESC LIMIT 1",
      arrayOf(scope),
    ).use { cursor ->
      if (cursor.moveToFirst() && cursor.getString(1) == hash &&
        cursor.getString(2) == runtime.take(80) &&
        cursor.getInt(3) == (if (complete) 1 else 0)) existingId = cursor.getLong(0)
    }
    if (existingId >= 0) return existingId
    db.beginTransaction()
    try {
      val values = ContentValues().apply {
        put("captured_at", System.currentTimeMillis())
        put("scope", scope)
        put("runtime_version", runtime.take(80))
        put("registry_hash", hash)
        put("tool_count", entries.size)
        put("is_complete", if (complete) 1 else 0)
      }
      val id = db.insertOrThrow("registry_snapshots", null, values)
      for (e in normalized) db.insertOrThrow("registry_entries", null, ContentValues().apply {
        put("snapshot_id", id)
        put("tool_name", e.name)
        put("provider_id", e.provider)
        put("schema_hash", e.schemaHash)
      })
      db.execSQL(
        """DELETE FROM registry_snapshots WHERE scope=?
        AND id NOT IN (SELECT id FROM registry_snapshots
        WHERE scope=? ORDER BY id DESC LIMIT 32)""", arrayOf(scope, scope),
      )
      db.setTransactionSuccessful()
      return id
    } finally { db.endTransaction() }
  }

  /**
   * Idempotent observation. A running-to-success transition updates one row;
   * session and call identifiers are SHA-256 hashed before persistence.
   */
  @Synchronized fun observe(
    sessionKey: String, callId: String, name: String, status: String, error: String?,
  ) {
    require(sessionKey.length in 1..2048 && callId.length in 1..160 && name.length in 1..160)
    require(status in setOf("running", "success", "failure"))
    require(callId.none(Char::isISOControl) && name.none(Char::isISOControl))
    val key = digest(sessionKey + "\u0000" + callId)
    val db = writableDatabase
    val now = System.currentTimeMillis()
    val values = ContentValues().apply {
      put("event_key", key)
      put("session_hash", digest(sessionKey))
      put("tool_name", name)
      put("first_seen", now)
      put("status", status)
      put("category", ToolErrorClassifier.classify(status, error))
      put("error_code", ToolErrorClassifier.safeCode(error))
      put("last_seen", now)
    }
    db.beginTransaction()
    try {
      // Terminal statuses never regress when a late DOM poll reports "running".
      val inserted = db.insertWithOnConflict(
        "tool_observations", null, values, SQLiteDatabase.CONFLICT_IGNORE,
      )
      if (inserted == -1L && status != "running") {
        val terminal = ContentValues().apply {
          put("status", status)
          put("category", ToolErrorClassifier.classify(status, error))
          put("error_code", ToolErrorClassifier.safeCode(error))
          put("last_seen", now)
        }
        db.update("tool_observations", terminal,
          "event_key=? AND status='running'", arrayOf(key))
      }
      // Amortize retention trimming: no large DELETE on every DOM observation.
      if (++observations % 128 == 0) db.execSQL(
        """DELETE FROM tool_observations WHERE event_key IN
        (SELECT event_key FROM tool_observations ORDER BY first_seen DESC
        LIMIT -1 OFFSET 10000)""",
      )
      db.setTransactionSuccessful()
    } finally { db.endTransaction() }
  }

  private var observations = 0

  @Synchronized fun counts(): Map<String, Long> {
    val db = readableDatabase
    return mapOf(
      "snapshots" to DatabaseUtils.longForQuery(db, "SELECT count(*) FROM registry_snapshots", null),
      "observations" to DatabaseUtils.longForQuery(db, "SELECT count(*) FROM tool_observations", null),
      "invalidArguments" to DatabaseUtils.longForQuery(db,
        "SELECT count(*) FROM tool_observations WHERE category='INVALID_ARGUMENT'", null),
      "sessions" to DatabaseUtils.longForQuery(db, "SELECT count(*) FROM session_index", null),
      "extensions" to DatabaseUtils.longForQuery(db, "SELECT count(*) FROM extension_inventory", null),
    )
  }

  @Synchronized fun quickCheck(): String =
    readableDatabase.rawQuery("PRAGMA quick_check(1)", null).use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0) else "no result"
    }

  companion object {
    const val FILE_NAME = "dsh-mobile.db"
    private val HEX = "0123456789abcdef".toCharArray()
    @Volatile private var instance: MobileDatabase? = null
    fun get(context: Context): MobileDatabase = instance ?: synchronized(this) {
      instance ?: MobileDatabase(context).also { instance = it }
    }

    fun digest(text: String): String {
      val bytes = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
      val chars = CharArray(bytes.size * 2)
      for (i in bytes.indices) {
        val b = bytes[i].toInt() and 255
        chars[i * 2] = HEX[b ushr 4]
        chars[i * 2 + 1] = HEX[b and 15]
      }
      return String(chars)
    }

    private val DDL = listOf(
      """CREATE TABLE registry_snapshots(
        id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at INTEGER NOT NULL,
        scope TEXT NOT NULL, runtime_version TEXT NOT NULL,
        registry_hash TEXT NOT NULL, tool_count INTEGER NOT NULL CHECK(tool_count>=0),
        is_complete INTEGER NOT NULL CHECK(is_complete IN (0,1)))""",
      "CREATE INDEX idx_registry_scope_time ON registry_snapshots(scope,id DESC)",
      """CREATE TABLE registry_entries(
        snapshot_id INTEGER NOT NULL REFERENCES registry_snapshots(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL, provider_id TEXT NOT NULL, schema_hash TEXT NOT NULL,
        PRIMARY KEY(snapshot_id,tool_name))""",
      """CREATE TABLE tool_observations(
        event_key TEXT PRIMARY KEY, session_hash TEXT NOT NULL, tool_name TEXT NOT NULL,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','success','failure')),
        category TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '')""",
      "CREATE INDEX idx_tool_name_time ON tool_observations(tool_name,last_seen DESC)",
      "CREATE INDEX idx_tool_category_time ON tool_observations(category,last_seen DESC)",
      "CREATE INDEX idx_tool_retention ON tool_observations(first_seen DESC)",
      """CREATE TABLE extension_inventory(
        kind TEXT NOT NULL, stable_id TEXT NOT NULL, version TEXT NOT NULL DEFAULT '',
        configured_enabled INTEGER NOT NULL CHECK(configured_enabled IN (0,1)),
        source TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(kind,stable_id))""",
      """CREATE TABLE session_index(
        relative_path TEXT PRIMARY KEY, modified_at INTEGER NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size>=0), observed_at INTEGER NOT NULL)""",
      "CREATE INDEX idx_session_modified ON session_index(modified_at DESC)",
      """CREATE TABLE audit_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, happened_at INTEGER NOT NULL,
        action TEXT NOT NULL, result TEXT NOT NULL)""",
      "CREATE INDEX idx_audit_time ON audit_events(happened_at DESC)",
    )
  }
}
