(() => {
  'use strict';
  const CAPABILITY = /*__DSH_WORKSPACE_PROBE_CAP__*/;
  let reported = false;
  function report(value) {
    if (reported) return;
    reported = true;
    try { window.androidBridge?.reportWorkspaceStreamDiagnostic(CAPABILITY, String(value).slice(0, 1000)); } catch (_) {}
  }
  // A separate, read-only Remote stream. Never touch the Client's existing
  // Workspace stream, mutate its registry, or read message contents.
  const streamId = 'android-readonly-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const target = new URL('/api/remote.mux', location.origin);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  let timeout;
  function finish(value) {
    clearTimeout(timeout);
    report(value);
    if (ws) { try { ws.close(1000, 'read-only probe finished'); } catch (_) {} }
  }
  try {
    ws = new WebSocket(target.href);
    timeout = setTimeout(() => finish('工作区数据流：超时（8秒），无法确认 Host 工作区状态'), 8000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} }
      }));
    };
    ws.onmessage = event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch (_) { return; }
      if (frame.streamId !== streamId) return;
      if (frame.type === 'error') {
        const code = String(frame.error?.code || 'unknown').slice(0, 64);
        const message = String(frame.error?.message || 'unknown').slice(0, 180);
        finish('工作区数据流：远端错误\n代码：' + code + '\n信息：' + message);
      } else if (frame.type === 'end') {
        finish('工作区数据流：未收到完整 baseline 就结束');
      } else if (frame.type === 'item') {
        const value = frame.value;
        if (value?.type !== 'baseline') {
          finish('工作区数据流：首帧非 baseline（' + String(value?.type || 'unknown') + '）');
          return;
        }
        const baseline = value.value;
        if (!Array.isArray(baseline?.items)) {
          finish('工作区数据流：baseline 不含 items，协议结构异常');
          return;
        }
        const workspaces = baseline.items;
        const memberships = workspaces.reduce((count, item) =>
          count + (Array.isArray(item.sessionIds) ? item.sessionIds.length : 0), 0);
        const archived = Array.isArray(baseline.archivedSessionIds) ? baseline.archivedSessionIds.length : 0;
        finish('工作区数据流：baseline 正常\n可见工作区：' + workspaces.length +
          '\n工作区内会话关联：' + memberships +
          '\n归档会话：' + archived +
          '\n这与 session/list 是独立结果；没有读取任何聊天正文。');
      }
    };
    ws.onerror = () => finish('工作区数据流：WebSocket 连接失败；检查 Gateway 和认证状态');
    ws.onclose = e => { if (!reported) finish('工作区数据流：连接提前关闭，代码 ' + e.code); };
  } catch (error) {
    finish('工作区数据流：无法发起检查（' + String(error?.message || error).slice(0, 200) + '）');
  }
})();