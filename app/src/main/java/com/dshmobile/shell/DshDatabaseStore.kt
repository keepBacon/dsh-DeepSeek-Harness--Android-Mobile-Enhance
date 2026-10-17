package com.dshmobile.shell

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/**
 * Host-owned database. No WebView JS, MCP process or model is handed a raw
 * SQLite handle. All model calls must supply a validated access context and
 * explicit host-issued authorization for changes.
 *
 * File payloads and secret values are deliberately NOT part of this schema:
 * files are imported by the host in a subsequent phase; credential operations
 * require a separate Android Keystore broker. A special record stores ONLY a
 * provider/alias reference, never an access token.
 */
internal class DshDatabaseStore(context: Context) :
  SQLiteOpenHelper(context.applicationContext, "dsh_user_data.db", null, 1) {

  companion object {
    const val DEFAULT_PARTITION = "long_term_memory"
    const val MAX_TEXT_BYTES = 256 * 1024
    const val MAX_DESCRIPTION = 2048
    const val MAX_TITLE = 180
    const val MAX_PAGE = 100
    const val MAX_PARTITIONS = 64
    const val MAX_ENTRIES = 10000
    private val scopeKinds = setOf("global", "conversation", "workspace")
    private val dataKinds = setOf("text", "file", "special")
    private val importanceKinds = setOf("low", "normal", "high", "critical")
  }

  /** A read only object is never accepted as write consent. */
  data class AccessContext(
    val conversationId: String? = null,
    val workspaceId: String? = null,
    val actor: String = "user",
  )

  /** This object is only created at the UI authorization boundary. */
  class WriteAuthorization private constructor(
    internal val issuedAtElapsed: Long,
    internal val scope: String,
  ) {
    companion object {
      fun fromConfirmedUserAction(scope: String): WriteAuthorization {
        require(scope.isNotBlank() && scope.length <= 120)
        return WriteAuthorization(SystemClock.elapsedRealtime(), scope)
      }
    }
    internal fun check(required: String) {
      require(scope == required) { "Authorization scope mismatch" }
      require(SystemClock.elapsedRealtime() - issuedAtElapsed in 0..120_000L) {
        "Authorization expired"
      }
    }
  }

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    db.setForeignKeyConstraintsEnabled(true)
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("""
      CREATE TABLE partitions (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        importance TEXT NOT NULL DEFAULT 'normal'
          CHECK(importance IN ('low','normal','high','critical')),
        access_mode TEXT NOT NULL DEFAULT 'global'
          CHECK(access_mode IN ('global','conversation','workspace')),
        access_id TEXT,
        allow_model_read INTEGER NOT NULL DEFAULT 0 CHECK(allow_model_read IN (0,1)),
        require_write_confirmation INTEGER NOT NULL DEFAULT 1
          CHECK(require_write_confirmation IN (0,1)),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    """.trimIndent())
    db.execSQL("""
      CREATE TABLE entries (
        id TEXT PRIMARY KEY NOT NULL,
        partition_id TEXT NOT NULL REFERENCES partitions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('text','file','special')),
        title TEXT NOT NULL,
        text_body TEXT,
        external_ref TEXT,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (kind='text' AND text_body IS NOT NULL AND external_ref IS NULL)
          OR (kind IN ('file','special') AND text_body IS NULL
              AND external_ref IS NOT NULL)
        )
      )
    """.trimIndent())
    db.execSQL("CREATE INDEX idx_entry_partition ON entries(partition_id, updated_at DESC)")
    db.execSQL("CREATE INDEX idx_partition_access ON partitions(access_mode, access_id)")
    val now = System.currentTimeMillis()
    val row = ContentValues().apply {
      put("id", DEFAULT_PARTITION)
      put("title", "长期记忆")
      put("description", "长期记忆、项目规则与用户明确保存的设计准则。模型读取需要符合访问范围；模型写入必须先取得用户授权。")
      put("importance", "high")
      put("access_mode", "global")
      put("allow_model_read", 0)
      put("require_write_confirmation", 1)
      put("is_default", 1)
      put("created_at", now)
      put("updated_at", now)
    }
    db.insertOrThrow("partitions", null, row)
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // Do not destroy user data during future schema migrations.
    throw IllegalStateException("Explicit database migration required: $oldVersion -> $newVersion")
  }

  @Synchronized
  fun listPartitions(context: AccessContext = AccessContext(), forModel: Boolean = false): JSONArray {
    val result = JSONArray()
    readableDatabase.rawQuery(
      "SELECT id,title,description,importance,access_mode,access_id,allow_model_read,require_write_confirmation,is_default FROM partitions ORDER BY is_default DESC,updated_at DESC",
      null,
    ).use { cursor ->
      while (cursor.moveToNext()) {
        val mode = cursor.getString(4)
        val scope = if (cursor.isNull(5)) null else cursor.getString(5)
        val readable = cursor.getInt(6) == 1
        if (forModel && (!readable || !inScope(mode, scope, context))) continue
        result.put(JSONObject().apply {
          put("id", cursor.getString(0))
          put("title", cursor.getString(1))
          put("description", cursor.getString(2))
          put("importance", cursor.getString(3))
          put("accessMode", mode)
          put("accessId", scope)
          put("allowModelRead", readable)
          put("requireWriteConfirmation", cursor.getInt(7) == 1)
          put("isDefault", cursor.getInt(8) == 1)
        })
      }
    }
    return result
  }

  private fun inScope(mode: String, scope: String?, context: AccessContext): Boolean =
    when (mode) {
      "global" -> true
      "conversation" -> scope != null && scope == context.conversationId
      "workspace" -> scope != null && scope == context.workspaceId
      else -> false
    }

  private fun cleanText(value: String, label: String, maxBytes: Int): String {
    val clean = value.trim()
    require(clean.isNotEmpty() && clean.toByteArray(Charsets.UTF_8).size <= maxBytes) { "Invalid $label" }
    return clean
  }

  @Synchronized
  fun createPartition(
    title: String,
    description: String,
    importance: String = "normal",
    accessMode: String = "global",
    accessId: String? = null,
    allowModelRead: Boolean = false,
    authorization: WriteAuthorization,
  ): String {
    authorization.check("partition:create")
    require(importance in importanceKinds && accessMode in scopeKinds)
    require((accessMode == "global" && accessId == null) ||
      (accessMode != "global" && !accessId.isNullOrBlank() && accessId.length <= 120))
    require(description.toByteArray(Charsets.UTF_8).size <= MAX_DESCRIPTION)
    val db = writableDatabase
    db.beginTransaction()
    try {
      db.rawQuery("SELECT count(*) FROM partitions", null).use {
        require(it.moveToFirst() && it.getInt(0) < MAX_PARTITIONS) { "Partition limit reached" }
      }
      val id = UUID.randomUUID().toString()
      val now = System.currentTimeMillis()
      db.insertOrThrow("partitions", null, ContentValues().apply {
        put("id", id)
        put("title", cleanText(title, "title", MAX_TITLE))
        put("description", description)
        put("importance", importance)
        put("access_mode", accessMode)
        put("access_id", accessId)
        put("allow_model_read", if (allowModelRead) 1 else 0)
        put("require_write_confirmation", 1)
        put("is_default", 0)
        put("created_at", now)
        put("updated_at", now)
      })
      db.setTransactionSuccessful()
      return id
    } finally {
      db.endTransaction()
    }
  }

  private fun findPartition(id: String): Triple<String, String?, Boolean> {
    readableDatabase.rawQuery(
      "SELECT access_mode, access_id, allow_model_read FROM partitions WHERE id=?",
      arrayOf(id),
    ).use {
      require(it.moveToFirst()) { "Partition not found" }
      return Triple(it.getString(0), if (it.isNull(1)) null else it.getString(1), it.getInt(2) == 1)
    }
  }

  @Synchronized
  fun listEntries(
    partitionId: String,
    context: AccessContext = AccessContext(),
    forModel: Boolean = false,
    limit: Int = 40,
    offset: Int = 0,
  ): JSONArray {
    require(limit in 1..MAX_PAGE && offset in 0..100000)
    val (mode, scope, modelRead) = findPartition(partitionId)
    if (forModel) require(modelRead && inScope(mode, scope, context)) { "Model read denied" }
    val result = JSONArray()
    readableDatabase.rawQuery(
      "SELECT id,kind,title,text_body,external_ref,description,created_at,updated_at FROM entries WHERE partition_id=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
      arrayOf(partitionId, limit.toString(), offset.toString()),
    ).use { cursor ->
      while (cursor.moveToNext()) {
        result.put(JSONObject().apply {
          put("id", cursor.getString(0))
          put("kind", cursor.getString(1))
          put("title", cursor.getString(2))
          // A special item NEVER returns its sensitive reference to a model.
          put("text", if (cursor.getString(1) == "text") cursor.getString(3) else JSONObject.NULL)
          put("externalRef", if (forModel || cursor.getString(1) == "special") JSONObject.NULL else cursor.getString(4))
          put("description", cursor.getString(5))
          put("createdAt", cursor.getLong(6))
          put("updatedAt", cursor.getLong(7))
        })
      }
    }
    return result
  }

  @Synchronized
  fun upsertText(
    partitionId: String,
    title: String,
    body: String,
    authorization: WriteAuthorization,
    entryId: String? = null,
  ): String {
    authorization.check("entry:write:$partitionId")
    findPartition(partitionId)
    val value = cleanText(body, "text", MAX_TEXT_BYTES)
    val name = cleanText(title, "title", MAX_TITLE)
    val db = writableDatabase
    db.beginTransaction()
    try {
      val now = System.currentTimeMillis()
      val id = entryId ?: UUID.randomUUID().toString()
      if (entryId != null) {
        val update = ContentValues().apply {
          put("title", name)
          put("text_body", value)
          put("updated_at", now)
        }
        require(db.update("entries", update, "id=? AND partition_id=? AND kind='text'",
          arrayOf(entryId, partitionId)) == 1) { "Text entry not found" }
      } else {
        db.rawQuery("SELECT count(*) FROM entries", null).use {
          require(it.moveToFirst() && it.getInt(0) < MAX_ENTRIES) { "Entry limit reached" }
        }
        db.insertOrThrow("entries", null, ContentValues().apply {
          put("id", id)
          put("partition_id", partitionId)
          put("kind", "text")
          put("title", name)
          put("text_body", value)
          putNull("external_ref")
          put("description", "")
          put("created_at", now)
          put("updated_at", now)
        })
      }
      db.setTransactionSuccessful()
      return id
    } finally {
      db.endTransaction()
    }
  }

  /**
   * File and special entries are references only. The file bytes are never
   * held in SQLite; their import must go through DshDatabaseAttachments.
   * A special alias is a Keystore-broker lookup key, NOT a secret itself.
   */
  @Synchronized
  fun insertReference(
    partitionId: String,
    kind: String,
    title: String,
    description: String,
    reference: String,
    authorization: WriteAuthorization,
  ): String {
    authorization.check("entry:write:$partitionId")
    require(kind in dataKinds && kind != "text")
    require(description.toByteArray(Charsets.UTF_8).size <= MAX_DESCRIPTION)
    require(reference.length in 8..220 && reference.matches(Regex("[a-zA-Z0-9:_./-]+")))
    require(
      (kind == "file" && reference.startsWith("attachment:")) ||
      (kind == "special" && reference.startsWith("keystore:"))
    ) { "Reference type does not match entry kind" }
    findPartition(partitionId)
    val id = UUID.randomUUID().toString()
    val now = System.currentTimeMillis()
    val db = writableDatabase
    db.beginTransaction()
    try {
      db.rawQuery("SELECT count(*) FROM entries", null).use {
        require(it.moveToFirst() && it.getInt(0) < MAX_ENTRIES) { "Entry limit reached" }
      }
      db.insertOrThrow("entries", null, ContentValues().apply {
        put("id", id)
        put("partition_id", partitionId)
        put("kind", kind)
        put("title", cleanText(title, "title", MAX_TITLE))
        putNull("text_body")
        put("external_ref", reference)
        put("description", description)
        put("created_at", now)
        put("updated_at", now)
      })
      db.setTransactionSuccessful()
      return id
    } finally {
      db.endTransaction()
    }
  }

  @Synchronized
  fun updatePartitionRules(
    id: String,
    title: String,
    description: String,
    importance: String,
    accessMode: String,
    accessId: String?,
    allowModelRead: Boolean,
    authorization: WriteAuthorization,
  ) {
    authorization.check("partition:update:$id")
    require(importance in importanceKinds && accessMode in scopeKinds)
    require((accessMode == "global" && accessId == null) ||
      (accessMode != "global" && !accessId.isNullOrBlank() && accessId.length <= 120))
    require(description.toByteArray(Charsets.UTF_8).size <= MAX_DESCRIPTION)
    val values = ContentValues().apply {
      put("title", cleanText(title, "title", MAX_TITLE))
      put("description", description)
      put("importance", importance)
      put("access_mode", accessMode)
      put("access_id", accessId)
      put("allow_model_read", if (allowModelRead) 1 else 0)
      put("updated_at", System.currentTimeMillis())
    }
    require(writableDatabase.update("partitions", values, "id=?", arrayOf(id)) == 1) {
      "Partition not found"
    }
  }

  /**
   * Secret metadata is always redacted, even for a user facing list.
   * Actual credentials belong in Android Keystore backed storage.
   */
  @Synchronized
  fun getEntryKind(partitionId: String, entryId: String): String {
    readableDatabase.rawQuery(
      "SELECT kind FROM entries WHERE partition_id=? AND id=?",
      arrayOf(partitionId, entryId),
    ).use {
      require(it.moveToFirst()) { "Entry not found" }
      return it.getString(0)
    }
  }

  @Synchronized
  fun deleteEntry(partitionId: String, entryId: String, authorization: WriteAuthorization) {
    authorization.check("entry:delete:$partitionId")
    require(writableDatabase.delete("entries", "id=? AND partition_id=?",
      arrayOf(entryId, partitionId)) == 1) { "Entry not found" }
  }

  @Synchronized
  fun deletePartition(id: String, authorization: WriteAuthorization) {
    authorization.check("partition:delete:$id")
    require(id != DEFAULT_PARTITION) { "Default long-term memory cannot be deleted; format explicitly" }
    require(writableDatabase.delete("partitions", "id=? AND is_default=0", arrayOf(id)) == 1) {
      "Partition not found"
    }
  }

  /** Formatting requires a *fresh*, separately confirmed destructive action. */
  @Synchronized
  fun formatAll(authorization: WriteAuthorization) {
    authorization.check("database:format")
    val db = writableDatabase
    db.beginTransaction()
    try {
      db.delete("entries", null, null)
      db.delete("partitions", "is_default=0", null)
      // Keep the built-in partition but reset model read access.
      db.execSQL("UPDATE partitions SET allow_model_read=0, updated_at=? WHERE id=?",
        arrayOf(System.currentTimeMillis(), DEFAULT_PARTITION))
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun databaseFile(): File = File(readableDatabase.path)
}
