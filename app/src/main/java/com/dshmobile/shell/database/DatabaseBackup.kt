package com.dshmobile.shell.database

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.security.MessageDigest

/** Consistent private SQLite export using SQLite's own VACUUM INTO. */
object DatabaseBackup {
  fun create(context: Context, store: MobileDatabase): File = synchronized(store) {
    check(store.quickCheck() == "ok") { "Database failed integrity check" }
    val directory = File(context.filesDir, "database-backups").apply { mkdirs() }
    val target = File(directory, "dsh-mobile-${System.currentTimeMillis()}.db")
    require(!target.exists())
    // SQLite 3.27+ only. Unsupported runtime fails safely with no raw-file copying.
    val quoted = target.absolutePath.replace("'", "''")
    try {
      store.writableDatabase.execSQL("VACUUM INTO '$quoted'")
      check(target.length() > 0)
      SQLiteDatabase.openDatabase(target.absolutePath, null,
        SQLiteDatabase.OPEN_READONLY).use { backup ->
        backup.rawQuery("PRAGMA integrity_check", null).use { cursor ->
          check(cursor.moveToFirst() && cursor.getString(0) == "ok")
        }
      }
      val hash = MessageDigest.getInstance("SHA-256")
      target.inputStream().use { input ->
        val buf = ByteArray(65536)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          hash.update(buf, 0, n)
        }
      }
      File(directory, target.name + ".sha256").writeText(
        hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) } + "\n"
      )
      target
    } catch (t: Exception) {
      target.delete()
      throw t
    }
  }
}
