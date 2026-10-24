package com.dshmobile.shell.database

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.security.MessageDigest

/**
 * App-private, consistent SQLite export.
 * SQLite >= 3.27 uses VACUUM INTO; older Android runtimes use a checkpointed
 * close-and-copy while all in-process metadata writers are paused on [store].
 * Raw WAL copying while the database is open is deliberately avoided.
 */
object DatabaseBackup {
  private fun supportsVacuumInto(version: String): Boolean {
    val parts = version.split('.').take(3).mapNotNull { it.toIntOrNull() }
    if (parts.size != 3) return false
    val (major, minor, patch) = parts
    return major > 3 || (major == 3 && (minor > 27 || (minor == 27 && patch >= 0)))
  }

  private fun exportLegacy(context: Context, store: MobileDatabase, target: File) {
    val database = store.writableDatabase
    // Only app-private metadata uses this SQLiteOpenHelper. All its public
    // read/write methods and refresh/backup paths synchronize on the helper.
    // A checkpoint must succeed before a single main-db file can be copied.
    database.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null).use { cursor ->
      check(cursor.moveToFirst() && cursor.getInt(0) == 0) {
        "SQLite WAL checkpoint could not complete"
      }
    }
    store.close()
    val source = context.getDatabasePath(MobileDatabase.FILE_NAME)
    check(source.isFile) { "Metadata SQLite source is missing" }
    val wal = File(source.absolutePath + "-wal")
    check(!wal.exists() || wal.length() == 0L) {
      "SQLite WAL is not empty after checkpoint; backup cancelled"
    }
    source.copyTo(target, overwrite = false)
  }

  fun create(context: Context, store: MobileDatabase): File = synchronized(store) {
    check(store.quickCheck() == "ok") { "Database failed integrity check" }
    val directory = File(context.filesDir, "database-backups").apply { mkdirs() }
    val target = File.createTempFile("dsh-mobile-", ".db", directory).apply { delete() }
    val checksum = File(directory, target.name + ".sha256")
    try {
      val version = store.readableDatabase.rawQuery("SELECT sqlite_version()", null).use { cursor ->
        check(cursor.moveToFirst()) { "SQLite version unavailable" }
        cursor.getString(0)
      }
      if (supportsVacuumInto(version)) {
        val quoted = target.absolutePath.replace("'", "''")
        store.writableDatabase.execSQL("VACUUM INTO '$quoted'")
      } else {
        exportLegacy(context, store, target)
      }

      check(target.length() > 0L) { "SQLite backup is empty" }
      SQLiteDatabase.openDatabase(target.absolutePath, null,
        SQLiteDatabase.OPEN_READONLY).use { exported ->
        exported.rawQuery("PRAGMA integrity_check", null).use { cursor ->
          check(cursor.moveToFirst() && cursor.getString(0) == "ok") {
            "SQLite export failed integrity_check"
          }
        }
      }
      val digest = MessageDigest.getInstance("SHA-256")
      target.inputStream().use { input ->
        val buffer = ByteArray(65536)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      checksum.writeText(
        digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) } + "\n"
      )
      directory.listFiles()
        ?.filter { it.name.startsWith("dsh-mobile-") && it.name.endsWith(".db") }
        ?.sortedByDescending { it.lastModified() }
        ?.drop(5)
        ?.forEach { old ->
          if (old.delete()) File(directory, old.name + ".sha256").delete()
        }
      target
    } catch (t: Exception) {
      target.delete()
      checksum.delete()
      throw t
    }
  }
}
