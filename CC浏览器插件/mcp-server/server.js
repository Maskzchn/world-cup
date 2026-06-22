#!/usr/bin/env node
'use strict';

/**
 * CC Browser Bridge — MCP server (merged).
 *
 * Exposes browser-control tools to local Claude Code over MCP (stdio JSON-RPC),
 * and relays those commands to a Chrome extension over a localhost WebSocket.
 *
 * 架构: 独立常驻桥 (bridge.js, 多会话路由) <- server.js (每个 Claude Code 会话一个) ;
 *       浏览器侧扩展用 CDP + DOM 执行。
 *
 * stdout : MCP JSON-RPC ONLY (one message per line). Never print anything else here.
 * stderr : human-readable logs.
 */

const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.CC_BRIDGE_PORT || '8765', 10);
const VERSION = '2.0.0';

function log(...a) {
  process.stderr.write('[cc-browser] ' + a.join(' ') + '\n');
}

/* ----------------------------------------------------------------------- *
 *  WebSocket client to the standalone bridge (bridge.js).
 *  Auto-spawns the bridge daemon if it isn't already running.
 * ----------------------------------------------------------------------- */

let bridge = null;
let bridgeReady = false;
let spawnTried = false;
let cmdSeq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

function startBridgeDaemon() {
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'bridge.js')], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    log('spawned bridge daemon');
  } catch (e) {
    log('failed to spawn bridge:', e.message);
  }
}

function connectBridge() {
  bridge = new WebSocket('ws://127.0.0.1:' + PORT);

  bridge.on('open', () => {
    bridgeReady = true;
    spawnTried = false;
    bridge.send(JSON.stringify({ type: 'hello', role: 'mcp' }));
    log('connected to bridge on ' + PORT);
  });

  bridge.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'browser command failed'));
  });

  bridge.on('error', () => {
    if (!spawnTried) { spawnTried = true; startBridgeDaemon(); }
  });

  bridge.on('close', () => {
    bridgeReady = false;
    setTimeout(ensureBridge, 1500);
  });
}

function ensureBridge() {
  if (bridge && (bridge.readyState === 0 || bridge.readyState === 1)) return;
  connectBridge();
}

function waitReady(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (bridgeReady) return resolve();
    ensureBridge();
    const start = Date.now();
    const iv = setInterval(() => {
      if (bridgeReady) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(
          'Browser bridge not reachable on port ' + PORT + '. The bridge daemon should auto-start; ' +
          'if this persists, run "node bridge.js" manually and make sure the Chrome extension is connected.'
        ));
      }
    }, 150);
  });
}

async function browserCommand(method, params = {}, timeoutMs = 45000) {
  await waitReady();
  return new Promise((resolve, reject) => {
    const id = ++cmdSeq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Browser command "' + method + '" timed out'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    bridge.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------------- *
 *  MCP tool definitions
 * ----------------------------------------------------------------------- */

const tools = [
  {
    name: 'browser_list_tabs',
    description: 'List the open browser tabs (id, title, url, active, enabled). Use the returned tabId with other tools to target a specific tab. "enabled" indicates the tab is authorized for control.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_get_content',
    description: 'Read the visible text of a page (good for reading a document/article). Returns title, url and innerText (and a docTitle if the page is a doc editor).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id. Omit to use the active tab.' },
        maxChars: { type: 'number', description: 'Truncate text to this many characters (default 40000).' },
      },
    },
  },
  {
    name: 'browser_get_html',
    description: 'Get the HTML of the page or of a single element (by CSS selector). Useful to inspect structure before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        selector: { type: 'string', description: 'CSS selector. Omit to get the whole document HTML.' },
      },
    },
  },
  {
    name: 'browser_query',
    description: 'Query elements by CSS selector and return a compact list (tag, id, class, text, name, href). Use this to discover selectors before clicking/filling.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        tabId: { type: 'number' },
        limit: { type: 'number', description: 'Max elements to return (default 30).' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Snapshot the interactive elements on the page (links, buttons, inputs, editable areas) with a stable "ref", role, name and rect. Use the ref with browser_click / browser_type to target an element without guessing selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        maxElements: { type: 'number', description: 'Default 200.' },
      },
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab to a URL (or open a new tab, which is auto-authorized for control). Waits for the page to finish loading.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        tabId: { type: 'number', description: 'Tab to navigate. Ignored if newTab is true.' },
        newTab: { type: 'boolean', description: 'Open the URL in a new tab instead.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector, by (partial) visible text, by snapshot ref, or by absolute x/y. Set real=true to dispatch a CDP hardware-level click (needed for some canvas/rich editors).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string', description: 'Partial visible text to match if selector is not given.' },
        ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
        x: { type: 'number' }, y: { type: 'number' },
        real: { type: 'boolean', description: 'Use CDP real mouse event instead of element.click().' },
        tabId: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_fill',
    description: 'Set the value of an input, textarea or simple contenteditable and fire input/change events. Best for plain form fields. For rich editors (e.g. DingTalk/Yuque) prefer browser_type or browser_paste.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        value: { type: 'string' },
        tabId: { type: 'number' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text at the current caret using CDP Input.insertText (real input; works with contenteditable / DingTalk / Yuque Lake editors). Optionally focus a ref/selector first.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ref: { type: 'string' }, selector: { type: 'string' },
        tabId: { type: 'number' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_paste',
    description: 'Paste a whole block of text at once via a synthetic paste event (fast and reliable for rich editors). focus=true focuses the doc body/title first. Optional html for rich content.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        html: { type: 'string' },
        focus: { type: 'boolean' },
        target: { type: 'string', enum: ['body', 'title'] },
        ref: { type: 'string' }, selector: { type: 'string' },
        tabId: { type: 'number' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_focus',
    description: 'Focus the document body or title editing area (uses Lake/DingTalk-aware selectors + a CDP real click). target=body|title.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['body', 'title'] },
        tabId: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a functional key via CDP: Enter/Tab/Backspace/Delete/Escape/Arrow*/Home/End, with optional modifiers (Ctrl/Shift/Alt/Meta).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'number' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page (deltaY positive = down).',
    inputSchema: {
      type: 'object',
      properties: { dx: { type: 'number' }, dy: { type: 'number' }, tabId: { type: 'number' } },
    },
  },
  {
    name: 'browser_get_selection',
    description: 'Return the text the user has currently selected/highlighted on the page.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
  {
    name: 'browser_execute_js',
    description: 'Run JavaScript in the page and return the result. The most flexible escape hatch for reading/editing (manipulate the editor DOM, call the page\'s own APIs). Returns the value of the last expression. Runs in the page (MAIN) world by default.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        tabId: { type: 'number' },
        world: { type: 'string', enum: ['MAIN', 'ISOLATED'] },
      },
      required: ['code'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the visible area of a tab and return it as an image.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
  /* ----------------------- DingTalk high-level ----------------------- */
  {
    name: 'dingtalk_read_doc',
    description: 'Open a DingTalk doc URL in your logged-in browser and read it back as markdown (title + body).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'DingTalk doc link, e.g. https://alidocs.dingtalk.com/i/nodes/...' } },
      required: ['url'],
    },
  },
  {
    name: 'dingtalk_create_doc',
    description: 'Create a new DingTalk doc and write a title + body. Opens the new-doc page, focuses title/body and writes via real input/paste.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Body text (plain/markdown-ish). Pasted as one block.' },
        newDocUrl: { type: 'string', description: 'New-doc entry URL. Default https://alidocs.dingtalk.com/i/nodes/new' },
      },
      required: ['title'],
    },
  },
  {
    name: 'dingtalk_edit_doc',
    description: 'Append/insert text into an already-open DingTalk doc tab. atEnd=true jumps to the document end (Ctrl+End) first.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab of the open DingTalk doc (from dingtalk_read_doc / browser_list_tabs).' },
        text: { type: 'string' },
        atEnd: { type: 'boolean' },
      },
      required: ['tabId', 'text'],
    },
  },
];

/* ----------------------------------------------------------------------- *
 *  Tool dispatch
 * ----------------------------------------------------------------------- */

function text(s) { return { content: [{ type: 'text', text: s }] }; }
function json(o) { return text(JSON.stringify(o, null, 2)); }

async function callTool(name, args) {
  switch (name) {
    case 'browser_list_tabs':
      return json(await browserCommand('list_tabs'));

    case 'browser_get_content': {
      const r = await browserCommand('get_content', args);
      let t = r.text || '';
      const max = args.maxChars || 40000;
      if (t.length > max) t = t.slice(0, max) + '\n...[truncated, ' + (t.length - max) + ' more chars]';
      return text('# ' + (r.docTitle || r.title || '') + '\nURL: ' + (r.url || '') + '\n\n' + t);
    }
    case 'browser_get_html': {
      const r = await browserCommand('get_html', args);
      return text(r.html == null ? '[element not found]' : r.html);
    }
    case 'browser_query':
      return json(await browserCommand('query', args));
    case 'browser_snapshot':
      return json(await browserCommand('snapshot', args));
    case 'browser_navigate': {
      const r = await browserCommand('navigate', args, 30000);
      return text('Navigated. tabId=' + r.tabId + ' url=' + r.url);
    }
    case 'browser_click':
      return json(await browserCommand('click', args));
    case 'browser_fill':
      return json(await browserCommand('fill', args));
    case 'browser_type':
      return json(await browserCommand('type_text', args));
    case 'browser_paste':
      return json(await browserCommand('paste_text', args));
    case 'browser_focus':
      return json(await browserCommand('focus_target', args));
    case 'browser_press_key':
      return json(await browserCommand('press_key', args));
    case 'browser_scroll':
      return json(await browserCommand('scroll', args));
    case 'browser_get_selection': {
      const r = await browserCommand('get_selection', args);
      return text(r.text || '');
    }
    case 'browser_execute_js': {
      const r = await browserCommand('execute_js', args);
      if (r.ok) return text(r.value == null ? 'undefined' : String(r.value));
      return { content: [{ type: 'text', text: 'JS error: ' + r.error }], isError: true };
    }
    case 'browser_screenshot': {
      const r = await browserCommand('screenshot', args, 20000);
      const b64 = (r.dataUrl || '').split(',')[1] || r.base64 || '';
      return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
    }

    /* --------------------- DingTalk composites --------------------- */
    case 'dingtalk_read_doc': {
      const nav = await browserCommand('navigate', { url: args.url, newTab: true }, 30000);
      await sleep(2500);
      const r = await browserCommand('get_content', { tabId: nav.tabId });
      return text('# ' + (r.docTitle || r.title || '') + '\ntabId: ' + nav.tabId + '\nURL: ' + (r.url || '') + '\n\n' + (r.text || ''));
    }
    case 'dingtalk_create_doc': {
      const url = args.newDocUrl || 'https://alidocs.dingtalk.com/i/nodes/new';
      const nav = await browserCommand('navigate', { url, newTab: true }, 30000);
      await sleep(3000);
      const tabId = nav.tabId;
      await browserCommand('focus_target', { tabId, target: 'title' }).catch(() => {});
      await sleep(300);
      await browserCommand('type_text', { tabId, text: args.title });
      await sleep(300);
      if (args.content) {
        await browserCommand('focus_target', { tabId, target: 'body' }).catch(() => {});
        await sleep(300);
        const pasted = await browserCommand('paste_text', { tabId, text: args.content }).catch((e) => ({ error: e.message }));
        if (pasted && pasted.error) {
          await typeMultiline(tabId, args.content);
        }
      }
      await sleep(500);
      const info = await browserCommand('tab_info', { tabId }).catch(() => null);
      return json({ tabId, url: info ? info.url : url, note: '已新建并写入, 钉钉自动保存; 请在浏览器核对。' });
    }
    case 'dingtalk_edit_doc': {
      await browserCommand('focus_target', { tabId: args.tabId, target: 'body' }).catch(() => {});
      await sleep(200);
      if (args.atEnd) {
        await browserCommand('press_key', { tabId: args.tabId, key: 'End', modifiers: ['Ctrl'] });
        await sleep(200);
      }
      const pasted = await browserCommand('paste_text', { tabId: args.tabId, text: args.text }).catch((e) => ({ error: e.message }));
      if (pasted && pasted.error) await typeMultiline(args.tabId, args.text);
      return json({ ok: true, written: args.text.length });
    }

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

async function typeMultiline(tabId, content) {
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await browserCommand('type_text', { tabId, text: lines[i] });
    if (i < lines.length - 1) await browserCommand('press_key', { tabId, key: 'Enter' });
    await sleep(100);
  }
}

/* ----------------------------------------------------------------------- *
 *  MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * ----------------------------------------------------------------------- */

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cc-browser-bridge', version: VERSION },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools } }); return; }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments || {});
      send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + (e.message || String(e)) }], isError: true } });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

log('cc-browser-bridge v' + VERSION + ' started (MCP on stdio)');
ensureBridge();
