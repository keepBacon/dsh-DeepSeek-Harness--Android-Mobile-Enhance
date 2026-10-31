(() => {
  'use strict';
  const CAP = /*__DSH_SESSION_UI_CAP__*/;
  if (window.__dshSessionUiRecoveryInstalled) return;
  window.__dshSessionUiRecoveryInstalled = true;

  // The Session Host and the Workspace follow stream are separate sources.
  // An empty sidebar is not evidence of deleted data. This watchdog only
  // reads the Host and reports a persistent discrepancy to the native shell.
  const state = { inFlight: false, consecutive: 0, firstPositive: 0, reported: false };
  const ROWS = '[data-row-key^="workspace:"], [data-row-key^="session:"]';

  function emptyWorkspaceView() {
    const empty = document.querySelector('[data-row-key="empty"]');
    // Archived-only filter legitimately has no entries; it contains an action.
    return !!empty && !empty.querySelector('button') && !document.querySelector(ROWS);
  }

  function composing() {
    const active = document.activeElement;
    if (!active || typeof active.matches !== 'function') return false;
    if (!active.matches('textarea, input, [contenteditable="true"]')) return false;
    return !!String(active.value || active.textContent || '').trim();
  }

  async function verify() {
    if (state.inFlight || state.reported || document.visibilityState === 'hidden') return;
    if (!emptyWorkspaceView() || composing()) {
      state.consecutive = 0;
      state.firstPositive = 0;
      return;
    }
    state.inFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      // Always resolve from the Host root. document.baseURI can be /session/...
      const response = await fetch(new URL('/api/session/list', location.origin).href, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'android-workspace-watch-' + Date.now().toString(36),
          method: 'session/list', payload: { args: { _request: {} } }
        }),
        signal: controller.signal
      });
      if (!response.ok) return;
      const envelope = await response.json();
      const items = envelope && envelope.result && envelope.result.ok
        ? envelope.result.value && envelope.result.value.items : null;
      if (!Array.isArray(items) || !items.length || !emptyWorkspaceView() || composing()) {
        state.consecutive = 0;
        state.firstPositive = 0;
        return;
      }
      if (!state.consecutive) state.firstPositive = Date.now();
      state.consecutive++;
      // Require two real, independently completed Host calls at least 8s
      // apart. A slow initial Workspace baseline must not trigger a reload.
      if (state.consecutive < 2 || Date.now() - state.firstPositive < 8000) return;
      state.reported = true;
      window.androidBridge?.reportSessionUiMismatch(CAP, items.length);
    } catch (_) {
      // A failed query is not a confirmed mismatch. Never reset Host storage,
      // switch Profile or reload a page solely because of network errors.
      state.consecutive = 0;
      state.firstPositive = 0;
    } finally {
      clearTimeout(timer);
      state.inFlight = false;
    }
  }

  // Low frequency, DOM-independent checks: never observe streaming chat text.
  // A hidden page, archived-only view or nonempty Workspace is a no-op.
  setTimeout(verify, 10000);
  const periodic = setInterval(verify, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(verify, 1500);
  }, { passive: true });
  window.addEventListener('pagehide', () => clearInterval(periodic), { once: true });
})();