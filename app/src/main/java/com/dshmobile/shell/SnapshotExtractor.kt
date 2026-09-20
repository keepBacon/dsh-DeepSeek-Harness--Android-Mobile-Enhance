package com.dshmobile.shell

import android.system.Os
import java.io.BufferedInputStream
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

  private const val COPY_BUFFER_SIZE = 256 * 1024
  private const val PROGRESS_STEP_BYTES = 4L * 1024L * 1024L
  private const val EXEC_ATTR_BATCH_SIZE = 64

  // The upstream runtime intentionally stores usr/bin/bash (and sometimes sh)
  // as an absolute symlink to Android's read-only system shell. v0.12.9's
  // traversal hardening rejected every absolute symlink, which made first-run
  // extraction abort before node / DSH / termux-exec could be installed. Keep
  // the exception deliberately exact: arbitrary absolute archive links remain
  // forbidden, and /system/bin/sh cannot be used as an extraction parent.
  private val trustedAbsoluteSymlinkTargets = setOf(
    Paths.get("/system/bin/sh").normalize(),
  )

  /**
   * Extract an xz-compressed tar stream without allowing path traversal.
   *
   * [preservedRoots] are existing user-owned trees below [dest] that an APK
   * runtime refresh must never overwrite. This is used for HOME: the bundled
   * snapshot may seed a default profile on first install, but an upgrade must
   * preserve installed plugins, credentials, Skills, caches and user profile
   * manifests byte-for-byte.
   */
  fun extract(
    input: InputStream,
    totalBytes: Long,
    dest: File,
    preservedRoots: Set<File> = emptySet(),
    onProgress: (Long, Long) -> Unit,
  ) {
    val root = dest.canonicalFile.toPath().normalize()
    Files.createDirectories(root)
    val preservedPaths = preservedRoots.mapTo(LinkedHashSet()) { preserved ->
      val path = preserved.canonicalFile.toPath().normalize()
      if (!path.startsWith(root) || path == root) {
        throw SecurityException("snapshot preserved root escapes destination: $path")
      }
      path
    }

    // Most runtime archives contain tens of thousands of entries sharing the
    // same parent directories. Re-validating every path component for every
    // file turns extraction into a syscall-heavy workload on Android. Cache
    // directories only after they have been created/verified as real
    // directories; symlink creation invalidates affected cache entries.
    val safeDirectories = HashSet<Path>(4096)
    safeDirectories.add(root)

    val execFiles = ArrayList<String>(2048)
    val copyBuffer = ByteArray(COPY_BUFFER_SIZE)
    var done = 0L
    var nextProgress = PROGRESS_STEP_BYTES

    BufferedInputStream(input, COPY_BUFFER_SIZE).use { buffered ->
      XZCompressorInputStream(buffered).use { xz ->
        TarArchiveInputStream(xz).use { tar ->
          var entry: TarArchiveEntry? = tar.nextEntry
          while (entry != null) {
            val current = entry
            val target = safeTarget(root, current.name)

            // APK upgrades may carry a seeded home/ tree in the archive. Once
            // the app already owns a real user HOME, skip every entry below
            // that protected root instead of truncating package.json/lockfiles
            // or replacing plugin/Skill content. TarArchiveInputStream advances
            // over unread entry data when nextEntry is requested.
            if (preservedPaths.any { target == it || target.startsWith(it) }) {
              done += current.size.coerceAtLeast(0)
              if (done >= nextProgress) {
                onProgress(done, totalBytes)
                nextProgress = done + PROGRESS_STEP_BYTES
              }
              entry = tar.nextEntry
              continue
            }

            when {
              current.isDirectory -> {
                ensureSafeDirectory(root, target, safeDirectories)
              }
              current.isSymbolicLink -> {
                val parent = target.parent ?: root
                ensureSafeDirectory(root, parent, safeDirectories)
                val rawLink = Paths.get(current.linkName).normalize()
                if (rawLink.isAbsolute) {
                  if (rawLink !in trustedAbsoluteSymlinkTargets) {
                    throw SecurityException("snapshot symlink uses untrusted absolute target: ${current.name} -> ${current.linkName}")
                  }
                } else {
                  val resolvedLink = parent.resolve(rawLink).normalize()
                  if (!resolvedLink.startsWith(root)) {
                    throw SecurityException("snapshot symlink escapes destination: ${current.name} -> ${current.linkName}")
                  }
                }

                if (Files.deleteIfExists(target)) invalidateSafeDirectoryCache(safeDirectories, target)
                Files.createSymbolicLink(target, rawLink)
              }
              current.isLink -> {
                // Preserve legitimate in-tree hard links while refusing aliases
                // outside the extraction root or through symlink parents.
                val source = safeTarget(root, current.linkName)
                ensureSafeDirectory(root, source.parent ?: root, safeDirectories)
                if (!Files.exists(source, LinkOption.NOFOLLOW_LINKS) ||
                  Files.isSymbolicLink(source) || !Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) {
                  throw SecurityException("snapshot hard-link source is unsafe or missing: ${current.name} -> ${current.linkName}")
                }
                val parent = target.parent ?: root
                ensureSafeDirectory(root, parent, safeDirectories)
                rejectExistingSymlink(target)
                if (Files.deleteIfExists(target)) invalidateSafeDirectoryCache(safeDirectories, target)
                Files.createLink(target, source)
                if (Files.isExecutable(source)) execFiles.add(target.toFile().absolutePath)
              }
              current.isFile -> {
                val parent = target.parent ?: root
                ensureSafeDirectory(root, parent, safeDirectories)
                rejectExistingSymlink(target)
                target.toFile().outputStream().use { out ->
                  var n = tar.read(copyBuffer)
                  while (n >= 0) {
                    if (n > 0) out.write(copyBuffer, 0, n)
                    n = tar.read(copyBuffer)
                  }
                }
                val file = target.toFile()
                val executable = current.mode and 0x40 != 0
                setOwnerOnlyMode(file, executable)
                if (executable) execFiles.add(file.absolutePath)
              }
              else -> throw SecurityException("unsupported snapshot entry type: ${current.name}")
            }

            done += current.size.coerceAtLeast(0)
            if (done >= nextProgress) {
              onProgress(done, totalBytes)
              nextProgress = done + PROGRESS_STEP_BYTES
            }
            entry = tar.nextEntry
          }
        }
      }
    }
    onProgress(done, totalBytes)
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

  /**
   * Ensure [dir] exists as a real directory below [root].
   *
   * Verified directories are cached so common prefixes such as
   * usr/lib/node_modules are stat'ed only once instead of once per archive
   * entry. Missing directories are created one component at a time only after
   * their parent has been verified.
   */
  private fun ensureSafeDirectory(root: Path, dir: Path, safeDirectories: MutableSet<Path>) {
    val normalized = dir.normalize()
    if (!normalized.startsWith(root)) throw SecurityException("snapshot parent escapes destination: $dir")
    if (normalized == root || safeDirectories.contains(normalized)) return

    val parent = normalized.parent ?: root
    ensureSafeDirectory(root, parent, safeDirectories)

    if (Files.exists(normalized, LinkOption.NOFOLLOW_LINKS)) {
      if (Files.isSymbolicLink(normalized)) {
        throw SecurityException("snapshot would traverse symlink parent: $normalized")
      }
      if (!Files.isDirectory(normalized, LinkOption.NOFOLLOW_LINKS)) {
        throw SecurityException("snapshot parent is not a directory: $normalized")
      }
    } else {
      Files.createDirectory(normalized)
    }
    safeDirectories.add(normalized)
  }

  /** Drop a directory and all cached descendants after an archive replacement. */
  private fun invalidateSafeDirectoryCache(safeDirectories: MutableSet<Path>, path: Path) {
    val normalized = path.normalize()
    safeDirectories.removeIf { it == normalized || it.startsWith(normalized) }
  }

  /** One chmod syscall instead of multiple java.io.File permission syscalls. */
  private fun setOwnerOnlyMode(file: File, executable: Boolean) {
    try {
      Os.chmod(file.absolutePath, if (executable) 448 else 384) // 0700 / 0600
    } catch (_: Throwable) {
      // Conservative fallback for devices whose libc wrapper rejects chmod.
      file.setReadable(false, false)
      file.setWritable(false, false)
      file.setExecutable(false, false)
      file.setReadable(true, true)
      file.setWritable(true, true)
      if (executable) file.setExecutable(true, true)
    }
  }

  private fun rejectExistingSymlink(path: Path) {
    if (Files.isSymbolicLink(path)) throw SecurityException("snapshot entry collides with symlink: $path")
  }

  /**
   * Stamp the Android exec attribute on extracted executables.
   *
   * setfattr accepts multiple FILE arguments. The previous implementation
   * spawned one process per executable, which was disproportionately expensive
   * on first launch. Use one process per batch and fall back to per-file calls
   * only if a device-specific setfattr implementation rejects batching.
   */
  private fun stampExecAttribute(files: List<String>) {
    if (files.isEmpty()) return
    val base = listOf("/system/bin/setfattr", "-n", "security.android.exec", "-v", "1")
    val devNull = File("/dev/null")
    try {
      files.distinct().chunked(EXEC_ATTR_BATCH_SIZE).forEach { batch ->
        val process = ProcessBuilder(base + batch)
          .redirectErrorStream(true)
          .redirectOutput(devNull)
          .start()
        val finished = process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
        if (!finished) {
          process.destroyForcibly()
          return@forEach
        }
        if (process.exitValue() != 0) {
          // Keep compatibility with older/toybox variants that accept only
          // one path even though current Android setfattr accepts FILE...
          batch.forEach { file ->
            try {
              val single = ProcessBuilder(base + file)
                .redirectErrorStream(true)
                .redirectOutput(devNull)
                .start()
              if (!single.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) single.destroyForcibly()
            } catch (_: Throwable) {
            }
          }
        }
      }
    } catch (_: Throwable) {
      // Older Android kernels do not require this xattr.
    }
  }

}
