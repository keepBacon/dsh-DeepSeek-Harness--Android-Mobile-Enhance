package com.dshmobile.shell.database

/** Explicitly distinguish rejected test input from a failed tool handler. */
object ToolErrorClassifier {
  fun safeCode(raw: String?): String {
    if (raw.isNullOrBlank()) return ""
    return Regex("""[A-Z][A-Z0-9_]{1,63}""").find(raw.uppercase())?.value ?: ""
  }

  fun classify(status: String, raw: String?): String {
    if (status == "running") return "RUNNING"
    if (status == "success") return "OK"
    val text = raw.orEmpty().uppercase()
    return when {
      text.contains("MCP_SCHEMA_REQUIRED") || text.contains("INVALID_ARGUMENT") ||
        text.contains("INVALID_PARAMS") || text.contains("MISSING_REQUIRED") ||
        text.contains("-32602") -> "INVALID_ARGUMENT"
      text.contains("UNSUPPORTED_SCHEMA") || text.contains("SCHEMA_ERROR") -> "SCHEMA_ERROR"
      text.contains("UNAUTHORIZED") || text.contains("FORBIDDEN") || text.contains("AUTH_ERROR") -> "AUTH_ERROR"
      text.contains("TIMEOUT") || text.contains("TIMED_OUT") -> "TIMEOUT"
      text.contains("TRANSPORT") || text.contains("ECONNREFUSED") ||
        text.contains("CONNECTION") -> "TRANSPORT_ERROR"
      text.contains("DISABLED") || text.contains("SAFE_MODE") -> "DISABLED"
      text.contains("LOAD_FAILURE") || text.contains("MODULE_NOT_FOUND") -> "LOAD_FAILURE"
      else -> "UNCLASSIFIED"
    }
  }
}
