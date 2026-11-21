import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const src=readFileSync('app/src/main/java/com/dshmobile/shell/MainActivity.kt','utf8')
const first=src.indexOf('override fun onCreateWindow(')
const last=src.indexOf('override fun onConsoleMessage(',first)
assert.ok(first>=0&&last>first,'popup handler missing')
const handler=src.slice(first,last)
assert.ok(handler.includes('override fun onPageStarted('),'popup navigation must handle load startup')
assert.ok(handler.includes('shouldOverrideUrlLoading'),'popup target must be intercepted')
assert.ok(handler.includes('openInExternalBrowser(target)'),'HTTP popup must open separate browser')
assert.ok(handler.includes('target.scheme.equals("http", true)') &&
 handler.includes('target.scheme.equals("https", true)'),'reject unsupported popup schemes')
assert.ok(!handler.includes('webView.loadUrl(url)'),'popup must never replace active DSH session or unsaved forms')
assert.ok(!handler.includes('popup.addJavascriptInterface'),'do not install privileged bridge in popup')
assert.ok(handler.includes('try { popup.destroy() }'),'discard temporary WebView after routing')
console.log('[DSH] window.open and target=_blank preserve main WebView state: OK')
