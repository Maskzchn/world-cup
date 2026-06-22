#!/usr/bin/env node
'use strict';

/**
 * CC Browser Bridge — standalone WebSocket hub.
 *
 * A small always-on daemon that both the Chrome extension and the MCP server
 * (server.js, one per Claude Code session) connect to. It routes browser
 * commands from any MCP client to the single connected extension, and routes
 * the extension's responses back to the right MCP client.
 *
 *   Chrome extension  --(role: extension)-->  bridge  <--(role: mcp)--  server.js
 *
 * Run standalone:  node bridge.js
 * server.js will also auto-spawn this if it isn't already running.
 */

const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.CC_BRIDGE_PORT || '8765', 10);

function log(...a) { process.stderr.write('[cc-bridge] ' + a.join(' ') + '\n'); }

let extensionWS = null;          // the one connected Chrome extension
const mcpClients = new Set();    // connected MCP servers (Claude Code sessions)
let seq = 0;
const route = new Map();         // bridgeId -> { client, origId }

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

wss.on('listening', () => log('listening on ws://127.0.0.1:' + PORT));

wss.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    // Another bridge already owns the port — that's fine, let it be the one.
    log('port ' + PORT + ' already in use; another bridge is running. Exiting.');
    process.exit(0);
  }
  log('error:', e.message);
});

wss.on('connection', (ws) => {
  ws._role = null;
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (_) { return; }

    if (m.type === 'hello') {
      ws._role = m.role === 'mcp' ? 'mcp' : 'extension';
      if (ws._role === 'extension') {
        if (extensionWS && extensionWS !== ws) { try { extensionWS.close(); } catch (_) {} }
        extensionWS = ws;
        log('extension connected:', m.userAgent || '');
      } else {
        mcpClients.add(ws);
        log('mcp client connected (' + mcpClients.size + ' total)');
      }
      return;
    }

    if (ws._role === 'mcp') {
      // Command from an MCP client -> forward to the extension.
      if (!extensionWS || extensionWS.readyState !== 1) {
        ws.send(JSON.stringify({ id: m.id, ok: false, error: 'Chrome extension not connected. Open Chrome, enable the "CC Browser Bridge" extension and click its icon → 保存并连接.' }));
        return;
      }
      const bid = ++seq;
      route.set(bid, { client: ws, origId: m.id });
      extensionWS.send(JSON.stringify({ id: bid, method: m.method, params: m.params }));
      return;
    }

    if (ws._role === 'extension') {
      // Response from the extension -> back to the originating MCP client.
      const r = route.get(m.id);
      if (!r) return;
      route.delete(m.id);
      if (r.client.readyState === 1) {
        r.client.send(JSON.stringify({ id: r.origId, ok: m.ok, result: m.result, error: m.error }));
      }
    }
  });

  ws.on('close', () => {
    if (extensionWS === ws) { extensionWS = null; log('extension disconnected'); }
    if (mcpClients.delete(ws)) log('mcp client disconnected (' + mcpClients.size + ' left)');
  });
  ws.on('error', () => {});
});

// Keepalive: send an APP-LEVEL message to the extension every 15s. Receiving a
// WebSocket message wakes the extension's onmessage handler and resets Chrome's
// MV3 service-worker idle timer, which a bare protocol ping does not reliably do.
setInterval(() => {
  if (extensionWS && extensionWS.readyState === 1) {
    try { extensionWS.send(JSON.stringify({ type: 'keepalive', t: Date.now() })); } catch (_) {}
  }
}, 15000);

// Liveness: drop sockets that stop responding to protocol pings.
setInterval(() => {
  wss.clients.forEach((c) => {
    if (c._alive === false) {
      log('terminating dead ' + (c._role || 'unknown') + ' socket');
      try { c.terminate(); } catch (_) {}
      return;
    }
    c._alive = false;
    if (c.readyState === 1) { try { c.ping(); } catch (_) {} }
  });
}, 30000);
