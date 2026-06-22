/**
 * CC Browser Bridge — extension background service worker (merged).
 *
 * - 维护到本地常驻桥 (bridge.js) 的 WebSocket 连接, 代为执行浏览器命令。
 * - 读取/探查走 DOM 注入 (chrome.scripting.executeScript)。
 * - 点击/输入/按键/滚动走 CDP (chrome.debugger), 真实事件, 兼容钉钉/语雀 Lake 富文本。
 * - 安全开关: 仅在“已授权”标签页执行写操作 (读操作不限制)。
 * - 活动日志: 每条命令广播给侧边栏并落盘。
 */

const DEFAULT_PORT = 8765;
const CDP_VERSION = '1.3';

let ws = null;
let reconnectTimer = null;
const attached = new Set(); // 已 attach 调试器的 tabId

/* 钉钉/语雀 Lake 编辑器选择器 (供注入函数使用) */
const BODY_SELECTORS = [
  '.ne-viewer-body', '.ne-engine', '.lake-engine-view', '.lakex-engine',
  '.lake-engine', '[data-lake-id]', '[data-lake-element="root"]',
  '.doc-content', '[data-testid="editor"]', '.ant-doc-editor', '.lake-editor',
];
const TITLE_SELECTORS = [
  'textarea[placeholder*="标题"]', 'input[placeholder*="标题"]',
  '.doc-title-input textarea', '.doc-title textarea', '.doc-title input',
  '[data-testid="title"] textarea', 'h1.title', '.title-editor',
];

/* ------------------------------ 配置 ------------------------------ */
async function getPort() {
  const { port } = await chrome.storage.local.get('port');
  return port || DEFAULT_PORT;
}
async function getEnabled() {
  const { enabledTabs, allowAll } = await chrome.storage.local.get(['enabledTabs', 'allowAll']);
  return { enabledTabs: enabledTabs || [], allowAll: !!allowAll };
}
async function isEnabled(tabId) {
  const { enabledTabs, allowAll } = await getEnabled();
  return allowAll || enabledTabs.includes(tabId);
}
async function requireAuth(tabId) {
  if (!(await isEnabled(tabId))) {
    throw new Error('标签页 ' + tabId + ' 未授权。请在扩展弹窗/侧边栏点击“启用当前页”。');
  }
}
async function authorizeTab(tabId) {
  const { enabledTabs } = await getEnabled();
  if (!enabledTabs.includes(tabId)) {
    enabledTabs.push(tabId);
    await chrome.storage.local.set({ enabledTabs });
  }
}

/* ------------------------------ WS ------------------------------ */
function setStatus(connected) {
  chrome.storage.local.set({ connected });
  chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#16a34a' : '#9ca3af' });
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', connected }).catch(() => {});
}

async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const port = await getPort();
  try { ws = new WebSocket('ws://127.0.0.1:' + port); }
  catch (e) { scheduleReconnect(); return; }

  ws.onopen = () => {
    setStatus(true);
    safeSend({ type: 'hello', role: 'extension', userAgent: navigator.userAgent });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.method) handleCommand(msg);
  };
  ws.onclose = () => { setStatus(false); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function scheduleReconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 3000); }
function safeSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function reply(id, ok, result, error) { safeSend({ id, ok, result, error }); }

async function handleCommand(msg) {
  const startedAt = Date.now();
  try {
    const result = await dispatch(msg.method, msg.params || {});
    reply(msg.id, true, result);
    logActivity({ method: msg.method, tabId: (msg.params || {}).tabId, ok: true, ms: Date.now() - startedAt });
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    reply(msg.id, false, null, error);
    logActivity({ method: msg.method, tabId: (msg.params || {}).tabId, ok: false, error, ms: Date.now() - startedAt });
  }
}

/* --------------------------- 活动日志 --------------------------- */
const ACTIVITY_MAX = 60;
async function logActivity(entry) {
  entry.t = Date.now();
  const { activity } = await chrome.storage.local.get('activity');
  const list = activity || [];
  list.unshift(entry);
  if (list.length > ACTIVITY_MAX) list.length = ACTIVITY_MAX;
  await chrome.storage.local.set({ activity: list });
  chrome.runtime.sendMessage({ type: 'ACTIVITY', entry }).catch(() => {});
}

/* ------------------------------ helpers ------------------------------ */
async function resolveTab(params) {
  if (params.tabId) return params.tabId;
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}
async function exec(tabId, func, args = [], world = 'ISOLATED') {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return res ? res.result : undefined;
}
function waitForLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const finish = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(t); setTimeout(resolve, 600); };
    const t = setTimeout(finish, timeout);
    function listener(id, info) { if (id === tabId && info.status === 'complete') finish(); }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab && tab.status === 'complete') finish(); }).catch(() => {});
  });
}

/* ------------------------------ CDP ------------------------------ */
async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  attached.add(tabId);
}
function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(method + ': ' + err.message));
      else resolve(res);
    });
  });
}
chrome.debugger.onDetach.addListener((src) => { if (src.tabId) attached.delete(src.tabId); });
chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  const { enabledTabs } = await getEnabled();
  const next = enabledTabs.filter((t) => t !== tabId);
  if (next.length !== enabledTabs.length) chrome.storage.local.set({ enabledTabs: next });
});

async function cdpClick(tabId, x, y) {
  await attach(tabId);
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, clickCount: 0 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

const KEY_MAP = {
  Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 },
  Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { code: 'Home', key: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', key: 'End', windowsVirtualKeyCode: 35 },
};

/* --------------------- 注入函数 (在页面里执行) --------------------- */
function injResolvePoint(ref, selector, matchText) {
  let el = null;
  if (ref) el = document.querySelector('[data-cc-ref="' + ref + '"]');
  if (!el && selector) el = document.querySelector(selector);
  if (!el && matchText) {
    const nodes = Array.from(document.querySelectorAll('a,button,[role=button],input,div,span,li,td'));
    el = nodes.find((n) => ((n.innerText || n.value || '') + '').trim().includes(matchText));
  }
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function injFocusPoint(target, bodySel, titleSel) {
  const sels = target === 'title' ? titleSel : bodySel;
  let el = null;
  for (const s of sels) { el = document.querySelector(s); if (el) break; }
  if (!el && target !== 'title') el = document.querySelector('[contenteditable="true"]');
  if (!el) return { found: false };
  const inner = el.querySelector && el.querySelector('[contenteditable="true"]');
  if (inner) el = inner;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const y = target === 'title' ? r.top + r.height / 2 : Math.min(r.bottom - 16, r.top + r.height / 2);
  return { found: true, x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(y) };
}

function injSnapshot(maxElements, bodySel) {
  const SEL = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=textbox],[contenteditable=true],summary,label';
  const out = []; const seen = new Set(); let n = 0;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && r.top < innerHeight + 1500 && r.bottom > -50;
  };
  document.querySelectorAll(SEL).forEach((el) => {
    if (out.length >= (maxElements || 200) || seen.has(el) || !vis(el)) return;
    seen.add(el);
    const ref = 'e' + (++n);
    el.setAttribute('data-cc-ref', ref);
    const r = el.getBoundingClientRect();
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    out.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || el.type || el.tagName.toLowerCase(), name, editable: el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA', rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  });
  return { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight }, elements: out };
}

function injPaste(text, html, ref, selector, bodySel) {
  let el = null;
  if (ref) el = document.querySelector('[data-cc-ref="' + ref + '"]');
  if (!el && selector) el = document.querySelector(selector);
  if (!el) { for (const s of bodySel) { el = document.querySelector(s); if (el) break; } }
  if (!el) el = document.activeElement;
  if (!el) return { ok: false, error: 'no target' };
  const inner = el.querySelector && el.querySelector('[contenteditable="true"]');
  if (inner) el = inner;
  el.focus();
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text || '');
    if (html) dt.setData('text/html', html);
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    const notHandled = el.dispatchEvent(ev);
    if (notHandled) document.execCommand('insertText', false, text || '');
  } catch (e) {
    try { document.execCommand('insertText', false, text || ''); } catch (_) {}
  }
  return { ok: true, length: (text || '').length };
}

function injCursor(x, y) {
  let c = document.getElementById('__cc_cursor');
  if (!c) {
    c = document.createElement('div');
    c.id = '__cc_cursor';
    c.style.cssText = 'position:fixed;top:0;left:0;width:18px;height:18px;margin:-4px 0 0 -4px;z-index:2147483647;pointer-events:none;border-radius:50%;background:rgba(37,99,235,.35);border:2px solid #2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.15);transition:transform .18s cubic-bezier(.22,1,.36,1),opacity .3s;';
    document.documentElement.appendChild(c);
  }
  c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  c.style.opacity = '1';
  clearTimeout(c.__h);
  c.__h = setTimeout(() => { c.style.opacity = '0'; }, 2500);
  return true;
}

/* ------------------------------ dispatch ------------------------------ */
async function dispatch(method, params) {
  switch (method) {
    /* ---------- 读取 / 探查 (不需授权) ---------- */
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      const { enabledTabs, allowAll } = await getEnabled();
      return tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, enabled: allowAll || enabledTabs.includes(t.id) }));
    }
    case 'tab_info': {
      const t = await chrome.tabs.get(params.tabId);
      return { tabId: t.id, title: t.title, url: t.url, status: t.status };
    }
    case 'get_content': {
      const tabId = await resolveTab(params);
      return exec(tabId, (titleSel, bodySel) => {
        let docTitle = '';
        for (const s of titleSel) { const e = document.querySelector(s); if (e) { docTitle = (e.value || e.innerText || '').trim(); break; } }
        let root = document.body;
        for (const s of bodySel) { const e = document.querySelector(s); if (e && (e.innerText || '').trim().length > 20) { root = e; break; } }
        return { title: document.title, docTitle, url: location.href, text: root ? root.innerText : '' };
      }, [TITLE_SELECTORS, BODY_SELECTORS]);
    }
    case 'get_html': {
      const tabId = await resolveTab(params);
      return exec(tabId, (selector) => {
        const el = selector ? document.querySelector(selector) : document.documentElement;
        return { html: el ? el.outerHTML : null };
      }, [params.selector || null]);
    }
    case 'query': {
      const tabId = await resolveTab(params);
      return exec(tabId, (selector, limit) => Array.from(document.querySelectorAll(selector)).slice(0, limit || 30).map((el) => ({
        tag: el.tagName, id: el.id || undefined,
        class: (typeof el.className === 'string' && el.className) || undefined,
        name: el.getAttribute('name') || undefined, href: el.getAttribute('href') || undefined,
        text: ((el.innerText || el.value || '') + '').trim().slice(0, 120) || undefined,
      })), [params.selector, params.limit || 30]);
    }
    case 'snapshot': {
      const tabId = await resolveTab(params);
      return exec(tabId, injSnapshot, [params.maxElements || 200, BODY_SELECTORS]);
    }
    case 'get_selection': {
      const tabId = await resolveTab(params);
      return exec(tabId, () => ({ text: window.getSelection().toString() }));
    }
    case 'screenshot': {
      const tabId = await resolveTab(params);
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { dataUrl };
    }

    /* ---------- 导航 ---------- */
    case 'navigate': {
      if (params.newTab) {
        const tab = await chrome.tabs.create({ url: params.url });
        await authorizeTab(tab.id); // 新开标签页自动授权
        await waitForLoad(tab.id);
        const cur = await chrome.tabs.get(tab.id);
        return { tabId: tab.id, url: cur.url };
      }
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      await chrome.tabs.update(tabId, { url: params.url });
      await waitForLoad(tabId);
      const cur = await chrome.tabs.get(tabId);
      return { tabId, url: cur.url };
    }

    /* ---------- 写操作 (需授权) ---------- */
    case 'click': {
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      let x = params.x, y = params.y;
      if (x == null || y == null) {
        const pt = await exec(tabId, injResolvePoint, [params.ref || null, params.selector || null, params.text || null]);
        if (!pt || !pt.found) return { clicked: false, reason: 'element not found' };
        x = pt.x; y = pt.y;
      }
      await exec(tabId, injCursor, [x, y]).catch(() => {});
      if (params.real || params.x != null) {
        await cdpClick(tabId, x, y);
        return { clicked: true, via: 'cdp', x, y };
      }
      // 默认 DOM 点击 (更快, 多数页面够用)
      const r = await exec(tabId, (ref, selector, matchText) => {
        let el = null;
        if (ref) el = document.querySelector('[data-cc-ref="' + ref + '"]');
        if (!el && selector) el = document.querySelector(selector);
        if (!el && matchText) { const nodes = Array.from(document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],div,span,li,td')); el = nodes.find((n) => ((n.innerText || n.value || '') + '').trim().includes(matchText)); }
        if (!el) return { clicked: false, reason: 'element not found' };
        el.scrollIntoView({ block: 'center' }); el.click();
        return { clicked: true, via: 'dom', tag: el.tagName, text: ((el.innerText || '') + '').slice(0, 80) };
      }, [params.ref || null, params.selector || null, params.text || null]);
      return r;
    }
    case 'fill': {
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      return exec(tabId, (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return { filled: false, reason: 'element not found' };
        el.focus();
        if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { filled: true };
      }, [params.selector, params.value]);
    }
    case 'focus_target': {
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      const pt = await exec(tabId, injFocusPoint, [params.target || 'body', BODY_SELECTORS, TITLE_SELECTORS]);
      if (!pt || !pt.found) throw new Error('找不到' + (params.target === 'title' ? '标题' : '正文') + '编辑区');
      await exec(tabId, injCursor, [pt.x, pt.y]).catch(() => {});
      await cdpClick(tabId, pt.x, pt.y);
      return { ok: true, ...pt };
    }
    case 'type_text': {
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      if (params.ref || params.selector) {
        const pt = await exec(tabId, injResolvePoint, [params.ref || null, params.selector || null, null]);
        if (pt && pt.found) { await exec(tabId, injCursor, [pt.x, pt.y]).catch(() => {}); await cdpClick(tabId, pt.x, pt.y); }
      }
      await attach(tabId);
      await cdp(tabId, 'Input.insertText', { text: params.text || '' });
      return { ok: true, length: (params.text || '').length };
    }
    case 'paste_text': {
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      if (params.focus) {
        const pt = await exec(tabId, injFocusPoint, [params.target || 'body', BODY_SELECTORS, TITLE_SELECTORS]);
        if (pt && pt.found) { await exec(tabId, injCursor, [pt.x, pt.y]).catch(() => {}); await cdpClick(tabId, pt.x, pt.y); }
      }
      return exec(tabId, injPaste, [params.text || '', params.html || null, params.ref || null, params.selector || null, BODY_SELECTORS]);
    }
    case 'press_key': {
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      const spec = KEY_MAP[params.key];
      if (!spec) throw new Error('不支持的按键: ' + params.key);
      const modifiers = (params.modifiers || []).reduce((m, k) => m | ({ Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Shift: 8 }[k] || 0), 0);
      await attach(tabId);
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...spec });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...spec });
      return { ok: true };
    }
    case 'scroll': {
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      await attach(tabId);
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 300, deltaX: params.dx || 0, deltaY: params.dy != null ? params.dy : 600 });
      return { ok: true };
    }
    case 'execute_js': {
      const tabId = await resolveTab(params);
      await requireAuth(tabId);
      const world = params.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
      return exec(tabId, (code) => {
        try {
          const r = (0, eval)(code);
          let value;
          if (r === undefined) value = undefined;
          else if (r === null) value = null;
          else if (typeof r === 'object') { try { value = JSON.stringify(r); } catch (_) { value = String(r); } }
          else value = String(r);
          return { ok: true, value };
        } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
      }, [params.code], world);
    }

    default:
      throw new Error('Unknown method: ' + method);
  }
}

/* ------------------------------ lifecycle ------------------------------ */
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { if (!ws || ws.readyState > 1) connect(); });

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  (async () => {
    if (req.type === 'connect') { connect(); sendResponse({ ok: true }); return; }
    if (req.type === 'status') {
      const { connected, port } = await chrome.storage.local.get(['connected', 'port']);
      const { enabledTabs, allowAll } = await getEnabled();
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      sendResponse({ connected: !!connected, port: port || DEFAULT_PORT, enabledTabs, allowAll, activeTab: tab ? { tabId: tab.id, title: tab.title, url: tab.url, enabled: allowAll || enabledTabs.includes(tab.id), windowId: tab.windowId } : null });
      return;
    }
    if (req.type === 'toggle_tab') {
      const { enabledTabs } = await getEnabled();
      const i = enabledTabs.indexOf(req.tabId);
      if (i >= 0) enabledTabs.splice(i, 1); else enabledTabs.push(req.tabId);
      await chrome.storage.local.set({ enabledTabs });
      sendResponse({ enabledTabs });
      return;
    }
    if (req.type === 'set_allow_all') { await chrome.storage.local.set({ allowAll: !!req.value }); sendResponse({ ok: true }); return; }
  })();
  return true; // async
});

connect();
