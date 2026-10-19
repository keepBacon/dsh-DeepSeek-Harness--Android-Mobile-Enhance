package com.dshmobile.shell

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * Private attachment storage for database file entries. Never exposes a raw
 * user-supplied path. Files are kept in app-private noBackupFilesDir, separate
 * from mutable Termux workspace data. Caller must obtain explicit user consent
 * before importing or deleting an attachment.
 *
 * This handles ordinary files, NOT credentials. A separate Keystore broker
 * must handle secret values in the final integration phase.
 */
internal class DshDatabaseAttachments(context: Context) {
  private val root = File(context.applicationContext.noBackupFilesDir, "dsh-database-files")
  private val maxFileBytes = 32L * 1024 * 1024

  data class ImportedAttachment(
    val reference: String,
    val length: Long,
    val sha256: String,
  )

  private fun checkRef(ref: String): File {
    require(ref.matches(Regex("attachment:[0-9a-f]{32}"))) { "Invalid attachment reference" }
    return File(root, ref.removePrefix("attachment:"))
  }

  private fun ensureRoot() {
    require(root.isDirectory || root.mkdirs()) { "Cannot create attachment storage" }
    require(!root.canonicalPath.startsWith("/storage/")) { "Attachment storage must remain private" }
  }

  @Synchronized
  fun importFile(
    source: InputStream,
    authorization: DshDatabaseStore.WriteAuthorization,
  ): ImportedAttachment {
    authorization.check("attachment:import")
    ensureRoot()
    val id = UUID.randomUUID().toString().replace("-", "")
    val target = File(root, id)
    val tmp = File(root, ".$id.part")
    val digest = MessageDigest.getInstance("SHA-256")
    var written = 0L
    try {
      FileOutputStream(tmp).use { output ->
        val chunk = ByteArray(16 * 1024)
        while (true) {
          val count = source.read(chunk)
          if (count < 0) break
          if (count == 0) continue
          written += count
          require(written <= maxFileBytes) { "Attachment exceeds 32 MiB" }
          digest.update(chunk, 0, count)
          output.write(chunk, 0, count)
        }
        output.fd.sync()
      }
      require(tmp.renameTo(target)) { "Attachment commit failed" }
      return ImportedAttachment(
        "attachment:$id",
        written,
        digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) },
      )
    } finally {
      if (tmp.exists()) tmp.delete()
    }
  }

  @Synchronized
  fun pruneUnreferenced(usedReferences: Set<String>): Int {
    ensureRoot()
    var removed = 0
    root.listFiles()?.forEach { file ->
      if (file.isFile && !java.nio.file.Files.isSymbolicLink(file.toPath()) &&
          file.name.matches(Regex("[0-9a-f]{32}")) &&
          "attachment:${file.name}" !in usedReferences && file.delete()) removed++
    }
    return removed
  }

  @Synchronized
  fun load(
    reference: String,
    authorization: DshDatabaseStore.WriteAuthorization,
  ): ByteArray {
    authorization.check("attachment:read")
    val file = checkRef(reference)
    require(file.isFile && !java.nio.file.Files.isSymbolicLink(file.toPath())) {
      "Attachment missing or unsafe"
    }
    require(file.length() <= maxFileBytes) { "Attachment too large" }
    return file.readBytes()
  }

  @Synchronized
  fun exportTo(
    reference: String,
    target: java.io.OutputStream,
    authorization: DshDatabaseStore.WriteAuthorization,
  ): Long {
    authorization.check("attachment:read")
    val file = checkRef(reference)
    require(file.isFile && !java.nio.file.Files.isSymbolicLink(file.toPath())) { "Attachment missing" }
    require(file.length() <= maxFileBytes) { "Attachment too large" }
    return file.inputStream().use { it.copyTo(target, 16 * 1024) }
  }

  @Synchronized
  fun delete(
    reference: String,
    authorization: DshDatabaseStore.WriteAuthorization,
  ) {
    authorization.check("attachment:delete")
    val file = checkRef(reference)
    require(file.isFile && !java.nio.file.Files.isSymbolicLink(file.toPath())) { "Attachment missing" }
    require(file.delete()) { "Failed to remove attachment" }
  }
}
