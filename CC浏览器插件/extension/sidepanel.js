const $ = (id) => document.getElementById(id);

function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0").slice(0, 2);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "POPUP_GET_STATE" });
  const st = $("status");
  if (state.status === "connected") { st.textContent = "● 已连接"; st.className = "status connected"; }
  else { st.textContent = "● 未连接"; st.className = "status disconnected"; }
  if (document.activeElement !== $("port")) $("port").value = state.port;

  // 标签页列表
  const tabs = await chrome.tabs.query({});
  const enabled = state.enabledTabs || [];
  const allMode = enabled.includes(0);
  $("tabsHint").textContent = allMode ? "(全部模式)" : "";
  const list = $("tabList");
  list.innerHTML = "";
  const controllable = tabs.filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"));
  const enabledOnes = controllable.filter((t) => enabled.includes(t.id));
  const shown = enabledOnes.length ? enabledOnes : controllable.filter((t) => t.active);
  if (!shown.length) {
    list.innerHTML = '<div class="empty">暂无已授权标签页。切到目标页后点“启用当前页”。</div>';
  }
  shown.forEach((t) => {
    const on = allMode || enabled.includes(t.id);
    const item = document.createElement("div");
    item.className = "tab-item";
    item.innerHTML = `<div class="meta"><div class="t"></div><div class="u"></div></div>`;
    item.querySelector(".t").textContent = t.title || "(无标题)";
    item.querySelector(".u").textContent = t.url;
    const btn = document.createElement("button");
    btn.className = on ? "primary enabled mini" : "ghost mini";
    btn.textContent = on ? "停用" : "启用";
    btn.onclick = async () => { await chrome.runtime.sendMessage({ type: "POPUP_TOGGLE_TAB", tabId: t.id }); refresh(); };
    item.appendChild(btn);
    list.appendChild(item);
  });

  // 顶部加“启用当前活动页”快捷
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && !enabled.includes(active.id) && !allMode) {
    const quick = document.createElement("button");
    quick.className = "primary wide mini";
    quick.style.marginTop = "8px";
    quick.textContent = "＋ 启用当前页";
    quick.onclick = async () => { await chrome.runtime.sendMessage({ type: "POPUP_TOGGLE_TAB", tabId: active.id }); refresh(); };
    list.appendChild(quick);
  }
}

async function renderLog() {
  const { activity } = await chrome.storage.local.get("activity");
  const log = $("log");
  log.innerHTML = "";
  (activity || []).forEach((e) => log.appendChild(logLine(e)));
}

function logLine(e) {
  const div = document.createElement("div");
  div.className = "log-line " + (e.ok ? "ok" : "err");
  const tab = e.tabId ? `#${e.tabId}` : "";
  div.innerHTML = `<span class="ts"></span><span class="dot">●</span><span class="m"></span>`;
  div.querySelector(".ts").textContent = fmtTime(e.t);
  div.querySelector(".m").textContent = `${e.method} ${tab} ${e.ms}ms`;
  if (!e.ok && e.error) {
    const em = document.createElement("span");
    em.className = "err-msg";
    em.textContent = "· " + e.error;
    div.appendChild(em);
  }
  return div;
}

$("savePort").addEventListener("click", async () => {
  const port = parseInt($("port").value, 10);
  if (port > 0 && port < 65536) { await chrome.runtime.sendMessage({ type: "POPUP_SET_PORT", port }); setTimeout(refresh, 500); }
});
$("reconnect").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "POPUP_RECONNECT" }); setTimeout(refresh, 500); });
$("clearLog").addEventListener("click", async () => { await chrome.storage.local.set({ activity: [] }); renderLog(); });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") refresh();
  if (msg.type === "ACTIVITY") { const log = $("log"); log.insertBefore(logLine(msg.entry), log.firstChild); }
});

refresh();
renderLog();
setInterval(refresh, 2500);
