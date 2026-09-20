package com.dshmobile.shell

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationCompat
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import android.util.Base64

/** Shell activity: WebView over the local dsh engine + engine guide fallback. */
class MainActivity : ComponentActivity() {

  private lateinit var webView: WebView
  private lateinit var guideView: LinearLayout
  /** 目录选择桥鉴权 token（每次进程启动随机；引擎 env + JS 桥同源持有）。 */
  private val pickToken: String by lazy { ShellState.pickToken(this) }
  /** Per-Activity capability required by every privileged JavascriptInterface call. */
  private val bridgeCapability: String by lazy {
    val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)
  }
  private lateinit var engineStatus: TextView
  private lateinit var progressText: TextView
  private val engineManager by lazy { EngineManager(this, pickToken) }
  private val engineFlowRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  private val authRecoveryRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  private val profileMutationRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  private val recoveryControls = mutableListOf<View>()
  private var pendingPickCallback: String? = null
  private var filePathCallback: ValueCallback<Array<Uri>>? = null
  private var pendingWorkspaceImportPath: String? = null
  private var pendingSharedImportUris: List<Uri>? = null
  private var legacyDirectoryPermissionPending = false
  private val legacyPermissionRequestRunning = java.util.concurrent.atomic.AtomicBoolean(false)

  private data class PendingNotification(val title: String, val text: String)
  private val pendingNotifications = java.util.concurrent.ConcurrentLinkedQueue<PendingNotification>()
  private val notificationPermissionRunning = java.util.concurrent.atomic.AtomicBoolean(false)

  private data class DownloadRequest(
    val url: String,
    val contentDisposition: String?,
    val hintedMime: String?,
    val dedupeKey: String,
  )
  private val downloadQueue = java.util.concurrent.ConcurrentLinkedQueue<DownloadRequest>()
  private val queuedDownloads = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
  private val downloadWorkerRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  private val legacyDownloadPermissionPending = java.util.concurrent.atomic.AtomicBoolean(false)

  private val directoryPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
    val callback = pendingPickCallback
    pendingPickCallback = null
    if (callback != null) {
      if (uri != null) {
        val path = resolveWritableWorkspacePath(uri)
        if (path != null) ShellState.rememberWorkspacePath(this, path)
        webView.evaluateJavascript(
          "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", " +
            (path?.let(::jsString) ?: "null") + ")", null,
        )
        if (path == null) showSimpleMessage(
          "无法使用该目录",
          "所选目录不能作为嵌入式 DSH 的真实文件系统工作区。请选择内部存储目录，或使用应用兼容工作区。",
        )
      } else {
        // 用户取消：回传 null，让引擎侧 pick() 以取消结算（否则页面轮询
        // 会继续拿到同一请求反复唤起选择器——设备实证的 picker 堆叠）。
        webView.evaluateJavascript(
          "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", null)", null,
        )
      }
    }
  }

  companion object {
    const val ACTION_UPDATE = "com.dshmobile.shell.action.UPDATE"
    const val GITHUB_REPOSITORY_URL = "https://github.com/keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance"

    /** 导出文件大小上限（防恶意/异常大文件 OOM）。 */
    const val MAX_DOWNLOAD_BYTES = 2L * 1024 * 1024 * 1024

    /** 会话日志导出端点路径（WebView 内双拦截识别用）。 */
    const val SESSION_EXPORT_PATH = "/api/session.export"

    /** 单个导入工作区文件的安全上限。 */
    const val MAX_WORKSPACE_IMPORT_BYTES = 2L * 1024 * 1024 * 1024

    /** Imported plugin archive size before extraction. */
    const val MAX_PLUGIN_PACKAGE_BYTES = 512L * 1024 * 1024

    /** 解压本地插件 ZIP 的总大小上限。 */
    const val MAX_PLUGIN_ZIP_BYTES = 512L * 1024 * 1024
    const val MAX_PLUGIN_ZIP_ENTRY_BYTES = 256L * 1024 * 1024
    const val MAX_PLUGIN_ZIP_ENTRIES = 20_000
    const val MAX_PLUGIN_ZIP_DEPTH = 32
  }

  // 文件上传（<input type=file> → WebView onShowFileChooser → 系统文件选择器）。
  // 与目录选择（directoryPicker，工作区用）分离：多选、任意类型。
  private val filePicker =
    registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      val callback = filePathCallback
      filePathCallback = null
      if (callback != null) {
        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
      }
    }

  /** Phone files -> real workspace files. Separate from chat attachment upload. */
  private val workspaceFilePicker =
    registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      val workspace = pendingWorkspaceImportPath ?: ShellState.lastWorkspacePath(this)
      pendingWorkspaceImportPath = null
      if (uris.isEmpty()) return@registerForActivityResult
      if (workspace.isNullOrBlank()) {
        showSimpleMessage("尚未选择工作区", "请先在 DSH 中选择一个手机目录作为工作区。")
        return@registerForActivityResult
      }
      importFilesIntoWorkspace(workspace, uris)
    }

  /** Optional override when the remembered workspace is stale or the user wants a different target. */
  private val workspaceImportTargetPicker =
    registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
      val sharedUris = pendingSharedImportUris
      pendingSharedImportUris = null
      if (uri == null) return@registerForActivityResult
      val path = resolveWritableWorkspacePath(uri)
      if (path == null) {
        showSimpleMessage("无法直接写入该目录", "请选择内部存储或可直接访问的外部存储目录。")
        return@registerForActivityResult
      }
      ShellState.rememberWorkspacePath(this, path)
      if (sharedUris != null) {
        importFilesIntoWorkspace(path, sharedUris)
      } else {
        pendingWorkspaceImportPath = path
        workspaceFilePicker.launch(arrayOf("*/*"))
      }
    }

  /** Android SAF import for local plugin tarballs (content:// -> private real path). */
  private val pluginPackagePicker =
    registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
      if (uri == null) return@registerForActivityResult
      Thread {
        try {
          val name = queryDisplayName(uri) ?: "plugin-${System.currentTimeMillis()}.tgz"
          queryContentSize(uri)?.let { size ->
            if (size > MAX_PLUGIN_PACKAGE_BYTES) throw java.io.IOException("插件包超过 512 MB 导入上限")
          }
          val dir = java.io.File(filesDir, "plugin-import").apply { mkdirs() }
          val target = java.io.File(dir, sanitizeFilename(name))
          try {
            contentResolver.openInputStream(uri)?.use { input ->
              target.outputStream().use { output -> copyWithLimit(input, output, MAX_PLUGIN_PACKAGE_BYTES, "插件包超过 512 MB 导入上限") }
            } ?: throw java.io.IOException("无法读取所选插件包")
          } catch (t: Throwable) {
            target.delete()
            throw t
          }
          val installSpec = prepareImportedPluginPackage(target)
          runOnUiThread { installPluginInBackground(installSpec) }
        } catch (t: Throwable) {
          runOnUiThread { showSimpleMessage("导入失败", t.message ?: t.javaClass.simpleName) }
        }
      }.start()
    }

  /** Import any OpenSSH private-key type into the app-private HOME used by embedded Git. */
  private val sshKeyPicker =
    registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
      if (uri == null) return@registerForActivityResult
      Thread {
        try {
          val sshDir = java.io.File(filesDir, "home/.ssh")
          if (java.nio.file.Files.isSymbolicLink(sshDir.toPath())) {
            throw java.io.IOException("HOME/.ssh 不能是符号链接")
          }
          if (!sshDir.exists() && !sshDir.mkdirs()) throw java.io.IOException("无法创建 HOME/.ssh")
          val homeCanonical = java.io.File(filesDir, "home").canonicalFile
          val sshCanonical = sshDir.canonicalFile
          if (!sshCanonical.path.startsWith(homeCanonical.path + java.io.File.separator)) {
            throw java.io.IOException("SSH 目录越界")
          }
          val target = java.io.File(sshDir, "id_dsh")
          val temp = java.io.File(sshDir, ".id_dsh-import-${java.util.UUID.randomUUID()}.tmp")
          try {
            contentResolver.openInputStream(uri)?.use { input ->
              temp.outputStream().use { output -> copyWithLimit(input, output, 8L * 1024 * 1024, "SSH 私钥文件异常过大") }
            } ?: throw java.io.IOException("无法读取 SSH 私钥")
            try { android.system.Os.chmod(sshDir.absolutePath, 448) } catch (_: Throwable) {} // 0700
            try { android.system.Os.chmod(temp.absolutePath, 384) } catch (_: Throwable) {} // 0600
            try {
              java.nio.file.Files.move(
                temp.toPath(), target.toPath(),
                java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                java.nio.file.StandardCopyOption.REPLACE_EXISTING,
              )
            } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
              java.nio.file.Files.move(temp.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            }
            try { android.system.Os.chmod(target.absolutePath, 384) } catch (_: Throwable) {} // 0600
          } finally {
            temp.delete()
          }
          runOnUiThread { showSshPassphraseDialog(afterImport = true) }
        } catch (t: Throwable) {
          runOnUiThread { showSimpleMessage("SSH 密钥导入失败", t.message ?: t.javaClass.simpleName) }
        }
      }.start()
    }

  private val notificationPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      notificationPermissionRunning.set(false)
      if (granted) {
        while (true) {
          val pending = pendingNotifications.poll() ?: break
          postNotification(pending.title, pending.text)
        }
      } else {
        pendingNotifications.clear()
      }
    }

  /** Android 8–10 legacy/workspace permission support; downloads use MediaStore on Android 10. */
  private val legacyStoragePermission =
    registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
      legacyPermissionRequestRunning.set(false)
      val writeGranted = grants[Manifest.permission.WRITE_EXTERNAL_STORAGE] == true ||
        checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
      if (legacyDirectoryPermissionPending) {
        legacyDirectoryPermissionPending = false
        if (writeGranted && pendingPickCallback != null) {
          directoryPicker.launch(null)
        } else if (pendingPickCallback != null) {
          val callback = pendingPickCallback
          pendingPickCallback = null
          webView.evaluateJavascript(
            "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback!!) + ", null)", null,
          )
          showSimpleMessage("存储权限未授权", "Android 8–10 需要存储权限或兼容工作区才能使用外部目录。")
        }
      }
      legacyDownloadPermissionPending.set(false)
      if (writeGranted) startDownloadWorker() else if (downloadQueue.isNotEmpty()) {
        clearDownloadQueue("Android 8/9 未获得写入下载目录的权限")
      }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val root = FrameLayout(this)
    webView = WebView(this).apply { id = View.generateViewId() }
    root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    guideView = buildGuideView()
    root.addView(guideView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(root)
    configureWebView()
    showStartingState("正在连接 DeepSeek Harness…")
    // Testable update trigger: adb am start -n .../.MainActivity -a com.dshmobile.shell.action.UPDATE
    if (intent?.action == ACTION_UPDATE) {
      runUpdate()
    } else {
      startEngineFlow()
      handleIncomingShare(intent)
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (intent.action == ACTION_UPDATE) runUpdate() else handleIncomingShare(intent)
  }

  override fun onResume() {
    super.onResume()
    // Never probe localhost on the UI thread. If the recovery/startup surface
    // is visible, let the background engine flow decide whether to reuse or
    // restart the Host. The atomic guard makes repeated lifecycle callbacks safe.
    if (::guideView.isInitialized && guideView.visibility == View.VISIBLE) startEngineFlow()
  }

  override fun onDestroy() {
    // The foreground EngineService owns the embedded Host lifetime. Activity
    // recreation/backgrounding must not kill long-running agent tasks.
    try {
      webView.stopLoading()
      webView.removeJavascriptInterface("androidBridge")
      webView.destroy()
    } catch (_: Throwable) {}
    super.onDestroy()
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    pushSystemDark(webView)
  }

  override fun onBackPressed() {
    if (webView.visibility != View.VISIBLE) {
      fallbackBackNavigation()
      return
    }
    // Desktop DSH closes dialogs/drawers with Escape. Android Back should do
    // the same before navigating away from the single-page application.
    val script = """
      (() => {
        if (document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')) {
          document.documentElement.removeAttribute('data-dsh-mobile-sidebar-open');
          return true;
        }
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };
        const overlays = Array.from(document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], [data-radix-popper-content-wrapper]'
        )).filter(visible);
        if (!overlays.length) return false;
        const init = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
        document.dispatchEvent(new KeyboardEvent('keydown', init));
        window.dispatchEvent(new KeyboardEvent('keydown', init));
        document.dispatchEvent(new KeyboardEvent('keyup', init));
        return true;
      })();
    """.trimIndent()
    try {
      webView.evaluateJavascript(script) { value ->
        if (value != "true") fallbackBackNavigation()
      }
    } catch (_: Throwable) {
      fallbackBackNavigation()
    }
  }

  private fun fallbackBackNavigation() {
    if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
  }

  private fun configureWebView() {
    // WebView 远程调试（debug 构建）：真机/模拟器 CDP 自动化验证 UI 行为。
    // AGP 8 默认不生成 BuildConfig，用 debuggable 标志判断。
    val debuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (debuggable) android.webkit.WebView.setWebContentsDebuggingEnabled(true)
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      javaScriptCanOpenWindowsAutomatically = true
      setSupportMultipleWindows(true)
      allowFileAccess = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      // Mode-specific viewport settings are applied below. Mobile mode uses
      // the real device viewport; Native mode keeps upstream DSH desktop layout.
      useWideViewPort = false
      loadWithOverviewMode = false
      setSupportZoom(true)
      builtInZoomControls = true
      displayZoomControls = false
      textZoom = 100
      userAgentString = "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 DSH-Android/0.1"
      // prefers-color-scheme 跟随系统深色（某些厂商 WebView 默认不跟随；
      // FORCE_DARK_AUTO 让 media query 反映系统深浅，dsh 的"跟随系统"主题依赖它）。
      if (Build.VERSION.SDK_INT >= 29) {
        @Suppress("DEPRECATION")
        forceDark = WebSettings.FORCE_DARK_AUTO
      }
    }
    applyInterfaceModeSettings()
    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      if (Build.VERSION.SDK_INT >= 21) setAcceptThirdPartyCookies(webView, true)
    }
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        // 会话日志导出（issue apk#6 + 403 修复）：浏览器导航带 Origin:null /
        // sec-fetch-site 标记，会被 dsh 的 /api browser-trust fence 拒绝
        // （403 forbidden，防 DNS rebinding/跨站）。改为 app 内下载：
        // HttpURLConnection 无浏览器标记 → fence 放行（MuMu 实测验证）。
        if (isSessionExport(url, request.method)) {
          downloadToDownloads(url, null, "application/zip")
          return true
        }
        // 只允许引擎同源页面留在 WebView（特权桥 + 下载能力仅对引擎可信）；
        // 外部链接交给系统浏览器，防止不可信页面获得桥能力（社工/通知轰炸/任意下载）。
        if (isEngineSource(url)) {
          // Let WebView follow DSH's 303 token->cookie redirect itself. Calling
          // loadUrl() from this callback can interrupt Set-Cookie processing.
          return false
        }
        openInExternalBrowser(request.url)
        return true
      }

      override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) {
        if (isEngineSource(failingUrl)) {
          showStartingState("正在重新连接 DSH…", description)
          startEngineFlow()
        }
      }

      override fun onReceivedHttpError(
        view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse,
      ) {
        super.onReceivedHttpError(view, request, errorResponse)
        if (!request.isForMainFrame || !isEngineSource(request.url.toString())) return
        when (errorResponse.statusCode) {
          401, 403 -> recoverWebAuthentication()
          in 500..599 -> {
            showStartingState("DSH 页面暂时不可用，正在恢复…", "HTTP ${errorResponse.statusCode}")
            startEngineFlow()
          }
        }
      }

      override fun onPageFinished(view: WebView, url: String) {
        super.onPageFinished(view, url)
        // Never inject the privileged shell shim/capability into a non-DSH
        // document, even if a future WebView redirect bypasses URL routing.
        if (!isEngineSource(url)) return
        CookieManager.getInstance().flush()
        authRecoveryRunning.set(false)
        pushSystemDark(view)
        installMobileUiBridge(view)
      }
    }
    // WebView 下载：会话日志导出（/api/session.export）与其余引擎源下载
    // 统一走 app 内 MediaStore 下载——浏览器导航带 Origin:null 会被 dsh
    // 的 /api browser-trust fence 拒绝（403），app 内 HttpURLConnection
    // 无浏览器标记 → fence 放行（403 修复路径，见 downloadToDownloads）。
    webView.setDownloadListener { url, _userAgent, contentDisposition, mimeType, _contentLength ->
      downloadToDownloads(url, contentDisposition, mimeType)
    }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams,
      ): Boolean {
        // 文件上传走系统文件选择器（OpenDocument，可多选）；directoryPicker
        // 是目录选择（工作区用），两者必须分离。
        this@MainActivity.filePathCallback?.onReceiveValue(null)
        this@MainActivity.filePathCallback = filePathCallback
        val accepts = fileChooserParams.acceptTypes.filter { it.isNotBlank() }.toTypedArray()
        filePicker.launch(if (accepts.isEmpty()) arrayOf("*/*") else accepts)
        return true
      }

      override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
        android.app.AlertDialog.Builder(this@MainActivity)
          .setMessage(message)
          .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
          .setOnCancelListener { result.cancel() }
          .show()
        return true
      }

      override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
        android.app.AlertDialog.Builder(this@MainActivity)
          .setMessage(message)
          .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
          .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
          .setOnCancelListener { result.cancel() }
          .show()
        return true
      }

      override fun onJsPrompt(
        view: WebView, url: String, message: String, defaultValue: String?, result: android.webkit.JsPromptResult,
      ): Boolean {
        val input = android.widget.EditText(this@MainActivity).apply {
          setText(defaultValue.orEmpty())
          setSelection(text.length)
          setSingleLine(true)
        }
        android.app.AlertDialog.Builder(this@MainActivity)
          .setMessage(message)
          .setView(input)
          .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
          .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm(input.text?.toString().orEmpty()) }
          .setOnCancelListener { result.cancel() }
          .show()
        return true
      }

      override fun onCreateWindow(
        view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message,
      ): Boolean {
        // Electron sends target=_blank HTTP(S) links to the OS browser. Mirror
        // that behavior instead of silently dropping them in WebView.
        val popup = WebView(this@MainActivity)
        popup.settings.javaScriptEnabled = true
        var routed = false
        popup.webViewClient = object : WebViewClient() {
          private fun route(url: String): Boolean {
            if (url == "about:blank") return false
            if (routed) return true
            routed = true
            if (isEngineSource(url)) webView.loadUrl(url) else openInExternalBrowser(Uri.parse(url))
            try { popup.destroy() } catch (_: Throwable) {}
            return true
          }
          override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean = route(request.url.toString())
          override fun onPageStarted(v: WebView, url: String, favicon: android.graphics.Bitmap?) {
            super.onPageStarted(v, url, favicon)
            if (url != "about:blank") route(url)
          }
        }
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
      }

      override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage): Boolean {
        Log.d(
          "dsh-web",
          "${consoleMessage.messageLevel()}: ${consoleMessage.message()} " +
            "(${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})",
        )
        return true
      }
    }
    webView.addJavascriptInterface(
      AndroidBridge(
        expectedCapability = bridgeCapability,
        onPickRequest = { callbackId -> runOnUiThread { pickDirectoryWithPermissionCheck(callbackId) } },
        onKeepScreen = { enable -> runOnUiThread { keepScreenOn(enable) } },
        onNotify = { title, text -> runOnUiThread { showTestNotification(title, text) } },
        onHasAllFilesAccess = {
          if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else hasLegacyStoragePermission()
        },
        onAllFilesAccessRequest = { runOnUiThread { requestWorkspaceStorageAccess() } },
        onOpenPluginInstaller = { runOnUiThread { showPluginInstaller() } },
        onOpenPluginManager = { runOnUiThread { showPluginManager() } },
        onOpenConfigEditor = { runOnUiThread { showConfigEditor() } },
        onOpenAppSettings = { runOnUiThread { showAppSettings() } },
        onImportWorkspaceFiles = { runOnUiThread { showWorkspaceImportDialog() } },
        onWorkspacePath = { ShellState.lastWorkspacePath(this) },
        pickToken = pickToken,
      ),
      "androidBridge",
    )
  }

  /** Apply persisted WebView viewport/UA policy before the next navigation. */
  private fun applyInterfaceModeSettings() {
    val native = ShellState.interfaceMode(this) == ShellState.UI_MODE_NATIVE
    webView.settings.apply {
      useWideViewPort = native
      loadWithOverviewMode = native
      userAgentString = if (native) {
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 DSH-Android/0.1"
      } else {
        "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 DSH-Android/0.1"
      }
    }
  }

  /** App-only settings opened from the gear icon in the top navigation bar. */
  private fun showAppSettings() {
    val density = resources.displayMetrics.density
    val wrap = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding((20 * density).toInt(), (8 * density).toInt(), (20 * density).toInt(), 0)
    }
    wrap.addView(TextView(this).apply {
      text = "界面设置"
      textSize = 16f
      setPadding(0, 0, 0, (8 * density).toInt())
    })
    val group = android.widget.RadioGroup(this).apply {
      orientation = android.widget.RadioGroup.VERTICAL
    }
    val mobileId = View.generateViewId()
    val nativeId = View.generateViewId()
    group.addView(android.widget.RadioButton(this).apply {
      id = mobileId
      text = "移动端"
      textSize = 15f
      setPadding(0, (4 * density).toInt(), 0, (4 * density).toInt())
    })
    group.addView(android.widget.RadioButton(this).apply {
      id = nativeId
      text = "原生（DSH 原布局）"
      textSize = 15f
      setPadding(0, (4 * density).toInt(), 0, (4 * density).toInt())
    })
    val current = ShellState.interfaceMode(this)
    group.check(if (current == ShellState.UI_MODE_NATIVE) nativeId else mobileId)
    wrap.addView(group)

    wrap.addView(TextView(this).apply {
      text = "关于"
      textSize = 16f
      setPadding(0, (16 * density).toInt(), 0, (8 * density).toInt())
    })
    wrap.addView(TextView(this).apply {
      text = "版本  V0.1"
      textSize = 14f
      setPadding(0, (4 * density).toInt(), 0, (8 * density).toInt())
    })
    wrap.addView(TextView(this).apply {
      text = "GitHub 仓库\n$GITHUB_REPOSITORY_URL"
      textSize = 15f
      isClickable = true
      isFocusable = true
      contentDescription = "打开 GitHub 仓库"
      setPadding((12 * density).toInt(), (12 * density).toInt(), (12 * density).toInt(), (12 * density).toInt())
      android.util.TypedValue().also { value ->
        if (theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true) && value.resourceId != 0) {
          setBackgroundResource(value.resourceId)
        }
      }
      setOnClickListener { openExternalUrl(GITHUB_REPOSITORY_URL) }
    })

    android.app.AlertDialog.Builder(this)
      .setTitle("应用设置")
      .setIcon(android.R.drawable.ic_menu_preferences)
      .setView(wrap)
      .setNegativeButton("取消", null)
      .setPositiveButton("应用") { _, _ ->
        val selected = if (group.checkedRadioButtonId == nativeId) ShellState.UI_MODE_NATIVE else ShellState.UI_MODE_MOBILE
        if (selected != current) {
          ShellState.setInterfaceMode(this, selected)
          applyInterfaceModeSettings()
          // A navigation creates a clean document, removing the previous mode's
          // injected CSS/DOM before the bridge mounts the selected layout.
          showStartingState("正在应用界面设置…")
          startEngineFlow()
        }
      }
      .show()
  }

  /** Open a trusted external URL outside the privileged DSH WebView. */
  private fun openExternalUrl(url: String) {
    try {
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    } catch (t: Throwable) {
      showSimpleMessage("无法打开链接", url)
    }
  }

  /** Re-authenticate a live Host instead of leaving WebView on its 401/403 error page. */
  private fun recoverWebAuthentication() {
    if (!authRecoveryRunning.compareAndSet(false, true)) return
    Thread {
      var target = engineManager.webStartupUrl()
      var attempts = 0
      while (!target.contains("?token=") && attempts < 20) {
        Thread.sleep(100)
        target = engineManager.webStartupUrl()
        attempts++
      }
      runOnUiThread {
        if (!target.contains("?token=")) {
          authRecoveryRunning.set(false)
          showStartingState("正在重新建立 DSH 会话…")
          startEngineFlow()
        } else {
          CookieManager.getInstance().setAcceptCookie(true)
          webView.stopLoading()
          webView.loadUrl(target)
        }
      }
    }.start()
  }

  /**
   * Desktop-parity DOM shim. The product UI is still entirely upstream DSH;
   * this only replaces shell actions that Electron normally owns and forces a
   * desktop-class viewport so layout/interaction match the PC Web app.
   */
  private fun installMobileUiBridge(view: WebView) {
    val uiMode = ShellState.interfaceMode(this)
    val capability = bridgeCapability
    val script = """
      (() => {
        if (window.__dshAndroidMobileMounted) return;
        window.__dshAndroidMobileMounted = true;

        const ROOT = document.documentElement;
        const UI_MODE = ${jsString(uiMode)};
        const BRIDGE_CAP = ${jsString(capability)};
        const MANAGER_ID = 'dsh-android-plugin-manager';
        const COMPOSER_IMPORT_CLASS = 'dsh-android-composer-import';
        const STYLE_ID = 'dsh-android-mobile-style';
        const BAR_ID = 'dsh-android-mobile-bar';
        const SCRIM_ID = 'dsh-android-mobile-scrim';

        ROOT.setAttribute('data-dsh-android', UI_MODE);

        const ensureViewport = () => {
          let meta = document.querySelector('meta[name="viewport"]');
          if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'viewport';
            if (document.head) document.head.appendChild(meta);
          }
          if (meta) {
            meta.content = UI_MODE === 'mobile'
              ? 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
              : 'width=1280, initial-scale=0.32, minimum-scale=0.2, maximum-scale=3, user-scalable=yes, viewport-fit=cover';
          }
        };

        const installStyles = () => {
          if (document.getElementById(STYLE_ID)) return;
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = `
            :root[data-dsh-android] {
              --dsh-mobile-bar: 52px;
            }

            :root[data-dsh-android="native"] body {
              margin: 0 !important;
              padding-top: var(--dsh-mobile-bar) !important;
              box-sizing: border-box !important;
              min-height: 100dvh !important;
            }

            :root[data-dsh-android="native"] body > #root,
            :root[data-dsh-android="native"] body > [id="root"] {
              min-height: calc(100dvh - var(--dsh-mobile-bar)) !important;
              height: calc(100dvh - var(--dsh-mobile-bar)) !important;
            }

            :root[data-dsh-android="native"] #dsh-android-mobile-scrim {
              display: none !important;
            }

            :root[data-dsh-android="mobile"] {
              --dsh-mobile-bar: 52px;
              --dsh-mobile-gutter: 12px;
              --dsh-mobile-sheet-radius: 18px;
              --dsh-mobile-ease: cubic-bezier(0.32, 0.72, 0, 1);
            }

            :root[data-dsh-android="mobile"],
            :root[data-dsh-android="mobile"] body {
              width: 100%;
              min-width: 0 !important;
              max-width: 100%;
              min-height: 100%;
              overflow: hidden;
              overscroll-behavior: none;
              -webkit-text-size-adjust: 100%;
            }

            :root[data-dsh-android="mobile"] body {
              margin: 0;
              touch-action: manipulation;
            }

            :root[data-dsh-android="mobile"] * {
              box-sizing: border-box;
              scrollbar-width: thin;
            }

            :root[data-dsh-android="mobile"] input,
            :root[data-dsh-android="mobile"] textarea,
            :root[data-dsh-android="mobile"] select {
              font-size: 16px !important;
            }

            #dsh-android-mobile-bar {
              position: fixed;
              inset: 0 0 auto 0;
              z-index: 1200;
              height: var(--dsh-mobile-bar);
              padding: 6px max(8px, env(safe-area-inset-right)) 6px max(8px, env(safe-area-inset-left));
              display: grid;
              grid-template-columns: 44px minmax(0, 1fr) auto;
              align-items: center;
              gap: 4px;
              background: var(--dsw-alias-bg-base, #fff);
              border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.08));
              color: var(--dsw-alias-text-primary, currentColor);
            }

            #dsh-android-mobile-bar .dsh-mobile-title {
              min-width: 0;
              padding-left: 4px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              font-size: 15px;
              font-weight: 600;
              letter-spacing: -.01em;
            }

            #dsh-android-mobile-bar .dsh-mobile-actions {
              display: flex;
              align-items: center;
              gap: 2px;
            }

            #dsh-android-mobile-bar button {
              width: 40px;
              height: 40px;
              min-width: 40px;
              min-height: 40px;
              padding: 0;
              display: grid;
              place-items: center;
              border: 0;
              border-radius: 10px;
              background: transparent;
              color: inherit;
              -webkit-tap-highlight-color: transparent;
            }

            #dsh-android-mobile-bar button:active {
              transform: scale(.97);
              background: color-mix(in srgb, currentColor 8%, transparent);
            }

            #dsh-android-mobile-bar button:focus-visible {
              outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff);
              outline-offset: -2px;
            }

            #dsh-android-mobile-bar svg {
              width: 20px;
              height: 20px;
              fill: none;
              stroke: currentColor;
              stroke-width: 1.8;
              stroke-linecap: round;
              stroke-linejoin: round;
            }

            #dsh-android-mobile-scrim {
              position: fixed;
              inset: var(--dsh-mobile-bar) 0 0 0;
              z-index: 880;
              background: rgba(0, 0, 0, .28);
              opacity: 0;
              pointer-events: none;
              transition: opacity 160ms ease-out;
            }

            :root[data-dsh-mobile-sidebar-open] #dsh-android-mobile-scrim {
              opacity: 1;
              pointer-events: auto;
            }

            [data-dsh-mobile-frame] {
              width: 100vw !important;
              max-width: 100vw !important;
              grid-template-columns: 0 minmax(0, 1fr) 0 !important;
              transition: none !important;
            }

            [data-dsh-mobile-center] {
              width: 100vw !important;
              min-width: 0 !important;
              max-width: 100vw !important;
              padding-top: var(--dsh-mobile-bar);
              overflow: hidden !important;
            }

            [data-dsh-mobile-sidebar] {
              position: fixed !important;
              z-index: 900 !important;
              top: var(--dsh-mobile-bar) !important;
              bottom: 0 !important;
              left: 0 !important;
              width: min(86vw, 344px) !important;
              min-width: 0 !important;
              max-width: 344px !important;
              overflow: hidden !important;
              transform: translate3d(-102%, 0, 0);
              transition: transform 220ms var(--dsh-mobile-ease) !important;
              background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff));
              border-right: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.08)) !important;
              box-shadow: 12px 0 36px rgba(0,0,0,.12);
            }

            :root[data-dsh-mobile-sidebar-open] [data-dsh-mobile-sidebar] {
              transform: translate3d(0, 0, 0);
            }

            [data-dsh-mobile-sidebar] > * {
              width: 100% !important;
              min-width: 0 !important;
              max-width: 100% !important;
              height: 100% !important;
            }

            [data-dsh-mobile-frame] > [data-side] {
              display: none !important;
            }

            [data-rightbar-col] {
              position: fixed !important;
              z-index: 820 !important;
              left: 0 !important;
              right: 0 !important;
              bottom: 0 !important;
              top: auto !important;
              width: 100vw !important;
              max-width: 100vw !important;
              min-width: 0 !important;
              max-height: 72svh !important;
            }

            [data-rightbar-col] > * {
              width: 100vw !important;
              max-width: 100vw !important;
              max-height: 72svh !important;
              border-radius: var(--dsh-mobile-sheet-radius) var(--dsh-mobile-sheet-radius) 0 0 !important;
              overflow: auto !important;
            }

            [data-conversation-content] {
              width: 100% !important;
              min-width: 0 !important;
              max-width: 100% !important;
            }

            [data-conversation-scroll] {
              width: 100% !important;
              min-width: 0 !important;
              padding-left: var(--dsh-mobile-gutter) !important;
              padding-right: var(--dsh-mobile-gutter) !important;
              scroll-padding-bottom: calc(96px + env(safe-area-inset-bottom));
              overscroll-behavior-y: contain;
            }

            [data-composer-seat] {
              width: 100% !important;
              min-width: 0 !important;
              padding: 8px 4px max(8px, env(safe-area-inset-bottom)) !important;
            }

            [data-composer-seat] > * {
              width: 100% !important;
              max-width: 760px !important;
              margin-inline: auto !important;
            }

            [data-composer-card] .dsh-android-composer-import {
              flex: none !important;
              width: 32px !important;
              height: 32px !important;
              min-width: 32px !important;
              min-height: 32px !important;
              padding: 0 !important;
              display: inline-grid !important;
              place-items: center !important;
              border-radius: 9px !important;
              -webkit-tap-highlight-color: transparent;
            }

            [data-composer-card] .dsh-android-composer-import:active {
              transform: scale(.97);
            }

            [data-composer-card] .dsh-android-composer-import svg {
              width: 16px;
              height: 16px;
              fill: none;
              stroke: currentColor;
              stroke-width: 1.7;
              stroke-linecap: round;
              stroke-linejoin: round;
            }

            [role="menu"],
            [role="listbox"] {
              max-width: calc(100vw - 16px) !important;
              max-height: min(68svh, 560px) !important;
              overflow: auto !important;
            }

            [role="dialog"][aria-modal="true"],
            [aria-modal="true"][role="dialog"] {
              width: calc(100vw - 16px) !important;
              max-width: calc(100vw - 16px) !important;
              max-height: calc(100svh - 24px) !important;
              margin: 0 !important;
              border-radius: 16px !important;
              overflow: auto !important;
            }

            [data-dsh-mobile-settings-overlay] {
              z-index: 1100 !important;
              align-items: stretch !important;
              justify-content: stretch !important;
              padding-top: var(--dsh-mobile-bar) !important;
            }

            [data-dsh-mobile-settings-dialog] {
              position: relative !important;
              inset: auto !important;
              display: flex !important;
              flex-direction: column !important;
              width: 100vw !important;
              height: calc(100dvh - var(--dsh-mobile-bar)) !important;
              max-width: none !important;
              max-height: none !important;
              margin: 0 !important;
              border-radius: 16px 16px 0 0 !important;
              overflow: hidden !important;
              min-width: 0 !important;
            }

            [data-dsh-mobile-settings-nav] {
              flex: 0 0 auto !important;
              display: block !important;
              width: 100% !important;
              min-width: 0 !important;
              max-width: 100% !important;
              padding: 12px 12px 8px !important;
              box-sizing: border-box !important;
              overflow: hidden !important;
            }

            [data-dsh-mobile-settings-nav-title] {
              display: block !important;
              padding: 0 4px 8px !important;
              font-size: 16px !important;
              line-height: 24px !important;
              font-weight: 600 !important;
            }

            [data-dsh-mobile-settings-nav-list] {
              display: flex !important;
              flex-direction: row !important;
              align-items: center !important;
              gap: 4px !important;
              width: 100% !important;
              min-width: 0 !important;
              max-width: 100% !important;
              overflow-x: auto !important;
              overflow-y: hidden !important;
              padding: 0 0 2px !important;
              scroll-snap-type: x proximity;
              scrollbar-width: none;
              -webkit-overflow-scrolling: touch;
            }

            [data-dsh-mobile-settings-nav-list]::-webkit-scrollbar {
              display: none;
            }

            [data-dsh-mobile-settings-nav-list] button {
              flex: 0 0 auto !important;
              width: auto !important;
              min-width: max-content !important;
              height: 40px !important;
              min-height: 40px !important;
              padding-inline: 12px !important;
              scroll-snap-align: start;
            }

            [data-dsh-mobile-settings-content] {
              flex: 1 1 auto !important;
              width: 100% !important;
              min-width: 0 !important;
              min-height: 0 !important;
              max-width: 100% !important;
              display: flex !important;
              flex-direction: column !important;
              overflow: hidden !important;
            }

            [data-dsh-mobile-settings-header] {
              flex: 0 0 auto !important;
              width: 100% !important;
              min-width: 0 !important;
              min-height: 44px !important;
              height: auto !important;
              padding: 6px 10px 6px 12px !important;
              box-sizing: border-box !important;
              align-items: center !important;
              gap: 6px !important;
            }

            [data-dsh-mobile-settings-header] > * {
              min-width: 0 !important;
            }

            [data-dsh-mobile-settings-options] {
              flex: 1 1 auto !important;
              width: 100% !important;
              min-width: 0 !important;
              min-height: 0 !important;
              max-width: 100% !important;
              padding: 8px 14px calc(22px + env(safe-area-inset-bottom)) !important;
              overflow: auto !important;
              overscroll-behavior: contain;
              -webkit-overflow-scrolling: touch;
            }

            [data-dsh-mobile-settings-options] > * {
              min-width: 0 !important;
              max-width: 100% !important;
            }

            [data-dsh-mobile-settings-options] img,
            [data-dsh-mobile-settings-options] video,
            [data-dsh-mobile-settings-options] canvas,
            [data-dsh-mobile-settings-options] input,
            [data-dsh-mobile-settings-options] textarea,
            [data-dsh-mobile-settings-options] select {
              max-width: 100% !important;
            }

            [data-dsh-mobile-settings-options] pre,
            [data-dsh-mobile-settings-options] table {
              max-width: 100% !important;
              overflow-x: auto !important;
            }

            @media (max-width: 560px) {
              :root[data-dsh-android="mobile"] {
                --dsh-mobile-gutter: 10px;
              }

              [data-conversation-scroll] {
                padding-left: 10px !important;
                padding-right: 10px !important;
              }

              [role="dialog"][aria-modal="true"],
              [aria-modal="true"][role="dialog"] {
                width: calc(100vw - 12px) !important;
                max-width: calc(100vw - 12px) !important;
                max-height: calc(100svh - 12px) !important;
              }

              [data-dsh-mobile-settings-dialog] {
                border-radius: 12px 12px 0 0 !important;
              }

              [data-dsh-mobile-settings-nav] {
                padding: 10px 10px 6px !important;
              }

              [data-dsh-mobile-settings-options] {
                padding: 6px 12px calc(20px + env(safe-area-inset-bottom)) !important;
              }
            }

            @media (orientation: landscape) and (max-height: 560px) {
              :root[data-dsh-android="mobile"] { --dsh-mobile-bar: 46px; }
              #dsh-android-mobile-bar { height: 46px; padding-block: 3px; }
              #dsh-android-mobile-bar button { width: 38px; height: 38px; min-width: 38px; min-height: 38px; }
              [data-rightbar-col], [data-rightbar-col] > * { max-height: 82svh !important; }
            }

            @media (min-width: 900px) {
              :root[data-dsh-android="mobile"] { --dsh-mobile-bar: 48px; }
              [data-dsh-mobile-sidebar] { width: min(42vw, 360px) !important; }
              [data-conversation-scroll] { padding-inline: 20px !important; }
            }

            @media (prefers-reduced-motion: reduce) {
              [data-dsh-mobile-sidebar], #dsh-android-mobile-scrim { transition: none !important; }
            }
          `;
          if (document.head) document.head.appendChild(style);
        };

        const icon = (name) => {
          if (name === 'menu') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
          if (name === 'new') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
          return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 18h14"/></svg>';
        };

        // Reuse the settings icon rendered by DSH's own UI component library.
        // This keeps the Android chrome visually aligned with whichever icon
        // package/version upstream DSH ships instead of embedding a copied path.
        const upstreamSettingsIcon = () => {
          const node = document.querySelector(
            'button:not(#dsh-mobile-app-settings)[aria-label*="设置"] svg,' +
            'button:not(#dsh-mobile-app-settings)[aria-label*="setting" i] svg,' +
            '[data-settings-trigger] svg'
          );
          return node ? node.outerHTML : '<span aria-hidden="true" style="font-size:20px;line-height:1">⚙</span>';
        };

        const makeButton = (id, label, iconName) => {
          const button = document.createElement('button');
          button.id = id;
          button.type = 'button';
          button.setAttribute('aria-label', label);
          if (iconName) button.innerHTML = icon(iconName);
          return button;
        };

        const findButton = (tests) => Array.from(document.querySelectorAll('button')).find((el) => {
          const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim().toLowerCase();
          return tests.some((value) => label.includes(value));
        });

        const findSidebarToggle = () => findButton(['打开侧边栏', '收起侧边栏', 'open sidebar', 'collapse sidebar']);
        const findNewSession = () => findButton(['新建会话', 'new session']);

        const directChildUnder = (node, ancestor) => {
          let current = node;
          while (current && current.parentElement && current.parentElement !== ancestor) current = current.parentElement;
          return current && current.parentElement === ancestor ? current : null;
        };

        const resolveFrame = () => {
          const right = document.querySelector('[data-rightbar-col]');
          const frame = right && right.parentElement;
          if (!frame) return null;
          frame.setAttribute('data-dsh-mobile-frame', '');
          const toggle = findSidebarToggle();
          const sidebar = toggle ? directChildUnder(toggle, frame) : null;
          if (sidebar) sidebar.setAttribute('data-dsh-mobile-sidebar', '');
          const candidates = Array.from(frame.children).filter((el) =>
            el !== sidebar && el !== right && !el.hasAttribute('data-shell-overlay') && !el.hasAttribute('data-side'));
          const center = candidates.find((el) => el.querySelector('[data-conversation-content]')) || candidates[0];
          if (center) center.setAttribute('data-dsh-mobile-center', '');
          return { frame, sidebar, center, right };
        };

        const closeSidebar = () => ROOT.removeAttribute('data-dsh-mobile-sidebar-open');
        const openSidebar = () => {
          const parts = resolveFrame();
          if (!parts || !parts.sidebar) return;
          if (parts.frame.hasAttribute('data-sidebar-collapsed')) {
            try { findSidebarToggle()?.click(); } catch (_) {}
          }
          ROOT.setAttribute('data-dsh-mobile-sidebar-open', '');
        };
        const toggleMobileSidebar = () => {
          if (ROOT.hasAttribute('data-dsh-mobile-sidebar-open')) closeSidebar();
          else openSidebar();
        };

        const installMobileChrome = () => {
          if (!document.body) return;
          let bar = document.getElementById(BAR_ID);
          if (!bar) {
            bar = document.createElement('div');
            bar.id = BAR_ID;
            const menu = makeButton('dsh-mobile-menu', '菜单', 'menu');
            const title = document.createElement('div');
            title.className = 'dsh-mobile-title';
            title.textContent = 'DeepSeek Harness';
            const actions = document.createElement('div');
            actions.className = 'dsh-mobile-actions';
            const add = makeButton('dsh-mobile-new', '新建会话', 'new');
            const appSettings = makeButton('dsh-mobile-app-settings', '应用设置', null);
            appSettings.innerHTML = upstreamSettingsIcon();
            menu.addEventListener('click', () => {
              if (UI_MODE === 'mobile') toggleMobileSidebar();
              else { try { findSidebarToggle()?.click(); } catch (_) {} }
            });
            add.addEventListener('click', () => {
              const target = findNewSession();
              if (target) target.click();
            });
            appSettings.addEventListener('click', () => {
              try { window.androidBridge && window.androidBridge.openAppSettings(BRIDGE_CAP); } catch (_) {}
            });
            actions.append(add, appSettings);
            bar.append(menu, title, actions);
            document.body.appendChild(bar);
          }
          let scrim = document.getElementById(SCRIM_ID);
          if (!scrim) {
            scrim = document.createElement('div');
            scrim.id = SCRIM_ID;
            scrim.addEventListener('click', closeSidebar);
            document.body.appendChild(scrim);
          }
        };

        const findConfigButton = () => {
          for (const dialog of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
            const match = Array.from(dialog.querySelectorAll('button')).find((el) => {
              const text = (el.textContent || '').trim();
              return text === '打开配置文件' || /open config/i.test(text);
            });
            if (match) return match;
          }
          return null;
        };

        const pluginSurfaceVisible = (anchor) => {
          if (!anchor) return false;
          const scope = anchor.closest('[role="dialog"], [aria-modal="true"]') || anchor.parentElement;
          if (!scope) return false;
          const active = Array.from(scope.querySelectorAll('button[aria-current], button[aria-selected="true"], button[data-state="active"]'))
            .some((el) => /^(插件|plugins?)\b/i.test((el.textContent || '').trim()));
          if (active) return true;
          return !!scope.querySelector('input[type="search"], input[placeholder*="搜索"], input[placeholder*="Search" i]');
        };

        const wireConfig = () => {
          const original = findConfigButton();
          if (!original || original.dataset.dshAndroidNative === '1') return original;
          const replacement = original.cloneNode(true);
          replacement.dataset.dshAndroidNative = '1';
          replacement.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            try { window.androidBridge && window.androidBridge.openConfigEditor(BRIDGE_CAP); } catch (_) {}
          }, true);
          original.replaceWith(replacement);
          return replacement;
        };

        const wireComposerImport = () => {
          const cards = Array.from(document.querySelectorAll('[data-composer-card]'));
          for (const card of cards) {
            const fileInput = card.querySelector('input[type="file"][multiple]');
            const tools = fileInput && fileInput.parentElement;
            if (!tools) continue;
            if (tools.querySelector('.' + COMPOSER_IMPORT_CLASS)) continue;

            const command = Array.from(tools.children).find((el) =>
              el instanceof HTMLButtonElement && el.getAttribute('aria-haspopup') === 'listbox');
            const button = command
              ? command.cloneNode(false)
              : document.createElement('button');
            button.type = 'button';
            button.classList.add(COMPOSER_IMPORT_CLASS);
            button.removeAttribute('aria-haspopup');
            button.removeAttribute('aria-expanded');
            button.removeAttribute('disabled');
            button.setAttribute('aria-label', '从手机导入文件到工作区');
            button.setAttribute('title', '上传手机文件到工作区');
            button.innerHTML = icon('import');
            button.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              try { window.androidBridge && window.androidBridge.importFilesToWorkspace(BRIDGE_CAP); } catch (_) {}
            }, true);

            if (fileInput.nextSibling) tools.insertBefore(button, fileInput.nextSibling);
            else tools.appendChild(button);
          }
        };

        const commonAncestor = (nodes, stop) => {
          if (!nodes.length) return null;
          let current = nodes[0].parentElement;
          while (current && current !== stop) {
            if (nodes.every((node) => current.contains(node))) return current;
            current = current.parentElement;
          }
          return null;
        };

        const tagSettings = () => {
          let modal = null;
          let nav = null;
          let navButtons = [];
          for (const candidate of document.querySelectorAll('[role="dialog"][aria-modal="true"], [aria-modal="true"][role="dialog"]')) {
            const candidateNav = candidate.querySelector('nav');
            if (!candidateNav) continue;
            const buttons = Array.from(candidateNav.querySelectorAll('button')).filter((button) => {
              const value = ((button.textContent || '') + ' ' + (button.getAttribute('aria-label') || '')).trim();
              return ['通用设置', '模型', '插件', 'Agent 预设', '已归档会话',
                'General', 'Models', 'Plugins', 'Agent presets', 'Archived sessions'].some((name) =>
                  value === name || value.startsWith(name + ' '));
            });
            if (buttons.length >= 2) { modal = candidate; nav = candidateNav; navButtons = buttons; break; }
          }
          if (!modal || !nav || navButtons.length < 2) return;

          modal.setAttribute('data-dsh-mobile-settings-dialog', '');
          if (modal.parentElement) modal.parentElement.setAttribute('data-dsh-mobile-settings-overlay', '');
          nav.setAttribute('data-dsh-mobile-settings-nav', '');

          const navTitle = nav.firstElementChild;
          if (navTitle) navTitle.setAttribute('data-dsh-mobile-settings-nav-title', '');

          const navList = commonAncestor(navButtons, nav);
          if (navList) navList.setAttribute('data-dsh-mobile-settings-nav-list', '');

          const content = Array.from(modal.children).find((child) => child !== nav);
          if (!content) return;
          content.setAttribute('data-dsh-mobile-settings-content', '');

          const header = content.firstElementChild;
          const options = content.lastElementChild;
          if (header) header.setAttribute('data-dsh-mobile-settings-header', '');
          if (options && options !== header) options.setAttribute('data-dsh-mobile-settings-options', '');
        };

        const sync = () => {
          ensureViewport();
          installStyles();
          installMobileChrome();
          if (UI_MODE === 'mobile') {
            resolveFrame();
            tagSettings();
          } else {
            ROOT.removeAttribute('data-dsh-mobile-sidebar-open');
          }
          wireComposerImport();
          const anchor = wireConfig();
          let manager = document.getElementById(MANAGER_ID);
          if (!pluginSurfaceVisible(anchor)) {
            if (manager) manager.remove();
            return;
          }
          if (manager || !anchor || !anchor.parentElement) return;
          manager = anchor.cloneNode(false);
          manager.id = MANAGER_ID;
          manager.type = 'button';
          const zh = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh');
          manager.textContent = zh ? '管理插件' : 'Manage plugins';
          manager.setAttribute('aria-label', manager.textContent);
          manager.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            try { window.androidBridge && window.androidBridge.openPluginManager(BRIDGE_CAP); } catch (_) {}
          }, true);
          anchor.parentElement.insertBefore(manager, anchor);
        };

        let pending = false;
        const schedule = () => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => { pending = false; sync(); });
        };
        const relevantSelector = [
          '[role="dialog"]', '[aria-modal="true"]', '[data-composer-card]',
          'nav', 'button[aria-current]', 'button[aria-selected]',
          '[data-sidebar-collapsed]', '[data-state="active"]'
        ].join(',');
        const mutationRelevant = (mutation) => {
          const target = mutation.target instanceof Element ? mutation.target : null;
          if (mutation.type === 'attributes') {
            return !!target && (target.matches(relevantSelector) || !!target.closest('[role="dialog"], nav, [data-composer-card]'));
          }
          const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
          return nodes.some((node) => {
            if (!(node instanceof Element)) return false;
            return node.matches(relevantSelector) || !!node.querySelector(relevantSelector);
          });
        };
        const observer = new MutationObserver((mutations) => {
          if (mutations.some(mutationRelevant)) schedule();
        });
        observer.observe(document.body || document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['aria-current', 'aria-selected', 'data-sidebar-collapsed', 'data-state']
        });
        // No polling and no message-body text scans. Streaming conversation DOM
        // changes that do not touch app-shell/settings/composer structures are
        // ignored, avoiding a sync/layout pass on every generated token.
        document.addEventListener('click', schedule, true);
        window.addEventListener('resize', schedule, { passive: true });
        window.addEventListener('popstate', schedule, { passive: true });
        window.addEventListener('hashchange', schedule, { passive: true });
        sync();
      })();
    """.trimIndent()
    try { view.evaluateJavascript(script, null) } catch (_: Throwable) {}
  }

  /**
   * Phone file import. This is intentionally a filesystem copy, not a chat
   * attachment upload: the selected files become normal files under the
   * workspace root and are therefore available to shell/tools immediately.
   */
  private fun showWorkspaceImportDialog() {
    val remembered = ShellState.lastWorkspacePath(this)
    if (remembered.isNullOrBlank()) {
      android.app.AlertDialog.Builder(this)
        .setTitle("导入手机文件")
        .setMessage("还没有可用的工作区路径。先选择目标工作区目录，再选择要导入的手机文件。")
        .setNegativeButton("取消", null)
        .setPositiveButton("选择工作区目录") { _, _ -> workspaceImportTargetPicker.launch(null) }
        .show()
      return
    }
    android.app.AlertDialog.Builder(this)
      .setTitle("导入手机文件")
      .setMessage("目标工作区：\n$remembered\n\n支持一次选择多个文件；同名文件会自动生成不冲突的新文件名，不会覆盖原文件。")
      .setNegativeButton("取消", null)
      .setNeutralButton("更换目录") { _, _ -> workspaceImportTargetPicker.launch(null) }
      .setPositiveButton("选择文件") { _, _ ->
        pendingWorkspaceImportPath = remembered
        workspaceFilePicker.launch(arrayOf("*/*"))
      }
      .show()
  }

  /** Handle Android share-sheet SEND/SEND_MULTIPLE as workspace imports. */
  private fun handleIncomingShare(source: Intent?) {
    val action = source?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    @Suppress("DEPRECATION")
    val extraUris: List<Uri> = when (action) {
      Intent.ACTION_SEND -> listOfNotNull(source.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
      Intent.ACTION_SEND_MULTIPLE -> source.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.toList().orEmpty()
      else -> emptyList()
    }
    val clipUris = buildList {
      val clip = source.clipData
      if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(::add)
    }
    val uris = (extraUris + clipUris).distinctBy { it.toString() }
    // Prevent recreation from replaying the same external share.
    source.action = null
    if (uris.isEmpty()) return
    val workspace = ShellState.lastWorkspacePath(this)
    if (workspace.isNullOrBlank()) {
      pendingSharedImportUris = uris
      android.app.AlertDialog.Builder(this)
        .setTitle("导入到 DSH 工作区")
        .setMessage("尚未记录工作区目录。请选择目标目录后导入这 ${uris.size} 个文件。")
        .setNegativeButton("取消") { _, _ -> pendingSharedImportUris = null }
        .setPositiveButton("选择目录") { _, _ -> workspaceImportTargetPicker.launch(null) }
        .show()
      return
    }
    android.app.AlertDialog.Builder(this)
      .setTitle("导入到 DSH 工作区")
      .setMessage("将 ${uris.size} 个文件复制到：\n$workspace")
      .setNegativeButton("取消", null)
      .setNeutralButton("更换目录") { _, _ -> chooseShareImportTarget(uris) }
      .setPositiveButton("导入") { _, _ -> importFilesIntoWorkspace(workspace, uris) }
      .show()
  }

  /** Destination override for a share intent without losing the selected URIs. */
  private fun chooseShareImportTarget(uris: List<Uri>) {
    pendingSharedImportUris = uris
    workspaceImportTargetPicker.launch(null)
  }

  private fun importFilesIntoWorkspace(workspacePath: String, uris: List<Uri>) {
    Thread {
      val imported = mutableListOf<String>()
      val failures = mutableListOf<String>()
      var canonicalRoot: java.io.File? = null
      try {
        val root = java.io.File(workspacePath).canonicalFile
        canonicalRoot = root
        if (!root.exists() || !root.isDirectory) throw java.io.IOException("工作区目录不存在：${root.absolutePath}")
        if (!root.canWrite()) throw java.io.IOException("工作区不可写，请检查‘所有文件访问权限’：${root.absolutePath}")
        ShellState.rememberWorkspacePath(this, root.absolutePath)

        for (uri in uris.distinctBy { it.toString() }) {
          try {
            val rawName = queryDisplayName(uri) ?: "import-${System.currentTimeMillis()}"
            val cleanName = sanitizeFilename(rawName)
            val temp = java.io.File(root, ".dsh-import-${java.util.UUID.randomUUID()}.tmp")
            try {
              contentResolver.openInputStream(uri)?.use { input ->
                temp.outputStream().buffered(128 * 1024).use { output ->
                  copyWithLimit(input, output, MAX_WORKSPACE_IMPORT_BYTES, "单个文件超过 2 GB 上限")
                }
              } ?: throw java.io.IOException("无法读取文件")
              val target = publishWorkspaceImport(temp, root, cleanName)
              imported += target.name
            } catch (t: Throwable) {
              temp.delete()
              throw t
            }
          } catch (t: Throwable) {
            val label = queryDisplayName(uri) ?: uri.lastPathSegment ?: "未知文件"
            failures += "$label：${t.message ?: t.javaClass.simpleName}"
          }
        }
      } catch (t: Throwable) {
        failures += (t.message ?: t.javaClass.simpleName)
      }

      runOnUiThread {
        if (imported.isNotEmpty()) {
          notifyWorkspaceFilesImported(canonicalRoot?.absolutePath ?: workspacePath, imported)
        }
        val summary = buildString {
          if (imported.isNotEmpty()) {
            append("已导入 ${imported.size} 个文件到：\n")
            append(canonicalRoot?.absolutePath ?: workspacePath)
            append("\n\n")
            append(imported.take(12).joinToString("\n"))
            if (imported.size > 12) append("\n…以及另外 ${imported.size - 12} 个文件")
          }
          if (failures.isNotEmpty()) {
            if (isNotEmpty()) append("\n\n")
            append("失败 ${failures.size} 个：\n")
            append(failures.take(8).joinToString("\n"))
            if (failures.size > 8) append("\n…")
          }
        }.ifBlank { "没有导入任何文件。" }
        showSimpleMessage(if (failures.isEmpty()) "导入完成" else "导入完成（部分失败）", summary)
      }
    }.start()
  }

  /**
   * Publish an imported temp file with no-overwrite semantics. A hard-link is
   * the ideal same-filesystem atomic publish. Android shared-storage FUSE may
   * reject hard links, so the fallback first reserves the final name with
   * createNewFile() before copying; an existing/concurrent file is never
   * replaced implicitly.
   */
  private fun publishWorkspaceImport(temp: java.io.File, root: java.io.File, requestedName: String): java.io.File {
    val clean = sanitizeFilename(requestedName)
    val dot = clean.lastIndexOf('.')
    val hasExt = dot > 0 && dot < clean.length - 1
    val stem = if (hasExt) clean.substring(0, dot) else clean
    val ext = if (hasExt) clean.substring(dot) else ""
    for (index in 0..9999) {
      val name = if (index == 0) clean else "$stem ($index)$ext"
      val candidate = java.io.File(root, name)
      try {
        java.nio.file.Files.createLink(candidate.toPath(), temp.toPath())
        if (!temp.delete()) {
          try { java.nio.file.Files.deleteIfExists(temp.toPath()) } catch (_: Throwable) {}
        }
        return candidate
      } catch (_: java.nio.file.FileAlreadyExistsException) {
        continue
      } catch (_: Throwable) {
        // Emulated/shared storage commonly rejects hard links. Reserve the name
        // atomically, then fill only the file we just created.
        if (!candidate.createNewFile()) continue
        try {
          temp.inputStream().buffered(128 * 1024).use { input ->
            candidate.outputStream().buffered(128 * 1024).use { output -> input.copyTo(output, 128 * 1024) }
          }
          if (!temp.delete()) {
            try { java.nio.file.Files.deleteIfExists(temp.toPath()) } catch (_: Throwable) {}
          }
          return candidate
        } catch (copyError: Throwable) {
          candidate.delete()
          throw copyError
        }
      }
    }
    throw java.io.IOException("同名文件过多：$clean")
  }

  private fun notifyWorkspaceFilesImported(workspace: String, files: List<String>) {
    showTestNotification("文件已导入工作区", "${files.size} 个文件 · ${java.io.File(workspace).name}")
    val detail = org.json.JSONObject().apply {
      put("workspace", workspace)
      put("files", org.json.JSONArray(files))
    }.toString()
    try {
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('dsh-android-files-imported',{detail:$detail}));" +
          "window.dispatchEvent(new Event('focus'));",
        null,
      )
    } catch (_: Throwable) {}
  }

  /**
   * DSH/pnpm accepts tarballs and directories but does not treat a generic ZIP
   * as a package tarball. Extract phone-picked ZIP plugins into app-private
   * storage and install the shallowest directory that owns package.json.
   */
  private fun prepareImportedPluginPackage(file: java.io.File): String {
    if (!file.name.endsWith(".zip", ignoreCase = true)) return file.absolutePath
    val base = file.name.substringBeforeLast('.', file.name)
    val outDir = java.io.File(file.parentFile, "$base-unpacked-${System.currentTimeMillis()}")
    if (outDir.exists()) outDir.deleteRecursively()
    outDir.mkdirs()
    val rootPath = outDir.canonicalPath
    val rootPrefix = rootPath + java.io.File.separator
    var extractedBytes = 0L
    var entries = 0
    val buffer = ByteArray(64 * 1024)
    try {
      java.util.zip.ZipInputStream(file.inputStream().buffered()).use { zip ->
        var entry = zip.nextEntry
        while (entry != null) {
          entries++
          if (entries > MAX_PLUGIN_ZIP_ENTRIES) throw java.io.IOException("插件 ZIP 文件项超过 $MAX_PLUGIN_ZIP_ENTRIES 个")
          val normalized = entry.name.replace('\\', '/').trimStart('/')
          val segments = normalized.split('/').filter { it.isNotEmpty() }
          if (normalized.isBlank() || segments.any { it == ".." || it == "." } || segments.size > MAX_PLUGIN_ZIP_DEPTH) {
            throw java.io.IOException("ZIP 包含不安全或过深路径：${entry.name}")
          }
          val output = java.io.File(outDir, normalized)
          val canonical = output.canonicalPath
          if (canonical != rootPath && !canonical.startsWith(rootPrefix)) {
            throw java.io.IOException("ZIP 路径越界：${entry.name}")
          }
          if (entry.isDirectory) {
            if (!output.exists() && !output.mkdirs()) throw java.io.IOException("无法创建 ZIP 目录：${entry.name}")
          } else {
            output.parentFile?.let { parent ->
              if (!parent.exists() && !parent.mkdirs()) throw java.io.IOException("无法创建 ZIP 父目录：${entry.name}")
            }
            var entryBytes = 0L
            output.outputStream().use { sink ->
              while (true) {
                val count = zip.read(buffer)
                if (count <= 0) break
                entryBytes += count
                extractedBytes += count
                if (entryBytes > MAX_PLUGIN_ZIP_ENTRY_BYTES) throw java.io.IOException("ZIP 单文件超过 256 MB：${entry.name}")
                if (extractedBytes > MAX_PLUGIN_ZIP_BYTES) throw java.io.IOException("插件 ZIP 解压后超过 512 MB")
                sink.write(buffer, 0, count)
              }
            }
          }
          zip.closeEntry()
          entry = zip.nextEntry
        }
      }
    } catch (t: Throwable) {
      outDir.deleteRecursively()
      throw t
    }
    val manifests = outDir.walkTopDown()
      .filter { it.isFile && it.name == "package.json" }
      .toList()
    if (manifests.isEmpty()) throw java.io.IOException("ZIP 中未找到 package.json，无法作为 DSH 插件安装")

    // GitHub ZIPs can be monorepos. Prefer the shallowest package that actually
    // declares a DSH bundle instead of blindly choosing the repository root.
    val bundleManifests = manifests.filter { candidate ->
      try {
        val json = org.json.JSONObject(candidate.readText())
        json.optJSONObject("dsh")?.optJSONObject("bundle")?.optString("patch", "")?.isNotBlank() == true
      } catch (_: Throwable) { false }
    }
    val candidates = if (bundleManifests.isNotEmpty()) bundleManifests else manifests
    val manifest = candidates.minByOrNull {
      it.relativeTo(outDir).invariantSeparatorsPath.count { ch -> ch == '/' }
    } ?: throw java.io.IOException("无法确定插件 package.json")
    val packageRoot = manifest.parentFile ?: throw java.io.IOException("无法确定插件根目录")

    // ZIP does not reliably preserve Unix executable bits. Restore every path
    // declared by package.json#bin so npm/pnpm lifecycle scripts can invoke
    // CLI helpers exactly as they would from a tarball or git checkout.
    try {
      val json = org.json.JSONObject(manifest.readText())
      val bins = mutableListOf<String>()
      when (val bin = json.opt("bin")) {
        is String -> bins += bin
        is org.json.JSONObject -> {
          val keys = bin.keys()
          while (keys.hasNext()) {
            val value = bin.optString(keys.next(), "").trim()
            if (value.isNotBlank()) bins += value
          }
        }
      }
      val packageCanonical = packageRoot.canonicalPath
      val packagePrefix = packageCanonical + java.io.File.separator
      for (relative in bins.distinct()) {
        val target = java.io.File(packageRoot, relative).canonicalFile
        if ((target.path == packageCanonical || target.path.startsWith(packagePrefix)) && target.isFile) {
          target.setExecutable(true, false)
        }
      }
    } catch (_: Throwable) {
      // package metadata diagnostics are handled by DSH/pnpm after selection.
    }
    return packageRoot.absolutePath
  }

  /** Native package-spec prompt; installation itself runs in the embedded runtime. */
  private fun showPluginInstaller() {
    val density = resources.displayMetrics.density
    val pad = (20 * density).toInt()
    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(pad, (8 * density).toInt(), pad, 0)
    }
    val note = TextView(this).apply {
      text = "输入 npm 包名、GitHub 仓库地址、git+https/SSH spec、tarball URL 或本地路径。GitHub 网页地址会自动转换为 Git spec；本地 ZIP 会安全解压并优先识别其中真正声明 dsh.bundle 的包。\n\nGit 源插件如需 prepare/install，pnpm 11 会要求显式构建授权；授权脚本以 DSH Host 权限运行，只对你信任的来源授权。"
      textSize = 14f
      setPadding(0, 0, 0, (12 * density).toInt())
    }
    val input = android.widget.EditText(this).apply {
      hint = "例如：@linxin666/dsh-web-all"
      setSingleLine(true)
      textSize = 15f
      setSelectAllOnFocus(false)
    }
    container.addView(note)
    container.addView(input, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    ))

    val dialog = android.app.AlertDialog.Builder(this)
      .setTitle("安装 DSH 插件")
      .setView(container)
      .setNegativeButton("取消", null)
      .setPositiveButton("安装", null)
      .create()

    dialog.setOnShowListener {
      dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
        val spec = input.text?.toString()?.trim().orEmpty()
        if (spec.isEmpty()) {
          input.error = "请输入插件地址"
          return@setOnClickListener
        }
        dialog.dismiss()
        installPluginInBackground(spec)
      }
    }
    dialog.show()
    input.requestFocus()
  }

  /** Full Android-side plugin manager for snapshots that do not yet expose the new Web manager. */
  private fun showPluginManager() {
    val density = resources.displayMetrics.density
    val pad = (16 * density).toInt()
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(pad, (8 * density).toInt(), pad, 0)
    }
    val intro = TextView(this).apply {
      text = "与电脑端使用同一个 web profile。支持安装、更新、启用/停用和卸载；操作完成后自动重启本机 DSH。\n" + engineManager.pluginRuntimeSummary()
      textSize = 13f
      setPadding(0, 0, 0, (10 * density).toInt())
    }
    val installActions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    val install = Button(this).apply { text = "安装" }
    val importLocal = Button(this).apply { text = "本地包" }
    val updateAll = Button(this).apply { text = "全部更新" }
    val sshKey = Button(this).apply { text = "导入/替换 SSH 私钥" }
    val sshPassphrase = Button(this).apply {
      text = if (SecureCredentialStore.sshPassphrase(this@MainActivity) == null) "SSH 私钥口令" else "SSH 私钥口令（已配置）"
    }
    val httpsCredential = Button(this).apply {
      text = if (SecureCredentialStore.gitCredential(this@MainActivity) == null) "私有 Git HTTPS 凭据" else "私有 Git HTTPS 凭据（已配置）"
    }
    val pendingBuilds = engineManager.pendingPluginBuilds()
    val buildApproval = Button(this).apply {
      text = if (pendingBuilds.isEmpty()) "构建授权（无待处理）" else "构建授权（${pendingBuilds.size}）"
      isEnabled = pendingBuilds.isNotEmpty()
    }
    installActions.addView(install, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    installActions.addView(importLocal, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    installActions.addView(updateAll, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    val scroll = android.widget.ScrollView(this).apply {
      addView(list, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    root.addView(intro)
    root.addView(installActions)
    root.addView(sshKey, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(sshPassphrase, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(httpsCredential, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(buildApproval, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(scroll, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, (420 * density).toInt(),
    ))
    lateinit var dialog: android.app.AlertDialog

    fun refresh() {
      list.removeAllViews()
      val plugins = engineManager.listPluginBundles()
      if (plugins.isEmpty()) {
        list.addView(TextView(this).apply {
          text = "当前 profile 没有额外依赖。"
          textSize = 14f
          setPadding(0, pad, 0, pad)
        })
        return
      }
      plugins.forEach { info ->
        val card = LinearLayout(this).apply {
          orientation = LinearLayout.VERTICAL
          setPadding(0, (12 * density).toInt(), 0, (12 * density).toInt())
        }
        card.addView(TextView(this).apply {
          text = buildString {
            append(info.name)
            if (info.version.isNotBlank()) append("  ").append(info.version)
            if (info.firstParty) append("  · 官方")
          }
          textSize = 15f
          setTextIsSelectable(true)
        })
        card.addView(TextView(this).apply {
          text = when {
            !info.bundle -> "普通依赖 · 不作为 DSH profile 层启用"
            info.enabled -> "已启用"
            else -> "已安装 · 未启用"
          }
          textSize = 12f
        })
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun actionParams() = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        actions.addView(Button(this).apply {
          text = if (!info.bundle) "普通依赖" else if (info.enabled) "停用" else "启用"
          textSize = 12f
          isEnabled = info.bundle
          setOnClickListener {
            dialog.dismiss()
            runProfileMutation(if (info.enabled) "正在停用插件…" else "正在启用插件…") {
              engineManager.setBundleEnabled(info.name, !info.enabled)
            }
          }
        }, actionParams())
        actions.addView(Button(this).apply {
          text = "更新"
          textSize = 12f
          isEnabled = !info.firstParty
          setOnClickListener {
            dialog.dismiss()
            runProfileMutation("正在更新插件…") { engineManager.updatePlugin(info.name) }
          }
        }, actionParams())
        actions.addView(Button(this).apply {
          text = "卸载"
          textSize = 12f
          isEnabled = !info.firstParty
          setOnClickListener {
            android.app.AlertDialog.Builder(this@MainActivity)
              .setTitle("卸载插件")
              .setMessage("确定卸载 ${info.name}？")
              .setNegativeButton("取消", null)
              .setPositiveButton("卸载") { _, _ ->
                dialog.dismiss()
                runProfileMutation("正在卸载插件…") { engineManager.removePlugin(info.name) }
              }
              .show()
          }
        }, actionParams())
        card.addView(actions)
        list.addView(card)
        list.addView(View(this).apply {
          setBackgroundColor(0x14000000)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
      }
    }

    dialog = android.app.AlertDialog.Builder(this)
      .setTitle("DSH 插件管理")
      .setView(root)
      .setNegativeButton("关闭", null)
      .create()
    install.setOnClickListener {
      dialog.dismiss()
      showPluginInstaller()
    }
    importLocal.setOnClickListener {
      dialog.dismiss()
      pluginPackagePicker.launch(arrayOf(
        "application/gzip", "application/x-gzip", "application/x-tar",
        "application/octet-stream", "application/zip",
      ))
    }
    updateAll.setOnClickListener {
      dialog.dismiss()
      runProfileMutation("正在更新全部第三方插件…") { engineManager.updateAllPlugins() }
    }
    sshKey.setOnClickListener {
      dialog.dismiss()
      sshKeyPicker.launch(arrayOf("application/octet-stream", "text/plain", "*/*"))
    }
    sshPassphrase.setOnClickListener {
      dialog.dismiss()
      showSshPassphraseDialog(afterImport = false)
    }
    httpsCredential.setOnClickListener {
      dialog.dismiss()
      showGitHttpsCredentialDialog()
    }
    buildApproval.setOnClickListener {
      if (pendingBuilds.isEmpty()) return@setOnClickListener
      android.app.AlertDialog.Builder(this)
        .setTitle("授权安装期构建")
        .setMessage(
          "以下依赖被 pnpm 11 阻止执行 prepare/install 脚本：\n\n• " +
            pendingBuilds.joinToString("\n• ") +
            "\n\n授权后这些脚本会以 DSH Host 权限运行。只对你信任的源码授权。",
        )
        .setNegativeButton("取消", null)
        .setPositiveButton("授权") { _, _ ->
          dialog.dismiss()
          runProfileMutation("正在写入构建授权…") { engineManager.approvePluginBuilds(pendingBuilds) }
        }
        .show()
    }
    refresh()
    dialog.show()
  }

  /** Configure an optional passphrase for the imported SSH private key. */
  private fun showSshPassphraseDialog(afterImport: Boolean) {
    val input = android.widget.EditText(this).apply {
      hint = "无口令请留空"
      setSingleLine(true)
      inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
    }
    val builder = android.app.AlertDialog.Builder(this)
      .setTitle(if (afterImport) "SSH 私钥已导入" else "SSH 私钥口令")
      .setMessage(
        if (afterImport) "私钥已保存为应用私有 HOME/.ssh/id_dsh。若密钥有口令，请在下方输入；口令会使用 Android Keystore 加密保存，仅在插件 Git/SSH 操作期间注入。"
        else "输入私钥口令。留空并保存会清除已保存口令；私钥文件本身不会删除。",
      )
      .setView(input)
      .setNegativeButton("取消", null)
      .setPositiveButton("保存", null)
    if (!afterImport) {
      builder.setNeutralButton("清除口令") { _, _ ->
        SecureCredentialStore.clearSshPassphrase(this)
        showSimpleMessage("已清除", "SSH 私钥口令已从 Android Keystore 凭据存储中清除。")
      }
    }
    val dialog = builder.create()
    dialog.setOnShowListener {
      dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
        try {
          SecureCredentialStore.saveSshPassphrase(this, input.text?.toString())
          dialog.dismiss()
          showSimpleMessage(
            "SSH 配置已保存",
            if (input.text.isNullOrEmpty()) "将按无口令私钥使用 HOME/.ssh/id_dsh。" else "私钥口令已加密保存，可用于 Git SSH 插件安装。",
          )
        } catch (t: Throwable) {
          input.error = t.message ?: "无法保存口令"
        }
      }
    }
    dialog.show()
  }

  /** Configure host-scoped HTTPS Git credentials for private plugin repositories. */
  private fun showGitHttpsCredentialDialog() {
    val density = resources.displayMetrics.density
    val current = SecureCredentialStore.gitCredential(this)
    val box = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding((20 * density).toInt(), (6 * density).toInt(), (20 * density).toInt(), 0)
    }
    val host = android.widget.EditText(this).apply {
      hint = "Git 主机，例如 github.com"
      setSingleLine(true)
      setText(current?.host ?: "github.com")
    }
    val username = android.widget.EditText(this).apply {
      hint = "用户名"
      setSingleLine(true)
      setText(current?.username ?: "x-access-token")
    }
    val token = android.widget.EditText(this).apply {
      hint = if (current == null) "Personal access token" else "重新输入 token 以保存/更新"
      setSingleLine(true)
      inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
    }
    box.addView(host)
    box.addView(username)
    box.addView(token)
    val dialog = android.app.AlertDialog.Builder(this)
      .setTitle("私有 Git HTTPS 凭据")
      .setMessage("凭据只会响应所填主机的 Git HTTPS 认证提示，不写入 DSH profile、URL 或日志，并使用 Android Keystore 加密保存。")
      .setView(box)
      .setNegativeButton("取消", null)
      .setNeutralButton("清除凭据") { _, _ ->
        SecureCredentialStore.clearGitCredential(this)
        showSimpleMessage("已清除", "私有 Git HTTPS 凭据已删除。")
      }
      .setPositiveButton("保存", null)
      .create()
    dialog.setOnShowListener {
      dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
        try {
          SecureCredentialStore.saveGitCredential(
            this,
            host.text?.toString().orEmpty(),
            username.text?.toString().orEmpty(),
            token.text?.toString().orEmpty(),
          )
          dialog.dismiss()
          showSimpleMessage("已保存", "私有 Git HTTPS 凭据已加密保存，仅用于插件安装/更新。")
        } catch (t: Throwable) {
          token.error = t.message ?: "无法保存凭据"
        }
      }
    }
    dialog.show()
  }

  /** Built-in editor replacing Electron's "open config file" shell action. */
  private fun showConfigEditor() {
    val current = try { engineManager.readProfilePatch() } catch (t: Throwable) {
      showSimpleMessage("无法读取配置", t.message ?: t.javaClass.simpleName)
      return
    }
    val editor = android.widget.EditText(this).apply {
      setText(current)
      setSelection(text.length)
      textSize = 13f
      typeface = android.graphics.Typeface.MONOSPACE
      minLines = 18
      gravity = android.view.Gravity.TOP or android.view.Gravity.START
      inputType = android.text.InputType.TYPE_CLASS_TEXT or
        android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or
        android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      setHorizontallyScrolling(false)
      setPadding(24, 16, 24, 16)
    }
    val dialog = android.app.AlertDialog.Builder(this)
      .setTitle("web / cordis.patch.yml")
      .setView(editor)
      .setNegativeButton("取消", null)
      .setPositiveButton("保存并应用", null)
      .create()
    dialog.setOnShowListener {
      dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
        val text = editor.text?.toString().orEmpty()
        dialog.dismiss()
        runProfileMutation("正在应用配置…") { engineManager.saveProfilePatch(text) }
      }
    }
    dialog.show()
  }

  private fun installPluginInBackground(spec: String) {
    runProfileMutation(
      "正在安装插件…",
      detail = spec,
      operation = { engineManager.installPlugin(spec) },
      onResult = { result, running -> showPluginInstallResult(spec, result, running) },
    )
  }

  /** pnpm 11 deliberately requires a separate trust decision before running git/plugin build scripts. */
  private fun showPluginInstallResult(spec: String, result: PluginCommandResult, engineRunning: Boolean) {
    if (!result.ok && result.pendingBuilds.isNotEmpty()) {
      val names = result.pendingBuilds.joinToString("\n• ", prefix = "• ")
      val advice = engineManager.pluginCompatibilityAdvice(result).orEmpty()
      val body = buildString {
        if (result.output.isNotBlank()) append(result.output.trim()).append("\n\n")
        if (advice.isNotBlank()) append(advice).append("\n\n")
        append("以下包请求在安装阶段执行代码：\n").append(names)
        append("\n\n这些 prepare/install 脚本以 DSH Host 权限运行，不受 Agent 沙箱保护。只对你信任的插件源码授权。")
      }
      android.app.AlertDialog.Builder(this)
        .setTitle("需要构建授权")
        .setMessage(body)
        .setNegativeButton("暂不授权") { _, _ -> showProfileMutationResult(result, engineRunning) }
        .setPositiveButton("授权并重试") { _, _ ->
          runProfileMutation("正在授权并重试插件…", detail = spec, operation = {
            val approved = engineManager.approvePluginBuilds(result.pendingBuilds)
            if (!approved.ok) approved else {
              val retried = engineManager.installPlugin(spec)
              if (retried.output.isBlank()) retried else retried.copy(
                output = approved.output + "\n\n" + retried.output,
              )
            }
          })
        }
        .show()
      return
    }
    showProfileMutationResult(result, engineRunning)
  }

  /**
   * Desktop-like profile transaction boundary: stop the Host, mutate profile,
   * then start the same embedded Host and surface exact diagnostics.
   */
  private fun runProfileMutation(
    title: String,
    detail: String = "",
    onResult: ((PluginCommandResult, Boolean) -> Unit)? = null,
    operation: () -> PluginCommandResult,
  ) {
    if (!profileMutationRunning.compareAndSet(false, true)) {
      showSimpleMessage("操作进行中", "已有 profile 操作尚未完成，请稍后再试。")
      return
    }
    showStartingState(title, detail)
    EngineManager.beginMaintenance()

    Thread {
      var result = PluginCommandResult(false, -3, "操作没有完成")
      var running = false
      try {
        try { stopService(Intent(this, EngineService::class.java)) } catch (_: Throwable) {}
        engineManager.stopEngine()
        Thread.sleep(500)
        result = try {
          operation()
        } catch (t: Throwable) {
          PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
        }

        val started = engineManager.startEngine()
        if (started) running = waitForEngineReady()
        if (running) {
          startEngineService()
          applyShizukuKeepAlive()
        }
      } catch (t: Throwable) {
        result = PluginCommandResult(false, -3, buildString {
          append(result.output)
          if (isNotEmpty()) append('\n')
          append(t.message ?: t.javaClass.simpleName)
        })
      } finally {
        EngineManager.endMaintenance()
        profileMutationRunning.set(false)
      }
      runOnUiThread {
        if (running) showWeb() else showEngineFailure("操作完成后 DSH 未能重新启动")
        if (onResult != null) onResult(result, running) else showProfileMutationResult(result, running)
      }
    }.start()
  }

  private fun showProfileMutationResult(result: PluginCommandResult, engineRunning: Boolean) {
    val title = if (result.ok) "操作完成" else "操作失败"
    val bodyText = buildString {
      if (result.output.isNotBlank()) append(result.output.trim())
      if (!result.ok) {
        if (isNotEmpty()) append("\n\n")
        append("退出码：${result.exitCode}")
        engineManager.pluginCompatibilityAdvice(result)?.let { advice ->
          append("\n\n--- 插件兼容性 ---\n").append(advice)
        }
      }
      if (!engineRunning) {
        if (isNotEmpty()) append("\n\n")
        append("DSH 引擎未恢复运行。\n")
        append(engineManager.engineDiagnostics(5000))
      }
    }.ifBlank { if (result.ok) "已应用到 web profile。" else "没有更多诊断。" }
    val body = TextView(this).apply {
      text = bodyText
      textSize = 13f
      setTextIsSelectable(true)
      setPadding(32, 16, 32, 16)
    }
    android.app.AlertDialog.Builder(this)
      .setTitle(title)
      .setView(android.widget.ScrollView(this).apply { addView(body) })
      .setPositiveButton("确定", null)
      .show()
  }

  private fun showSimpleMessage(title: String, message: String) {
    android.app.AlertDialog.Builder(this)
      .setTitle(title)
      .setMessage(message)
      .setPositiveButton("确定", null)
      .show()
  }

  /**
   * SAF 目录选择（带 All Files Access 引导）：外部工作区要求 bash 进程能
   * 直接访问所选真实路径；无权限时先跳系统授权页并提示页面侧重试。
   */
  private fun pickDirectoryWithPermissionCheck(callbackId: String) {
    // 并发保护：已有在途选择时拒绝新请求（单槽 pendingPickCallback 会被
    // 覆盖导致前一个引擎 pick 永不结算——P2-8）。
    if (pendingPickCallback != null) {
      webView.evaluateJavascript(
        "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callbackId) + ", null)", null,
      )
      return
    }
    if (android.os.Build.VERSION.SDK_INT < 30) {
      pendingPickCallback = callbackId
      if (hasLegacyStoragePermission()) {
        directoryPicker.launch(null)
      } else {
        legacyDirectoryPermissionPending = true
        requestLegacyStoragePermission()
      }
      return
    }
    if (android.os.Environment.isExternalStorageManager()) {
      pendingPickCallback = callbackId
      directoryPicker.launch(null)
      return
    }
    openAllFilesAccessSettings()
    webView.evaluateJavascript(
      "window.__dshBridge?.onPermissionRequired?.()", null,
    )
  }

  private fun hasLegacyStoragePermission(): Boolean {
    if (Build.VERSION.SDK_INT >= 30) return true
    return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
  }

  private fun requestLegacyStoragePermission() {
    if (Build.VERSION.SDK_INT >= 30 || hasLegacyStoragePermission()) return
    if (!legacyPermissionRequestRunning.compareAndSet(false, true)) return
    legacyStoragePermission.launch(arrayOf(
      Manifest.permission.READ_EXTERNAL_STORAGE,
      Manifest.permission.WRITE_EXTERNAL_STORAGE,
    ))
  }

  /**
   * Resolve a SAF tree to a raw path usable by the embedded shell. Android 8/9
   * can use legacy shared storage after runtime permission. On devices where
   * Android 10 scoped storage refuses the raw path, fall back to an app-owned
   * external workspace so the feature remains functional instead of hanging.
   */
  private fun resolveWritableWorkspacePath(uri: Uri): String? {
    val resolved = AndroidBridge.resolvePickedPath(uri)
    if (resolved.startsWith("/")) {
      try {
        val dir = java.io.File(resolved).canonicalFile
        if (dir.isDirectory && dir.canRead() && dir.canWrite()) return dir.absolutePath
      } catch (_: Throwable) {}
    }
    if (Build.VERSION.SDK_INT < 30) {
      val base = getExternalFilesDir("workspaces") ?: java.io.File(filesDir, "legacy-workspace")
      val fallback = java.io.File(base, "DSH-Workspace").apply { mkdirs() }
      if (fallback.isDirectory && fallback.canWrite()) {
        showTestNotification("已使用兼容工作区", "系统限制了所选目录的原始路径，已改用应用可写工作区")
        return fallback.canonicalPath
      }
    }
    return null
  }

  private fun requestWorkspaceStorageAccess() {
    if (Build.VERSION.SDK_INT >= 30) {
      openAllFilesAccessSettings()
    } else if (!hasLegacyStoragePermission()) {
      requestLegacyStoragePermission()
    }
  }

  /** Open the system All Files Access screen for this app. */
  private fun openAllFilesAccessSettings() {
    if (android.os.Build.VERSION.SDK_INT < 30) return
    try {
      startActivity(
        Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          .setData(Uri.parse("package:$packageName")),
      )
    } catch (_: Exception) {
      // Some OEMs lack the per-app screen; fall back to the global one.
      try {
        startActivity(Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
      } catch (_: Exception) {
        // 无任何可用入口：静默忽略（引擎侧会以取消结算）。
      }
    }
  }

  /**
   * Download one same-origin DSH resource. Different files queue instead of
   * being silently dropped; duplicate WebView callbacks for the same URL are
   * de-duplicated until that job completes.
   */
  private fun downloadToDownloads(url: String, contentDisposition: String?, hintedMime: String? = null) {
    if (!isEngineSource(url)) {
      showTestNotification("下载被拒绝", "仅支持从本机 DSH 引擎下载文件")
      return
    }
    val key = url + "\n" + contentDisposition.orEmpty()
    if (!queuedDownloads.add(key)) return
    downloadQueue.add(DownloadRequest(url, contentDisposition, hintedMime, key))
    startDownloadWorker()
  }

  private fun startDownloadWorker() {
    if (!downloadWorkerRunning.compareAndSet(false, true)) return
    Thread {
      try {
        if (Build.VERSION.SDK_INT < 29 && !hasLegacyStoragePermission()) {
          legacyDownloadPermissionPending.set(true)
          runOnUiThread { requestLegacyStoragePermission() }
          return@Thread
        }
        while (true) {
          val request = downloadQueue.poll() ?: break
          try {
            performDownload(request)
          } finally {
            queuedDownloads.remove(request.dedupeKey)
          }
        }
      } finally {
        downloadWorkerRunning.set(false)
        // Close a race where a new item was queued after the final poll but
        // before the worker flag was cleared.
        if (downloadQueue.isNotEmpty() && !legacyDownloadPermissionPending.get()) startDownloadWorker()
      }
    }.start()
  }

  private fun clearDownloadQueue(reason: String) {
    while (true) {
      val request = downloadQueue.poll() ?: break
      queuedDownloads.remove(request.dedupeKey)
    }
    downloadWorkerRunning.set(false)
    showTestNotification("下载失败", reason)
  }

  private fun performDownload(request: DownloadRequest) {
    var conn: HttpURLConnection? = null
    try {
      val c = URL(request.url).openConnection() as HttpURLConnection
      conn = c
      c.connectTimeout = 15_000
      c.readTimeout = 120_000
      c.requestMethod = "GET"
      c.instanceFollowRedirects = false
      c.setRequestProperty("Accept", "*/*")
      CookieManager.getInstance().getCookie(request.url)?.takeIf { it.isNotBlank() }?.let { cookie ->
        c.setRequestProperty("Cookie", cookie)
      }
      if (c.responseCode != HttpURLConnection.HTTP_OK) throw java.io.IOException("HTTP " + c.responseCode)
      val disposition = c.getHeaderField("Content-Disposition") ?: request.contentDisposition
      val mime = normalizeMime(c.contentType ?: request.hintedMime, request.url)
      val filename = sanitizeFilename(parseDownloadFilename(request.url, disposition, mime))
      c.inputStream.use { input -> saveToDownloadsStreamed(filename, mime, input) }
      runOnUiThread { showTestNotification("文件已下载", "已保存到 下载/$filename") }
    } catch (t: Throwable) {
      runOnUiThread { showTestNotification("下载失败", t.message ?: "未知错误") }
    } finally {
      conn?.disconnect()
    }
  }

  /** Generic same-origin download path for generated documents, archives and attachments. */
  private fun saveToDownloadsStreamed(filename: String, mimeType: String, input: java.io.InputStream) {
    if (Build.VERSION.SDK_INT >= 29) {
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, filename)
        put(MediaStore.Downloads.MIME_TYPE, mimeType)
        put(MediaStore.Downloads.IS_PENDING, 1)
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      }
      val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw java.io.IOException("无法创建下载文件")
      try {
        contentResolver.openOutputStream(uri)?.use { out ->
          copyWithLimit(input, out, MAX_DOWNLOAD_BYTES, "下载文件超过 2 GB 上限")
        } ?: throw java.io.IOException("无法写入下载文件")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        contentResolver.update(uri, values, null, null)
      } catch (t: Throwable) {
        contentResolver.delete(uri, null, null)
        throw t
      }
      return
    }

    if (!hasLegacyStoragePermission()) throw java.io.IOException("未获得共享存储写入权限")
    @Suppress("DEPRECATION")
    val root = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
      ?: throw java.io.IOException("系统下载目录不可用")
    if (!root.exists() && !root.mkdirs()) throw java.io.IOException("无法创建系统下载目录")
    val target = reserveUniqueFile(root, filename)
    try {
      target.outputStream().buffered(128 * 1024).use { out ->
        copyWithLimit(input, out, MAX_DOWNLOAD_BYTES, "下载文件超过 2 GB 上限")
      }
    } catch (t: Throwable) {
      target.delete()
      throw t
    }
  }

  /** Atomically reserve a unique filename before writing on legacy shared storage. */
  private fun reserveUniqueFile(root: java.io.File, requestedName: String): java.io.File {
    val clean = sanitizeFilename(requestedName)
    val dot = clean.lastIndexOf('.')
    val hasExt = dot > 0 && dot < clean.length - 1
    val stem = if (hasExt) clean.substring(0, dot) else clean
    val ext = if (hasExt) clean.substring(dot) else ""
    for (index in 0..9999) {
      val candidate = java.io.File(root, if (index == 0) clean else "$stem ($index)$ext")
      if (candidate.createNewFile()) return candidate
    }
    throw java.io.IOException("同名下载文件过多：$clean")
  }

  private fun queryDisplayName(uri: Uri): String? {
    return try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index < 0) null else cursor.getString(index)
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun queryContentSize(uri: Uri): Long? {
    return try {
      contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        val index = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (index < 0 || cursor.isNull(index)) null else cursor.getLong(index).takeIf { it >= 0 }
      }
    } catch (_: Throwable) { null }
  }

  private fun copyWithLimit(
    input: java.io.InputStream,
    output: java.io.OutputStream,
    maxBytes: Long,
    limitMessage: String,
  ): Long {
    val buffer = ByteArray(128 * 1024)
    var total = 0L
    while (true) {
      val n = input.read(buffer)
      if (n < 0) break
      total += n
      if (total > maxBytes) throw java.io.IOException(limitMessage)
      output.write(buffer, 0, n)
    }
    return total
  }

  /** 文件名净化：去路径分隔符/控制字符，限长。 */
  private fun sanitizeFilename(name: String): String {
    val cleaned = name.replace(Regex("[/\\\\\u0000-\u001f]"), "_").take(200)
    return if (cleaned.isBlank()) "dsh-download" else cleaned
  }

  /** Content-Disposition first, then URL path, then a MIME-derived fallback. */
  private fun parseDownloadFilename(url: String, contentDisposition: String?, mimeType: String): String {
    contentDisposition?.let { cd ->
      Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(cd)?.groupValues?.get(1)?.let {
        return try { java.net.URLDecoder.decode(it, "UTF-8") } catch (_: Throwable) { it }
      }
      Regex("filename=\\\"?([^\\\";]+)\\\"?", RegexOption.IGNORE_CASE).find(cd)?.groupValues?.get(1)?.let { return it }
    }
    try {
      val path = Uri.parse(url).lastPathSegment
      if (!path.isNullOrBlank() && path.contains('.')) return path
      val q = URL(url).query ?: ""
      val sid = q.split("&").mapNotNull { seg ->
        val kv = seg.split("=", limit = 2)
        if (kv.size == 2 && kv[0] == "sessionId") kv[1] else null
      }.firstOrNull()
      if (sid != null) return "dsh-session-$sid.zip"
    } catch (_: Exception) {}
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
    return if (ext.isNullOrBlank()) "dsh-download" else "dsh-download.$ext"
  }

  private fun normalizeMime(value: String?, url: String): String {
    val clean = value?.substringBefore(';')?.trim()?.takeIf { it.contains('/') }
    if (clean != null && clean != "application/octet-stream") return clean
    val ext = try { MimeTypeMap.getFileExtensionFromUrl(url) } catch (_: Throwable) { "" }
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase()) ?: "application/octet-stream"
  }

  /** 系统深色状态推送：某些厂商 WebView 的 prefers-color-scheme 不跟随
   *  uiMode（vivo/Android 16 实测），UI 插件经 matchMedia hook 消费此桥值
   *  （window.__dshThemeBridge.setDark）驱动上游 system 主题。 */
  private fun pushSystemDark(view: android.webkit.WebView) {
    val dark = (resources.configuration.uiMode and
      android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    try {
      view.evaluateJavascript(
        "window.__dshThemeBridge && window.__dshThemeBridge.setDark(" + dark + ")", null,
      )
    } catch (_: Exception) {
      // 页面未就绪：onPageFinished 会再推一次。
    }
  }

  /**
   * 引擎源判定：精确匹配本机引擎的 scheme/host/port（防前缀欺骗，
   * 如 127.0.0.1:30800 或 127.0.0.1:3080.evil.com 误判为引擎源）。
   */
  private fun isEngineSource(url: String): Boolean {
    return try {
      val base = Uri.parse(EngineProbe.ENGINE_URL)
      val uri = Uri.parse(url)
      uri.scheme == base.scheme && uri.host == base.host && uri.port == base.port
    } catch (_: Exception) {
      false
    }
  }

  /** 命中判定：引擎源 + 会话导出路径 + GET（HEAD 是前端预检，不得触发跳转）。 */
  private fun isSessionExport(url: String, method: String): Boolean {
    return method == "GET" && isEngineSource(url) && url.contains(SESSION_EXPORT_PATH)
  }

  /**
   * 原子防重放的外部浏览器打开（非导出外链）。尽力而为：启动失败时
   * 静默（调用方不读返回值），不再有 MediaStore 回退契约——回退仅
   * 存在于导出路径（downloadToDownloads 内）。
   */
  private val exportLaunching = java.util.concurrent.atomic.AtomicBoolean(false)

  private fun openInExternalBrowser(uri: android.net.Uri): Boolean {
    if (!exportLaunching.compareAndSet(false, true)) return true // 已在途：吞掉重复触发
    return try {
      startActivity(Intent(Intent.ACTION_VIEW, uri))
      true
    } catch (_: Exception) {
      // 无浏览器可处理：回退 MediaStore 下载路径
      false
    } finally {
      exportLaunching.set(false)
    }
  }

  private fun keepScreenOn(enable: Boolean) {
    if (enable) {
      window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    } else {
      window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }

  private fun showTestNotification(title: String, text: String) {
    if (Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      pendingNotifications.add(PendingNotification(title, text))
      if (notificationPermissionRunning.compareAndSet(false, true)) {
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
      }
      return
    }
    postNotification(title, text)
  }

  private fun postNotification(title: String, text: String) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel("dsh", "dsh", NotificationManager.IMPORTANCE_DEFAULT))
    }
    val pending = android.app.PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java), android.app.PendingIntent.FLAG_IMMUTABLE,
    )
    val id = ((System.currentTimeMillis() xor title.hashCode().toLong()) and 0x7fffffff).toInt()
    manager.notify(
      id,
      NotificationCompat.Builder(this, "dsh")
        .setSmallIcon(android.R.drawable.stat_notify_chat)
        .setContentTitle(title)
        .setContentText(text)
        .setContentIntent(pending)
        .setAutoCancel(true)
        .build(),
    )
  }

  private fun buildGuideView(): LinearLayout {
    val padding = (24 * resources.displayMetrics.density).toInt()
    val guide = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(padding, padding, padding, padding)
      gravity = android.view.Gravity.CENTER
      visibility = View.GONE
    }
    engineStatus = TextView(this).apply {
      text = "正在启动 DeepSeek Harness…"
      textSize = 16f
      setPadding(0, 0, 0, padding)
    }
    progressText = TextView(this).apply {
      text = "正在检查本机 DSH 引擎状态"
      textSize = 13f
      setPadding(0, 0, 0, padding)
      visibility = View.VISIBLE
      setTextIsSelectable(true)
    }
    val repairRuntime = Button(this).apply {
      text = "修复运行时"
      setOnClickListener { repairRuntimeFlow() }
    }
    val retry = Button(this).apply {
      text = "重试"
      setOnClickListener { startEngineFlow() }
    }
    val safeMode = Button(this).apply {
      text = "禁用第三方插件并重启"
      setOnClickListener {
        android.app.AlertDialog.Builder(this@MainActivity)
          .setTitle("安全模式恢复")
          .setMessage("保留已安装文件，但停用 web profile 中全部第三方 bundle，然后重启 DSH。")
          .setNegativeButton("取消", null)
          .setPositiveButton("继续") { _, _ ->
            runProfileMutation("正在禁用第三方插件…") { engineManager.disableThirdPartyBundles() }
          }
          .show()
      }
    }
    val resetConfig = Button(this).apply {
      text = "备份并重置 web 配置"
      setOnClickListener {
        android.app.AlertDialog.Builder(this@MainActivity)
          .setTitle("重置配置覆盖层")
          .setMessage("会先备份 cordis.patch.yml，再创建空覆盖层。插件包与会话不会删除。")
          .setNegativeButton("取消", null)
          .setPositiveButton("备份并重置") { _, _ ->
            runProfileMutation("正在恢复配置…") { engineManager.backupAndResetProfilePatch() }
          }
          .show()
      }
    }
    val copyDiagnostics = Button(this).apply {
      text = "复制诊断"
      setOnClickListener {
        val diag = engineManager.engineDiagnostics(12000).ifBlank { "暂无引擎诊断。" }
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("DSH diagnostics", diag))
        showTestNotification("诊断已复制", "可以直接粘贴发送错误日志")
      }
    }
    recoveryControls.clear()
    recoveryControls += listOf(repairRuntime, retry, safeMode, resetConfig, copyDiagnostics)
    recoveryControls.forEach { it.visibility = View.GONE }
    guide.addView(engineStatus)
    guide.addView(progressText)
    guide.addView(repairRuntime)
    guide.addView(retry)
    guide.addView(safeMode)
    guide.addView(resetConfig)
    guide.addView(copyDiagnostics)
    return guide
  }

  /**
   * Engine-first flow: use an already-running engine, otherwise validate the
   * bundled runtime, self-heal an incomplete /usr extraction, and start DSH.
   * No external Termux installation is required.
   */
  private fun startEngineFlow() {
    if (!engineFlowRunning.compareAndSet(false, true)) return
    runOnUiThread { showStartingState("正在连接 DeepSeek Harness…") }
    Thread {
      try {
        if (EngineProbe.check(250).optBoolean("running", false)) {
          // Re-arm foreground ownership even when the Host survived an
          // Activity recreation or was already listening before this launch.
          startEngineService()
          applyShizukuKeepAlive()
          runOnUiThread { showWeb() }
          return@Thread
        }

        if (!engineManager.engineReady) {
          runOnUiThread {
            progressText.visibility = View.VISIBLE
            progressText.text = engineManager.runtimeHealth().describe()
            guideView.visibility = View.VISIBLE
            webView.visibility = View.GONE
            engineStatus.text = "正在修复并解压内置运行时…"
          }
          val ok = engineManager.extractSnapshot { done, _ ->
            runOnUiThread {
              engineStatus.text = "正在解压运行时… " + done / 1024 / 1024 + " MB"
            }
          }
          if (!ok) {
            runOnUiThread { showEngineFailure("运行时解压/校验失败") }
            return@Thread
          }
        }

        runOnUiThread { showStartingState("正在启动 DSH 引擎…", "首次启动或插件较多时可能需要一些时间。") }
        if (!engineManager.startEngine(runtimeAlreadyChecked = true)) {
          runOnUiThread { showEngineFailure("引擎启动失败") }
          return@Thread
        }

        // Poll aggressively during the first few seconds. A 1 s fixed polling
        // interval added ~500 ms average latency after the HTTP listener was
        // already ready. Also stop immediately if the child process dies.
        if (waitForEngineReady()) {
          startEngineService()
          applyShizukuKeepAlive()
          runOnUiThread { showWeb() }
          return@Thread
        }
        runOnUiThread {
          showEngineFailure(if (engineManager.isEngineProcessAlive()) "引擎启动超时" else "引擎启动后退出")
        }
      } finally {
        engineFlowRunning.set(false)
      }
    }.start()
  }

  /**
   * Wait for the verified DSH HTTP listener with low perceived latency.
   *
   * Local connection-refused probes return immediately, so 100 ms polling is
   * cheap during the hot part of startup. The interval backs off afterwards
   * to avoid wasting CPU on unusually slow plugin trees.
   */
  private fun waitForEngineReady(timeoutMs: Long = 60_000L): Boolean {
    val startedAt = android.os.SystemClock.elapsedRealtime()
    while (android.os.SystemClock.elapsedRealtime() - startedAt < timeoutMs) {
      if (EngineProbe.check(250).optBoolean("running", false)) return true
      if (!engineManager.isEngineProcessAlive()) return false

      val elapsed = android.os.SystemClock.elapsedRealtime() - startedAt
      val delay = when {
        elapsed < 3_000L -> 100L
        elapsed < 10_000L -> 250L
        else -> 500L
      }
      Thread.sleep(delay)
    }
    return false
  }

  /** Force-reinstall only the embedded /usr runtime; user data under HOME stays intact. */
  private fun repairRuntimeFlow() {
    if (!engineFlowRunning.compareAndSet(false, true)) return
    EngineManager.beginMaintenance()
    Thread {
      try {
        runOnUiThread {
          showStartingState("正在修复运行时…", "保留会话/配置，仅重建 APK 内置运行时。")
        }
        try { stopService(Intent(this, EngineService::class.java)) } catch (_: Throwable) {}
        engineManager.stopEngine()
        engineManager.clearBrokenRuntime()
      } finally {
        EngineManager.endMaintenance()
        engineFlowRunning.set(false)
      }
      runOnUiThread { startEngineFlow() }
    }.start()
  }

  /** Show the actual runtime/preload/engine.log failure instead of a generic message. */
  private fun showEngineFailure(prefix: String) {
    val diag = engineManager.engineDiagnostics()
    engineStatus.text = prefix + "。"
    progressText.visibility = View.VISIBLE
    progressText.text = if (diag.isBlank()) "未生成额外诊断日志。" else diag
    recoveryControls.forEach { it.visibility = View.VISIBLE }
    showGuide()
  }

  /** Normal launches use a lightweight status view; recovery actions appear only after a real failure. */
  private fun showStartingState(message: String, detail: String = "") {
    recoveryControls.forEach { it.visibility = View.GONE }
    engineStatus.text = message
    progressText.text = detail
    progressText.visibility = if (detail.isBlank()) View.GONE else View.VISIBLE
    webView.visibility = View.GONE
    guideView.visibility = View.VISIBLE
  }

  /** Run the runtime snapshot update; status mirrored to a file for adb verification. */
  private fun runUpdate() {
    val statusFile = java.io.File(filesDir, "update-status.txt")
    val manager = UpdateManager(this)
    manager.checkAndApply { status ->
      runOnUiThread {
        engineStatus.text = status
        progressText.visibility = View.VISIBLE
        guideView.visibility = View.VISIBLE
        webView.visibility = View.GONE
      }
      try {
        statusFile.appendText(status + "\n")
      } catch (_: Exception) {
      }
    }
  }

  /** Start the foreground service (engine keep-alive + watchdog). */
  private fun startEngineService() {
    try {
      startForegroundService(Intent(this, EngineService::class.java))
    } catch (_: Exception) {
      // Foreground-service start limits: service will start on next launch.
    }
  }

  /** Best-effort Shizuku keep-alive boost; outcome logged only. */
  private fun applyShizukuKeepAlive() {
    try {
      Thread {
        val result = ShizukuSupport.status(this)
        Log.i("dsh-shizuku", result)
      }.start()
    } catch (_: Throwable) {
    }
  }

  private fun showWeb() {
    recoveryControls.forEach { it.visibility = View.GONE }
    guideView.visibility = View.GONE
    webView.visibility = View.VISIBLE
    applyInterfaceModeSettings()
    // In stable DSH 0.1.5-rc.2 the launch token remains valid for the lifetime
    // of the Host process. Always prefer it on Activity recreation: if the
    // WebView cookie was not flushed before Android killed the Activity, the
    // token simply mints a fresh persistent cookie and redirects to clean /.
    val startup = engineManager.webStartupUrl()
    val target = if (startup.contains("?token=")) startup else EngineProbe.ENGINE_URL
    webView.stopLoading()
    webView.loadUrl(target)
  }

  private fun showGuide() {
    webView.visibility = View.GONE
    guideView.visibility = View.VISIBLE
  }
}