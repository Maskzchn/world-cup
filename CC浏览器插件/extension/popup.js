const $ = (id) => document.getElementById(id);
let state = null;

function render(s) {
  state = s;
  const connected = s && s.connected;
  $('dot').className = 'dot ' + (connected ? 'on' : 'off');
  $('status').textContent = connected ? '已连接' : '未连接';
  if (document.activeElement !== $('port')) $('port').value = (s && s.port) || 8765;
  $('allowAll').checked = !!(s && s.allowAll);

  if (s && s.activeTab) {
    $('tabTitle').textContent = s.activeTab.title || '(无标题)';
    $('tabUrl').textContent = s.activeTab.url || '';
    const btn = $('toggleTab');
    if (s.activeTab.enabled) { btn.textContent = '已启用 ✓ 点击停用'; btn.className = 'on'; }
    else { btn.textContent = '在当前标签页启用'; btn.className = ''; }
  } else {
    $('tabTitle').textContent = '无可用标签页';
    $('tabUrl').textContent = '';
  }
}

function refresh() { chrome.runtime.sendMessage({ type: 'status' }, render); }

$('connect').addEventListener('click', () => {
  const port = parseInt($('port').value, 10) || 8765;
  chrome.storage.local.set({ port }, () => {
    chrome.runtime.sendMessage({ type: 'connect' }, () => setTimeout(refresh, 600));
  });
});

$('toggleTab').addEventListener('click', () => {
  if (!state || !state.activeTab) return;
  chrome.runtime.sendMessage({ type: 'toggle_tab', tabId: state.activeTab.tabId }, () => setTimeout(refresh, 150));
});

$('allowAll').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({ type: 'set_allow_all', value: e.target.checked }, () => setTimeout(refresh, 150));
});

$('openPanel').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  try { await chrome.sidePanel.open({ windowId: tab.windowId }); window.close(); }
  catch (e) { try { await chrome.sidePanel.open({ tabId: tab.id }); window.close(); } catch (_) {} }
});

refresh();
setInterval(refresh, 1500);
