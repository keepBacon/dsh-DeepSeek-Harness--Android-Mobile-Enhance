package com.dshmobile.shell

import android.content.Context
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
  private val patchFile = File(context.filesDir, "mcp/android-mcp.patch.yml")
  private val toolboxFile = File(usrDir, "libexec/dsh-mobile/toolbox-mcp.mjs")
  private val basicToolboxFile = File(usrDir, "libexec/dsh-mobile/basic-toolbox-mcp.mjs")

  fun toolboxEnabled(): Boolean = readRootSafe().optBoolean("toolboxEnabled", true)
  fun listServers(): List<McpServerConfig> = readServers(readRootSafe())

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

  @Synchronized fun ensureRuntimePatch(): File {
    val rows = mutableListOf<String>()
    if (toolboxEnabled() && toolboxFile.isFile) rows += toolboxRow()
    if (toolboxEnabled() && basicToolboxFile.isFile) rows += basicToolboxRow()
    listServers().filter { it.enabled }.forEach { rows += serverRow(it) }
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
    patchFile.parentFile?.mkdirs()
    patchFile.writeText(text)
    return patchFile
  }

  fun runtimeSummary(): String {
    val servers = listServers()
    val builtIn = if (toolboxEnabled() && toolboxFile.isFile) "已启用" else if (toolboxFile.isFile) "已关闭" else "未内置"
    val basic = if (toolboxEnabled() && basicToolboxFile.isFile) " · Basic tools" else ""
    val binary = if (File(usrDir, "libexec/dsh/wrappers/readelf").exists() && File(usrDir, "libexec/dsh/wrappers/objdump").exists()) " · Binutils" else ""
    return "内置 MCP " + builtIn + basic + " · 外部 " + servers.count { it.enabled } + "/" + servers.size + binary
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
    configFile.parentFile?.mkdirs()
    val temp = File(configFile.parentFile, ".mcp-servers.tmp")
    temp.writeText(root.toString(2) + "\n")
    if (configFile.exists() && !configFile.delete()) throw java.io.IOException("无法替换 MCP 配置")
    if (!temp.renameTo(configFile)) throw java.io.IOException("无法提交 MCP 配置")
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
