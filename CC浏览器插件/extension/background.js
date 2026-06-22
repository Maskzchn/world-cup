// CC Browser Bridge - background service worker (MV3, module)
//
// 职责:
//  1. 维护到本地桥接进程的 WebSocket 连接 (ws://127.0.0.1:<port>)
//  2. 接收 Claude Code 经 MCP->桥 下发的命令, 用 CDP + DOM 执行, 回传结果
//  3. 管理“受控标签页”白名单, 只在用户授权的标签页上操作 (安全开关)

const DEFAULT_PORT = 8765;
const CDP_VERSION = "1.3";

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000; // 指数退避, 上限 16s
let pingTimer = null;

// 当前已 attach 调试器的标签页集合
const attached = new Set();

// ---------------------------------------------------------------------------
// 配置存取
// ---------------------------------------------------------------------------
async function getConfig() {
  const { bridgePort, enabledTabs } = await chrome.storage.local.get([
    "bridgePort",
    "enabledTabs",
  ]);
  return {
    port: bridgePort || DEFAULT_PORT,
    enabledTabs: enabledTabs || [],
  };
}

async function isTabEnabled(tabId) {
  const { enabledTabs } = await getConfig();
  // 0 表示“全部标签页”通配 (高级模式); 否则按白名单
  return enabledTabs.includes(0) || enabledTabs.includes(tabId);
}

// ---------------------------------------------------------------------------
// WebSocket 连接管理
// ---------------------------------------------------------------------------
async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const { port } = await getConfig();
  const url = `ws://127.0.0.1:${port}`;
  try {
    socket = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectDelay = 1000;
    broadcastStatus("connected");
    send({ type: "hello", role: "extension", version: chrome.runtime.getManifest().version });
    startPing();
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "command") {
      await handleCommand(msg);
    }
  };

  socket.onclose = () => {
    stopPing();
    broadcastStatus("disconnected");
    scheduleReconnect();
  };

  socket.onerror = () => {
    try { socket.close(); } catch {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 16000);
    connect();
  }, reconnectDelay);
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => send({ type: "ping", t: Date.now() }), 20000);
}
function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function broadcastStatus(status) {
  chrome.storage.local.set({ connectionStatus: status, statusAt: Date.now() });
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", status }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 命令分发: 收到 {type:"command", id, method, params}, 回传 {type:"result", id, ok, result|error}
// ---------------------------------------------------------------------------
async function handleCommand({ id, method, params }) {
  params = params || {};
  try {
    const result = await dispatch(method, params);
    send({ type: "result", id, ok: true, result });
  } catch (err) {
    send({ type: "result", id, ok: false, error: String(err && err.message ? err.message : err) });
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "list_tabs":
      return await listTabs();
    case "get_active_tab":
      return await getActiveControllableTab();
    case "tab_info": {
      const t = await chrome.tabs.get(params.tabId);
      return { tabId: t.id, title: t.title, url: t.url, status: t.status };
    }
    case "navigate":
      return await navigate(params);
    case "get_content":
      return await contentAction(params.tabId, { action: "readContent", format: params.format || "markdown" });
    case "snapshot":
      return await contentAction(params.tabId, { action: "snapshot", maxElements: params.maxElements || 200 });
    case "screenshot":
      return await screenshot(params);
    case "click":
      return await click(params);
    case "type_text":
      return await typeText(params);
    case "fill":
      return await contentAction(params.tabId, { action: "fill", selector: params.selector, ref: params.ref, text: params.text });
    case "press_key":
      return await pressKey(params);
    case "scroll":
      return await scroll(params);
    case "eval_js":
      return await evalJs(params);
    default:
      throw new Error(`未知方法: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// 标签页相关
// ---------------------------------------------------------------------------
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  const { enabledTabs } = await getConfig();
  return tabs
    .filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
    .map((t) => ({
      tabId: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      enabled: enabledTabs.includes(0) || enabledTabs.includes(t.id),
    }));
}

async function getActiveControllableTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("没有活动标签页");
  return { tabId: tab.id, title: tab.title, url: tab.url };
}

async function resolveTabId(params) {
  let tabId = params.tabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error("没有可用标签页, 请传入 tabId");
    tabId = tab.id;
  }
  if (!(await isTabEnabled(tabId))) {
    throw new Error(`标签页 ${tabId} 未授权。请在扩展弹窗中点击“在当前标签页启用”。`);
  }
  return tabId;
}

async function navigate({ tabId, url, newTab }) {
  if (!url) throw new Error("navigate 需要 url");
  let tab;
  if (newTab) {
    tab = await chrome.tabs.create({ url, active: true });
    // 新建的标签页自动加入授权白名单
    const { enabledTabs } = await getConfig();
    if (!enabledTabs.includes(tab.id)) {
      enabledTabs.push(tab.id);
      await chrome.storage.local.set({ enabledTabs });
    }
  } else {
    const id = await resolveTabId({ tabId });
    tab = await chrome.tabs.update(id, { url });
  }
  await waitForTabComplete(tab.id);
  const finalTab = await chrome.tabs.get(tab.id);
  return { tabId: tab.id, url: finalTab.url, title: finalTab.title };
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      // 给前端框架渲染一点时间
      setTimeout(resolve, 800);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === "complete") finish();
    });
    setTimeout(finish, timeout);
  });
}

// ---------------------------------------------------------------------------
// 与 content script 通信 (DOM 层: 读取/快照/填充)
// ---------------------------------------------------------------------------
async function contentAction(tabId, message) {
  const id = await resolveTabId({ tabId });
  await ensureContentScript(id);
  return await chrome.tabs.sendMessage(id, message);
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    if (pong && pong.ok) return;
  } catch {
    // 未注入, 动态注入
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {});
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CDP 层: 真实输入事件 / 截图
// ---------------------------------------------------------------------------
async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  attached.add(tabId);
  await cdp(tabId, "DOM.enable", {});
  await cdp(tabId, "Runtime.enable", {});
}

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(res);
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  cleanupEnabledTab(tabId);
});

async function cleanupEnabledTab(tabId) {
  const { enabledTabs } = await getConfig();
  const next = enabledTabs.filter((t) => t !== tabId);
  if (next.length !== enabledTabs.length) await chrome.storage.local.set({ enabledTabs: next });
}

async function withDebugger(tabId, fn) {
  await attach(tabId);
  try {
    return await fn();
  } finally {
    // 保持 attach 以便连续操作; 由空闲检测/标签关闭时清理
  }
}

// 点击: 支持 ref / selector / 坐标。先解析坐标, 显示代理光标, 再派发真实鼠标事件
async function click(params) {
  const tabId = await resolveTabId(params);
  let x = params.x, y = params.y;
  if (x == null || y == null) {
    const point = await contentAction(tabId, { action: "resolvePoint", ref: params.ref, selector: params.selector });
    x = point.x; y = point.y;
    await chrome.tabs.sendMessage(tabId, { action: "cursorTo", x, y }).catch(() => {});
  }
  await withDebugger(tabId, async () => {
    const base = { x, y, button: "left", clickCount: 1 };
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base, clickCount: 0 });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  });
  return { ok: true, x, y };
}

// 输入文本: 用 CDP Input.insertText (像真实输入, 兼容 contenteditable / 钉钉编辑器)
async function typeText(params) {
  const tabId = await resolveTabId(params);
  if (params.ref || params.selector) {
    // 先聚焦目标
    const point = await contentAction(tabId, { action: "resolvePoint", ref: params.ref, selector: params.selector });
    await chrome.tabs.sendMessage(tabId, { action: "cursorTo", x: point.x, y: point.y }).catch(() => {});
    await withDebugger(tabId, async () => {
      const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    });
  }
  await withDebugger(tabId, async () => {
    await cdp(tabId, "Input.insertText", { text: params.text || "" });
  });
  return { ok: true, length: (params.text || "").length };
}

const KEY_MAP = {
  Enter: { code: "Enter", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", key: "Delete", windowsVirtualKeyCode: 46 },
  Escape: { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { code: "Home", key: "Home", windowsVirtualKeyCode: 36 },
  End: { code: "End", key: "End", windowsVirtualKeyCode: 35 },
};

async function pressKey(params) {
  const tabId = await resolveTabId(params);
  const spec = KEY_MAP[params.key];
  if (!spec) throw new Error(`不支持的按键: ${params.key}`);
  const modifiers = (params.modifiers || []).reduce((m, k) => {
    return m | ({ Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Shift: 8 }[k] || 0);
  }, 0);
  await withDebugger(tabId, async () => {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...spec });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...spec });
  });
  return { ok: true };
}

async function scroll(params) {
  const tabId = await resolveTabId(params);
  const dx = params.dx || 0, dy = params.dy != null ? params.dy : 600;
  await withDebugger(tabId, async () => {
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x: params.x || 300, y: params.y || 300, deltaX: dx, deltaY: dy,
    });
  });
  return { ok: true, dx, dy };
}

async function screenshot(params) {
  const tabId = await resolveTabId(params);
  const data = await withDebugger(tabId, async () => {
    const res = await cdp(tabId, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return res.data;
  });
  return { mimeType: "image/png", base64: data };
}

async function evalJs(params) {
  const tabId = await resolveTabId(params);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (code) => {
      try { return { ok: true, value: eval(code) }; }
      catch (e) { return { ok: false, error: String(e) }; }
    },
    args: [params.expression || ""],
  });
  return result;
}

// ---------------------------------------------------------------------------
// 来自 popup 的消息 (启用/禁用标签页、查询状态、手动重连)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "POPUP_GET_STATE") {
      const { connectionStatus } = await chrome.storage.local.get("connectionStatus");
      const { enabledTabs, port } = await getConfig();
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      sendResponse({
        status: connectionStatus || "disconnected",
        port,
        enabledTabs,
        activeTab: tab ? { tabId: tab.id, title: tab.title, url: tab.url, enabled: enabledTabs.includes(tab.id) || enabledTabs.includes(0) } : null,
      });
    } else if (msg.type === "POPUP_TOGGLE_TAB") {
      const { enabledTabs } = await getConfig();
      const idx = enabledTabs.indexOf(msg.tabId);
      if (idx >= 0) enabledTabs.splice(idx, 1);
      else enabledTabs.push(msg.tabId);
      await chrome.storage.local.set({ enabledTabs });
      sendResponse({ enabledTabs });
    } else if (msg.type === "POPUP_SET_PORT") {
      await chrome.storage.local.set({ bridgePort: msg.port });
      try { if (socket) socket.close(); } catch {}
      reconnectDelay = 1000;
      connect();
      sendResponse({ ok: true });
    } else if (msg.type === "POPUP_RECONNECT") {
      try { if (socket) socket.close(); } catch {}
      reconnectDelay = 1000;
      connect();
      sendResponse({ ok: true });
    }
  })();
  return true; // async
});

// ---------------------------------------------------------------------------
// 启动 + keepalive (MV3 service worker 会休眠, 用 alarms 唤醒重连)
// ---------------------------------------------------------------------------
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
