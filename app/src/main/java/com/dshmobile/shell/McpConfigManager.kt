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

  fun toolboxEnabled(): Boolean = readRoot().optBoolean("toolboxEnabled", true)
  fun listServers(): List<McpServerConfig> = readServers(readRoot())
  fun configurationIssue(): String? = try { readServers(readRoot()); null } catch (t: Throwable) { t.message }

  @Synchronized fun setToolboxEnabled(enabled: Boolean) {
    val root = readRoot(); root.put("toolboxEnabled", enabled); writeRoot(root)
  }

  @Synchronized fun upsert(server: McpServerConfig) {
    validate(server)
    val current = listServers().filterNot { it.id == server.id }.toMutableList()
    require(current.none { it.serverName == server.serverName }) { "MCP 工具命名空间重复" }
    current += server; writeServers(current)
  }

  @Synchronized fun setServerEnabled(id: String, enabled: Boolean) {
    var found = false
    val next = listServers().map { if (it.id == id) { found = true; it.copy(enabled = enabled) } else it }
    require(found) { "找不到 MCP 服务器" }; writeServers(next)
  }

  @Synchronized fun remove(id: String) {
    val old = listServers(); val next = old.filterNot { it.id == id }
    require(next.size != old.size) { "找不到 MCP 服务器" }; writeServers(next)
  }

  fun secretEnvironment(): Map<String,String> = buildMap {
    listServers().filter { it.enabled && it.transport == HTTP && it.bearerAuth }.forEach { server ->
      SecureCredentialStore.mcpBearerToken(context, server.id)?.let { put(tokenEnvName(server.id), it) }
    }
  }

  @Synchronized fun ensureRuntimePatch(): File {
    val rows = mutableListOf<String>()
    if (toolboxEnabled() && toolboxFile.isFile) rows += toolboxRow()
    listServers().filter { it.enabled }.forEach { rows += serverRow(it) }
    val text = if (rows.isEmpty()) "[]\n" else "- insert:\n" + rows.joinToString("\n") { row -> row.lines().joinToString("\n") { "    $it" } } + "\n"
    patchFile.parentFile?.mkdirs(); patchFile.writeText(text); return patchFile
  }

  fun runtimeSummary(): String {
    val servers = listServers()
    val builtIn = if (toolboxEnabled() && toolboxFile.isFile) "已启用" else if (toolboxFile.isFile) "已关闭" else "未内置"
    val bin = if (File(usrDir,"bin/readelf").isFile && File(usrDir,"bin/objdump").isFile) " · Binutils" else ""
    return "内置 MCP $builtIn · 外部 ${servers.count { it.enabled }}/${servers.size}$bin"
  }

  private fun readRoot(): JSONObject = if (configFile.isFile) JSONObject(configFile.readText()) else JSONObject().put("schema",1).put("toolboxEnabled",true).put("servers",JSONArray())
  private fun readServers(root: JSONObject): List<McpServerConfig> {
    require(root.optInt("schema",1) == 1) { "不支持的 MCP 配置版本" }
    val a = root.optJSONArray("servers") ?: JSONArray(); require(a.length() <= 32) { "MCP 服务器过多" }
    return List(a.length()) { i ->
      val o=a.getJSONObject(i); val aa=o.optJSONArray("args") ?: JSONArray()
      McpServerConfig(o.getString("id"),o.getString("serverName"),o.getString("transport"),o.optString("command"),List(aa.length()){aa.getString(it)},o.optString("cwd"),o.optString("url"),o.optBoolean("bearerAuth"),o.optBoolean("enabled",true),o.optString("preset","generic")).also(::validate)
    }.also { list -> require(list.map{it.serverName}.distinct().size == list.size) { "MCP 工具命名空间重复" } }
  }

  private fun writeServers(servers: List<McpServerConfig>) {
    val root=readRoot(); val a=JSONArray(); servers.forEach { s -> a.put(JSONObject().put("id",s.id).put("serverName",s.serverName).put("transport",s.transport).put("command",s.command).put("args",JSONArray(s.args)).put("cwd",s.cwd).put("url",s.url).put("bearerAuth",s.bearerAuth).put("enabled",s.enabled).put("preset",s.preset)) }; root.put("servers",a); writeRoot(root)
  }
  private fun writeRoot(root: JSONObject) { configFile.parentFile?.mkdirs(); configFile.writeText(root.toString(2)+"\n") }

  private fun validate(s: McpServerConfig) {
    UUID.fromString(s.id); require(Regex("^[A-Za-z0-9_-]{1,32}$").matches(s.serverName) && s.serverName != BUILTIN) { "MCP 命名空间无效" }
    when(s.transport) {
      STDIO -> { require(s.command.isNotBlank() && !s.command.contains('\n')) { "stdio 命令无效" }; require(s.args.size <= 64) { "stdio 参数过多" } }
      HTTP -> { val u=URI(s.url); require((u.scheme=="http" || u.scheme=="https") && !u.host.isNullOrBlank() && u.rawUserInfo==null) { "MCP URL 无效" } }
      else -> error("不支持的 MCP transport")
    }
  }

  private fun toolboxRow(): String = listOf(
    "- id: android-mcp-mobile-tools",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: mobile_tools",
    "    transport: stdio",
    "    command: ${JSONObject.quote(File(usrDir,"bin/node").absolutePath)}",
    "    args: [${JSONObject.quote(toolboxFile.absolutePath)}]",
    "    env: {}",
    "    cwd: ${JSONObject.quote(homeDir.absolutePath)}",
    "    toolCallTimeoutMs: 60000",
    "    failOnStartupError: false",
  ).joinToString("\n")

  private fun serverRow(s: McpServerConfig): String = buildString {
    append("- id: android-mcp-").append(s.id.replace("-","")).append('\n')
    append("  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: ").append(JSONObject.quote(s.serverName)).append('\n')
    append("    transport: ").append(s.transport).append('\n')
    if (s.transport==STDIO) {
      append("    command: ").append(JSONObject.quote(s.command)).append('\n')
      append("    args: ").append(JSONArray(s.args).toString()).append('\n')
      append("    env: {}\n    cwd: ").append(JSONObject.quote(s.cwd.ifBlank { homeDir.absolutePath })).append('\n')
    } else {
      append("    url: ").append(JSONObject.quote(s.url)).append('\n')
      if (s.bearerAuth) append("    headers:\n      Authorization: !!js '`Bearer ${process.env.").append(tokenEnvName(s.id)).append(" ?? \"\"}`'\n") else append("    headers: {}\n")
    }
    append("    toolCallTimeoutMs: 60000\n    failOnStartupError: false")
  }

  companion object {
    const val STDIO="stdio"; const val HTTP="streamable-http"; const val BUILTIN="mobile_tools"
    fun tokenEnvName(id:String)="DSH_ANDROID_MCP_TOKEN_"+id.uppercase().replace(Regex("[^A-Z0-9]"),"_")
  }
}
