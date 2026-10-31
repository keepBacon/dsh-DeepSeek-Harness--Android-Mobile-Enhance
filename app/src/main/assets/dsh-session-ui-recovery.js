(() => {
  'use strict';
  const CAP = /*__DSH_SESSION_UI_CAP__*/;
  if (window.__dshSessionUiRecoveryInstalled) return;
  window.__dshSessionUiRecoveryInstalled = true;
  let sent = false;
  let checking = false;

  // The Host session/list and the Workspace follow baseline are independent.
  // Do not call workspace mutation APIs or inspect message bodies.
  async function verify() {
    if (sent || checking || document.visibilityState === 'hidden') return;
    const empty = document.querySelector('[data-row-key="empty"]');
    if (!empty || empty.querySelector('button')) return; // archived-only filter
    if (document.querySelector('[data-row-key^="workspace:"], [data-row-key^="session:"]')) return;
    const draft = document.querySelector('textarea:focus, [contenteditable="true"]:focus');
    if (draft && String(draft.value || draft.textContent || '').trim()) return;
    checking = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let response;
      try {
        response = await fetch(new URL('api/session/list', document.baseURI).href, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'android-workspace-watchdog-' + Date.now().toString(36),
            method: 'session/list',
            payload: {args: {_request: {}}}
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) return;
      const envelope = await response.json();
      const items = envelope?.result?.ok ? envelope.result.value?.items : null;
      if (!Array.isArray(items) || items.length === 0) return;
      // Check again after the asynchronous request: the frontend may have
      // received its Workspace baseline while the request was in flight.
      if (!document.querySelector('[data-row-key="empty"]') ||
          document.querySelector('[data-row-key^="workspace:"], [data-row-key^="session:"]')) return;
      sent = true;
      window.androidBridge?.reportSessionUiMismatch(CAP, items.length);
    } catch (_) {
      // Network errors are not evidence of lost sessions. No changes are made.
    } finally {
      checking = false;
    }
  }

  // Bounded checks, not a polling loop or a MutationObserver over streaming
  // message content. Hidden pages and non-empty views do nothing.
  for (const delay of [12000, 30000, 60000]) setTimeout(verify, delay);
})();