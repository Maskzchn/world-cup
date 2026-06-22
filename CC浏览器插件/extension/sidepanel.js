const $ = (id) => document.getElementById(id);

function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 2);
}

function getState() { return new Promise((r) => chrome.runtime.sendMessage({ type: 'status' }, r)); }

async function refresh() {
  const s = await getState();
  $('status').textContent = s.connected ? '● 已连接' : '● 未连接';
  $('status').className = 'status ' + (s.connected ? 'on' : 'off');
  if (document.activeElement !== $('port')) $('port').value = s.port || 8765;
  $('allowAll').checked = !!s.allowAll;

  const tabs = await chrome.tabs.query({});
  const enabled = s.enabledTabs || [];
  const list = $('tabList');
  list.innerHTML = '';
  const controllable = tabs.filter((t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
  const enabledOnes = controllable.filter((t) => enabled.includes(t.id));
  if (!enabledOnes.length) list.innerHTML = '<div class="empty">暂无已授权标签页。切到目标页点“启用当前页”。</div>';
  enabledOnes.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.innerHTML = '<div class="meta"><div class="t"></div><div class="u"></div></div>';
    item.querySelector('.t').textContent = t.title || '(无标题)';
    item.querySelector('.u').textContent = t.url;
    const btn = document.createElement('button');
    btn.className = 'on mini'; btn.textContent = '停用';
    btn.onclick = () => chrome.runtime.sendMessage({ type: 'toggle_tab', tabId: t.id }, () => setTimeout(refresh, 150));
    item.appendChild(btn);
    list.appendChild(item);
  });

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && !enabled.includes(active.id) && !s.allowAll) {
    const quick = document.createElement('button');
    quick.className = 'wide mini'; quick.textContent = '＋ 启用当前页';
    quick.onclick = () => chrome.runtime.sendMessage({ type: 'toggle_tab', tabId: active.id }, () => setTimeout(refresh, 150));
    list.appendChild(quick);
  }
}

function logLine(e) {
  const div = document.createElement('div');
  div.className = 'log-line ' + (e.ok ? 'ok' : 'err');
  div.innerHTML = '<span class="ts"></span><span class="dot">●</span><span class="m"></span>';
  div.querySelector('.ts').textContent = fmtTime(e.t);
  div.querySelector('.m').textContent = e.method + ' ' + (e.tabId ? '#' + e.tabId : '') + ' ' + e.ms + 'ms';
  if (!e.ok && e.error) { const em = document.createElement('span'); em.className = 'err-msg'; em.textContent = '· ' + e.error; div.appendChild(em); }
  return div;
}

async function renderLog() {
  const { activity } = await chrome.storage.local.get('activity');
  const log = $('log'); log.innerHTML = '';
  (activity || []).forEach((e) => log.appendChild(logLine(e)));
}

$('connect').addEventListener('click', () => {
  const port = parseInt($('port').value, 10) || 8765;
  chrome.storage.local.set({ port }, () => chrome.runtime.sendMessage({ type: 'connect' }, () => setTimeout(refresh, 600)));
});
$('allowAll').addEventListener('change', (e) => chrome.runtime.sendMessage({ type: 'set_allow_all', value: e.target.checked }, () => setTimeout(refresh, 150)));
$('clearLog').addEventListener('click', () => chrome.storage.local.set({ activity: [] }, renderLog));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') refresh();
  if (msg.type === 'ACTIVITY') { const log = $('log'); log.insertBefore(logLine(msg.entry), log.firstChild); }
});

refresh();
renderLog();
setInterval(refresh, 2500);
