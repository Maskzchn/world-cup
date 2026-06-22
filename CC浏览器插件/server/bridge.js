// WebSocket 桥: 监听 127.0.0.1:<port>, 等待 Chrome 扩展连接,
// 提供 sendCommand(method, params) -> Promise(result) 的请求/响应通道。
import { WebSocketServer } from "ws";

export class Bridge {
  constructor(port) {
    this.port = port;
    this.ext = null; // 当前连接的扩展 socket
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.seq = 0;
  }

  start() {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
    this.wss.on("connection", (ws) => {
      // 最新连接者胜出
      this.ext = ws;
      this.log(`扩展已连接`);
      ws.on("message", (data) => this.onMessage(data));
      ws.on("close", () => {
        if (this.ext === ws) this.ext = null;
        this.log("扩展已断开");
      });
      ws.on("error", () => {});
    });
    this.wss.on("error", (e) => this.log(`WS 服务错误: ${e.message}`));
    this.log(`桥接服务监听 ws://127.0.0.1:${this.port}`);
  }

  log(msg) {
    // stderr, 避免污染 MCP 的 stdout (stdio JSON-RPC)
    process.stderr.write(`[cc-bridge] ${msg}\n`);
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "扩展返回错误"));
    }
    // hello / ping 忽略
  }

  isConnected() {
    return this.ext && this.ext.readyState === 1;
  }

  sendCommand(method, params = {}, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        return reject(new Error(
          "Chrome 扩展未连接。请确认: 1) 已加载扩展; 2) 扩展弹窗端口与桥一致; 3) 已点击重新连接。"
        ));
      }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`命令 ${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ext.send(JSON.stringify({ type: "command", id, method, params }));
    });
  }
}
