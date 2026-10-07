package com.dshmobile.shell

import android.content.Context
import android.os.Environment
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream

/** Result of a DSH plugin package-manager command executed inside the embedded runtime. */
data class PluginCommandResult(
  val ok: Boolean,
  val exitCode: Int,
  val output: String,
  /** Stable compatibility category used by the Android plugin manager. */
  val failureKind: String? = null,
  /** pnpm 11 build-script approvals waiting in pnpm-workspace.yaml. */
  val pendingBuilds: List<String> = emptyList(),
)

/** One dependency installed into a DSH profile and whether its bundle layer is active. */
data class PluginBundleInfo(
  val name: String,
  val version: String,
  val enabled: Boolean,
  val firstParty: Boolean,
  /** True only when the installed package declares dsh.bundle.patch. */
  val bundle: Boolean,
)

/** Health snapshot for the embedded runtime required to boot DSH Web. */
data class RuntimeHealth(
  val ok: Boolean,
  val missing: List<String>,
) {
  fun describe(): String = if (ok) "运行时完整" else "运行时缺少：" + missing.joinToString(", ")
}

/**
 * Owns the embedded Termux environment snapshot: first-launch extraction into
 * filesDir/usr and the dsh engine process lifecycle (PATH/LD_LIBRARY_PATH/HOME
 * injected explicitly — the snapshot is self-sufficient, no Termux app needed).
 */
class EngineManager(private val context: Context, private val pickToken: String? = null) {

  val usrDir = File(context.filesDir, "usr")
  val homeDir = File(context.filesDir, "home")

  /**
   * 公共持久化目录：/storage/emulated/0/Documents/dshdata。
   * 引擎 DSH_HOME 指向此处——个性化设置、插件配置、对话记录、附件等全部
   * 用户数据默认落公共目录（文件管理器可见、可备份、卸载重装不丢）。
   */
  val dshDataDir: File
    get() {
      val publicDocs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
        ?: File(context.filesDir, "dshdata-fallback")
      return File(publicDocs, "dshdata")
    }
  private val nodeBin = File(usrDir, "bin/node")
  private val dshBin = File(usrDir, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")
  private val preloadBin = File(usrDir, "lib/libtermux-exec-ld-preload.so")
  private val engineLogFile = File(context.filesDir, "engine.log")
  private var engineProcess: Process? = null
  private val pluginLogFile = File(context.filesDir, "plugin-install.log")
  private val profileCheckLogFile = File(context.filesDir, "profile-check.log")
  private val dshPackageFile = File(usrDir, "lib/node_modules/@deepseek-ai/dsh/package.json")
  private val compatManifestFile = File(usrDir, "etc/dsh-android-compat.json")
  private val runtimeIdMarker = File(context.filesDir, "runtime-version.txt")
  private val userHomeInitializedMarker = File(context.filesDir, "user-home-initialized")
  private val gitBin = File(usrDir, "bin/git")
  private val sshBin = File(usrDir, "bin/ssh")
  private val npmBin = File(usrDir, "bin/npm")
  private val npxBin = File(usrDir, "bin/npx")
  private val gitExecDir = File(usrDir, "libexec/git-core")
  private val gitConfigFile = File(usrDir, "etc/gitconfig")
  private val sshConfigFile = File(usrDir, "etc/ssh/ssh_config")
  private val caBundleFile = File(usrDir, "etc/tls/cert.pem")
  private val nodeCacheDir = File(homeDir, ".cache").apply { mkdirs() }
  private val nodeCompileCacheDir = File(nodeCacheDir, "node-compile").apply { mkdirs() }
  private val mcpConfigManager by lazy { McpConfigManager(context, dshDataDir, usrDir, homeDir) }

  private fun bundledRuntimeId(): String = try {
    context.assets.open("runtime-version.txt").bufferedReader().use { it.readText().trim() }
  } catch (_: Throwable) { "legacy-bundled-runtime" }

  /** Public identity used by the signed OTA updater when committing a runtime marker. */
  fun bundledRuntimeIdentity(): String = bundledRuntimeId()

  private fun bundledDshVersion(): String? = Regex("""(?m)^dsh=([^\s]+)\s*$""")
    .find(bundledRuntimeId())?.groupValues?.getOrNull(1)

  private fun semverKey(value: String): IntArray? {
    val m = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?""").find(value.trim()) ?: return null
    val stage = when (m.groupValues[4]) {
      "alpha" -> 0
      "beta" -> 1
      "rc" -> 2
      else -> 3
    }
    return intArrayOf(
      m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt(),
      stage, m.groupValues[5].ifBlank { "0" }.toInt(),
    )
  }

  private fun versionAtLeast(value: String, floor: String): Boolean {
    val a = semverKey(value) ?: return false
    val b = semverKey(floor) ?: return false
    for (i in a.indices) {
      if (a[i] != b[i]) return a[i] > b[i]
    }
    return true
  }

  /**
   * A bundled runtime must match this APK's runtime identity. A signed OTA
   * runtime is also accepted when it was based on this bundle, or when its
   * actual embedded DSH version is not older than the new APK's bundled DSH.
   * This prevents a successful OTA from being overwritten on every relaunch,
   * while still letting an APK upgrade supersede an older OTA runtime.
   */
  private fun installedRuntimeAccepted(): Boolean {
    return try {
      if (!runtimeIdMarker.isFile) return false
      val marker = runtimeIdMarker.readText().trim()
      val bundleId = bundledRuntimeId()
      if (marker == bundleId || marker == "bundle:$bundleId") return true

      if (marker.startsWith("{")) {
        val root = JSONObject(marker)
        if (root.optString("kind") != "ota") return false
        val baseBundleId = root.optString("baseBundleId", "")
        if (baseBundleId == bundleId) return true
        val installed = dshVersion()
        val bundled = bundledDshVersion() ?: return false
        return versionAtLeast(installed, bundled)
      }

      // Compatibility with v0.13.1's plain OTA marker. Only accept when the
      // marker equals the actual installed DSH version and is not older than the
      // runtime bundled with this APK.
      val bundled = bundledDshVersion()
      marker == dshVersion() && bundled != null && versionAtLeast(marker, bundled)
    } catch (_: Throwable) {
      false
    }
  }


  fun dshVersion(): String = try {
    if (!dshPackageFile.isFile) "unknown"
    else JSONObject(dshPackageFile.readText()).optString("version", "unknown")
  } catch (_: Throwable) { "unknown" }

  /** Runtime capabilities relevant to community plugin installation. */
  fun pluginRuntimeSummary(): String {
    val gitHttps = gitBin.isFile && File(gitExecDir, "git-remote-https").isFile && caBundleFile.isFile
    val ssh = sshBin.isFile
    val npmTools = npmBin.isFile && npxBin.isFile
    val sshKey = listOf("id_dsh", "id_ed25519", "id_rsa", "id_ecdsa").any { File(homeDir, ".ssh/$it").isFile }
    val pending = pendingPluginBuilds().size
    return buildString {
      append("pnpm 可用")
      append(" · npm/npx ").append(if (npmTools) "可用" else "不可用")
      append(" · Git/HTTPS ").append(if (gitHttps) "可用" else "不可用")
      append(" · SSH ").append(if (ssh) "可用" else "不可用")
      append(" · Python3 ").append(if (File(usrDir, "libexec/dsh/wrappers/python3").isFile) "可用" else "不可用")
      append(" · pkg/apt ").append(if (File(usrDir, "libexec/dsh/wrappers/pkg").isFile && File(usrDir, "libexec/dsh/wrappers/apt").isFile) "可用" else "不可用")
      if (gitHttps) append(" · CA 已内置")
      if (sshKey) append(" · SSH 密钥已配置")
      if (SecureCredentialStore.sshPassphrase(context) != null) append(" · SSH 口令已安全保存")
      if (SecureCredentialStore.gitCredential(context) != null) append(" · 私有 Git HTTPS 凭据已配置")
      if (pending > 0) append(" · 待授权构建 ").append(pending)
    }
  }

  fun mcpRuntimeSummary(): String = mcpConfigManager.runtimeSummary()
  fun listMcpServers(): List<McpServerConfig> = mcpConfigManager.listServers()
  fun mcpToolboxEnabled(): Boolean = mcpConfigManager.toolboxEnabled()
  fun mcpConfigurationIssue(): String? = mcpConfigManager.configurationIssue()
  fun hasMcpBearerToken(id: String): Boolean = try { SecureCredentialStore.hasMcpBearerToken(context, id) } catch (_: Throwable) { false }

  fun setMcpToolboxEnabled(enabled: Boolean): PluginCommandResult = try {
    mcpConfigManager.setToolboxEnabled(enabled)
    mcpConfigManager.ensureRuntimePatch()
    PluginCommandResult(true, 0, if (enabled) "已启用内置 mobile_tools + basic_tools MCP。" else "已关闭内置 MCP 工具箱。")
  } catch (t: Throwable) {
    PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
  }

  fun saveMcpServer(server: McpServerConfig, bearerToken: String? = null): PluginCommandResult = try {
    if (!bearerToken.isNullOrBlank()) SecureCredentialStore.saveMcpBearerToken(context, server.id, bearerToken)
    mcpConfigManager.upsert(server)
    if (!server.bearerAuth) SecureCredentialStore.clearMcpBearerToken(context, server.id)
    mcpConfigManager.ensureRuntimePatch()
    PluginCommandResult(true, 0, "已保存 MCP：" + server.serverName)
  } catch (t: Throwable) {
    PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
  }

  fun setMcpServerEnabled(id: String, enabled: Boolean): PluginCommandResult = try {
    mcpConfigManager.setServerEnabled(id, enabled)
    mcpConfigManager.ensureRuntimePatch()
    PluginCommandResult(true, 0, if (enabled) "MCP 已启用" else "MCP 已停用")
  } catch (t: Throwable) {
    PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
  }

  fun removeMcpServer(id: String): PluginCommandResult = try {
    mcpConfigManager.remove(id)
    SecureCredentialStore.clearMcpBearerToken(context, id)
    mcpConfigManager.ensureRuntimePatch()
    PluginCommandResult(true, 0, "MCP 已删除")
  } catch (t: Throwable) {
    PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
  }

  /**
   * Execute one request from the Android mobile Tools surface.
   *
   * The category is allow-listed here rather than accepting arbitrary native
   * executable paths from WebView. Terminal is the only free-form command
   * surface; it still runs through the same embedded Termux namespace and cwd
   * used by DSH instead of through Android's app process shell.
   */
  fun runMobileToolRequest(category: String, command: String, workspacePath: String?): String {
    val normalized = category.trim().lowercase()
    return try {
      when (normalized) {
        "catalog" -> mobileToolCatalogJson()
        "terminal" -> {
          val value = command.trim()
          if (value.isEmpty()) {
            JSONObject()
              .put("ok", false)
              .put("category", normalized)
              .put("error", "命令不能为空")
              .toString()
          } else if (value.length > 4096) {
            JSONObject()
              .put("ok", false)
              .put("category", normalized)
              .put("error", "命令长度超过 4096 个字符")
              .toString()
          } else {
            runMobileToolShell(normalized, value, workspacePath, timeoutSeconds = 20)
          }
        }
        "files" -> mobileFilesSnapshot(workspacePath)
        "processes" -> mobileProcessesSnapshot(workspacePath)
        "packages" -> mobilePackagesSnapshot(workspacePath)
        "git" -> mobileGitSnapshot(workspacePath)
        "network" -> mobileNetworkSnapshot(workspacePath)
        "network-service-start" -> startLocalDevServer(command, workspacePath)
        "network-service-stop" -> stopLocalDevServer()
        "system" -> mobileSystemSnapshot(workspacePath)
        else -> JSONObject()
          .put("ok", false)
          .put("category", normalized)
          .put("error", "未知工具分类")
          .toString()
      }
    } catch (t: Throwable) {
      JSONObject()
        .put("ok", false)
        .put("category", normalized)
        .put("error", t.message ?: t.javaClass.simpleName)
        .toString()
    }
  }

  private fun mobileToolCategory(name: String): String {
    val terminal = setOf(
      "bash", "sh", "tmux", "fzf", "bat", "eza", "micro", "nvim", "ranger", "yazi",
      "glow", "gum", "dialog", "less", "which", "tree", "htop", "btop", "ncdu", "duf", "watch",
    )
    val files = setOf(
      "file", "fd", "find", "rg", "grep", "sed", "awk", "gawk", "jq", "yq", "rsync",
      "diff", "patch", "sd", "tar", "gzip", "bzip2", "xz", "zstd", "lz4", "cpio",
      "zip", "unzip", "7z",
    )
    val processes = setOf(
      "ps", "htop", "btop", "watch", "lsof", "strace", "ltrace", "gdb", "gdbserver",
      "frida", "frida-ps", "frida-trace", "frida-server", "rizin", "r2",
    )
    val packages = setOf(
      "pkg", "apt", "apt-get", "apt-cache", "apt-config", "dpkg", "dpkg-query", "dpkg-deb",
      "python", "python3", "pip", "pip3", "node", "npm", "npx", "pnpm",
    )
    val git = setOf("git", "git-lfs", "lazygit", "tig", "ssh", "scp", "sftp")
    val network = setOf(
      "curl", "wget", "aria2c", "http", "dig", "ip", "ss", "ifconfig", "nmap", "socat",
      "nc", "whois", "traceroute", "tcpdump", "adb",
    )
    return when (name) {
      in processes -> "processes"
      in packages -> "packages"
      in git -> "git"
      in network -> "network"
      in files -> "files"
      in terminal -> "terminal"
      else -> "system"
    }
  }

  /**
   * Return the command surface actually present in this installed APK runtime.
   *
   * Most names come from libexec/dsh/wrappers, which is generated from the
   * canonical Termux tool catalog during the full build. A small set of DSH
   * runtime commands (Node/npm/pnpm/Bash/OpenSSH/ripgrep) live directly under
   * usr/bin and are added only when the installed file really exists.
   */
  private fun mobileToolCatalogJson(): String {
    val names = linkedSetOf<String>()
    val validName = Regex("""^[A-Za-z0-9][A-Za-z0-9._+-]*$""")
    val wrappers = File(usrDir, "libexec/dsh/wrappers")
    wrappers.listFiles()?.forEach { entry ->
      if (validName.matches(entry.name) && (entry.exists() || java.nio.file.Files.isSymbolicLink(entry.toPath()))) {
        names += entry.name
      }
    }

    val directRuntimeCommands = listOf(
      "bash", "sh", "node", "npm", "npx", "pnpm", "rg",
      "git", "ssh", "scp", "sftp", "ps",
    )
    for (name in directRuntimeCommands) {
      val entry = File(usrDir, "bin/$name")
      if (entry.exists() || java.nio.file.Files.isSymbolicLink(entry.toPath())) names += name
    }

    val categoryOrder = listOf("terminal", "files", "processes", "packages", "git", "network", "system")
    val grouped = categoryOrder.associateWith { mutableListOf<String>() }
    for (name in names.sorted()) {
      grouped.getValue(mobileToolCategory(name)).add(name)
    }

    val categories = JSONObject()
    for (id in categoryOrder) {
      val array = JSONArray()
      for (name in grouped.getValue(id)) array.put(name)
      categories.put(id, array)
    }

    val desktopCapabilities = JSONArray()
    for (name in listOf(
      "Bash", "文件", "文件搜索", "作业", "技能", "子代理",
      "工作流", "网页", "展示", "待办", "目标 / 计划",
    )) desktopCapabilities.put(name)

    return JSONObject()
      .put("ok", true)
      .put("runtime", "embedded-termux")
      .put("dshVersion", dshVersion())
      .put("total", names.size)
      .put("categories", categories)
      .put("desktopCapabilities", desktopCapabilities)
      .toString()
  }

  private fun mobileToolCwd(workspacePath: String?): File {
    if (!workspacePath.isNullOrBlank()) {
      try {
        val workspace = File(workspacePath).canonicalFile
        if (workspace.isDirectory) return workspace
      } catch (_: Throwable) {}
    }
    homeDir.mkdirs()
    return homeDir
  }

  private fun mobileFilesSnapshot(workspacePath: String?): String {
    val cwd = mobileToolCwd(workspacePath)
    val workspaceAvailable = !workspacePath.isNullOrBlank() && try {
      File(workspacePath).canonicalFile == cwd
    } catch (_: Throwable) { false }
    if (!workspaceAvailable) {
      return JSONObject()
        .put("ok", false)
        .put("category", "files")
        .put("cwd", cwd.absolutePath)
        .put("error", "当前没有可用工作区")
        .toString()
    }

    val all = cwd.listFiles()?.toList().orEmpty()
      .sortedWith(compareBy<File>({ !it.isDirectory }, { it.name.lowercase() }))
    val limit = 250
    val output = buildString {
      append("Workspace: ").append(cwd.absolutePath).append('\n')
      append("Entries: ").append(all.size).append("\n\n")
      for (entry in all.take(limit)) {
        val name = entry.name.replace("\n", "⏎").replace("\t", " ")
        if (java.nio.file.Files.isSymbolicLink(entry.toPath())) {
          append("LINK  ").append(name).append('\n')
        } else if (entry.isDirectory) {
          append("DIR   ").append(name).append('/').append('\n')
        } else {
          append("FILE  ").append(entry.length()).append(" B  ").append(name).append('\n')
        }
      }
      if (all.size > limit) append("\n… ").append(all.size - limit).append(" more entries")
    }
    val items = JSONArray()
    for (entry in all.take(limit)) {
      val kind = when {
        java.nio.file.Files.isSymbolicLink(entry.toPath()) -> "link"
        entry.isDirectory -> "directory"
        else -> "file"
      }
      items.put(
        JSONObject()
          .put("name", entry.name)
          .put("kind", kind)
          .put("size", if (entry.isFile) entry.length() else 0L)
          .put("modified", entry.lastModified())
          .put("hidden", entry.name.startsWith("."))
      )
    }

    return JSONObject()
      .put("ok", true)
      .put("category", "files")
      .put("view", "files")
      .put("cwd", cwd.absolutePath)
      .put("exitCode", 0)
      .put("count", all.size)
      .put("truncated", all.size > limit)
      .put("items", items)
      .put("output", output)
      .toString()
  }

  private fun mobileProcessesSnapshot(workspacePath: String?): String {
    val raw = JSONObject(
      runMobileToolShell(
        "processes",
        "ps -A -o PID,PPID,USER,STAT,ETIME,NAME,ARGS 2>/dev/null || ps -A",
        workspacePath,
        timeoutSeconds = 8,
      )
    )
    if (!raw.optBoolean("ok", false)) return raw.toString()

    val rows = JSONArray()
    for (line in raw.optString("output").lineSequence()) {
      val trimmed = line.trim()
      if (trimmed.isEmpty() || trimmed.startsWith("PID ")) continue
      val parts = trimmed.split(Regex("""\s+"""), limit = 7)
      if (parts.size < 6 || parts[0].toIntOrNull() == null) continue
      rows.put(
        JSONObject()
          .put("pid", parts[0].toInt())
          .put("ppid", parts.getOrElse(1) { "" })
          .put("user", parts.getOrElse(2) { "" })
          .put("state", parts.getOrElse(3) { "" })
          .put("elapsed", parts.getOrElse(4) { "" })
          .put("name", parts.getOrElse(5) { "" })
          .put("args", parts.getOrElse(6) { "" })
      )
      if (rows.length() >= 400) break
    }
    return raw
      .put("view", "processes")
      .put("count", rows.length())
      .put("items", rows)
      .toString()
  }

  private fun mobilePackagesSnapshot(workspacePath: String?): String {
    val raw = JSONObject(
      runMobileToolShell(
        "packages",
        "dpkg-query -W -f='\${binary:Package}\\t\${Version}\\n' 2>/dev/null | sort | head -n 600",
        workspacePath,
        timeoutSeconds = 12,
      )
    )
    if (!raw.optBoolean("ok", false)) return raw.toString()

    val rows = JSONArray()
    for (line in raw.optString("output").lineSequence()) {
      val tab = line.indexOf('\t')
      if (tab <= 0) continue
      rows.put(
        JSONObject()
          .put("name", line.substring(0, tab))
          .put("version", line.substring(tab + 1))
      )
    }
    return raw
      .put("view", "packages")
      .put("count", rows.length())
      .put("items", rows)
      .toString()
  }

  private fun mobileGitSnapshot(workspacePath: String?): String {
    val script =
      "root=\"\$(git rev-parse --show-toplevel 2>/dev/null)\" || { echo 'Not a Git repository.'; exit 2; }; " +
        "printf '__DSH_ROOT__\\t%s\\n' \"\$root\"; " +
        "printf '__DSH_BRANCH__\\t'; git branch --show-current 2>/dev/null; " +
        "printf '__DSH_STATUS__\\n'; git status --porcelain=v1 2>/dev/null; " +
        "printf '__DSH_LOG__\\n'; git log -12 --date=short --pretty=format:'%h%x09%ad%x09%s' 2>/dev/null || true"
    val raw = JSONObject(runMobileToolShell("git", script, workspacePath, timeoutSeconds = 10))
    if (!raw.optBoolean("ok", false)) return raw.toString()

    var root = ""
    var branch = ""
    var section = ""
    val changes = JSONArray()
    val commits = JSONArray()
    for (line in raw.optString("output").lineSequence()) {
      when {
        line.startsWith("__DSH_ROOT__\t") -> root = line.substringAfter('\t')
        line.startsWith("__DSH_BRANCH__\t") -> branch = line.substringAfter('\t')
        line == "__DSH_STATUS__" -> section = "status"
        line == "__DSH_LOG__" -> section = "log"
        section == "status" && line.isNotBlank() -> {
          val code = line.take(2)
          val path = line.drop(3).trim()
          changes.put(JSONObject().put("code", code).put("path", path))
        }
        section == "log" && line.isNotBlank() -> {
          val parts = line.split('\t', limit = 3)
          if (parts.size == 3) {
            commits.put(
              JSONObject()
                .put("hash", parts[0])
                .put("date", parts[1])
                .put("subject", parts[2])
            )
          }
        }
      }
    }

    return raw
      .put("view", "git")
      .put("root", root)
      .put("branch", branch)
      .put("changes", changes)
      .put("commits", commits)
      .toString()
  }

  private fun mobileNetworkSnapshot(workspacePath: String?): String {
    val raw = JSONObject(
      runMobileToolShell(
        "network",
        "printf '__DSH_ADDR__\\n'; (ip -brief addr 2>/dev/null || ifconfig 2>/dev/null); " +
          "printf '__DSH_LISTEN__\\n'; (ss -ltnp 2>/dev/null || ss -ltn 2>/dev/null || true)",
        workspacePath,
        timeoutSeconds = 10,
      )
    )

    val interfaces = JSONArray()
    val listeners = JSONArray()
    var section = ""
    for (line in raw.optString("output").lineSequence()) {
      when (line.trim()) {
        "__DSH_ADDR__" -> { section = "addr"; continue }
        "__DSH_LISTEN__" -> { section = "listen"; continue }
      }
      val trimmed = line.trim()
      if (trimmed.isEmpty()) continue
      if (section == "addr") {
        val parts = trimmed.split(Regex("""\s+"""), limit = 3)
        if (parts.isNotEmpty()) {
          interfaces.put(
            JSONObject()
              .put("name", parts.getOrElse(0) { "" })
              .put("state", parts.getOrElse(1) { "" })
              .put("addresses", parts.getOrElse(2) { "" })
          )
        }
      } else if (section == "listen") {
        if (trimmed.startsWith("State ") || trimmed.startsWith("Netid ")) continue
        val parts = trimmed.split(Regex("""\s+"""), limit = 7)
        if (parts.size < 4) continue
        val local = parts.getOrElse(3) { "" }
        val match = Regex("""^(.*):(\d+)$""").find(local) ?: continue
        val host = match.groupValues[1].trim('[', ']')
        val port = match.groupValues[2].toIntOrNull() ?: continue
        listeners.put(
          JSONObject()
            .put("protocol", "tcp")
            .put("state", parts.getOrElse(0) { "" })
            .put("host", host)
            .put("port", port)
            .put("local", local)
            .put("process", parts.getOrElse(6) { "" })
            .put("loopback", host == "127.0.0.1" || host == "::1" || host == "localhost")
        )
      }
    }

    val process = DEV_SERVER_PROCESS.get()
    val alive = try { process?.isAlive == true } catch (_: Throwable) { false }
    if (!alive && process != null) {
      DEV_SERVER_PROCESS.compareAndSet(process, null)
      DEV_SERVER_PORT.set(0)
      DEV_SERVER_ROOT.set("")
    }
    val port = if (alive) DEV_SERVER_PORT.get() else 0
    val devServer = JSONObject()
      .put("running", alive)
      .put("port", port)
      .put("url", if (alive && port > 0) "http://127.0.0.1:$port/" else "")
      .put("root", if (alive) DEV_SERVER_ROOT.get() else "")

    return raw
      .put("view", "network")
      .put("interfaces", interfaces)
      .put("listeners", listeners)
      .put("count", listeners.length())
      .put("devServer", devServer)
      .toString()
  }

  private fun startLocalDevServer(portText: String, workspacePath: String?): String {
    val port = portText.trim().toIntOrNull()
      ?: return JSONObject().put("ok", false).put("category", "network").put("error", "端口无效").toString()
    if (port !in 1024..65535) {
      return JSONObject().put("ok", false).put("category", "network").put("error", "端口必须位于 1024–65535").toString()
    }

    val cwd = mobileToolCwd(workspacePath)
    if (workspacePath.isNullOrBlank() || !cwd.isDirectory) {
      return JSONObject().put("ok", false).put("category", "network").put("error", "当前没有可用工作区").toString()
    }

    val current = DEV_SERVER_PROCESS.get()
    if (try { current?.isAlive == true } catch (_: Throwable) { false }) {
      val currentPort = DEV_SERVER_PORT.get()
      return JSONObject()
        .put("ok", false)
        .put("category", "network")
        .put("error", "本地开发服务器已在端口 $currentPort 运行")
        .toString()
    }

    val termuxRun = File(usrDir, "libexec/dsh/termux-run")
    if (!termuxRun.isFile) {
      return JSONObject().put("ok", false).put("category", "network").put("error", "内置 Termux 执行器不可用").toString()
    }

    val logDir = File(homeDir, ".dsh-mobile").apply { mkdirs() }
    val log = File(logDir, "dev-server.log")
    return try {
      if (log.length() > 512 * 1024) log.writeText("")
      val builder = ProcessBuilder(
        "/system/bin/sh",
        termuxRun.absolutePath,
        "python3",
        "-m",
        "http.server",
        port.toString(),
        "--bind",
        "127.0.0.1",
      )
      builder.environment().putAll(engineEnv(preloadBin))
      builder.directory(cwd)
      builder.redirectErrorStream(true)
      builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log))
      val process = builder.start()
      if (process.waitFor(450, TimeUnit.MILLISECONDS)) {
        val tail = try { log.readText().takeLast(2000) } catch (_: Throwable) { "" }
        JSONObject()
          .put("ok", false)
          .put("category", "network")
          .put("error", "本地开发服务器启动后立即退出")
          .put("output", tail)
          .toString()
      } else {
        DEV_SERVER_PROCESS.set(process)
        DEV_SERVER_PORT.set(port)
        DEV_SERVER_ROOT.set(cwd.absolutePath)
        JSONObject()
          .put("ok", true)
          .put("category", "network")
          .put("url", "http://127.0.0.1:$port/")
          .put("port", port)
          .put("root", cwd.absolutePath)
          .put("output", "本地 Python HTTP 服务器已启动：127.0.0.1:$port")
          .toString()
      }
    } catch (t: Throwable) {
      JSONObject()
        .put("ok", false)
        .put("category", "network")
        .put("error", t.message ?: t.javaClass.simpleName)
        .toString()
    }
  }

  private fun stopLocalDevServer(): String {
    val process = DEV_SERVER_PROCESS.getAndSet(null)
    val port = DEV_SERVER_PORT.getAndSet(0)
    DEV_SERVER_ROOT.set("")
    if (process == null) {
      return JSONObject().put("ok", true).put("category", "network").put("output", "当前没有由应用管理的开发服务器").toString()
    }
    return try {
      if (process.isAlive) {
        process.destroy()
        if (!process.waitFor(1200, TimeUnit.MILLISECONDS) && process.isAlive) process.destroyForcibly()
      }
      JSONObject()
        .put("ok", true)
        .put("category", "network")
        .put("output", "已停止端口 $port 上的本地开发服务器")
        .toString()
    } catch (t: Throwable) {
      JSONObject()
        .put("ok", false)
        .put("category", "network")
        .put("error", t.message ?: t.javaClass.simpleName)
        .toString()
    }
  }

  private fun mobileSystemSnapshot(workspacePath: String?): String {
    val raw = JSONObject(
      runMobileToolShell(
        "system",
        "printf 'Kernel:\\n'; uname -a; printf '\\nIdentity:\\n'; id; " +
          "printf '\\nStorage:\\n'; df -h .; printf '\\nRuntime:\\n'; " +
          "printf 'SHELL=%s\\nTERM=%s\\nCOLORTERM=%s\\nHOME=%s\\nTMPDIR=%s\\n' " +
          "\"\$SHELL\" \"\$TERM\" \"\$COLORTERM\" \"\$HOME\" \"\$TMPDIR\"; " +
          "printf 'XDG_CONFIG_HOME=%s\\nXDG_DATA_HOME=%s\\nXDG_STATE_HOME=%s\\nXDG_CACHE_HOME=%s\\n' " +
          "\"\$XDG_CONFIG_HOME\" \"\$XDG_DATA_HOME\" \"\$XDG_STATE_HOME\" \"\$XDG_CACHE_HOME\"; " +
          "printf '\\nAndroid:\\n'; getprop ro.product.manufacturer 2>/dev/null; " +
          "getprop ro.product.model 2>/dev/null; getprop ro.build.version.release 2>/dev/null; " +
          "getprop ro.build.version.sdk 2>/dev/null",
        workspacePath,
        timeoutSeconds = 8,
      )
    )

    val provider = try { WebView.getCurrentWebViewPackage() } catch (_: Throwable) { null }
    val defaultUa = try { WebSettings.getDefaultUserAgent(context) } catch (_: Throwable) { "" }
    val browser = JSONObject()
      .put("engine", "Chromium WebView")
      .put("provider", provider?.packageName ?: "unknown")
      .put("version", provider?.versionName ?: "")
      .put("userAgent", defaultUa)
      .put("javascript", true)
      .put("domStorage", true)
      .put("cookies", true)
      .put("thirdPartyCookies", true)
      .put("safeBrowsing", true)
      .put("mixedContent", "never_allow")
      .put("fileAccess", false)

    val runtime = JSONObject()
      .put("shell", File(usrDir, "bin/bash").absolutePath)
      .put("home", homeDir.absolutePath)
      .put("prefix", usrDir.absolutePath)
      .put("xdgConfig", File(homeDir, ".config").absolutePath)
      .put("xdgData", File(homeDir, ".local/share").absolutePath)
      .put("xdgState", File(homeDir, ".local/state").absolutePath)
      .put("xdgCache", nodeCacheDir.absolutePath)
      .put("term", "xterm-256color")
      .put("colorTerm", "truecolor")

    return raw
      .put("view", "system")
      .put("browser", browser)
      .put("runtimeEnvironment", runtime)
      .toString()
  }

  private fun readMobileToolLog(file: File, maxBytes: Int = 128 * 1024): String {
    if (!file.isFile) return ""
    val length = file.length()
    val size = minOf(length, maxBytes.toLong()).toInt()
    val bytes = ByteArray(size)
    var offset = 0
    file.inputStream().use { input ->
      while (offset < size) {
        val read = input.read(bytes, offset, size - offset)
        if (read <= 0) break
        offset += read
      }
    }
    val text = String(bytes, 0, offset, Charsets.UTF_8)
    return if (length > maxBytes) text + "\n\n[output truncated]" else text
  }

  private fun runMobileToolShell(
    category: String,
    script: String,
    workspacePath: String?,
    timeoutSeconds: Long,
  ): String {
    val cwd = mobileToolCwd(workspacePath)
    val termuxRun = File(usrDir, "libexec/dsh/termux-run")
    if (!termuxRun.isFile) {
      return JSONObject()
        .put("ok", false)
        .put("category", category)
        .put("cwd", cwd.absolutePath)
        .put("error", "内置 Termux 执行器不可用")
        .toString()
    }

    val log = File.createTempFile("dsh-mobile-tool-", ".log", context.cacheDir)
    var process: Process? = null
    return try {
      val builder = ProcessBuilder(
        "/system/bin/sh",
        termuxRun.absolutePath,
        "bash",
        "-lc",
        script,
      )
      builder.environment().putAll(engineEnv(preloadBin))
      builder.directory(cwd)
      builder.redirectErrorStream(true)
      builder.redirectOutput(log)
      process = builder.start()

      val finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
      if (!finished) {
        process.destroy()
        if (!process.waitFor(500, TimeUnit.MILLISECONDS)) process.destroyForcibly()
      }
      val exitCode = if (finished) process.exitValue() else -2
      val output = readMobileToolLog(log)
      JSONObject()
        .put("ok", finished && exitCode == 0)
        .put("category", category)
        .put("cwd", cwd.absolutePath)
        .put("exitCode", exitCode)
        .put("timedOut", !finished)
        .put("output", output)
        .apply {
          if (!finished) put("error", "命令执行超时（$timeoutSeconds 秒）")
        }
        .toString()
    } catch (t: Throwable) {
      try { process?.destroyForcibly() } catch (_: Throwable) {}
      JSONObject()
        .put("ok", false)
        .put("category", category)
        .put("cwd", cwd.absolutePath)
        .put("exitCode", -3)
        .put("error", t.message ?: t.javaClass.simpleName)
        .put("output", readMobileToolLog(log))
        .toString()
    } finally {
      try { log.delete() } catch (_: Throwable) {}
    }
  }

  private fun compatibilityHint(text: String): String? = when {
    text.contains("node-addon-require-builtin", ignoreCase = true) ->
      "Android 兼容层缺少 require-builtin 回退；请用 v0.1 的兼容构建脚本重新生成 runtime。"
    text.contains("flock is not supported", ignoreCase = true) ->
      "检测到 Android flock 原生绑定不兼容；请重新生成已应用 single-process flock fallback 的 runtime。"
    text.contains("pty.node", ignoreCase = true) ->
      "node-pty 原生模块不可用；构建端需安装 clang/cmake/make/python 后重新构建。"
    text.contains("sharp", ignoreCase = true) && text.contains("android", ignoreCase = true) ->
      "Sharp Android 原生绑定不可用；v0.1 兼容构建会安装 @img/sharp-wasm32 回退。"
    text.contains("UNSUPPORTED_SCHEMA", ignoreCase = true) || text.contains("schema.type must be one of", ignoreCase = true) ->
      "检测到社区插件使用旧版工具输出 JSON Schema；Android 宿主会在工具注册边界做非破坏式兼容规范化，不改写插件源码或用户数据。"
    text.contains("installSettingsSection", ignoreCase = true) || text.contains("settingsNamespace", ignoreCase = true) ->
      "检测到旧版社区插件 Settings API；请更新插件，或使用 v0.1 的 legacy settings compatibility shim。"
    text.contains("git", ignoreCase = true) && (text.contains("not found", ignoreCase = true) || text.contains("ENOENT", ignoreCase = true)) ->
      "Git/GitHub 插件安装需要 v0.1 的内置 Git runtime；请重新构建并确认日志显示 Git/SSH/CA runtime: OK。"
    text.contains("certificate", ignoreCase = true) || text.contains("SSL certificate", ignoreCase = true) ->
      "检测到 TLS/CA 错误；v0.1 会内置 CA bundle 并向 Git/curl/Node 显式注入证书路径。"
    else -> null
  }

  /** Human-readable recovery hint for plugin package-manager failures. */
  fun pluginCompatibilityAdvice(result: PluginCommandResult): String? = when (result.failureKind) {
    "build-blocked" -> if (result.pendingBuilds.isEmpty())
      "pnpm 阻止了安装期构建脚本。请只对可信插件授权其 prepare/install 脚本后重试。"
    else "pnpm 阻止了安装期构建脚本；可授权并重试：${result.pendingBuilds.joinToString(", ")}"
    "network" -> "网络请求连续失败。已自动重试两次；检查 VPN、DNS、npm registry 或 GitHub 连通性。"
    "not-found" -> "注册表或远程仓库未找到该插件。检查包名、仓库地址、分支或私有仓库凭据。"
    "no-matching-version" -> "没有匹配的插件版本。检查版本范围，或改用插件作者明确支持的版本。"
    "workspace-protocol" -> "该源码包仍引用 monorepo 的 workspace: 依赖。优先安装作者发布的 npm 包或 pnpm pack 生成的 .tgz。"
    "unsupported-platform" -> "插件或其依赖未声明 Android/arm64 支持。预编译的 Linux/Windows/macOS 原生模块不能直接在 Android 使用。"
    "engine" -> "插件声明的 Node.js engine 与内置 Node 不兼容。"
    "native-build" -> "插件需要在安装时编译原生 Node 模块；APK 运行时不内置完整编译工具链，优先使用带 Android 预编译产物或纯 JS/WASM 的版本。"
    "integrity" -> "下载包完整性校验失败。清理该插件缓存后重试，或换用可信 tarball/npm 来源。"
    "disk-full" -> "应用私有存储空间不足，无法完成插件安装。"
    "permission" -> "插件安装遇到 Android 文件权限/执行权限限制。"
    "profile-invalid" -> "插件包已落盘，但其 DSH 配置层与当前稳定版不兼容；兼容层已尽量保持 Host 可启动。"
    "timeout" -> "插件安装超时；大型 Git 插件首次 prepare 构建可能较慢。"
    else -> compatibilityHint(result.output)
  }

  /** Runtime is ready only when every file startEngine() actually requires exists. */
  val engineReady: Boolean get() = runtimeHealth().ok

  fun runtimeHealth(): RuntimeHealth {
    val files = runtimeHealthFilesOnly()
    val missing = files.missing.toMutableList()
    if (missing.isEmpty() && !installedRuntimeAccepted()) missing += "runtime identity mismatch"
    return RuntimeHealth(missing.isEmpty(), missing)
  }

  /**
   * Mark the runtime for transactional replacement without deleting it first.
   *
   * A repair must never destroy the last runnable /usr before a replacement has
   * been completely extracted and validated. User HOME is never touched here.
   */
  fun clearBrokenRuntime() {
    try { runtimeIdMarker.delete() } catch (_: Throwable) {}
    ACTIVE_PROCESS.set(null)
    engineProcess = null
  }

  /**
   * Token-bearing DSH Web URL printed by the current Host at startup. Newer
   * stable DSH releases protect the local UI with a one-time URL token; the
   * Android WebView must consume that URL once so the Host can issue its
   * session cookie. Falling back to the bare loopback URL keeps older DSH
   * releases working unchanged.
   */
  fun webStartupUrl(): String {
    val log = try { if (engineLogFile.isFile) engineLogFile.readText() else "" } catch (_: Throwable) { "" }
    val match = Regex("""https?://(?:127\.0\.0\.1|localhost|\[::1\]):\d+/\?token=[^\s]+""")
      .findAll(log)
      .lastOrNull()
      ?.value
      ?.trimEnd('.', ',', ';', ')', ']', '}')
    return match ?: EngineProbe.ENGINE_URL
  }

  /** Last useful engine diagnostics for the recovery screen. */
  fun engineDiagnostics(maxChars: Int = 6000): String {
    val health = runtimeHealth()
    val log = try {
      if (engineLogFile.isFile) engineLogFile.readText() else ""
    } catch (_: Throwable) { "" }
    val tail = if (log.length <= maxChars) log else log.takeLast(maxChars)
    return buildString {
      append("DSH ").append(dshVersion())
      if (compatManifestFile.isFile) append(" · Android compat runtime")
      if (!health.ok) append("\n").append(health.describe())
      val startError = LAST_START_ERROR
      if (startError.isNotBlank()) {
        if (isNotEmpty()) append('\n')
        append(startError)
      }
      if (tail.isNotBlank()) {
        if (isNotEmpty()) append("\n\n--- engine.log ---\n")
        append(tail)
      }
      compatibilityHint(startError + "\n" + tail)?.let { hint ->
        append("\n\n--- Android compatibility ---\n").append(hint)
      }
    }.trim()
  }

  /** 进程级启动守卫（MainActivity 与 EngineService 各自 new EngineManager，
   *  实例字段互不可见——双启动竞态必须用 companion 级 CAS）。 */
  private val starting: Boolean
    get() = STARTING.get()

  /**
   * Extract the bundled snapshot archive into filesDir. Runs on any thread;
   * callers own the progress UI.
   * @param onProgress bytesDone, bytesTotal.
   * @returns true on success.
   */
  /**
   * Runtime archives can contain a bootstrap home/. That tree is install-time
   * seed data, not an upgrade payload. Once a prior runtime/user profile exists,
   * HOME is authoritative and must survive APK replacement and runtime repair.
   */
  private fun shouldPreserveUserHome(): Boolean {
    if (userHomeInitializedMarker.isFile || runtimeIdMarker.isFile) return true
    if (File(dshDataDir, ".migrated-from").isFile) return true
    val dsh = File(homeDir, ".dsh")
    val webProfile = File(dsh, "profiles/web")
    return File(dsh, ".credentials.yaml").isFile ||
      File(dsh, "sessions").exists() ||
      File(dsh, "storages").exists() ||
      File(dsh, "attachments").exists() ||
      File(dsh, "skills").exists() ||
      File(webProfile, "package.json").isFile ||
      File(webProfile, "pnpm-lock.yaml").isFile ||
      File(webProfile, "node_modules").isDirectory
  }

  private fun runtimeHealthFilesAt(rootUsr: File): RuntimeHealth {
    val required = listOf(
      File(rootUsr, "bin/node") to "usr/bin/node",
      File(rootUsr, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js") to "@deepseek-ai/dsh/lib/bin.js",
      File(rootUsr, "lib/libtermux-exec-ld-preload.so") to "usr/lib/libtermux-exec-ld-preload.so",
      File(rootUsr, "bin/bash") to "usr/bin/bash",
      File(rootUsr, "libexec/dsh-mobile/android-sandbox-runner.sh") to "usr/libexec/dsh-mobile/android-sandbox-runner.sh",
      File(rootUsr, "libexec/dsh/wrappers/python3") to "usr/libexec/dsh/wrappers/python3",
      File(rootUsr, "libexec/dsh/wrappers/pip3") to "usr/libexec/dsh/wrappers/pip3",
      File(rootUsr, "libexec/dsh/wrappers/pkg") to "usr/libexec/dsh/wrappers/pkg",
      File(rootUsr, "libexec/dsh/wrappers/apt") to "usr/libexec/dsh/wrappers/apt",
      File(rootUsr, "libexec/dsh/wrappers/dpkg") to "usr/libexec/dsh/wrappers/dpkg",
      File(rootUsr, "bin/proot") to "usr/bin/proot",
    )
    val missing = required.filterNot { it.first.isFile }.map { it.second }
    return RuntimeHealth(missing.isEmpty(), missing)
  }

  private fun seedHomeFromStage(stageHome: File) {
    if (!stageHome.isDirectory) return
    if (shouldPreserveUserHome()) return
    if (!homeDir.exists()) {
      if (!stageHome.renameTo(homeDir)) {
        homeDir.mkdirs()
        copyTree(stageHome, homeDir, emptySet(), overwrite = false)
      }
      return
    }
    // A pre-existing HOME may contain user-created files even without an old
    // marker. Never replace it; only seed files that do not already exist.
    copyTree(stageHome, homeDir, emptySet(), overwrite = false)
  }

  fun extractSnapshot(onProgress: (Long, Long) -> Unit): Boolean {
    val stageRoot = File(context.filesDir, ".runtime-stage-" + System.nanoTime())
    val stageUsr = File(stageRoot, "usr")
    val stageHome = File(stageRoot, "home")
    val backupUsr = File(context.filesDir, ".usr-backup-" + System.nanoTime())
    var oldUsrBackedUp = false
    var newUsrCommitted = false

    return try {
      // Never extract directly over the live runtime. A malformed archive,
      // unsupported symlink or interrupted copy must leave both user data and
      // the previous /usr untouched.
      if (!stageRoot.mkdirs()) throw java.io.IOException("无法创建运行时暂存目录")

      val fd = context.assets.openFd("snapshot.tar.xz")
      SnapshotExtractor.extract(
        context.assets.open("snapshot.tar.xz"),
        fd.length,
        stageRoot,
        preservedRoots = emptySet(),
        onProgress = onProgress,
      )

      val stagedHealth = runtimeHealthFilesAt(stageUsr)
      if (!stagedHealth.ok) {
        throw java.io.IOException("暂存运行时不完整：" + stagedHealth.describe())
      }

      // Seed HOME independently. Existing user HOME is authoritative and is
      // never renamed/deleted as part of a runtime repair.
      seedHomeFromStage(stageHome)

      if (usrDir.exists()) {
        if (backupUsr.exists()) backupUsr.deleteRecursively()
        if (!usrDir.renameTo(backupUsr)) {
          throw java.io.IOException("无法备份现有运行时；已取消修复以保护数据")
        }
        oldUsrBackedUp = true
      }

      if (!stageUsr.renameTo(usrDir)) {
        throw java.io.IOException("无法提交新运行时")
      }
      newUsrCommitted = true

      val health = runtimeHealthFilesOnly()
      if (!health.ok) {
        throw java.io.IOException("新运行时提交后校验失败：" + health.describe())
      }

      runtimeIdMarker.writeText(bundledRuntimeId())
      userHomeInitializedMarker.writeText("1\n")
      if (oldUsrBackedUp) backupUsr.deleteRecursively()
      stageRoot.deleteRecursively()
      LAST_START_ERROR = ""
      true
    } catch (t: Throwable) {
      // Roll back /usr if commit had started. HOME and public DSH data are never
      // part of this transaction and therefore cannot be lost here.
      try {
        if (newUsrCommitted && usrDir.exists()) usrDir.deleteRecursively()
        if (oldUsrBackedUp && backupUsr.exists() && !usrDir.exists()) {
          if (!backupUsr.renameTo(usrDir)) {
            Log.e(TAG, "runtime rollback rename failed; backup retained at ${backupUsr.absolutePath}")
          }
        }
      } catch (rollback: Throwable) {
        Log.e(TAG, "runtime rollback failed", rollback)
      }
      try { stageRoot.deleteRecursively() } catch (_: Throwable) {}
      try { runtimeIdMarker.delete() } catch (_: Throwable) {}
      LAST_START_ERROR = "运行时解压异常：" + (t.message ?: t.javaClass.simpleName)
      Log.e(TAG, "transactional snapshot extract failed", t)
      false
    }
  }

  /**
   * 确保公共持久化目录就绪（幂等，后台线程调用）。
   *
   * 方案（issue apk#8）：DSH_HOME 本身**必须留在私有域**——dsh 每次启动会在
   * `$DSH_HOME/profiles/node_modules` 维护 flat-module 回退（每个依赖包一个
   * symlink 指向引擎安装位置），而公共目录（/storage/emulated/0）FUSE 禁止
   * 创建 symlink（实测 Permission denied），整体迁移会使引擎必然崩溃。
   *
   * 因此采用**数据项级迁移**：把用户数据搬到 Documents/dshdata，并在私有
   * 原位建立 symlink（app 私有域允许 symlink，实测 OK），dsh 读写跟随
   * symlink 落到公共目录：
   *  - settings.yaml：拷贝到公共（settings-file 经 cordis.patch.yml 的
   *    config.path 直接指向公共文件，规避原子写替换 symlink 的问题）
   *  - sessions/、storages/、attachments/：整体搬移 + 私有 symlink
   *    （目录内写文件不会替换目录 symlink）
   *  - profiles/{web,headless}/cordis.yml + cordis.patch.yml：拷贝到公共
   *    + 私有替换为 symlink（dsh 启动只读这两个文件）
   *  - .credentials.yaml（API key）：**不迁移**——公共目录 FUSE 强制 660，
   *    credentials-local 权限校验会拒绝加载，且 key 暴露给其他应用；
   *    key 留在私有实体，由 cordis.patch.yml 的 credentials path 指向。
   * 迁移源在搬移后仅剩 symlink/保留实体，不删除公共副本。
   */
  @Synchronized
  fun ensureDshDataHome(): File {
    val dshData = dshDataDir
    val privateDsh = File(homeDir, ".dsh")
    val marker = File(dshData, ".migrated-from")
    if (privateDsh.isDirectory && !marker.exists()) {
      try {
        dshData.mkdirs()
        // settings.yaml is copied, never moved: settings-file is configured to
        // point at the public copy, while rollback must keep the private source.
        val privateSettings = File(privateDsh, "settings.yaml")
        val publicSettings = File(dshData, "settings.yaml")
        if (privateSettings.isFile && !publicSettings.exists()) copyFileIfExists(privateSettings, publicSettings)

        var complete = true
        complete = relocateDirTransactional(File(privateDsh, "sessions"), File(dshData, "sessions")) && complete
        complete = relocateDirTransactional(File(privateDsh, "storages"), File(dshData, "storages")) && complete
        complete = relocateDirTransactional(File(privateDsh, "attachments"), File(dshData, "attachments")) && complete

        for (profile in listOf("web", "headless")) {
          for (name in listOf("cordis.yml", "cordis.patch.yml")) {
            complete = relocateReadOnlyFileTransactional(
              File(privateDsh, "profiles/$profile/$name"),
              File(dshData, "profiles/$profile/$name"),
            ) && complete
          }
        }

        if (complete) {
          val tmp = File(dshData, ".migrated-from.tmp-${System.nanoTime()}")
          tmp.writeText(privateDsh.absolutePath + "\n")
          if (!tmp.renameTo(marker)) {
            tmp.copyTo(marker, overwrite = true)
            tmp.delete()
          }
          Log.i(TAG, "dshdata migration committed -> " + dshData.absolutePath)
        } else {
          Log.w(TAG, "dshdata migration left uncommitted; private data remains authoritative")
        }
      } catch (t: Throwable) {
        // Migration failure must never make the private DSH tree disappear.
        // Each destructive step rolls itself back; without the marker the next
        // launch retries only the still-uncommitted items.
        Log.e(TAG, "dshdata migration failed", t)
      }
    }
    return privateDsh
  }

  /** Copy one file only when present. Source remains untouched. */
  private fun copyFileIfExists(src: File, dst: File) {
    if (!src.isFile) return
    dst.parentFile?.mkdirs()
    src.copyTo(dst, overwrite = true)
  }

  private fun symlinkPointsTo(src: File, dst: File): Boolean = try {
    val p = src.toPath()
    java.nio.file.Files.isSymbolicLink(p) &&
      p.parent.resolve(java.nio.file.Files.readSymbolicLink(p)).normalize().toFile().canonicalFile == dst.canonicalFile
  } catch (_: Throwable) { false }

  /**
   * Transactional directory migration. The private source is first copied to a
   * public staging directory. Only after the public copy is complete is the
   * private directory renamed to a same-filesystem backup and replaced by a
   * symlink. If symlink creation fails, the private backup is restored before
   * the public copy is removed.
   */
  private fun relocateDirTransactional(src: File, dst: File): Boolean {
    if (symlinkPointsTo(src, dst)) return true

    // Repair a v0.13.1-style interrupted migration: public data exists while
    // the private source was deleted before symlink creation succeeded.
    if (!src.exists() && dst.isDirectory) {
      src.parentFile?.mkdirs()
      return try {
        java.nio.file.Files.createSymbolicLink(src.toPath(), dst.toPath())
        true
      } catch (t: Throwable) {
        Log.w(TAG, "repair symlink failed; restoring private directory ${src.absolutePath}", t)
        try {
          src.mkdirs()
          copyTree(dst, src, emptySet(), overwrite = false)
        } catch (restore: Throwable) {
          Log.e(TAG, "failed to restore private directory ${src.absolutePath}", restore)
        }
        false
      }
    }
    if (!src.exists()) return true
    if (!src.isDirectory) return false
    if (dst.exists()) {
      // Both trees contain data and there is no reliable ordering signal. Do
      // not overwrite either side automatically; keep the private tree live.
      Log.w(TAG, "migration conflict; both source and destination exist: ${src.absolutePath} / ${dst.absolutePath}")
      return false
    }

    dst.parentFile?.mkdirs()
    val stage = File(dst.parentFile, ".${dst.name}.migrate-${System.nanoTime()}")
    val backup = File(src.parentFile, ".${src.name}.migration-backup-${System.nanoTime()}")
    return try {
      stage.mkdirs()
      copyTree(src, stage, emptySet(), overwrite = true)
      if (!stage.renameTo(dst)) throw java.io.IOException("无法提交公共迁移目录 ${dst.absolutePath}")
      if (!src.renameTo(backup)) throw java.io.IOException("无法创建私有迁移备份 ${src.absolutePath}")
      try {
        java.nio.file.Files.createSymbolicLink(src.toPath(), dst.toPath())
      } catch (linkError: Throwable) {
        try { java.nio.file.Files.deleteIfExists(src.toPath()) } catch (_: Throwable) {}
        if (!backup.renameTo(src)) {
          src.mkdirs()
          copyTree(backup, src, emptySet(), overwrite = true)
          backup.deleteRecursively()
        }
        dst.deleteRecursively()
        throw linkError
      }
      backup.deleteRecursively()
      true
    } catch (t: Throwable) {
      stage.deleteRecursively()
      if (!src.exists() && backup.exists()) {
        if (!backup.renameTo(src)) {
          src.mkdirs()
          try { copyTree(backup, src, emptySet(), overwrite = true) } catch (_: Throwable) {}
        }
      }
      Log.w(TAG, "transactional directory migration failed: ${src.absolutePath}", t)
      false
    }
  }

  /** Transactional migration for the read-only profile patch/config files. */
  private fun relocateReadOnlyFileTransactional(src: File, dst: File): Boolean {
    if (symlinkPointsTo(src, dst)) return true
    if (!src.exists() && dst.isFile) {
      src.parentFile?.mkdirs()
      return try {
        java.nio.file.Files.createSymbolicLink(src.toPath(), dst.toPath())
        true
      } catch (t: Throwable) {
        try { dst.copyTo(src, overwrite = false) } catch (_: Throwable) {}
        Log.w(TAG, "repair config symlink failed: ${src.absolutePath}", t)
        false
      }
    }
    if (!src.exists()) return true
    if (!src.isFile) return false
    if (dst.exists()) {
      Log.w(TAG, "config migration conflict; keeping private file: ${src.absolutePath}")
      return false
    }

    dst.parentFile?.mkdirs()
    val stage = File(dst.parentFile, ".${dst.name}.migrate-${System.nanoTime()}")
    val backup = File(src.parentFile, ".${src.name}.migration-backup-${System.nanoTime()}")
    return try {
      src.copyTo(stage, overwrite = false)
      if (!stage.renameTo(dst)) throw java.io.IOException("无法提交公共配置 ${dst.absolutePath}")
      if (!src.renameTo(backup)) throw java.io.IOException("无法备份私有配置 ${src.absolutePath}")
      try {
        java.nio.file.Files.createSymbolicLink(src.toPath(), dst.toPath())
      } catch (linkError: Throwable) {
        try { java.nio.file.Files.deleteIfExists(src.toPath()) } catch (_: Throwable) {}
        if (!backup.renameTo(src)) backup.copyTo(src, overwrite = true)
        dst.delete()
        throw linkError
      }
      backup.delete()
      true
    } catch (t: Throwable) {
      stage.delete()
      if (!src.exists() && backup.exists()) {
        if (!backup.renameTo(src)) try { backup.copyTo(src, overwrite = true) } catch (_: Throwable) {}
      }
      Log.w(TAG, "transactional config migration failed: ${src.absolutePath}", t)
      false
    }
  }

  /** Recursively copy physical directory content without following symlinks. */
  private fun copyTree(src: File, dst: File, skip: Set<String>, overwrite: Boolean) {
    src.listFiles()?.forEach { f ->
      if (f.name in skip) return@forEach
      val target = File(dst, f.name)
      if (java.nio.file.Files.isSymbolicLink(f.toPath())) {
        throw java.io.IOException("迁移目录包含 symlink，拒绝自动搬移：${f.absolutePath}")
      }
      if (f.isDirectory) {
        if (!target.exists()) target.mkdirs()
        copyTree(f, target, skip, overwrite)
      } else if (!target.exists() || overwrite) {
        f.copyTo(target, overwrite = overwrite)
      }
    }
  }

  /** Start the dsh web engine from the embedded snapshot. */
  fun startEngine(port: Int = 3080, runtimeAlreadyChecked: Boolean = false): Boolean {
    if (!runtimeAlreadyChecked) {
      val health = runtimeHealth()
      if (!health.ok) {
        LAST_START_ERROR = health.describe()
        Log.e(TAG, "engine start failed: " + health.describe())
        return false
      }
    }
    val preload = preloadBin
    // If a child is genuinely alive, both Activity and Service should reuse it
    // while its HTTP listener is still booting. If the old child already died,
    // clear the stale Process reference and allow an immediate restart. The old
    // 90-second timestamp-only cooldown could otherwise strand a relaunch on
    // the startup screen after a crash/OS reclaim: startEngine() returned true
    // without actually creating a new process.
    val active = ACTIVE_PROCESS.get()
    if (active != null) {
      val alive = try { active.isAlive } catch (_: Throwable) { false }
      if (alive) return true
      ACTIVE_PROCESS.compareAndSet(active, null)
    }

    // 进程级 CAS：并发调用只有一个能真正启动（设备实证 EADDRINUSE 双启动）。
    if (!STARTING.compareAndSet(false, true)) return true
    return try {
      // This must run before the Host starts, not only before Android-native
      // plugin operations: Web marketplace plugins invoke DSH's plugin manager
      // inside the already-running Host and therefore share this profile file.
      ensurePluginWorkspaceCompat("web")
      applyAndroidCodexModelPickerCompat("web").forEach { Log.i(TAG, "[plugin compat] $it") }
      val mcpPatch = mcpConfigManager.ensureRuntimePatch()
      val args = arrayOf(
        nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath,
        "web", "--patch", mcpPatch.absolutePath, "--port", port.toString(), "--no-open",
      )
      engineLogFile.parentFile?.mkdirs()
      engineLogFile.writeText("")
      val env = engineEnv(preload)
      engineProcess = startWithArgs(args, env)
      ACTIVE_PROCESS.set(engineProcess)

      // Catch only truly immediate linker/loader failures here. The Activity
      // polls both the HTTP endpoint and child liveness at high frequency, so
      // a long fixed wait just adds cold-start latency.
      val early = engineProcess?.waitFor(80, TimeUnit.MILLISECONDS) == true
      if (early) {
        val code = try { engineProcess?.exitValue() ?: -1 } catch (_: Throwable) { -1 }
        ACTIVE_PROCESS.compareAndSet(engineProcess, null)
        engineProcess = null
        LAST_START_ERROR = "DSH 引擎启动后立即退出（exit=$code）"
        val diag = engineDiagnostics(3500)
        Log.e(TAG, "engine exited during boot: $diag")
        return false
      }

      LAST_START_ERROR = ""
      true
    } catch (t: Throwable) {
      LAST_START_ERROR = "启动异常：" + (t.message ?: t.javaClass.simpleName)
      Log.e(TAG, "engine start failed", t)
      false
    } finally {
      STARTING.set(false)
    }
  }

  /** True while the engine child started in this app process is still alive. */
  fun isEngineProcessAlive(): Boolean {
    val process = ACTIVE_PROCESS.get() ?: engineProcess ?: return false
    return try { process.isAlive } catch (_: Throwable) { false }
  }

  private fun preferredSshKeyFile(): File? = listOf("id_dsh", "id_ed25519", "id_rsa", "id_ecdsa")
    .map { File(homeDir, ".ssh/$it") }
    .firstOrNull { it.isFile }

  /** Create a secret-free helper script. Secrets are supplied only in child env. */
  private fun ensureHelperScript(name: String, body: String): File {
    val dir = File(homeDir, ".dsh-helpers").apply { mkdirs() }
    val file = File(dir, name)
    val text = "#!/system/bin/sh\n" + body.trimIndent().trim() + "\n"
    if (!file.isFile || file.readText() != text) file.writeText(text)
    try { android.system.Os.chmod(dir.absolutePath, 448) } catch (_: Throwable) {} // 0700
    try { android.system.Os.chmod(file.absolutePath, 448) } catch (_: Throwable) {} // 0700
    return file
  }

  private fun sshCommand(batchMode: Boolean): String = buildString {
    append(sshBin.absolutePath)
    if (sshConfigFile.isFile) append(" -F ").append(sshConfigFile.absolutePath)
    preferredSshKeyFile()?.let { append(" -i ").append(it.absolutePath) }
    append(" -o IdentitiesOnly=yes")
    append(" -o BatchMode=").append(if (batchMode) "yes" else "no")
    append(" -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no")
    append(" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=")
    append(File(homeDir, ".ssh/known_hosts").absolutePath)
  }

  /** Environment used by the DSH web engine and bundled command-line tools. */
  private fun engineEnv(preload: File = preloadBin): Map<String, String> {
    File(homeDir, ".ssh").mkdirs()
    val xdgConfig = File(homeDir, ".config").apply { mkdirs() }
    val xdgData = File(homeDir, ".local/share").apply { mkdirs() }
    val xdgState = File(homeDir, ".local/state").apply { mkdirs() }
    val runtimeDir = File(homeDir, ".run").apply {
      mkdirs()
      try { android.system.Os.chmod(absolutePath, 448) } catch (_: Throwable) {}
    }
    val editor = sequenceOf("nvim", "micro", "vi")
      .map { File(usrDir, "bin/$it") }
      .firstOrNull { it.isFile }
      ?.absolutePath
      ?: File(usrDir, "bin/bash").absolutePath
    val env = mutableMapOf(
      "PATH" to (usrDir.absolutePath + "/libexec/dsh/wrappers:" + usrDir.absolutePath + "/bin:/system/bin"),
      "LD_LIBRARY_PATH" to (usrDir.absolutePath + "/lib"),
      "HOME" to homeDir.absolutePath,
      "XDG_CONFIG_HOME" to xdgConfig.absolutePath,
      "XDG_DATA_HOME" to xdgData.absolutePath,
      "XDG_STATE_HOME" to xdgState.absolutePath,
      "XDG_RUNTIME_DIR" to runtimeDir.absolutePath,
      "TERM" to "xterm-256color",
      "COLORTERM" to "truecolor",
      "TERM_PROGRAM" to "DSH-Mobile",
      "TERM_PROGRAM_VERSION" to "0.1.1",
      "EDITOR" to editor,
      "VISUAL" to editor,
      "GIT_EDITOR" to editor,
      "TMP" to File(homeDir, "tmp").apply { mkdirs() }.absolutePath,
      "TEMP" to File(homeDir, "tmp").absolutePath,
      "PYTHONUTF8" to "1",
      "PYTHONIOENCODING" to "utf-8",
      // Sidebar terminal + model terminal tools must resolve the embedded
      // Android-compatible Bash rather than the app process' empty/default
      // shell. The plugin checks DSH_SIDEBAR_SHELL before $SHELL.
      "DSH_SIDEBAR_SHELL" to File(usrDir, "bin/bash").absolutePath,
      "SHELL" to File(usrDir, "bin/bash").absolutePath,
      "DSH_HOME" to ensureDshDataHome().absolutePath,
      "TMPDIR" to File(homeDir, "tmp").apply { mkdirs() }.absolutePath,
      "XDG_CACHE_HOME" to nodeCacheDir.absolutePath,
      // Node 22+ persists V8 module compile artifacts here. Older Node
      // versions ignore this variable, so the optimization is backwards-safe.
      "NODE_COMPILE_CACHE" to nodeCompileCacheDir.absolutePath,
      "LD_PRELOAD" to preload.absolutePath,
      "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE" to "force",
      "TERMUX_EXEC__EXECVE_CALL__INTERCEPT" to "1",
      "TERMUX__ROOTFS" to (usrDir.parentFile?.absolutePath ?: context.filesDir.absolutePath),
      "TERMUX__PREFIX" to usrDir.absolutePath,
      "TERMUX_PREFIX" to usrDir.absolutePath,
      "PREFIX" to usrDir.absolutePath,
      "TERMUX_HOME" to homeDir.absolutePath,
      "TERMUX_APP__DATA_DIR" to (context.filesDir.parentFile?.absolutePath ?: context.applicationInfo.dataDir),
      "TERMUX_APP__LEGACY_DATA_DIR" to "/data/data/com.dshmobile.shell",
      "TERMUX_VERSION" to "0.118.3",
      // @vscode/ripgrep does not publish Android binaries; the build script
      // copies Termux rg into the embedded prefix when available.
      "DSH_RG_PATH" to File(usrDir, "bin/rg").takeIf { it.isFile }?.absolutePath.orEmpty(),
      "DSH_ANDROID_STANDALONE" to "1",
      // Android cannot rely on desktop Linux bwrap/Landlock from an ordinary
      // app UID. sandbox-local is patched to use this explicit partial runner
      // while fs-sandbox remains the workspace write-containment authority.
      "DSH_ANDROID_SANDBOX_RUNNER" to File(usrDir, "libexec/dsh-mobile/android-sandbox-runner.sh").absolutePath,
      "DSH_PICK_TOKEN" to (pickToken ?: ""),
      // DSH's in-Web plugin manager launches pnpm as a child of this Host.
      // Keep peer dependency resolution aligned with the shipped profile:
      // DSH peers come from the runtime fallback rather than npm prereleases.
      "npm_config_auto_install_peers" to "false",
      "npm_config_node_linker" to "hoisted",
    )

    // The Termux Git/OpenSSH binaries are relocatable only when their prefix-
    // relative resources are supplied explicitly. This also prevents git/pnpm
    // from hanging on an invisible credential or host-key prompt in WebView.
    if (gitBin.isFile && gitExecDir.isDirectory) {
      env["GIT_EXEC_PATH"] = gitExecDir.absolutePath
      env["GIT_TEMPLATE_DIR"] = File(usrDir, "share/git-core/templates").absolutePath
      env["GIT_CONFIG_SYSTEM"] = gitConfigFile.absolutePath
      env["GIT_TERMINAL_PROMPT"] = "0"
      env["GIT_PAGER"] = "cat"
      env["PAGER"] = "cat"
      env["npm_config_git"] = gitBin.absolutePath
    }
    if (caBundleFile.isFile) {
      env["GIT_SSL_CAINFO"] = caBundleFile.absolutePath
      env["SSL_CERT_FILE"] = caBundleFile.absolutePath
      env["CURL_CA_BUNDLE"] = caBundleFile.absolutePath
      env["NODE_EXTRA_CA_CERTS"] = caBundleFile.absolutePath
      env["REQUESTS_CA_BUNDLE"] = caBundleFile.absolutePath
    }
    if (sshBin.isFile) {
      env["GIT_SSH_VARIANT"] = "ssh"
      env["GIT_SSH_COMMAND"] = sshCommand(batchMode = true)
    }
    env.putAll(mcpConfigManager.secretEnvironment())
    return env
  }

  /** Package-manager env extends the proven engine env with deterministic non-interactive state. */
  private fun pluginEnv(preload: File = preloadBin): Map<String, String> {
    val cache = File(homeDir, ".cache").apply { mkdirs() }
    val pnpmHome = File(homeDir, ".local/share/pnpm").apply { mkdirs() }
    val bash = File(usrDir, "bin/bash")
    val shell = if (bash.isFile) bash.absolutePath else "/system/bin/sh"
    val env = (engineEnv(preload) + mapOf(
      "PNPM_HOME" to pnpmHome.absolutePath,
      "XDG_CACHE_HOME" to cache.absolutePath,
      "npm_config_cache" to File(cache, "npm").apply { mkdirs() }.absolutePath,
      "npm_config_update_notifier" to "false",
      "npm_config_fund" to "false",
      "npm_config_audit" to "false",
      // Many community plugins run prepare/install scripts through npm/pnpm.
      // Pin the script shell to the embedded runtime rather than Android's
      // caller environment so Bash-based package scripts are relocatable.
      "SHELL" to shell,
      "npm_config_script_shell" to shell,
      "CI" to "true",
      "NO_COLOR" to "1",
    )).toMutableMap()

    // Private HTTPS Git credentials are exposed only to plugin-manager child
    // processes. The helper rejects prompts for any host other than the one
    // explicitly configured by the user, preventing credential forwarding.
    SecureCredentialStore.gitCredential(context)?.let { credential ->
      val helper = ensureHelperScript("git-askpass.sh", """
        prompt="${'$'}1"
        # Git formats HTTPS prompts as e.g.
        #   Username for 'https://github.com':
        #   Password for 'https://user@github.com':
        # Extract the quoted URL and compare its parsed host exactly. A plain
        # substring match would incorrectly forward github.com credentials to
        # a host such as github.com.evil.example.
        case "${'$'}prompt" in
          *"'https://"*"'"*) ;;
          *) exit 1 ;;
        esac
        url="${'$'}{prompt#*\'}"
        url="${'$'}{url%%\'*}"
        authority="${'$'}{url#https://}"
        authority="${'$'}{authority%%/*}"
        authority="${'$'}{authority##*@}"
        case "${'$'}authority" in
          \[*\]*) host="${'$'}{authority#\[}"; host="${'$'}{host%%\]*}" ;;
          *:*) host="${'$'}{authority%%:*}" ;;
          *) host="${'$'}authority" ;;
        esac
        [ "${'$'}host" = "${'$'}DSH_GIT_AUTH_HOST" ] || exit 1
        case "${'$'}prompt" in
          *Username*|*username*) printf '%s\n' "${'$'}DSH_GIT_AUTH_USERNAME" ;;
          *Password*|*password*) printf '%s\n' "${'$'}DSH_GIT_AUTH_TOKEN" ;;
          *) exit 1 ;;
        esac
      """)
      env["GIT_ASKPASS"] = helper.absolutePath
      env["DSH_GIT_AUTH_HOST"] = credential.host
      env["DSH_GIT_AUTH_USERNAME"] = credential.username
      env["DSH_GIT_AUTH_TOKEN"] = credential.token
    }

    SecureCredentialStore.sshPassphrase(context)?.takeIf { it.isNotEmpty() }?.let { passphrase ->
      val helper = ensureHelperScript("ssh-askpass.sh", """
        printf '%s\n' "${'$'}DSH_SSH_PASSPHRASE"
      """)
      env["SSH_ASKPASS"] = helper.absolutePath
      env["SSH_ASKPASS_REQUIRE"] = "force"
      env["DISPLAY"] = "dsh-mobile:0"
      env["DSH_SSH_PASSPHRASE"] = passphrase
      if (sshBin.isFile) env["GIT_SSH_COMMAND"] = sshCommand(batchMode = false)
    }
    return env
  }

  /** Classify pnpm failures using the same stable diagnostics as newer DSH plugin-manager builds. */
  private fun classifyPluginFailure(text: String, timedOut: Boolean = false): String? {
    if (timedOut) return "timeout"
    val rules = listOf(
      "build-blocked" to Regex("""ERR_PNPM_IGNORED_BUILDS|Ignored build scripts|ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|not in the ["']allowBuilds["'] allowlist""", RegexOption.IGNORE_CASE),
      "not-found" to Regex("""ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - GET""", RegexOption.IGNORE_CASE),
      "no-matching-version" to Regex("""ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version""", RegexOption.IGNORE_CASE),
      "disk-full" to Regex("""\bENOSPC\b|no space left on device""", RegexOption.IGNORE_CASE),
      "permission" to Regex("""\bEACCES\b|\bEPERM\b|permission denied""", RegexOption.IGNORE_CASE),
      "integrity" to Regex("""ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE|\bEINTEGRITY\b""", RegexOption.IGNORE_CASE),
      "network" to Regex("""\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_TIMEOUT|socket hang up|Could not resolve host|unable to access""", RegexOption.IGNORE_CASE),
      "workspace-protocol" to Regex("""ERR_PNPM_WORKSPACE_PKG_NOT_FOUND|workspace:|No matching version found in workspace""", RegexOption.IGNORE_CASE),
      "unsupported-platform" to Regex("""ERR_PNPM_UNSUPPORTED_PLATFORM|Unsupported platform|notsup""", RegexOption.IGNORE_CASE),
      "engine" to Regex("""Unsupported engine|ERR_PNPM_BAD_ENGINE|EBADENGINE""", RegexOption.IGNORE_CASE),
      "native-build" to Regex("""node-gyp|gyp ERR|prebuild-install|node-pre-gyp|\.node(?:'|"|\s)|CMake Error""", RegexOption.IGNORE_CASE),
    )
    return rules.firstOrNull { it.second.containsMatchIn(text) }?.first
  }

  private fun buildApprovalKeysFromOutput(output: String): List<String> {
    val lines = output.lines()
    val found = mutableListOf<String>()
    for (i in lines.indices) {
      if (lines[i].trim() != "allowBuilds:") continue
      for (j in (i + 1) until minOf(lines.size, i + 8)) {
        val line = lines[j]
        if (line.isBlank()) continue
        if (!line.first().isWhitespace()) break
        val trimmed = line.trim()
        val separator = trimmed.lastIndexOf(": ")
        if (separator <= 0) continue
        val key = trimmed.substring(0, separator).trim().trim('"', '\'')
        val value = trimmed.substring(separator + 2).trim().substringBefore(" #").trim()
        if ((value == "true" || value == "set this to true or false") && safeBuildApprovalKey(key)) {
          found += key
        }
      }
    }
    return found.distinct()
  }

  private fun pluginWorkspaceFile(profile: String = "web"): File = File(profileDir(profile), "pnpm-workspace.yaml")

  /**
   * Older preserved profiles may predate the current pnpm workspace policy.
   * Without autoInstallPeers=false, pnpm tries to download DSH prerelease peers
   * declared by community plugins and can fail with NO_MATCHING_VERSION even
   * though the plugin should consume the runtime's shared DSH modules.
   */
  private fun findRuntimePackageDir(packageName: String): File? {
    val root = File(usrDir, "lib/node_modules")
    if (!root.isDirectory) return null
    return root.walkTopDown()
      .maxDepth(8)
      .filter { it.isFile && it.name == "package.json" }
      .mapNotNull { manifest ->
        try {
          val json = JSONObject(manifest.readText())
          if (json.optString("name") == packageName) manifest.parentFile else null
        } catch (_: Throwable) {
          null
        }
      }
      .firstOrNull()
  }

  private fun setWorkspaceMappingValue(
    text: String,
    section: String,
    key: String,
    value: String,
    quoteValue: Boolean = true,
  ): String {
    val lines = text.replace("\r\n", "\n").split("\n").toMutableList()
    // Do not use a dynamically-built regex for the "{}" YAML form here.
    // This runs during engine startup; one malformed regex would prevent DSH
    // from booting at all. Section names are internal constants, so a simple
    // comment-stripped scalar comparison is both safer and clearer.
    val emptyMapIndex = lines.indexOfFirst { line ->
      line.substringBefore('#').trim() == "$section: {}"
    }
    if (emptyMapIndex >= 0) {
      val indent = lines[emptyMapIndex].takeWhile { it.isWhitespace() }
      lines[emptyMapIndex] = indent + section + ":"
    }
    var sectionIndex = lines.indexOfFirst { Regex("""^\s*${Regex.escape(section)}\s*:\s*(?:#.*)?$""").matches(it) }
    if (sectionIndex < 0) {
      if (lines.isNotEmpty() && lines.last().isNotBlank()) lines.add("")
      sectionIndex = lines.size
      lines.add("$section:")
    }
    val baseIndent = lines[sectionIndex].takeWhile { it.isWhitespace() }.length
    var end = sectionIndex + 1
    while (end < lines.size) {
      val line = lines[end]
      if (line.isBlank() || line.trimStart().startsWith("#")) { end++; continue }
      val indent = line.takeWhile { it.isWhitespace() }.length
      if (indent <= baseIndent) break
      end++
    }

    val encodedKey = JSONObject.quote(key)
    val encodedValue = if (quoteValue) JSONObject.quote(value) else value
    for (i in sectionIndex + 1 until end) {
      val parsed = parseAllowBuildLine(lines[i]) ?: continue
      if (parsed.first == key) {
        val prefix = lines[i].takeWhile { it.isWhitespace() }
        lines[i] = prefix + encodedKey + ": " + encodedValue
        return lines.joinToString("\n").trimEnd() + "\n"
      }
    }
    lines.add(end, " ".repeat(baseIndent + 2) + encodedKey + ": " + encodedValue)
    return lines.joinToString("\n").trimEnd() + "\n"
  }

  private fun ensurePluginWorkspaceCompat(profile: String = "web") {
    val file = pluginWorkspaceFile(profile)
    file.parentFile?.mkdirs()
    var workspace = if (file.isFile) file.readText() else "packages:\n  - .\n"

    fun setScalar(key: String, value: String) {
      val regex = Regex("""(?m)^\s*${Regex.escape(key)}\s*:\s*.*$""")
      workspace = if (regex.containsMatchIn(workspace)) {
        regex.replace(workspace, "$key: $value")
      } else {
        buildString {
          append(workspace)
          if (workspace.isNotEmpty() && !workspace.endsWith("\n")) append('\n')
          append(key).append(": ").append(value).append('\n')
        }
      }
    }

    setScalar("nodeLinker", "hoisted")
    setScalar("autoInstallPeers", "false")

    // Android cannot compile arbitrary native addons during plugin install.
    // Reuse native packages that were already built and smoke-tested together
    // with the embedded Node runtime. This avoids node-gyp on-device while
    // keeping the plugin's normal JS package resolution intact.
    findRuntimePackageDir("node-pty")?.let { runtimeNodePty ->
      workspace = setWorkspaceMappingValue(
        workspace,
        "overrides",
        "node-pty",
        "link:" + runtimeNodePty.absolutePath,
      )
      workspace = setWorkspaceMappingValue(
        workspace,
        "allowBuilds",
        "node-pty",
        "false",
        quoteValue = false,
      )
    }

    writeTextAtomic(file, workspace)
  }

  /**
   * Parse one scalar allowBuilds mapping line. Git-hosted pnpm keys contain
   * https://, so splitting at the first ':' truncates the identity and makes
   * the approval UI disappear. The mapping delimiter is the final ': '.
   */
  private fun parseAllowBuildLine(line: String): Pair<String, String>? {
    val trimmed = line.trim()
    val separator = trimmed.lastIndexOf(": ")
    if (separator <= 0) return null
    val key = trimmed.substring(0, separator).trim().trim('\"', '\'')
    val value = trimmed.substring(separator + 2)
      .trim()
      .substringBefore(" #")
      .trim()
      .trim('\"', '\'')
    if (!safeBuildApprovalKey(key)) return null
    return key to value
  }

  private fun safeBuildApprovalKey(value: String): Boolean {
    if (value.isBlank() || value.length > 4096) return false
    return value.none { ch -> ch == '\n' || ch == '\r' || ch == '\u0000' || (ch.code < 0x20 && ch != '\t') }
  }

  /** Read exact pnpm allowBuilds keys, including git-hosted URL identities. */
  fun pendingPluginBuilds(profile: String = "web"): List<String> {
    val file = pluginWorkspaceFile(profile)
    if (!file.isFile) return emptyList()
    return try {
      val lines = file.readLines()
      val result = mutableListOf<String>()
      var inAllow = false
      var baseIndent = -1
      val pendingValue = "set this to true or false"
      for (line in lines) {
        if (!inAllow) {
          val m = Regex("""^(\s*)allowBuilds\s*:\s*(?:#.*)?$""").find(line) ?: continue
          inAllow = true
          baseIndent = m.groupValues[1].length
          continue
        }
        if (line.isBlank() || line.trimStart().startsWith("#")) continue
        val indent = line.indexOfFirst { !it.isWhitespace() }.let { if (it < 0) line.length else it }
        if (indent <= baseIndent) break
        val parsed = parseAllowBuildLine(line) ?: continue
        if (parsed.second == pendingValue) result.add(parsed.first)
      }
      result.distinct()
    } catch (t: Throwable) {
      Log.w(TAG, "read pnpm allowBuilds failed", t)
      emptyList()
    }
  }

  /** Persist explicit build-script approvals without running any script yet. */
  fun approvePluginBuilds(names: List<String>, profile: String = "web"): PluginCommandResult {
    // names originate from pnpm's exact allowBuilds diagnostic and are shown
    // to the user before this explicit approval action. Git keys may not have
    // been persisted to pnpm-workspace.yaml at all, so requiring a preexisting
    // placeholder would make the approval button a no-op.
    val wanted = names.map { it.trim() }
      .filter { safeBuildApprovalKey(it) }
      .distinct()
    if (wanted.isEmpty()) return PluginCommandResult(false, -1, "没有可授权的构建脚本")
    val file = pluginWorkspaceFile(profile)
    return try {
      file.parentFile?.mkdirs()
      var text = if (file.isFile) file.readText() else "{}\n"
      if (Regex("""(?m)^\s*allowBuilds\s*:\s*\{\s*}\s*$""").containsMatchIn(text)) {
        text = text.replace(Regex("""(?m)^\s*allowBuilds\s*:\s*\{\s*}\s*$"""), "allowBuilds:")
      }
      val lines = text.lines().toMutableList()
      var allowIndex = lines.indexOfFirst { Regex("""^\s*allowBuilds\s*:\s*(?:#.*)?$""").matches(it) }
      val anyAllow = lines.indexOfFirst { Regex("""^\s*allowBuilds\s*:.*$""").matches(it) }
      if (allowIndex < 0 && anyAllow >= 0) {
        return PluginCommandResult(false, -1, "pnpm-workspace.yaml 的 allowBuilds 不是普通映射；为避免破坏用户配置，未自动改写")
      }
      if (allowIndex < 0) {
        if (lines.size == 1 && lines[0].trim() == "{}") lines.clear()
        if (lines.isNotEmpty() && lines.last().isNotBlank()) lines.add("")
        allowIndex = lines.size
        lines.add("allowBuilds:")
      }
      val baseIndent = lines[allowIndex].takeWhile { it.isWhitespace() }.length
      var end = allowIndex + 1
      while (end < lines.size) {
        val line = lines[end]
        if (line.isBlank() || line.trimStart().startsWith("#")) { end++; continue }
        val indent = line.takeWhile { it.isWhitespace() }.length
        if (indent <= baseIndent) break
        end++
      }
      val approved = mutableListOf<String>()
      for (name in wanted) {
        var found = false
        for (i in allowIndex + 1 until end) {
          val parsed = parseAllowBuildLine(lines[i]) ?: continue
          if (parsed.first == name) {
            val prefix = lines[i].takeWhile { it.isWhitespace() }
            lines[i] = prefix + JSONObject.quote(name) + ": true"
            found = true
            approved.add(name)
            break
          }
        }
        if (!found) {
          lines.add(end, " ".repeat(baseIndent + 2) + JSONObject.quote(name) + ": true")
          end++
          approved.add(name)
        }
      }
      writeTextAtomic(file, lines.joinToString("\n").trimEnd() + "\n")
      PluginCommandResult(true, 0, "已授权安装时构建：" + approved.joinToString(", "))
    } catch (t: Throwable) {
      PluginCommandResult(false, -3, "无法写入 pnpm 构建授权：" + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** Run one `dsh plugin --profile <name> ...` operation inside the embedded runtime. */
  private fun runPluginCommand(
    profile: String,
    tail: List<String>,
    timeoutMinutes: Long = 15,
  ): PluginCommandResult {
    if (!nodeBin.isFile || !dshBin.isFile) {
      return PluginCommandResult(false, -1, "DSH 运行时尚未安装")
    }
    if (!preloadBin.isFile) {
      return PluginCommandResult(false, -1, "缺少 termux-exec 运行库")
    }
    return try {
      ensurePluginWorkspaceCompat(profile)
      pluginLogFile.parentFile?.mkdirs()
      pluginLogFile.writeText("")
      val args = mutableListOf(
        nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath,
        "plugin", "--profile", profile,
      ).apply { addAll(tail) }.toTypedArray()
      val process = startWithArgsToFile(args, pluginEnv(preloadBin), pluginLogFile)
      val finished = process.waitFor(timeoutMinutes, TimeUnit.MINUTES)
      if (!finished) {
        process.destroyForcibly()
        val output = readPluginLog() + "\n操作超时（${timeoutMinutes} 分钟）"
        PluginCommandResult(false, -2, output, failureKind = "timeout")
      } else {
        val code = process.exitValue()
        val output = readPluginLog()
        val kind = if (code == 0) null else classifyPluginFailure(output)
        val pending = if (kind == "build-blocked") {
          (pendingPluginBuilds(profile) + buildApprovalKeysFromOutput(output)).distinct()
        } else emptyList()
        PluginCommandResult(code == 0, code, output, failureKind = kind, pendingBuilds = pending)
      }
    } catch (t: Throwable) {
      Log.e(TAG, "plugin command failed", t)
      val output = (readPluginLog() + "\n" + (t.message ?: t.javaClass.simpleName)).trim()
      PluginCommandResult(false, -3, output, failureKind = classifyPluginFailure(output))
    }
  }

  /** Retry only transient network failures; package/build/config failures are never hidden. */
  private fun runPluginCommandWithRetry(
    profile: String,
    tail: List<String>,
    timeoutMinutes: Long = 15,
  ): PluginCommandResult {
    var result = runPluginCommand(profile, tail, timeoutMinutes)
    if (result.ok || result.failureKind != "network") return result
    val history = StringBuilder(result.output.trim())
    for ((attempt, delayMs) in listOf(2000L, 5000L).withIndex()) {
      try { Thread.sleep(delayMs) } catch (_: InterruptedException) { break }
      val retry = runPluginCommand(profile, tail, timeoutMinutes)
      history.append("\n\n[Android compatibility] 网络失败，自动重试 ${attempt + 1}/2。\n")
      history.append(retry.output.trim())
      result = retry.copy(output = history.toString())
      if (result.ok || result.failureKind != "network") break
    }
    return result
  }

  private data class ProfilePackageSnapshot(val files: Map<String, String?>)

  /**
   * Snapshot only the pnpm-owned profile manifests. pnpm-workspace.yaml is
   * intentionally excluded because pnpm 11 writes pending allowBuilds there;
   * keeping that file is what lets the UI offer an explicit trust decision.
   */
  private fun snapshotProfilePackageFiles(profile: String): ProfilePackageSnapshot {
    val dir = profileDir(profile)
    val names = listOf("package.json", "pnpm-lock.yaml")
    return ProfilePackageSnapshot(names.associateWith { name ->
      val file = File(dir, name)
      if (file.isFile) file.readText() else null
    })
  }

  /** Restore the package/lock manifests after a failed or build-blocked add. */
  private fun restoreProfilePackageFiles(profile: String, snapshot: ProfilePackageSnapshot) {
    val dir = profileDir(profile)
    for ((name, previous) in snapshot.files) {
      val file = File(dir, name)
      try {
        if (previous == null) file.delete() else writeTextAtomic(file, previous)
      } catch (t: Throwable) {
        Log.w(TAG, "restore profile package file failed: ${file.absolutePath}", t)
      }
    }
  }

  /**
   * Install a DSH bundle into the embedded `web` profile. Compatibility extras:
   * transient-network retries, GitHub URL normalization, pnpm-11 build approval
   * discovery, and a post-install DSH config validation that disables only the
   * newly-added incompatible bundle instead of leaving the Host unbootable.
   */
  fun installPlugin(spec: String, profile: String = "web"): PluginCommandResult {
    val rawSpec = spec.trim()
    if (!safePluginToken(rawSpec)) return PluginCommandResult(false, -1, "插件地址无效")
    if (Regex("""^\.{1,2}(?:[/\\]|$)""").containsMatchIn(rawSpec)) {
      return PluginCommandResult(false, -1, "本地插件请使用绝对路径；相对路径会错误解析到 profile 目录")
    }
    val cleanSpec = normalizePluginSpec(rawSpec)
    val packageSnapshot = snapshotProfilePackageFiles(profile)
    val before = listPluginBundles(profile).associateBy { it.name }
    val first = runPluginCommandWithRetry(profile, listOf("add", cleanSpec))
    // Older pnpm versions reject adds at a workspace root; retry only for
    // that exact diagnostic so all other failures stay visible.
    var result = if (!first.ok && first.output.contains("ERR_PNPM_ADDING_TO_ROOT")) {
      val second = runPluginCommandWithRetry(profile, listOf("add", "-w", cleanSpec))
      if (second.output.isBlank()) second else second.copy(
        output = "首次安装触发 pnpm workspace-root 保护，已自动使用 -w 重试。\n\n" + second.output,
      )
    } else first
    if (!result.ok) {
      if (result.failureKind == "build-blocked" && result.pendingBuilds.isEmpty()) {
        result = result.copy(pendingBuilds = pendingPluginBuilds(profile))
      }
      restoreProfilePackageFiles(profile, packageSnapshot)
      val rollbackNote = "[Android compatibility] 安装未完成，已回滚 profile 的 package.json / pnpm-lock.yaml；下载缓存可保留供重试复用。"
      result = result.copy(output = listOf(result.output.trim(), rollbackNote).filter { it.isNotBlank() }.joinToString("\n\n"))
      return appendSpecNormalization(rawSpec, cleanSpec, result)
    }
    // pnpm 11 can materialize a dependency and still leave lifecycle scripts
    // undecided in allowBuilds. Treat that state as an explicit approval step
    // before DSH tries to load a half-built TypeScript/git plugin.
    val pendingAfterAdd = pendingPluginBuilds(profile)
    if (pendingAfterAdd.isNotEmpty()) {
      restoreProfilePackageFiles(profile, packageSnapshot)
      return appendSpecNormalization(rawSpec, cleanSpec, result.copy(
        ok = false,
        exitCode = 1,
        failureKind = "build-blocked",
        pendingBuilds = pendingAfterAdd,
        output = result.output.trim() + "\n\npnpm 已下载依赖，但仍有安装期脚本等待显式授权；profile manifest 已回滚，授权后会从干净状态重试。",
      ))
    }

    val after = listPluginBundles(profile)
    val added = after.filter { !before.containsKey(it.name) }
    val compatNotes = applyAndroidCodexModelPickerCompat(profile)
    val validation = validateProfileConfig(profile)
    if (!validation.ok) {
      val disabled = mutableListOf<String>()
      for (info in added) {
        if (info.enabled) {
          val off = setBundleEnabledRaw(info.name, false, profile)
          if (off.ok) disabled.add(info.name)
        }
      }
      val body = buildString {
        append(result.output.trim())
        if (isNotEmpty()) append("\n\n")
        append("插件安装完成，但 DSH 配置校验失败。")
        if (disabled.isNotEmpty()) append(" 为保证应用可再次启动，已自动停用：").append(disabled.joinToString(", "))
        append("\n\n--- DSH config validation ---\n").append(validation.output.trim())
      }
      return appendSpecNormalization(rawSpec, cleanSpec, PluginCommandResult(
        false, validation.exitCode, body, failureKind = "profile-invalid",
      ))
    }

    if (compatNotes.isNotEmpty()) {
      result = result.copy(output = buildString {
        append(result.output.trim())
        append("\n\n[Android compatibility]\n")
        compatNotes.forEach { append("• ").append(it).append('\n') }
      }.trim())
    }
    val warnings = added.flatMap { pluginMetadataWarnings(it.name, profile) }
    if (warnings.isNotEmpty()) {
      result = result.copy(output = buildString {
        append(result.output.trim())
        append("\n\n[兼容性检查]\n")
        warnings.forEach { append("• ").append(it).append('\n') }
      }.trim())
    }
    return appendSpecNormalization(rawSpec, cleanSpec, result)
  }

  private fun appendSpecNormalization(raw: String, clean: String, result: PluginCommandResult): PluginCommandResult {
    return if (clean != raw && result.output.isNotBlank()) result.copy(
      output = "已将输入转换为 pnpm/DSH 可安装格式：$clean\n\n" + result.output,
    ) else result
  }

  /** Convert common browser/share URLs into pnpm specs without changing npm package specs. */
  private fun normalizePluginSpec(value: String): String {
    val shorthand = Regex("""^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:#[^\s]+)?$""")
    if (!value.startsWith("@") && shorthand.matches(value)) return "github:$value"
    return try {
      val uri = java.net.URI(value)
      if (!uri.scheme.equals("https", ignoreCase = true) || !uri.host.equals("github.com", ignoreCase = true)) return value
      val parts = uri.path.orEmpty().trim('/').split('/').filter { it.isNotBlank() }
      // GitHub archive ZIP URLs are not npm tarballs. GitHub exposes the same
      // ref as tar.gz, which pnpm can install directly without a second parser.
      if (parts.size >= 5 && parts[2] == "archive" && value.substringBefore('?').endsWith(".zip", ignoreCase = true)) {
        return value.substringBefore('?').removeSuffix(".zip") + ".tar.gz" +
          (uri.rawQuery?.let { "?$it" } ?: "")
      }
      if (parts.size == 2) {
        val repo = parts[1].removeSuffix(".git")
        val ref = uri.rawFragment?.takeIf { it.isNotBlank() }?.let { "#$it" }.orEmpty()
        "git+https://github.com/${parts[0]}/$repo.git$ref"
      } else if (parts.size >= 4 && parts[2] == "tree") {
        val repo = parts[1].removeSuffix(".git")
        val ref = parts.drop(3).joinToString("/")
        "git+https://github.com/${parts[0]}/$repo.git#$ref"
      } else value
    } catch (_: Throwable) {
      value
    }
  }

  /** Installed package metadata is inspected without loading third-party JavaScript. */
  private fun pluginMetadataWarnings(name: String, profile: String = "web"): List<String> {
    val manifest = File(profileDir(profile), "node_modules/$name/package.json")
    if (!manifest.isFile) return emptyList()
    return try {
      val root = JSONObject(manifest.readText())
      val warnings = mutableListOf<String>()
      val target = root.optString("dshTarget", "").trim()
      if (target.isNotBlank()) warnings += "$name 声明 dshTarget=$target；当前 DSH=${dshVersion()}"
      val dsh = root.optJSONObject("dsh")
      if (dsh?.optJSONObject("bundle")?.optString("patch", "").isNullOrBlank()) {
        warnings += "$name 没有声明 dsh.bundle.patch，将作为普通依赖安装而不会自动成为 profile 层"
      }
      val platform = dsh?.optJSONObject("client")?.optString("platform", "")?.trim().orEmpty()
      if (platform.isNotBlank() && platform != "web") warnings += "$name 的 client platform=$platform；Android 版使用 web profile"
      val scripts = root.optJSONObject("scripts")
      val lifecycle = listOf("preinstall", "install", "postinstall", "prepare")
        .filter { scripts?.optString(it, "")?.isNotBlank() == true }
      if (lifecycle.isNotEmpty()) warnings += "$name 包含安装期脚本：${lifecycle.joinToString(", ")}；pnpm 11 可能要求显式构建授权"
      warnings
    } catch (_: Throwable) { emptyList() }
  }

  fun updatePlugin(name: String, profile: String = "web"): PluginCommandResult {
    val clean = name.trim()
    if (!safePluginToken(clean)) return PluginCommandResult(false, -1, "插件名称无效")
    val wasEnabled = listPluginBundles(profile).firstOrNull { it.name == clean }?.enabled == true
    var result = runPluginCommandWithRetry(profile, listOf("update", clean), timeoutMinutes = 20)
    if (!result.ok) return result
    val compatNotes = applyAndroidCodexModelPickerCompat(profile)
    if (compatNotes.isNotEmpty()) {
      result = result.copy(output = buildString {
        append(result.output.trim())
        append("\n\n[Android compatibility]\n")
        compatNotes.forEach { append("• ").append(it).append('\n') }
      }.trim())
    }
    val validation = validateProfileConfig(profile)
    if (validation.ok) return result
    if (wasEnabled) setBundleEnabledRaw(clean, false, profile)
    return PluginCommandResult(false, validation.exitCode, buildString {
      append(result.output.trim())
      append("\n\n更新后的插件未通过 DSH 配置校验")
      if (wasEnabled) append("，已自动停用该 bundle 以保持 Host 可启动")
      append("。\n\n").append(validation.output.trim())
    }, failureKind = "profile-invalid")
  }

  /** Update every mutable dependency in the selected profile. */
  fun updateAllPlugins(profile: String = "web"): PluginCommandResult {
    var result = runPluginCommandWithRetry(profile, listOf("update"), timeoutMinutes = 25)
    if (!result.ok) return result
    val compatNotes = applyAndroidCodexModelPickerCompat(profile)
    if (compatNotes.isNotEmpty()) {
      result = result.copy(output = buildString {
        append(result.output.trim())
        append("\n\n[Android compatibility]\n")
        compatNotes.forEach { append("• ").append(it).append('\n') }
      }.trim())
    }
    val validation = validateProfileConfig(profile)
    if (validation.ok) return result
    val recovery = disableThirdPartyBundles(profile)
    return PluginCommandResult(false, validation.exitCode, buildString {
      append(result.output.trim())
      append("\n\n全部更新后 DSH 配置校验失败。为保证 Host 能重新启动，已进入第三方 bundle 安全模式。\n")
      append(recovery.output).append("\n\n").append(validation.output.trim())
    }, failureKind = "profile-invalid")
  }

  fun removePlugin(name: String, profile: String = "web"): PluginCommandResult {
    val clean = name.trim()
    if (!safePluginToken(clean)) return PluginCommandResult(false, -1, "插件名称无效")
    return runPluginCommand(profile, listOf("remove", clean))
  }

  private fun safePluginToken(value: String): Boolean {
    return value.isNotEmpty() && value.length <= 2048 && !value.contains('\n') && !value.contains('\r') && !value.contains('\u0000')
  }

  private fun safePackageName(value: String): Boolean {
    if (value.isEmpty() || value.length > 214) return false
    return Regex("""^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$""").matches(value)
  }

  /**
   * Android keeps DSH's native conversation.input.model slot authoritative.
   *
   * dsh-codex-subscription registers its own CodexModelSelect on the same slot
   * with priority -10. That client-only override is useful on desktop, but on
   * Android WebView it can make the composer model control non-interactive.
   * Keep the plugin backend/provider/model directory/quota/search/image features
   * intact and remove only that one client slot registration from the installed
   * profile copy before the Host boots.
   *
   * This is intentionally package-specific and idempotent. Unknown plugins are
   * never rewritten. If a future plugin release changes its bundle shape, we
   * log and leave the file untouched rather than guessing.
   */
  private fun applyAndroidCodexModelPickerCompat(profile: String = "web"): List<String> {
    val packageNames = listOf(
      "dsh-codex-subscription-en",
      "dsh-codex-subscription",
      "@mamdouh-aboammar/dsh-codex-subscription",
    )
    val marker = "DSH Android compat: native model picker owns conversation.input.model"
    val notes = mutableListOf<String>()

    for (packageName in packageNames) {
      val root = File(profileDir(profile), "node_modules/$packageName")
      val manifest = File(root, "package.json")
      val client = File(root, "lib/client.js")
      if (!manifest.isFile || !client.isFile) continue

      val text = try { client.readText() } catch (t: Throwable) {
        Log.w(TAG, "read Codex client bundle failed: ${client.absolutePath}", t)
        notes += "$packageName: client bundle unreadable"
        continue
      }
      if (text.contains(marker)) {
        notes += "$packageName: Android native model picker compat already applied"
        continue
      }

      val doubleAnchor = "scope.slots.inject(\"conversation.input.model\""
      val singleAnchor = "scope.slots.inject('conversation.input.model'"
      val starts = buildList {
        var from = 0
        while (true) {
          val a = text.indexOf(doubleAnchor, from)
          val b = text.indexOf(singleAnchor, from)
          val next = listOf(a, b).filter { it >= 0 }.minOrNull() ?: break
          add(next)
          from = next + 1
        }
      }
      if (starts.isEmpty()) {
        // Newer releases may already have removed the override themselves.
        notes += "$packageName: no conversation.input.model override found"
        continue
      }
      if (starts.size != 1) {
        Log.w(TAG, "Codex model slot anchor count changed for $packageName: ${starts.size}")
        notes += "$packageName: ambiguous model-slot override (${starts.size})"
        continue
      }

      val start = starts.single()
      val tailRegex = Regex("""\}\s*,\s*CodexModelSelect\s*\)\s*\)\s*;?""")
      val tail = tailRegex.find(text, start)
      if (tail == null) {
        Log.w(TAG, "Codex model slot tail changed for $packageName")
        notes += "$packageName: model-slot tail changed"
        continue
      }

      val replacement = "/* $marker */"
      val patched = text.substring(0, start) + replacement + text.substring(tail.range.last + 1)
      if (patched.contains("scope.slots.inject(\"conversation.input.model\"") ||
          patched.contains("scope.slots.inject('conversation.input.model'")) {
        Log.w(TAG, "Codex model slot override survived compat patch for $packageName")
        notes += "$packageName: model-slot override survived patch"
        continue
      }

      try {
        writeTextAtomic(client, patched)
        notes += "$packageName: kept Provider/model directory; restored native DSH model picker"
        Log.i(TAG, "Applied Android Codex model-picker compatibility: $packageName")
      } catch (t: Throwable) {
        Log.w(TAG, "write Codex client compat failed: ${client.absolutePath}", t)
        notes += "$packageName: client compat write failed"
      }
    }
    return notes
  }

  private fun profileDir(profile: String = "web"): File = File(homeDir, ".dsh/profiles/$profile")

  private fun profileManifest(profile: String = "web"): File = File(profileDir(profile), "package.json")

  private fun installedPackageManifest(name: String, profile: String = "web"): File =
    File(profileDir(profile), "node_modules/$name/package.json")

  private fun packageDeclaresBundle(name: String, profile: String = "web"): Boolean {
    val file = installedPackageManifest(name, profile)
    if (!file.isFile) return false
    return try {
      val root = JSONObject(file.readText())
      root.optJSONObject("dsh")?.optJSONObject("bundle")?.optString("patch", "")?.isNotBlank() == true
    } catch (_: Throwable) { false }
  }

  private fun installedPackageVersion(name: String, fallback: String, profile: String = "web"): String {
    val file = installedPackageManifest(name, profile)
    if (!file.isFile) return fallback
    return try { JSONObject(file.readText()).optString("version", fallback) } catch (_: Throwable) { fallback }
  }

  /** Read profile dependencies and distinguish real DSH bundles from plain libraries. */
  fun listPluginBundles(profile: String = "web"): List<PluginBundleInfo> {
    val manifest = profileManifest(profile)
    if (!manifest.isFile) return emptyList()
    return try {
      val root = JSONObject(manifest.readText())
      val deps = root.optJSONObject("dependencies") ?: JSONObject()
      val profileObject = root.optJSONObject("dsh")?.optJSONObject("profile")
      val activeArray = profileObject?.optJSONArray("bundles") ?: JSONArray()
      val active = buildSet {
        for (i in 0 until activeArray.length()) add(activeArray.optString(i))
      }
      deps.keys().asSequence().map { name ->
        val isBundle = packageDeclaresBundle(name, profile)
        val declared = deps.optString(name, "")
        PluginBundleInfo(
          name = name,
          version = installedPackageVersion(name, declared, profile),
          enabled = isBundle && active.contains(name),
          firstParty = name.startsWith("@deepseek-ai/"),
          bundle = isBundle,
        )
      }.sortedBy { it.name.lowercase() }.toList()
    } catch (t: Throwable) {
      Log.e(TAG, "read plugin profile failed", t)
      emptyList()
    }
  }

  /** Toggle one installed bundle layer without removing its dependency. */
  fun setBundleEnabled(name: String, enabled: Boolean, profile: String = "web"): PluginCommandResult {
    val clean = name.trim()
    if (!safePluginToken(clean)) return PluginCommandResult(false, -1, "插件名称无效")
    val manifest = profileManifest(profile)
    if (!manifest.isFile) return PluginCommandResult(false, -1, "web profile 尚未初始化")
    val before = try { manifest.readText() } catch (t: Throwable) {
      return PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
    val changed = setBundleEnabledRaw(clean, enabled, profile)
    if (!changed.ok || !enabled) return changed
    val validation = validateProfileConfig(profile)
    if (validation.ok) return changed
    try { writeTextAtomic(manifest, before) } catch (_: Throwable) {}
    return PluginCommandResult(false, validation.exitCode,
      "该插件启用后未通过 DSH 配置校验，已自动恢复为停用状态。\n\n" + validation.output,
      failureKind = "profile-invalid")
  }

  /** Internal bundle toggle used by compatibility recovery paths; does not recurse into validation. */
  private fun setBundleEnabledRaw(name: String, enabled: Boolean, profile: String = "web"): PluginCommandResult {
    val clean = name.trim()
    if (!safePluginToken(clean)) return PluginCommandResult(false, -1, "插件名称无效")
    val manifest = profileManifest(profile)
    if (!manifest.isFile) return PluginCommandResult(false, -1, "web profile 尚未初始化")
    return try {
      val root = JSONObject(manifest.readText())
      val deps = root.optJSONObject("dependencies") ?: JSONObject()
      if (!deps.has(clean)) return PluginCommandResult(false, -1, "插件未安装：$clean")
      if (enabled && !packageDeclaresBundle(clean, profile)) {
        return PluginCommandResult(false, -1, "$clean 是普通依赖，没有声明 dsh.bundle.patch，不能作为 profile 层启用")
      }
      val dsh = root.optJSONObject("dsh") ?: JSONObject().also { root.put("dsh", it) }
      val profileObject = dsh.optJSONObject("profile") ?: JSONObject().also { dsh.put("profile", it) }
      val old = profileObject.optJSONArray("bundles") ?: JSONArray()
      val values = mutableListOf<String>()
      for (i in 0 until old.length()) {
        val v = old.optString(i)
        if (v.isNotBlank() && v != clean && !values.contains(v)) values.add(v)
      }
      if (enabled) values.add(clean)
      val next = JSONArray()
      values.forEach { next.put(it) }
      profileObject.put("bundles", next)
      writeTextAtomic(manifest, root.toString(2) + "\n")
      PluginCommandResult(true, 0, if (enabled) "已启用 $clean" else "已停用 $clean")
    } catch (t: Throwable) {
      PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
  }

  /** Desktop-style recovery: keep first-party layers, disable every third-party bundle. */
  fun disableThirdPartyBundles(profile: String = "web"): PluginCommandResult {
    val manifest = profileManifest(profile)
    if (!manifest.isFile) return PluginCommandResult(true, 0, "profile 尚未初始化，无需恢复")
    return try {
      val root = JSONObject(manifest.readText())
      val dsh = root.optJSONObject("dsh") ?: return PluginCommandResult(true, 0, "没有 bundle 配置")
      val profileObject = dsh.optJSONObject("profile") ?: return PluginCommandResult(true, 0, "没有 bundle 配置")
      val old = profileObject.optJSONArray("bundles") ?: JSONArray()
      val next = JSONArray()
      val disabled = mutableListOf<String>()
      for (i in 0 until old.length()) {
        val name = old.optString(i)
        if (name.startsWith("@deepseek-ai/")) next.put(name) else if (name.isNotBlank()) disabled.add(name)
      }
      profileObject.put("bundles", next)
      writeTextAtomic(manifest, root.toString(2) + "\n")
      PluginCommandResult(true, 0, if (disabled.isEmpty()) "没有启用的第三方 bundle" else "已停用：" + disabled.joinToString(", "))
    } catch (t: Throwable) {
      PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
  }

  /**
   * Diagnose a Host boot failure without mutating the user's plugin stack.
   *
   * Android runtime compatibility now preserves valid custom sandbox/approval
   * compositions inside dsh-permission-presets itself, so recovery must never
   * disable, remove, or rewrite a plugin merely to make the Host boot.
   */
  /**
   * Multiple first-party plugin resolution failures mean the embedded /usr
   * graph is damaged/incomplete rather than a normal single-plugin error.
   */
  fun bootFailureNeedsRuntimeRepair(): Boolean {
    val diag = engineDiagnostics(24_000)
    val pluginTreeFailure =
      diag.contains("plugin tree failed to load", ignoreCase = true) ||
      diag.contains("plugin(s) failed to load", ignoreCase = true) ||
      diag.contains("Cordis startup failed because these plugin(s) could not be resolved", ignoreCase = true)
    if (!pluginTreeFailure) return false

    val firstPartyFailures = Regex("""@deepseek-ai/dsh-[a-z0-9-]+""", RegexOption.IGNORE_CASE)
      .findAll(diag)
      .map { it.value.lowercase() }
      .distinct()
      .take(3)
      .count()
    return firstPartyFailures >= 2
  }

  fun recoverFromBootFailure(profile: String = "web"): PluginCommandResult {
    val diag = engineDiagnostics(20_000)
    val permissionMismatch =
      diag.contains("composed sandbox and approval defaults match no preset", ignoreCase = true) ||
      diag.contains("configure defaultPreset explicitly", ignoreCase = true)

    return if (permissionMismatch) {
      PluginCommandResult(
        false, -1,
        "检测到旧运行时的 permission preset 兼容故障。当前版本不会停用任何插件；" +
          "请重新构建/覆盖安装以使用保留插件组合默认值的运行时兼容层。profile=$profile",
        failureKind = "profile-invalid",
      )
    } else {
      PluginCommandResult(
        false, -1,
        "DSH 插件树未能启动。为保留插件全部功能，Android 不会自动停用、删除或改写任何 bundle。\n\n" +
          diag.takeLast(16 * 1024),
        failureKind = "profile-invalid",
      )
    }
  }

  /** Public/profile-aware config path. The public copy is authoritative after migration. */
  fun profilePatchFile(profile: String = "web"): File {
    val publicFile = File(dshDataDir, "profiles/$profile/cordis.patch.yml")
    if (publicFile.exists()) return publicFile
    return File(profileDir(profile), "cordis.patch.yml")
  }

  fun readProfilePatch(profile: String = "web"): String {
    val file = profilePatchFile(profile)
    return if (file.isFile) file.readText() else "# DSH web profile overrides\n"
  }

  /** Save a config edit, validate it through DSH itself, and roll back on failure. */
  fun saveProfilePatch(text: String, profile: String = "web"): PluginCommandResult {
    if (text.length > 2 * 1024 * 1024) return PluginCommandResult(false, -1, "配置文件超过 2 MB")
    val file = profilePatchFile(profile)
    val existed = file.isFile
    val previous = try { if (existed) file.readText() else null } catch (t: Throwable) {
      return PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
    return try {
      file.parentFile?.mkdirs()
      if (previous != null) File(file.parentFile, file.name + ".bak-last").writeText(previous)
      writeTextAtomic(file, text)
      val validation = validateProfileConfig(profile)
      if (!validation.ok) {
        if (previous == null) file.delete() else writeTextAtomic(file, previous)
        return PluginCommandResult(false, validation.exitCode,
          "配置未通过 DSH 校验，已自动恢复上一版本。\n\n" + validation.output)
      }
      PluginCommandResult(true, 0, "配置已保存并通过 DSH 校验：${file.absolutePath}")
    } catch (t: Throwable) {
      try { if (previous == null) file.delete() else writeTextAtomic(file, previous) } catch (_: Throwable) {}
      PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
  }

  /** Parse the composed profile without starting the web server. */
  private fun validateProfileConfig(profile: String): PluginCommandResult {
    if (!nodeBin.isFile || !dshBin.isFile || !preloadBin.isFile) {
      return PluginCommandResult(false, -1, "DSH 运行时不完整，无法校验配置")
    }
    return try {
      profileCheckLogFile.writeText("")
      val mcpPatch = mcpConfigManager.ensureRuntimePatch()
      val args = arrayOf(
        nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath,
        "--profile", profile, "--patch", mcpPatch.absolutePath, "--dump-config",
      )
      val process = startWithArgsToFile(args, engineEnv(preloadBin), profileCheckLogFile)
      val finished = process.waitFor(45, TimeUnit.SECONDS)
      if (!finished) {
        process.destroyForcibly()
        PluginCommandResult(false, -2, "配置校验超时")
      } else {
        val code = process.exitValue()
        val output = try { profileCheckLogFile.readText().takeLast(64 * 1024) } catch (_: Throwable) { "" }
        PluginCommandResult(code == 0, code, output)
      }
    } catch (t: Throwable) {
      PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
  }

  /** Backup the current profile patch and replace it with an empty override. */
  fun backupAndResetProfilePatch(profile: String = "web"): PluginCommandResult {
    return try {
      val file = profilePatchFile(profile)
      file.parentFile?.mkdirs()
      if (!file.exists()) {
        writeTextAtomic(file, "# DSH web profile overrides\n")
        return PluginCommandResult(true, 0, "配置原本不存在，已创建空配置")
      }
      val backup = File(file.parentFile, file.name + ".bak-" + System.currentTimeMillis())
      file.copyTo(backup, overwrite = false)
      writeTextAtomic(file, "# DSH web profile overrides\n")
      PluginCommandResult(true, 0, "已备份到 ${backup.absolutePath}")
    } catch (t: Throwable) {
      PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
  }

  private fun writeTextAtomic(file: File, text: String) {
    file.parentFile?.mkdirs()
    val temp = File(file.parentFile, file.name + ".tmp-" + System.nanoTime())
    temp.writeText(text)
    if (file.exists() && !file.delete()) {
      temp.delete()
      throw java.io.IOException("无法替换 ${file.absolutePath}")
    }
    if (!temp.renameTo(file)) {
      temp.copyTo(file, overwrite = true)
      temp.delete()
    }
  }

  private fun readPluginLog(): String {
    return try {
      val text = pluginLogFile.readText()
      if (text.length <= 96 * 1024) text else text.takeLast(96 * 1024)
    } catch (_: Throwable) {
      ""
    }
  }

  /**
   * Spawn the engine, falling back to the system linker when the direct exec
   * is denied: Android 15+ apps targeting SDK 35+ may not exec app-data ELF
   * binaries, but loading them through /system/bin/linker64 is the same
   * mechanism as native libraries (always permitted for app data).
   */
  private fun startWithArgs(args: Array<String>, env: Map<String, String>): Process {
    fun build(argv: List<String>): ProcessBuilder =
      ProcessBuilder(argv).also { b ->
        b.environment().putAll(env)
        b.directory(homeDir)
        b.redirectErrorStream(true)
        b.redirectOutput(engineLogFile)
      }
    return try {
      build(args.toList()).start()
    } catch (e: java.io.IOException) {
      if (e.message?.contains("Permission denied") != true) throw e
      Log.w(TAG, "direct exec denied, falling back to linker64: " + e.message)
      build(listOf("/system/bin/linker64") + args.toList()).start()
    }
  }

  /**
   * Execute a minimal in-place runtime smoke test. This is intentionally
   * side-effect free: Node must launch, and the selected DSH CLI must parse its
   * own package graph and answer --version. Used before an OTA runtime commit.
   */
  fun smokeTestRuntime(timeoutSeconds: Long = 20): PluginCommandResult {
    val required = runtimeHealthFilesOnly()
    if (!required.ok) return PluginCommandResult(false, -1, required.describe())
    val log = File(context.filesDir, "runtime-smoke.log")
    return try {
      log.writeText("")
      val node = startWithArgsToFile(
        arrayOf(nodeBin.absolutePath, "--version"),
        engineEnv(preloadBin),
        log,
      )
      if (!node.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
        node.destroyForcibly()
        return PluginCommandResult(false, -2, "Node runtime smoke test timeout")
      }
      if (node.exitValue() != 0) {
        return PluginCommandResult(false, node.exitValue(), log.readText().takeLast(16 * 1024))
      }

      log.writeText("")
      val dsh = startWithArgsToFile(
        arrayOf(nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath, "--version"),
        engineEnv(preloadBin),
        log,
      )
      if (!dsh.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
        dsh.destroyForcibly()
        return PluginCommandResult(false, -2, "DSH runtime smoke test timeout")
      }
      val output = try { log.readText().takeLast(16 * 1024) } catch (_: Throwable) { "" }
      PluginCommandResult(dsh.exitValue() == 0, dsh.exitValue(), output)
    } catch (t: Throwable) {
      PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
  }

  /** Runtime-file check that deliberately ignores the installed runtime marker. */
  private fun runtimeHealthFilesOnly(): RuntimeHealth {
    val required = listOf(
      nodeBin to "usr/bin/node",
      dshBin to "@deepseek-ai/dsh/lib/bin.js",
      preloadBin to "usr/lib/libtermux-exec-ld-preload.so",
      File(usrDir, "bin/bash") to "usr/bin/bash",
      File(usrDir, "libexec/dsh-mobile/android-sandbox-runner.sh") to "usr/libexec/dsh-mobile/android-sandbox-runner.sh",
      File(usrDir, "libexec/dsh/wrappers/python3") to "usr/libexec/dsh/wrappers/python3",
      File(usrDir, "libexec/dsh/wrappers/pip3") to "usr/libexec/dsh/wrappers/pip3",
      File(usrDir, "libexec/dsh/wrappers/pkg") to "usr/libexec/dsh/wrappers/pkg",
      File(usrDir, "libexec/dsh/wrappers/apt") to "usr/libexec/dsh/wrappers/apt",
      File(usrDir, "libexec/dsh/wrappers/dpkg") to "usr/libexec/dsh/wrappers/dpkg",
      File(usrDir, "bin/proot") to "usr/bin/proot",
    )
    val missing = required.filterNot { it.first.isFile }.map { it.second }
    return RuntimeHealth(missing.isEmpty(), missing)
  }

  /** Start an embedded command and redirect its merged output to a file. */
  private fun startWithArgsToFile(args: Array<String>, env: Map<String, String>, log: File): Process {
    fun build(argv: List<String>): ProcessBuilder =
      ProcessBuilder(argv).also { b ->
        b.environment().putAll(env)
        b.directory(homeDir)
        b.redirectErrorStream(true)
        b.redirectOutput(log)
      }
    return try {
      build(args.toList()).start()
    } catch (e: java.io.IOException) {
      if (e.message?.contains("Permission denied") != true) throw e
      build(listOf("/system/bin/linker64") + args.toList()).start()
    }
  }

  /**
   * Stop the engine process (best-effort), including one started by another
   * EngineManager instance in this Android app process. MainActivity and
   * EngineService run in the same process, so a shared Process reference is
   * both safer and more portable than relying on java.lang.Process.pid(),
   * which is not part of Android API 36.
   */
  fun stopEngine(graceMillis: Long = 3_000, forceMillis: Long = 2_000): Boolean {
    val local = engineProcess
    engineProcess = null
    val shared = ACTIVE_PROCESS.getAndSet(null)
    val processes = linkedSetOf<Process>()
    if (local != null) processes += local
    if (shared != null) processes += shared
    var stopped = true
    for (process in processes) {
      try {
        if (!process.isAlive) continue
        process.destroy()
        if (!process.waitFor(graceMillis, TimeUnit.MILLISECONDS) && process.isAlive) {
          process.destroyForcibly()
          if (!process.waitFor(forceMillis, TimeUnit.MILLISECONDS) && process.isAlive) stopped = false
        }
      } catch (t: Throwable) {
        stopped = false
        Log.w(TAG, "failed to stop embedded DSH process", t)
      }
    }
    if (!stopped) LAST_START_ERROR = "DSH 进程未能在超时内完全退出"
    return stopped
  }

  companion object {
    private const val TAG = "dsh-engine"

    /** 进程级启动 CAS：跨 EngineManager 实例可见（双启动竞态防护）。 */
    val STARTING = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * The embedded dsh child shared by every EngineManager in this app
     * process. EngineService and MainActivity do not need an Android-visible
     * PID to coordinate lifecycle operations.
     */
    private val ACTIVE_PROCESS = java.util.concurrent.atomic.AtomicReference<Process?>(null)

    /** One managed localhost dev server for browser-preview workflows. */
    private val DEV_SERVER_PROCESS = java.util.concurrent.atomic.AtomicReference<Process?>(null)
    private val DEV_SERVER_PORT = java.util.concurrent.atomic.AtomicInteger(0)
    private val DEV_SERVER_ROOT = java.util.concurrent.atomic.AtomicReference("")

    /** Last preflight/launch error surfaced on the standalone recovery screen. */
    @Volatile
    private var LAST_START_ERROR: String = ""

    /**
     * Cross-instance maintenance guard. Plugin/profile mutation, runtime repair
     * and OTA replacement increment this counter before stopping the Host. The
     * EngineService watchdog must not race those transactions by relaunching it.
     */
    private val MAINTENANCE_DEPTH = java.util.concurrent.atomic.AtomicInteger(0)

    fun beginMaintenance() { MAINTENANCE_DEPTH.incrementAndGet() }

    fun endMaintenance() {
      while (true) {
        val current = MAINTENANCE_DEPTH.get()
        if (current <= 0) return
        if (MAINTENANCE_DEPTH.compareAndSet(current, current - 1)) return
      }
    }

    fun isMaintenanceMode(): Boolean = MAINTENANCE_DEPTH.get() > 0

  }
}