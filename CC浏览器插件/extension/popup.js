const $ = (id) => document.getElementById(id);
let state = null;

async function refresh() {
  state = await chrome.runtime.sendMessage({ type: "POPUP_GET_STATE" });
  const st = $("status");
  if (state.status === "connected") {
    st.textContent = "● 已连接";
    st.className = "status connected";
  } else {
    st.textContent = "● 未连接";
    st.className = "status disconnected";
  }
  $("port").value = state.port;
  $("enabledCount").textContent = `已授权标签页: ${state.enabledTabs.filter((t) => t !== 0).length}${state.enabledTabs.includes(0) ? " (全部)" : ""}`;

  if (state.activeTab) {
    $("tabTitle").textContent = state.activeTab.title || "(无标题)";
    $("tabUrl").textContent = state.activeTab.url || "";
    const btn = $("toggleTab");
    if (state.activeTab.enabled) {
      btn.textContent = "已启用 ✓ 点击停用";
      btn.className = "primary wide enabled";
    } else {
      btn.textContent = "在当前标签页启用";
      btn.className = "primary wide";
    }
  } else {
    $("tabTitle").textContent = "无可用标签页";
  }
}

$("toggleTab").addEventListener("click", async () => {
  if (!state || !state.activeTab) return;
  await chrome.runtime.sendMessage({ type: "POPUP_TOGGLE_TAB", tabId: state.activeTab.tabId });
  refresh();
});

$("savePort").addEventListener("click", async () => {
  const port = parseInt($("port").value, 10);
  if (port > 0 && port < 65536) {
    await chrome.runtime.sendMessage({ type: "POPUP_SET_PORT", port });
    setTimeout(refresh, 500);
  }
});

$("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "POPUP_RECONNECT" });
  setTimeout(refresh, 500);
});

$("openPanel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } catch (e) {
    // 某些版本需 tabId
    try { await chrome.sidePanel.open({ tabId: tab.id }); window.close(); } catch {}
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") refresh();
});

refresh();
setInterval(refresh, 2000);
