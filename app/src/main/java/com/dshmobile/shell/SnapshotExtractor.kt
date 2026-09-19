package com.dshmobile.shell

import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream

/**
 * Shared snapshot extraction: xz tar -> dest with owner-only permissions.
 *
 * Security invariant: every archive entry must remain below [dest], and archive
 * symlink targets must also remain below [dest] except for the one Android OS
 * shell target used by the bundled Termux-compat runtime (`/system/bin/sh`).
 * Parent symlinks are still rejected, so a prior archive entry cannot redirect
 * a later regular-file write outside the extraction root.
 */
object SnapshotExtractor {

  // The upstream runtime intentionally stores usr/bin/bash (and sometimes sh)
  // as an absolute symlink to Android's read-only system shell. v0.12.9's
  // traversal hardening rejected every absolute symlink, which made first-run
  // extraction abort before node / DSH / termux-exec could be installed. Keep
  // the exception deliberately exact: arbitrary absolute archive links remain
  // forbidden, and /system/bin/sh cannot be used as an extraction parent.
  private val trustedAbsoluteSymlinkTargets = setOf(
    Paths.get("/system/bin/sh").normalize(),
  )

  /** Extract an xz-compressed tar stream without allowing path traversal. */
  fun extract(input: InputStream, totalBytes: Long, dest: File, onProgress: (Long, Long) -> Unit) {
    val root = dest.canonicalFile.toPath().normalize()
    Files.createDirectories(root)
    val execFiles = mutableListOf<String>()
    var done = 0L

    XZCompressorInputStream(input).use { xz ->
      TarArchiveInputStream(xz).use { tar ->
        var entry: TarArchiveEntry? = tar.nextEntry
        while (entry != null) {
          val current = entry
          val target = safeTarget(root, current.name)
          ensureParentsSafe(root, target.parent)

          when {
            current.isDirectory -> {
              rejectExistingSymlink(target)
              Files.createDirectories(target)
            }
            current.isSymbolicLink -> {
              val parent = target.parent ?: root
              Files.createDirectories(parent)
              ensureParentsSafe(root, parent)
              val rawLink = Paths.get(current.linkName).normalize()
              if (rawLink.isAbsolute) {
                if (rawLink !in trustedAbsoluteSymlinkTargets) {
                  throw SecurityException("snapshot symlink uses untrusted absolute target: ${current.name} -> ${current.linkName}")
                }
                // Preserve the upstream /system/bin/sh alias exactly. The
                // archive still cannot use this link as a parent for later
                // writes because ensureParentsSafe() rejects symlink parents.
                Files.deleteIfExists(target)
                Files.createSymbolicLink(target, rawLink)
              } else {
                val resolvedLink = parent.resolve(rawLink).normalize()
                if (!resolvedLink.startsWith(root)) {
                  throw SecurityException("snapshot symlink escapes destination: ${current.name} -> ${current.linkName}")
                }
                Files.deleteIfExists(target)
                Files.createSymbolicLink(target, rawLink)
              }
            }
            current.isLink -> {
              // Preserve legitimate in-tree hard links while refusing aliases
              // outside the extraction root or through symlink parents.
              val source = safeTarget(root, current.linkName)
              ensureParentsSafe(root, source.parent)
              if (!Files.exists(source, LinkOption.NOFOLLOW_LINKS) ||
                Files.isSymbolicLink(source) || !Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) {
                throw SecurityException("snapshot hard-link source is unsafe or missing: ${current.name} -> ${current.linkName}")
              }
              val parent = target.parent ?: root
              Files.createDirectories(parent)
              ensureParentsSafe(root, parent)
              rejectExistingSymlink(target)
              Files.deleteIfExists(target)
              Files.createLink(target, source)
              if (Files.isExecutable(source)) execFiles.add(target.toFile().absolutePath)
            }
            current.isFile -> {
              val parent = target.parent ?: root
              Files.createDirectories(parent)
              ensureParentsSafe(root, parent)
              rejectExistingSymlink(target)
              target.toFile().outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var n = tar.read(buf)
                while (n >= 0) {
                  if (n > 0) out.write(buf, 0, n)
                  n = tar.read(buf)
                }
              }
              val file = target.toFile()
              file.setReadable(false, false)
              file.setReadable(true, true)
              file.setWritable(true, true)
              val executable = current.mode and 0x40 != 0
              file.setExecutable(executable, true)
              if (executable) execFiles.add(file.absolutePath)
            }
            else -> throw SecurityException("unsupported snapshot entry type: ${current.name}")
          }

          done += current.size.coerceAtLeast(0)
          if (done % (1024 * 1024) < current.size.coerceAtLeast(0)) onProgress(done, totalBytes)
          entry = tar.nextEntry
        }
      }
    }
    stampExecAttribute(execFiles)
  }

  private fun safeTarget(root: Path, name: String): Path {
    if (name.isBlank()) throw SecurityException("snapshot contains an empty path")
    val raw = Paths.get(name)
    if (raw.isAbsolute) throw SecurityException("snapshot contains absolute path: $name")
    val target = root.resolve(raw).normalize()
    if (!target.startsWith(root) || target == root && name != ".") {
      throw SecurityException("snapshot path escapes destination: $name")
    }
    return target
  }

  /** Reject any existing symlink between root and parent. */
  private fun ensureParentsSafe(root: Path, parent: Path?) {
    if (parent == null) return
    val normalized = parent.normalize()
    if (!normalized.startsWith(root)) throw SecurityException("snapshot parent escapes destination: $parent")
    var cursor = root
    val relative = root.relativize(normalized)
    for (part in relative) {
      cursor = cursor.resolve(part)
      if (Files.isSymbolicLink(cursor)) {
        throw SecurityException("snapshot would traverse symlink parent: $cursor")
      }
      if (Files.exists(cursor, LinkOption.NOFOLLOW_LINKS) && !Files.isDirectory(cursor, LinkOption.NOFOLLOW_LINKS)) {
        throw SecurityException("snapshot parent is not a directory: $cursor")
      }
    }
  }

  private fun rejectExistingSymlink(path: Path) {
    if (Files.isSymbolicLink(path)) throw SecurityException("snapshot entry collides with symlink: $path")
  }

  /** Stamp the Android exec attribute on all extracted executables. */
  private fun stampExecAttribute(files: List<String>) {
    if (files.isEmpty()) return
    try {
      val base = listOf("/system/bin/setfattr", "-n", "security.android.exec", "-v", "1")
      files.chunked(64).forEach { batch ->
        val procs = batch.map { f -> ProcessBuilder(base + f).redirectErrorStream(true).start() }
        for (p in procs) {
          val finished = p.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
          if (!finished) p.destroyForcibly()
        }
      }
    } catch (_: Throwable) {
      // Older Android kernels do not require this xattr.
    }
  }
}
