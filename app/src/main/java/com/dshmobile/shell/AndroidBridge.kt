package com.dshmobile.shell

import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.JavascriptInterface
import java.security.MessageDigest
import org.json.JSONObject

/**
 * JS bridge exposed as window.androidBridge.
 *
 * Android injects JavascriptInterface objects into every frame, not only the
 * top-level DSH document. Privileged methods therefore require an unguessable
 * per-Activity capability that is injected only into the main-frame UI shim.
 */
class AndroidBridge(
  private val expectedCapability: String,
  private val onPickRequest: (callbackId: String) -> Unit,
  private val onKeepScreen: (enable: Boolean) -> Unit,
  private val onNotify: (title: String, text: String) -> Unit,
  private val onHasAllFilesAccess: () -> Boolean = { false },
  private val onAllFilesAccessRequest: () -> Unit = {},
  private val onOpenPluginInstaller: () -> Unit = {},
  private val onOpenPluginManager: () -> Unit = {},
  private val onOpenConfigEditor: () -> Unit = {},
  private val onOpenAppSettings: () -> Unit = {},
  private val onImportWorkspaceFiles: () -> Unit = {},
  private val onOpenSkillImporter: () -> Unit = {},
  private val onListSkills: () -> String = { JSONObject().put("ok", true).put("skills", org.json.JSONArray()).toString() },
  private val onDeleteSkill: (String) -> String = { JSONObject().put("ok", false).put("error", "Skill manager unavailable").toString() },
  private val onDeleteSkillCollection: (String) -> String = { JSONObject().put("ok", false).put("error", "Skill collection manager unavailable").toString() },
  private val onWorkspacePath: () -> String? = { null },
  private val onRememberWorkspacePath: (String) -> Boolean = { false },
  private val pickToken: String? = null,
) {

  @JavascriptInterface
  fun version(): String = "2.0"

  private fun authorized(capability: String?): Boolean {
    if (capability == null) return false
    return MessageDigest.isEqual(
      capability.toByteArray(Charsets.UTF_8), expectedCapability.toByteArray(Charsets.UTF_8),
    )
  }

  @JavascriptInterface
  fun checkEngine(capability: String): String =
    if (authorized(capability)) EngineProbe.check().toString()
    else JSONObject().put("running", false).put("error", "bridge authorization failed").toString()

  @JavascriptInterface
  fun keepScreenOn(capability: String, enable: Boolean) {
    if (authorized(capability)) onKeepScreen(enable)
  }

  @JavascriptInterface
  fun showNotification(capability: String, title: String, text: String) {
    if (authorized(capability)) onNotify(title, text)
  }

  @JavascriptInterface
  fun pickDirectory(capability: String, callbackId: String) {
    if (authorized(capability)) onPickRequest(callbackId)
  }

  @JavascriptInterface
  fun hasAllFilesAccess(capability: String): Boolean =
    authorized(capability) && onHasAllFilesAccess()

  @JavascriptInterface
  fun requestAllFilesAccess(capability: String) {
    if (authorized(capability)) onAllFilesAccessRequest()
  }

  @JavascriptInterface
  fun openPluginInstaller(capability: String) {
    if (authorized(capability)) onOpenPluginInstaller()
  }

  @JavascriptInterface
  fun openPluginManager(capability: String) {
    if (authorized(capability)) onOpenPluginManager()
  }

  @JavascriptInterface
  fun openConfigEditor(capability: String) {
    if (authorized(capability)) onOpenConfigEditor()
  }

  @JavascriptInterface
  fun openAppSettings(capability: String) {
    if (authorized(capability)) onOpenAppSettings()
  }

  @JavascriptInterface
  fun importFilesToWorkspace(capability: String) {
    if (authorized(capability)) onImportWorkspaceFiles()
  }

  @JavascriptInterface
  fun openSkillImporter(capability: String) {
    if (authorized(capability)) onOpenSkillImporter()
  }

  @JavascriptInterface
  fun listSkills(capability: String): String =
    if (authorized(capability)) onListSkills()
    else JSONObject().put("ok", false).put("error", "bridge authorization failed").toString()

  @JavascriptInterface
  fun deleteSkill(capability: String, name: String): String =
    if (authorized(capability)) onDeleteSkill(name)
    else JSONObject().put("ok", false).put("error", "bridge authorization failed").toString()

  @JavascriptInterface
  fun deleteSkillCollection(capability: String, collectionId: String): String =
    if (authorized(capability)) onDeleteSkillCollection(collectionId)
    else JSONObject().put("ok", false).put("error", "bridge authorization failed").toString()

  @JavascriptInterface
  fun getLastWorkspacePath(capability: String): String? =
    if (authorized(capability)) onWorkspacePath() else null

  /**
   * Synchronize the Android shell's file-operation root with the Workspace
   * currently owned by the DSH Web Session. The Activity validates and
   * canonicalizes the path before it is persisted.
   */
  @JavascriptInterface
  fun setCurrentWorkspacePath(capability: String, path: String): Boolean =
    authorized(capability) && onRememberWorkspacePath(path)

  @JavascriptInterface
  fun getPickToken(capability: String): String? =
    if (authorized(capability)) pickToken else null

  companion object {
    fun resolvePickedPath(uri: Uri): String {
      return try {
        val docId = DocumentsContract.getTreeDocumentId(uri)
        val idx = docId.indexOf(':')
        val volume = if (idx > 0) docId.substring(0, idx) else ""
        val rel = if (idx > 0) docId.substring(idx + 1) else docId
        if (volume == "primary" && rel.isEmpty()) return "/storage/emulated/0"
        if (volume == "primary") return "/storage/emulated/0/$rel"
        if (rel.isEmpty() && volume.isNotBlank()) {
          val root = java.io.File("/storage/$volume")
          return if (root.exists()) root.absolutePath else uri.toString()
        }
        val candidate = java.io.File("/storage/$volume/$rel")
        if (candidate.exists()) candidate.absolutePath else uri.toString()
      } catch (_: Exception) {
        uri.toString()
      }
    }
  }
}

internal fun jsString(value: String): String = JSONObject.quote(value)
