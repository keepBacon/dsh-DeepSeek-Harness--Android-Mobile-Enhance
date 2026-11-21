import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source=readFileSync('app/src/main/java/com/dshmobile/shell/MainActivity.kt','utf8')
const begin=source.indexOf('override fun onReceivedError(')
const end=source.indexOf('override fun onPageFinished(',begin)
assert.ok(begin>=0&&end>begin)
const handlers=source.slice(begin,end)
assert.ok(handlers.includes('if (!request.isForMainFrame || !isEngineSource(request.url.toString())) return'))
const navStart=source.slice(source.indexOf('override fun onPageStarted('),begin)
assert.ok(navStart.includes('mainFrameNavigationGeneration.incrementAndGet()'),
  'new navigation must invalidate earlier recovery callbacks')
assert.ok(handlers.includes('pageLoadRecoveryGeneration.getAndSet(generation) == generation'),
  'deduplicate errors for one navigation only')
assert.ok(handlers.includes('mainFrameNavigationGeneration.get() != generation'),
  'discard old network errors after navigating again')
assert.ok(handlers.includes('pageLoadRecoveryGeneration.compareAndSet(generation, -1L)'),
  'old probes must not clear a newer recovery guard')
assert.ok(handlers.indexOf('mainFrameNavigationGeneration.get() != generation') <
  handlers.indexOf('showSimpleMessage("DSH 页面加载失败"'),
  'stale callbacks must be checked before showing errors')
assert.ok(handlers.includes('EngineProbe.check(700).optBoolean("running", false)'))
assert.ok(handlers.includes('engineManager.isEngineProcessAlive()'))
assert.ok(handlers.includes('if (alive) {'))
assert.ok(handlers.includes('showSimpleMessage("DSH 页面加载失败",'))
assert.ok(handlers.includes('startEngineFlow()'))
assert.ok(!handlers.includes('pageLoadRecoveryRunning'))
assert.ok(!handlers.includes('webView.loadUrl('))
assert.ok(handlers.includes('Host 返回 HTTP'))
// A live Host with HTTP 500 must not trigger unconditional full WebView reload.
const error500=handlers.slice(handlers.indexOf('in 500..599 ->'),handlers.indexOf('\n          }',handlers.indexOf('in 500..599 ->')))
assert.ok(!error500.includes('startEngineFlow()'))
assert.ok(!error500.includes('showWeb()'))
console.log('[DSH] stale main-frame recovery callbacks are ignored; live Host drafts remain intact OK')
