package com.dshmobile.shell

import android.content.Context
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.webkit.ConsoleMessage
import android.webkit.WebView
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean

/**
 * App-private read-only WebView inspector. The model cannot supply JavaScript,
 * inspect cookies/storage, read input values, or access non-DSH origins.
 */
internal class WebViewInspector(
  context: Context,
  private val webView: WebView,
  private val isTrusted: (String) -> Boolean,
) {
  private val requests = File(context.filesDir, "webview-inspector/requests")
  private val responses = File(context.filesDir, "webview-inspector/responses")
  private val ui = Handler(Looper.getMainLooper())
  private val alive = AtomicBoolean(false)
  private val levels = linkedMapOf<String, Int>()
  private var watcher: FileObserver? = null
  private val requestName = Regex("^req-([0-9a-f]{32})\\.json$")

  fun start() {
    requests.mkdirs()
    responses.mkdirs()
    if (!alive.compareAndSet(false, true)) return
    watcher = object : FileObserver(requests.absolutePath, FileObserver.MOVED_TO or FileObserver.CLOSE_WRITE) {
      override fun onEvent(event: Int, path: String?) {
        if (!alive.get() || path == null || !requestName.matches(path)) return
        Thread({ handle(File(requests, path), path) }, "dsh-inspector-request").start()
      }
    }.also { it.startWatching() }
  }

  fun stop() {
    alive.set(false)
    watcher?.stopWatching()
    watcher = null
  }

  fun recordConsole(message: ConsoleMessage) {
    // Deliberately do not record console message text or source URLs: they may contain secrets.
    synchronized(levels) {
      val level = message.messageLevel().name
      levels[level] = (levels[level] ?: 0).coerceAtMost(100000) + 1
    }
  }

  private fun handle(file: File, name: String) {
    val id = requestName.matchEntire(name)?.groupValues?.get(1) ?: return
    try {
      if (!file.isFile) {
        reply(id, JSONObject().put("ok", false).put("error", "Inspector request file unavailable"))
        return
      }
      if (file.length() > 1024L) {
        reply(id, JSONObject().put("ok", false).put("error", "Inspector request exceeds 1024 bytes"))
        return
      }
      val request = JSONObject(file.readText(StandardCharsets.UTF_8))
      if (request.optString("id") != id || request.optString("operation") != "snapshot") {
        reply(id, JSONObject().put("ok", false).put("error", "Unsupported request"))
        return
      }
      ui.post {
        if (!alive.get() || webView.url.isNullOrEmpty() || !isTrusted(webView.url.orEmpty())) {
          reply(id, JSONObject().put("ok", false).put("error", "No active trusted DSH WebView"))
          return@post
        }
        try {
          webView.evaluateJavascript(SCRIPT) { result ->
            try {
              val decoded = JSONTokener(result).nextValue()
              val snapshot = JSONObject(decoded as? String ?: "{}")
              val counts = JSONObject()
              synchronized(levels) { for ((level, count) in levels) counts.put(level, count) }
              snapshot.put("consoleLevels", counts)
              reply(id, JSONObject().put("ok", true).put("snapshot", snapshot))
            } catch (_: Throwable) {
              reply(id, JSONObject().put("ok", false).put("error", "Invalid snapshot response"))
            }
          }
        } catch (_: Throwable) {
          reply(id, JSONObject().put("ok", false).put("error", "WebView evaluation unavailable"))
        }
      }
    } catch (_: Throwable) {
      reply(id, JSONObject().put("ok", false).put("error", "Invalid inspection request"))
    } finally {
      file.delete()
    }
  }

  private fun reply(id: String, objectValue: JSONObject) {
    objectValue.put("id", id)
    Thread({
      try {
        responses.mkdirs()
        val temporary = File(responses, "res-$id.json.tmp")
        val finalFile = File(responses, "res-$id.json")
        temporary.writeText(objectValue.toString(), StandardCharsets.UTF_8)
        if (!temporary.renameTo(finalFile)) temporary.delete()
      } catch (_: Throwable) {}
    }, "dsh-inspector-response").start()
  }

  companion object {
    private val SCRIPT = """
      (function(){
        try {
          var elems=Array.prototype.slice.call(document.querySelectorAll('button,input,textarea,select,a,[role="button"],[role="dialog"]'),0,80);
          var items=elems.map(function(el){
            var r=el.getBoundingClientRect();
            return {tag:el.tagName.toLowerCase(),id:(el.id||'').slice(0,60),
              classes:typeof el.className==='string'?el.className.slice(0,90):'',
              role:(el.getAttribute('role')||'').slice(0,32),
              rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
              visible:r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'};
          });
          // This is diagnostic state only. Never collect model identifiers,
          // provider endpoints, credentials, input values or error messages.
          // The upstream DSH ModelListEditor translates these exact labels.
          var fetchLabels=['获取可用模型','Fetch available models','利用可能なモデルを取得'];
          var fetchingLabels=['正在询问提供商…','Asking the provider…','プロバイダーに問い合わせ中…'];
          var pickerLabels=['选择模型','Choose models','モデルを選択'];
          var modelFetchButton=Array.prototype.slice.call(document.querySelectorAll('button')).find(function(el){
            var label=(el.textContent||'').trim();
            return fetchLabels.indexOf(label)>=0||fetchingLabels.indexOf(label)>=0;
          });
          var modelFetchLabel=modelFetchButton?(modelFetchButton.textContent||'').trim():'';
          var modelPicker=Array.prototype.slice.call(document.querySelectorAll('[role="dialog"]')).some(function(el){
            return pickerLabels.indexOf((el.getAttribute('aria-label')||'').trim())>=0;
          });
          var modelDiscovery={
            buttonPresent:!!modelFetchButton,
            buttonDisabled:!!(modelFetchButton&&modelFetchButton.disabled),
            buttonVisible:!!(modelFetchButton&&modelFetchButton.getBoundingClientRect().width>0&&
              modelFetchButton.getBoundingClientRect().height>0),
            askingProvider:fetchingLabels.indexOf(modelFetchLabel)>=0,
            pickerOpen:modelPicker
          };
          var nav=performance.getEntriesByType('navigation')[0];
          return JSON.stringify({
            origin:location.origin,path:location.pathname.slice(0,160),
            readyState:document.readyState,
            viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
            dom:{totalElements:document.getElementsByTagName('*').length,items:items},
            modelDiscovery:modelDiscovery,
            timing:nav?{domContentLoadedMs:Math.round(nav.domContentLoadedEventEnd),
              loadMs:Math.round(nav.loadEventEnd),durationMs:Math.round(nav.duration)}:null
          });
        } catch(e){return JSON.stringify({error:'DOM inspector unavailable'});}
      })()
    """.trimIndent()
  }
}
