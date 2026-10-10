/* Passive DSH tool-call display. Reads existing tool UI; never calls the LLM. */
(() => {
  'use strict';
  if (window.__dshAndroidToolMonitor) return;
  const MAX_ROWS = 120;
  const rows = new Map();
  let enabled = true, opened = false, chosen = null, queued = false, tabParent = null, currentSession = null;

  function el(tag, cls, value) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  const short = (v, size = 200) => String(v == null ? '' : v).slice(0, size);
  function redact(value) {
    let data;
    try { data = typeof value === 'string' ? value : JSON.stringify(value); } catch (_) { data = '[unavailable]'; }
    return short(data, 12000)
      .replace(/(authorization\s*[:=]\s*bearer\s+)\S+/gi, '$1[redacted]')
      .replace(/((?:api[_-]?key|password|secret|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
  }
  const time = (stamp) => new Date(stamp).toLocaleTimeString('zh-CN', {
    hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
  function indicator(parent, status) {
    const div = el('span', status === 'running' ? 'dsh-pcm-spin' :
      ('dsh-pcm-dot' + (status === 'failure' ? ' dsh-pcm-fail' : '')));
    parent.appendChild(div);
  }
  function sessionKey() {
    return document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
      ?.getAttribute('data-row-key') || location.pathname + location.search;
  }
  function take(item) {
    if (!enabled || !item || typeof item !== 'object') return;
    const id = short(item.callId || item.id, 160);
    if (!id) return;
    const old = rows.get(id);
    const status = ['running', 'success', 'failure'].includes(item.status)
      ? item.status : (old?.status || 'running');
    // A DOM poll with unchanged data must not redraw the UI; otherwise the
    // pill mutation would schedule another observation frame indefinitely.
    const normalizedName = short(item.name || old?.name || 'tool', 90);
    const normalizedOperation = short(item.operation ?? old?.operation ?? '', 160);
    const normalizedInput = item.input === undefined ? (old?.input || '（界面未公开输入）') : redact(item.input);
    const normalizedResult = item.result === undefined ? (old?.result || '（界面未公开结果）') : redact(item.result);
    if (old && old.name === normalizedName && old.operation === normalizedOperation &&
        old.status === status && old.input === normalizedInput && old.result === normalizedResult) return;
    rows.set(id, {
      id, status, name: normalizedName,
      operation: normalizedOperation,
      input: normalizedInput,
      result: normalizedResult,
      source: short(item.source || old?.source || 'DSH 工具', 90),
      startedAt: old?.startedAt || item.startedAt || Date.now(),
      endedAt: status === 'running' ? null : (old?.endedAt || Date.now())
    });
    if (rows.size > MAX_ROWS) rows.delete(rows.keys().next().value);
    draw();
  }
  function observeDom() {
    if (!enabled) return;
    const now = sessionKey();
    if (currentSession !== null && now !== currentSession) {
      rows.clear(); chosen = null;
    }
    currentSession = now;
    for (const call of document.querySelectorAll('[data-chat-call-id]')) {
      const tool = call.querySelector('[data-tool][data-state]');
      if (!tool) continue;
      const original = tool.getAttribute('data-state') || '';
      const status = /error|fail|interrupt|stop/.test(original) ? 'failure' :
        /ok|success|done|result/.test(original) ? 'success' : 'running';
      const name = tool.getAttribute('data-tool') || 'tool';
      const caption = short(tool.querySelector('button,[role="button"]')?.textContent?.trim()
        || name, 170);
      const blocks = Array.from(tool.querySelectorAll('pre,code'))
        .map(node => short(node.textContent, 2000));
      take({id:call.getAttribute('data-chat-call-id'), name, operation:caption, status,
        input:blocks[0], result:blocks[1], source: 'DSH / 内置或插件'});
    }
  }
  function findTabRow() {
    const candidates = Array.from(document.querySelectorAll('button,[role="tab"]'))
      .filter(node => /^(对话|轨迹|上下文|Chat|Trajectory|Context)$/i.test((node.textContent || '').trim()));
    const chat = candidates.find(node => /^(对话|Chat)$/i.test((node.textContent || '').trim()));
    if (!chat) return null;
    for (let parent = chat.parentElement, i = 0; parent && i < 3; parent = parent.parentElement, i++) {
      if (candidates.filter(node => parent.contains(node)).length >= 2) return parent;
    }
    return null;
  }
  const styleText = [
    '#dsh-pcm-pill{margin-left:auto;flex:0 1 134px;min-width:0;max-width:134px;height:27px;padding:0 8px;border-radius:10px;border:1px solid #959da54d;background:var(--dsw-alias-bg-elevated,#fff);color:inherit;display:flex;align-items:center;gap:6px;cursor:pointer;font:500 10px/1.2 system-ui,sans-serif}',
    '#dsh-pcm-pill[hidden]{display:none!important}',
    '.dsh-pcm-caption{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}',
    '.dsh-pcm-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#26b879}',
    '.dsh-pcm-fail{background:#eb505d}',
    '.dsh-pcm-spin{flex:none;width:12px;height:12px;border:2px solid #9ca9ba77;border-top-color:#4d89ea;border-radius:50%;animation:dsh-pcm-turn .8s linear infinite}',
    '@keyframes dsh-pcm-turn{to{transform:rotate(360deg)}}',
    '#dsh-pcm-panel{position:fixed;inset:0;z-index:1200;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-text-primary,#222);display:none;flex-direction:column;font:12px/1.5 system-ui,sans-serif}',
    '#dsh-pcm-panel[data-open="true"]{display:flex}',
    '.dsh-pcm-header{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #90909030;font-size:14px;font-weight:700}',
    '.dsh-pcm-header button{border:0;border-radius:9px;background:#88888817;color:inherit;padding:7px 11px}',
    '.dsh-pcm-body{flex:1;overflow:auto;padding:12px;overscroll-behavior:contain}',
    '.dsh-pcm-card{display:block;width:100%;text-align:left;padding:12px;margin-bottom:10px;border-radius:13px;border:1px solid #8888882b;background:var(--dsw-alias-bg-elevated,#fff);color:inherit;font:inherit;cursor:pointer}',
    '.dsh-pcm-line{display:flex;align-items:center;gap:7px;min-width:0}',
    '.dsh-pcm-line-title{flex:1;overflow:hidden;text-overflow:ellipsis;font-weight:700}',
    '.dsh-pcm-time{white-space:nowrap;font-size:11px;opacity:.65;font-variant-numeric:tabular-nums}',
    '.dsh-pcm-pair{display:grid;grid-template-columns:40px minmax(0,1fr);gap:6px;font-size:11px;margin-top:8px;opacity:.83}',
    '.dsh-pcm-pair span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-pcm-block{padding:13px;border-radius:11px;background:#88888815;white-space:pre-wrap;overflow-wrap:anywhere;max-height:36vh;overflow:auto}'
  ].join('\n');

  function mount() {
    if (!document.body) return;
    if (!document.getElementById('dsh-pcm-style')) {
      const css = el('style'); css.id = 'dsh-pcm-style'; css.textContent = styleText;
      document.head?.appendChild(css);
    }
    let pill = document.getElementById('dsh-pcm-pill');
    if (!pill) {
      pill = el('button'); pill.id = 'dsh-pcm-pill'; pill.hidden = true; pill.type = 'button';
      pill.setAttribute('aria-label', '工具调用监控');
      pill.addEventListener('click', () => { opened = true; chosen = null; draw(); });
      document.body.appendChild(pill);
    }
    if (!document.getElementById('dsh-pcm-panel')) {
      const panel = el('section'); panel.id = 'dsh-pcm-panel';
      const head = el('div','dsh-pcm-header');
      const back = el('button',null,'返回'); back.type = 'button';
      back.addEventListener('click',()=>{if(chosen)chosen=null;else opened=false;draw();});
      const title = el('strong','dsh-pcm-heading','工具调用监控');
      const close = el('button',null,'关闭'); close.type='button';
      close.addEventListener('click',()=>{opened=false;chosen=null;draw();});
      head.append(back,title,close);
      panel.append(head,el('div','dsh-pcm-body'));
      document.body.appendChild(panel);
    }
    const next = findTabRow();
    if (next && next !== tabParent) {
      tabParent = next;
      next.appendChild(pill);
      next.style.minWidth = '0';
    }
  }
  function draw() {
    mount();
    const pill=document.getElementById('dsh-pcm-pill');
    const panel=document.getElementById('dsh-pcm-panel');
    if (!pill || !panel) return;
    const last=Array.from(rows.values()).pop();
    pill.replaceChildren();
    pill.hidden=!enabled || !last || !tabParent?.isConnected;
    if (!pill.hidden) {
      indicator(pill,last.status);
      pill.appendChild(el('span','dsh-pcm-caption',last.status==='running' ? '' : last.name+' '+last.operation));
    }
    panel.dataset.open=String(opened && enabled);
    if (!opened || !enabled) return;
    panel.querySelector('.dsh-pcm-heading').textContent =
      chosen ? '工具调用详情' : '本轮工具调用 · '+rows.size;
    const body=panel.querySelector('.dsh-pcm-body');
    body.replaceChildren();
    if(chosen) {
      const item=rows.get(chosen);
      if (!item) {chosen=null;draw();return;}
      body.appendChild(el('h3',null,item.name+' · '+item.operation));
      body.appendChild(el('p',null,time(item.startedAt)+' · '+item.source+' · '+item.status));
      body.appendChild(el('h4',null,'输入'));
      body.appendChild(el('pre','dsh-pcm-block',item.input));
      body.appendChild(el('h4',null,'结果'));
      body.appendChild(el('pre','dsh-pcm-block',item.result));
      return;
    }
    for(const item of Array.from(rows.values()).reverse()) {
      const card=el('button','dsh-pcm-card');card.type='button';
      const line=el('div','dsh-pcm-line');
      indicator(line,item.status);
      line.appendChild(el('span','dsh-pcm-line-title',item.name+' '+item.operation));
      line.appendChild(el('span','dsh-pcm-time',time(item.startedAt)));
      const pair=el('div','dsh-pcm-pair');
      pair.append(el('strong',null,'输入'),el('span',null,short(item.input,110)));
      pair.append(el('strong',null,'结果'),el('span',null,short(item.result,110)));
      card.append(line,pair);
      card.addEventListener('click',()=>{chosen=item.id;draw();});
      body.appendChild(card);
    }
  }
  function schedule() {
    if (queued) return;
    queued=true;
    requestAnimationFrame(()=>{queued=false;mount();observeDom();draw();});
  }
  const observer=new MutationObserver(records=>{
    if(records.every(record=>record.target?.closest?.('#dsh-pcm-panel')))return;
    schedule();
  });
  function start() {
    if (!document.body){document.addEventListener('DOMContentLoaded',start,{once:true});return;}
    mount();observeDom();draw();
    observer.observe(document.body,{
      subtree:true,childList:true,attributes:true,
      attributeFilter:['data-state','data-chat-call-id','data-tool','aria-selected']
    });
  }
  const external=event=>take(event.detail);
  window.addEventListener('dsh-android-tool-observed',external);
  window.__dshAndroidToolMonitor=Object.freeze({
    observe:take,
    setVisible:value=>{enabled=Boolean(value);if(!enabled){opened=false;rows.clear();}draw();},
    stop:()=>{observer.disconnect();window.removeEventListener('dsh-android-tool-observed',external);rows.clear();enabled=false;opened=false;draw();}
  });
  start();
})();
