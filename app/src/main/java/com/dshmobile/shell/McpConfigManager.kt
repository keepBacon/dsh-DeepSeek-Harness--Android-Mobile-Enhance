package com.dshmobile.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.net.URI
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class McpServerConfig(
  val id: String,
  val serverName: String,
  val transport: String,
  val command: String = "",
  val args: List<String> = emptyList(),
  val cwd: String = "",
  val url: String = "",
  val bearerAuth: Boolean = false,
  val enabled: Boolean = true,
  val preset: String = "generic",
)

class McpConfigManager(
  private val context: Context,
  private val dataDir: File,
  private val usrDir: File,
  private val homeDir: File,
) {
  private val configFile = File(dataDir, "mobile/mcp-servers.json")
  private val tag = "McpConfigManager"
  private val patchFile = File(context.filesDir, "mcp/android-mcp.patch.yml")
  private val toolboxFile = File(usrDir, "libexec/dsh-mobile/toolbox-mcp.mjs")
  private val basicToolboxFile = File(usrDir, "libexec/dsh-mobile/basic-toolbox-mcp.mjs")

  fun toolboxEnabled(): Boolean = readRootSafe().optBoolean("toolboxEnabled", true)
  fun listServers(): List<McpServerConfig> = readServersForRuntime(readRootSafe())

  fun configurationIssue(): String? {
    if (!configFile.isFile) return null
    return try { readServers(JSONObject(configFile.readText())); null } catch (t: Throwable) { t.message ?: t.javaClass.simpleName }
  }

  @Synchronized fun setToolboxEnabled(enabled: Boolean) {
    val root = readRootStrictForMutation()
    root.put("toolboxEnabled", enabled)
    writeRoot(root)
  }

  @Synchronized fun upsert(server: McpServerConfig) {
    validate(server)
    val root = readRootStrictForMutation()
    val current = readServers(root).filterNot { it.id == server.id }.toMutableList()
    require(current.none { it.serverName == server.serverName }) { "MCP 工具命名空间重复" }
    current += server
    writeServers(root, current)
  }

  @Synchronized fun setServerEnabled(id: String, enabled: Boolean) {
    val root = readRootStrictForMutation()
    var found = false
    val next = readServers(root).map { server ->
      if (server.id == id) { found = true; server.copy(enabled = enabled) } else server
    }
    require(found) { "找不到 MCP 服务器" }
    writeServers(root, next)
  }

  @Synchronized fun remove(id: String) {
    val root = readRootStrictForMutation()
    val old = readServers(root)
    val next = old.filterNot { it.id == id }
    require(next.size != old.size) { "找不到 MCP 服务器" }
    writeServers(root, next)
  }

  fun secretEnvironment(): Map<String, String> {
    val result = linkedMapOf<String, String>()
    for (server in listServers()) {
      if (!server.enabled || server.transport != HTTP || !server.bearerAuth) continue
      SecureCredentialStore.mcpBearerToken(context, server.id)?.let { result[tokenEnvName(server.id)] = it }
    }
    return result
  }

  @Synchronized fun ensureRuntimePatch(safeMode: Boolean = false): File {
    val rows = mutableListOf<String>()
    // Read one consistent configuration generation for all MCP services.
    val root = readRootSafe()
    if (!safeMode) {
      if (root.optBoolean("toolboxEnabled", true)) {
        if (!toolboxFile.isFile || !basicToolboxFile.isFile)
          throw java.io.IOException("内置 MCP 工具箱文件缺失；需要修复 DSH 运行时")
        rows += toolboxRow()
        rows += basicToolboxRow()
      }
      readServersForRuntime(root).filter { it.enabled }.forEach { server ->
        val issue = externalStdioLaunchIssue(server)
        if (issue == null) {
          rows += serverRow(server)
        } else {
          // A stale external Android/Termux path must not poison DSH startup.
          // Keep the persisted server definition untouched for later repair.
          Log.w(tag, "Skipping unavailable MCP ${server.serverName}: $issue")
        }
      }
    }
    val text = if (rows.isEmpty()) {
      "[]\n"
    } else {
      buildString {
        append("- insert:\n")
        for (row in rows) {
          for (line in row.lines()) { append("    ").append(line).append('\n') }
        }
      }
    }
    writeFileAtomically(patchFile, text)
    return patchFile
  }

  /**
   * Never rewrite/delete legacy MCP definitions as part of a Host boot.
   * Stdio entrypoints with missing absolute local files cannot be executed
   * by the embedded Android Host; silently retrying them crashes or floods
   * the log with MODULE_NOT_FOUND on every restart.
   */
  private fun externalStdioLaunchIssue(server: McpServerConfig): String? {
    if (server.transport != STDIO || !server.enabled) return null
    val paths = mutableListOf(server.command)
    // Only examine executable-like script arguments, not arbitrary positional
    // arguments such as output locations or URLs.
    paths += server.args.filter { arg ->
      arg.startsWith("/") &&
        (arg.endsWith(".js") || arg.endsWith(".mjs") ||
         arg.endsWith(".cjs") || arg.endsWith(".ts"))
    }
    for (path in paths) {
      if (!path.startsWith("/")) continue
      if (!File(path).isFile) return "missing/unreadable executable or script"
    }
    if (server.cwd.isNotBlank() && server.cwd.startsWith("/") && !File(server.cwd).isDirectory)
      return "missing/unreadable working directory"
    return null
  }

  /** Read-only report: active choices remain in mcp-servers.json. */
  fun unavailableExternalServers(): List<String> =
    readServersForRuntime(readRootSafe()).filter { it.enabled }
      .mapNotNull { server ->
        externalStdioLaunchIssue(server)?.let { server.serverName + ": " + it }
      }

  fun runtimeSummary(): String {
    // Read once: settings rendering must not parse the same JSON repeatedly.
    val root = readRootSafe()
    val servers = readServersForRuntime(root)
    val enabled = root.optBoolean("toolboxEnabled", true)
    val mobilePresent = toolboxFile.isFile
    val basicPresent = basicToolboxFile.isFile
    val builtIn = when {
      !enabled -> "已关闭"
      mobilePresent && basicPresent -> "已配置（2/2 入口）"
      else -> "入口缺失（mobile=" + mobilePresent + ", basic=" + basicPresent + "）"
    }
    val binary = if (File(usrDir, "libexec/dsh/wrappers/readelf").exists() && File(usrDir, "libexec/dsh/wrappers/objdump").exists()) " · Binutils" else ""
    val skipped = unavailableExternalServers().size
    val diagnostic = (if (configurationIssue() == null) "" else " · MCP 配置异常（查看诊断）") +
      (if (skipped == 0) "" else " · 启动时跳过失效外部入口 $skipped 个（原配置保留）")
    return "内置 MCP " + builtIn + " · 外部 " + servers.count { it.enabled } + "/" + servers.size + binary + diagnostic
  }

  private fun newRoot(): JSONObject = JSONObject().put("schema", 1).put("toolboxEnabled", true).put("servers", JSONArray())

  private fun readRootSafe(): JSONObject {
    if (!configFile.isFile) return newRoot()
    return try { JSONObject(configFile.readText()) } catch (_: Throwable) { newRoot() }
  }

  private fun readRootStrictForMutation(): JSONObject {
    if (!configFile.isFile) return newRoot()
    return JSONObject(configFile.readText())
  }

  /**
   * Runtime registration is resilient per server: one malformed external entry
   * must not suppress unrelated working MCP servers. The settings diagnostic
   * still uses strict readServers() and reports the configuration problem.
   */
  private fun readServersForRuntime(root: JSONObject): List<McpServerConfig> {
    if (root.optInt("schema", 1) != 1) {
      Log.w(tag, "Unsupported MCP config schema; external servers not loaded")
      return emptyList()
    }
    val array = root.optJSONArray("servers") ?: return emptyList()
    val result = mutableListOf<McpServerConfig>()
    val names = mutableSetOf<String>()
    val ids = mutableSetOf<String>()
    for (i in 0 until minOf(array.length(), 32)) {
      try {
        val obj = array.optJSONObject(i) ?: throw IllegalArgumentException("entry is not an object")
        val rawArgs = obj.optJSONArray("args") ?: JSONArray()
        val server = McpServerConfig(
          id = obj.getString("id"),
          serverName = obj.getString("serverName"),
          transport = obj.getString("transport"),
          command = obj.optString("command", ""),
          args = MutableList(rawArgs.length()) { index -> rawArgs.getString(index) },
          cwd = obj.optString("cwd", ""),
          url = obj.optString("url", ""),
          bearerAuth = obj.optBoolean("bearerAuth", false),
          enabled = obj.optBoolean("enabled", true),
          preset = obj.optString("preset", "generic"),
        )
        validate(server)
        if (server.serverName in names || server.id in ids)
          throw IllegalArgumentException("duplicate MCP server name or id")
        names.add(server.serverName)
        ids.add(server.id)
        result += server
      } catch (t: Exception) {
        Log.w(tag, "Skipping invalid MCP server entry #${i + 1}: ${t.message}")
      }
    }
    return result
  }

  private fun readServers(root: JSONObject): List<McpServerConfig> {
    require(root.optInt("schema", 1) == 1) { "不支持的 MCP 配置版本" }
    val array = root.optJSONArray("servers") ?: JSONArray()
    require(array.length() <= 32) { "MCP 服务器过多" }
    val result = mutableListOf<McpServerConfig>()
    for (i in 0 until array.length()) {
      val obj = array.getJSONObject(i)
      val rawArgs = obj.optJSONArray("args") ?: JSONArray()
      val args = MutableList(rawArgs.length()) { index -> rawArgs.getString(index) }
      val server = McpServerConfig(
        id = obj.getString("id"),
        serverName = obj.getString("serverName"),
        transport = obj.getString("transport"),
        command = obj.optString("command", ""),
        args = args,
        cwd = obj.optString("cwd", ""),
        url = obj.optString("url", ""),
        bearerAuth = obj.optBoolean("bearerAuth", false),
        enabled = obj.optBoolean("enabled", true),
        preset = obj.optString("preset", "generic"),
      )
      validate(server)
      result += server
    }
    require(result.map { it.serverName }.distinct().size == result.size) { "MCP 工具命名空间重复" }
    require(result.map { it.id }.distinct().size == result.size) { "MCP 服务器 ID 重复" }
    return result
  }

  private fun writeServers(root: JSONObject, servers: List<McpServerConfig>) {
    val array = JSONArray()
    for (server in servers) {
      array.put(JSONObject()
        .put("id", server.id)
        .put("serverName", server.serverName)
        .put("transport", server.transport)
        .put("command", server.command)
        .put("args", JSONArray(server.args))
        .put("cwd", server.cwd)
        .put("url", server.url)
        .put("bearerAuth", server.bearerAuth)
        .put("enabled", server.enabled)
        .put("preset", server.preset))
    }
    root.put("servers", array)
    writeRoot(root)
  }

  private fun writeRoot(root: JSONObject) {
    writeFileAtomically(configFile, root.toString(2) + "\n")
  }

  /** Switch complete generations without a missing-file window. */
  private fun writeFileAtomically(target: File, content: String) {
    target.parentFile?.mkdirs()
    if (target.isFile && target.readText() == content) return
    val temp = File(target.parentFile, ".${target.name}.tmp-${UUID.randomUUID()}")
    try {
      temp.writeText(content)
      try {
        java.nio.file.Files.move(temp.toPath(), target.toPath(),
          java.nio.file.StandardCopyOption.ATOMIC_MOVE,
          java.nio.file.StandardCopyOption.REPLACE_EXISTING)
      } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
        java.nio.file.Files.move(temp.toPath(), target.toPath(),
          java.nio.file.StandardCopyOption.REPLACE_EXISTING)
      }
    } finally {
      if (temp.exists()) temp.delete()
    }
  }

  private fun validate(server: McpServerConfig) {
    UUID.fromString(server.id)
    require(Regex("^[A-Za-z0-9_-]{1,32}$").matches(server.serverName) && server.serverName !in BUILTIN_NAMES) { "MCP 命名空间无效" }
    when (server.transport) {
      STDIO -> {
        require(server.command.isNotBlank() && !server.command.contains('\n') && server.args.size <= 64) { "stdio 配置无效" }
      }
      HTTP -> {
        val uri = URI(server.url)
        require((uri.scheme == "http" || uri.scheme == "https") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null) { "MCP URL 无效" }
      }
      else -> error("不支持的 MCP transport")
    }
  }

  private fun toolboxRow(): String = buildString {
    append("- id: android-mcp-mobile-tools\n")
    append("  name: '@deepseek-ai/dsh-mcp-client'\n")
    append("  config:\n")
    append("    serverName: mobile_tools\n")
    append("    transport: stdio\n")
    append("    command: ").append(JSONObject.quote(File(usrDir, "bin/node").absolutePath)).append('\n')
    append("    args: [").append(JSONObject.quote(toolboxFile.absolutePath)).append("]\n")
    append("    env:\n")
    append("      TERMUX__PREFIX: ").append(JSONObject.quote(usrDir.absolutePath)).append('\n')
    append("      PREFIX: ").append(JSONObject.quote(usrDir.absolutePath)).append('\n')
    append("      LD_LIBRARY_PATH: ").append(JSONObject.quote(File(usrDir, "lib").absolutePath)).append('\n')
    append("      PATH: ").append(JSONObject.quote(File(usrDir, "libexec/dsh/wrappers").absolutePath + ":" + File(usrDir, "bin").absolutePath + ":/system/bin")).append('\n')
    append("      HOME: ").append(JSONObject.quote(homeDir.absolutePath)).append('\n')
    append("      TMPDIR: ").append(JSONObject.quote(File(homeDir, "tmp").absolutePath)).append('\n')
    append("      GIT_EXEC_PATH: ").append(JSONObject.quote(File(usrDir, "libexec/git-core").absolutePath)).append('\n')
    append("      GIT_TEMPLATE_DIR: ").append(JSONObject.quote(File(usrDir, "share/git-core/templates").absolutePath)).append('\n')
    append("      GIT_CONFIG_SYSTEM: ").append(JSONObject.quote(File(usrDir, "etc/gitconfig").absolutePath)).append('\n')
    append("      GIT_TERMINAL_PROMPT: \"0\"\n")
    append("      GIT_PAGER: \"cat\"\n")
    append("      PAGER: \"cat\"\n")
    append("      NO_COLOR: \"1\"\n")
    append("      SSL_CERT_FILE: ").append(JSONObject.quote(File(usrDir, "etc/tls/cert.pem").absolutePath)).append('\n')
    append("      NODE_EXTRA_CA_CERTS: ").append(JSONObject.quote(File(usrDir, "etc/tls/cert.pem").absolutePath)).append('\n')
    append("    cwd: ").append(JSONObject.quote(homeDir.absolutePath)).append('\n')
    append("    toolCallTimeoutMs: 60000\n")
    append("    failOnStartupError: false")
  }

  private fun basicToolboxRow(): String = buildString {
    append("- id: android-mcp-basic-tools\n")
    append("  name: '@deepseek-ai/dsh-mcp-client'\n")
    append("  config:\n")
    append("    serverName: basic_tools\n")
    append("    transport: stdio\n")
    append("    command: ").append(JSONObject.quote(File(usrDir, "bin/node").absolutePath)).append('\n')
    append("    args: [").append(JSONObject.quote(basicToolboxFile.absolutePath)).append("]\n")
    append("    env:\n")
    append("      TERMUX__PREFIX: ").append(JSONObject.quote(usrDir.absolutePath)).append('\n')
    append("      PREFIX: ").append(JSONObject.quote(usrDir.absolutePath)).append('\n')
    append("      LD_LIBRARY_PATH: ").append(JSONObject.quote(File(usrDir, "lib").absolutePath)).append('\n')
    append("      PATH: ").append(JSONObject.quote(File(usrDir, "libexec/dsh/wrappers").absolutePath + ":" + File(usrDir, "bin").absolutePath + ":/system/bin")).append('\n')
    append("      HOME: ").append(JSONObject.quote(homeDir.absolutePath)).append('\n')
    append("      TMPDIR: ").append(JSONObject.quote(File(homeDir, "tmp").absolutePath)).append('\n')
    append("      GIT_EXEC_PATH: ").append(JSONObject.quote(File(usrDir, "libexec/git-core").absolutePath)).append('\n')
    append("      GIT_TEMPLATE_DIR: ").append(JSONObject.quote(File(usrDir, "share/git-core/templates").absolutePath)).append('\n')
    append("      GIT_CONFIG_SYSTEM: ").append(JSONObject.quote(File(usrDir, "etc/gitconfig").absolutePath)).append('\n')
    append("      GIT_TERMINAL_PROMPT: \"0\"\n")
    append("      NO_COLOR: \"1\"\n")
    append("      SSL_CERT_FILE: ").append(JSONObject.quote(File(usrDir, "etc/tls/cert.pem").absolutePath)).append('\n')
    append("      NODE_EXTRA_CA_CERTS: ").append(JSONObject.quote(File(usrDir, "etc/tls/cert.pem").absolutePath)).append('\n')
    append("    cwd: ").append(JSONObject.quote(homeDir.absolutePath)).append('\n')
    append("    toolCallTimeoutMs: 300000\n")
    append("    failOnStartupError: false")
  }

  private fun serverRow(server: McpServerConfig): String = buildString {
    append("- id: android-mcp-").append(server.id.replace("-", "")).append('\n')
    append("  name: '@deepseek-ai/dsh-mcp-client'\n")
    append("  config:\n")
    append("    serverName: ").append(JSONObject.quote(server.serverName)).append('\n')
    append("    transport: ").append(server.transport).append('\n')
    if (server.transport == STDIO) {
      append("    command: ").append(JSONObject.quote(server.command)).append('\n')
      append("    args: ").append(JSONArray(server.args).toString()).append('\n')
      append("    env: {}\n")
      append("    cwd: ").append(JSONObject.quote(server.cwd.ifBlank { homeDir.absolutePath })).append('\n')
    } else {
      append("    url: ").append(JSONObject.quote(server.url)).append('\n')
      if (server.bearerAuth) {
        append("    headers:\n")
        append("      Authorization: !!js '`Bearer \${process.env.")
        append(tokenEnvName(server.id))
        append(" ?? \"\"}`'\n")
      } else {
        append("    headers: {}\n")
      }
    }
    append("    toolCallTimeoutMs: 60000\n")
    append("    failOnStartupError: false")
  }

  companion object {
    const val STDIO = "stdio"
    const val HTTP = "streamable-http"
    const val BUILTIN = "mobile_tools"
    const val BUILTIN_BASIC = "basic_tools"
    val BUILTIN_NAMES = setOf(BUILTIN, BUILTIN_BASIC)
    fun tokenEnvName(id: String): String = "DSH_ANDROID_MCP_TOKEN_" + id.uppercase().replace(Regex("[^A-Z0-9]"), "_")
  }
}
