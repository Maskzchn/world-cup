'use strict';
/**
 * Tiny CLI to drive the bridge as an MCP client.
 *   node cc.js <method> '<jsonParams>'
 *   node cc.js execute_js -        # read params JSON from stdin (for big code)
 * Prints the JSON result (or error) and exits.
 */
const WebSocket = require('ws');
const PORT = parseInt(process.env.CC_BRIDGE_PORT || '8765', 10);

const method = process.argv[2];
let rawParams = process.argv[3] || '{}';

function run(paramsStr) {
  let params;
  paramsStr = paramsStr.replace(/^﻿/, '').trim(); // strip BOM
  try { params = JSON.parse(paramsStr); } catch (e) { console.error('bad params JSON: ' + e.message); process.exit(1); }

  function attempt(triesLeft) {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT);
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(to); try { ws.close(); } catch (_) {} fn(); };
    const to = setTimeout(() => finish(() => {
      if (triesLeft > 0) { setTimeout(() => attempt(triesLeft - 1), 1500); }
      else { console.error('timeout'); process.exit(3); }
    }), 20000);
    ws.on('error', (e) => finish(() => {
      if (triesLeft > 0) { setTimeout(() => attempt(triesLeft - 1), 1500); }
      else { console.error('CANNOT_REACH_BRIDGE: ' + e.message); process.exit(1); }
    }));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'mcp' }));
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id !== 1) return;
      finish(() => {
        if (m.ok) { console.log(typeof m.result === 'string' ? m.result : JSON.stringify(m.result, null, 2)); process.exit(0); }
        else { console.error('ERR: ' + m.error); process.exit(2); }
      });
    });
  }
  attempt(1);
}

if (rawParams === '-') {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (buf += c));
  process.stdin.on('end', () => run(buf));
} else if (rawParams[0] === '@') {
  const fs = require('fs');
  run(fs.readFileSync(rawParams.slice(1), 'utf8'));
} else {
  run(rawParams);
}
