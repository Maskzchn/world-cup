#!/usr/bin/env node
// CC Browser Bridge - MCP 服务入口 (stdio)
//
// Claude Code 通过 stdio 连接本进程; 本进程把工具调用经 WebSocket 转发给 Chrome 扩展,
// 由扩展用 CDP+DOM 在你已登录的浏览器中执行 (含钉钉文档读取/新建/编辑)。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "./bridge.js";

const PORT = parseInt(process.env.CC_BRIDGE_PORT || "8765", 10);
const bridge = new Bridge(PORT);
bridge.start();

const server = new McpServer({ name: "cc-browser-bridge", version: "0.1.0" });

// 文本结果包装
const text = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

function tool(name, description, shape, handler) {
  server.tool(name, description, shape, async (args) => {
    try {
      const res = await handler(args || {});
      return text(res);
    } catch (e) {
      return { content: [{ type: "text", text: `错误: ${e.message}` }], isError: true };
    }
  });
}

// 等待页面稳定的小工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 通用浏览器工具
// ---------------------------------------------------------------------------
tool("browser_list_tabs", "列出浏览器中所有可控标签页 (含其 tabId / 标题 / URL / 是否已授权)。", {},
  () => bridge.sendCommand("list_tabs"));

tool("browser_navigate",
  "在标签页中打开 URL。newTab=true 则新开标签页并自动授权; 否则在指定/当前已授权标签页中导航。",
  { url: z.string().describe("要打开的网址"), tabId: z.number().optional(), newTab: z.boolean().optional() },
  (a) => bridge.sendCommand("navigate", a));

tool("browser_get_content",
  "读取标签页正文。返回纯文本与 markdown, 适合读取文档/网页内容。",
  { tabId: z.number().optional().describe("不传则用当前活动标签页"), format: z.enum(["markdown", "text"]).optional() },
  (a) => bridge.sendCommand("get_content", a));

tool("browser_snapshot",
  "获取页面可交互元素快照 (带 ref 引用 / 角色 / 名称 / 位置)。后续用 ref 进行 click/type。",
  { tabId: z.number().optional(), maxElements: z.number().optional() },
  (a) => bridge.sendCommand("snapshot", a));

tool("browser_screenshot",
  "对标签页可见区域截图, 返回 PNG。",
  { tabId: z.number().optional() },
  async (a) => {
    const r = await bridge.sendCommand("screenshot", a);
    return { content: [{ type: "image", data: r.base64, mimeType: r.mimeType }] };
  });

tool("browser_click",
  "点击元素 (用 browser_snapshot 得到的 ref, 或 CSS selector, 或绝对坐标 x/y)。用 CDP 派发真实鼠标事件。",
  { tabId: z.number().optional(), ref: z.string().optional(), selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
  (a) => bridge.sendCommand("click", a));

tool("browser_type",
  "在当前焦点(或先聚焦 ref/selector 指向的元素)处输入文本。用 CDP Input.insertText, 兼容 contenteditable 与钉钉富文本编辑器。",
  { tabId: z.number().optional(), text: z.string(), ref: z.string().optional(), selector: z.string().optional() },
  (a) => bridge.sendCommand("type_text", a));

tool("browser_fill",
  "直接设置 input/textarea/简单 contenteditable 的值 (适合表单)。富文本请优先用 browser_type。",
  { tabId: z.number().optional(), selector: z.string().optional(), ref: z.string().optional(), text: z.string() },
  (a) => bridge.sendCommand("fill", a));

tool("browser_press_key",
  "按下功能键 (Enter/Tab/Backspace/Delete/Escape/Arrow*/Home/End), 可带 modifiers。",
  { tabId: z.number().optional(), key: z.string(), modifiers: z.array(z.string()).optional() },
  (a) => bridge.sendCommand("press_key", a));

tool("browser_scroll",
  "滚动页面 (deltaY 正数向下)。",
  { tabId: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() },
  (a) => bridge.sendCommand("scroll", a));

tool("browser_eval",
  "在页面中执行 JavaScript 表达式并返回结果 (谨慎使用)。",
  { tabId: z.number().optional(), expression: z.string() },
  (a) => bridge.sendCommand("eval_js", a));

// ---------------------------------------------------------------------------
// 钉钉文档高层封装
// ---------------------------------------------------------------------------
tool("dingtalk_read_doc",
  "打开并读取一个钉钉文档(传入文档 URL), 返回正文 markdown。复用你浏览器里已登录的钉钉账号。",
  { url: z.string().describe("钉钉文档链接, 如 https://alidocs.dingtalk.com/i/nodes/...") },
  async (a) => {
    const nav = await bridge.sendCommand("navigate", { url: a.url, newTab: true });
    await sleep(2500); // 等编辑器渲染
    const content = await bridge.sendCommand("get_content", { tabId: nav.tabId, format: "markdown" });
    return { tabId: nav.tabId, title: content.title, url: content.url, markdown: content.markdown };
  });

tool("dingtalk_create_doc",
  "新建一个钉钉文档并写入内容。打开钉钉文档新建页, 在标题/正文处用真实输入写入。返回新文档标签页 tabId 与 URL。",
  {
    title: z.string().describe("文档标题"),
    content: z.string().optional().describe("正文内容 (纯文本/markdown 文本, 将逐行输入)"),
    newDocUrl: z.string().optional().describe("钉钉新建文档的入口 URL, 默认 https://alidocs.dingtalk.com/i/nodes/new"),
  },
  async (a) => {
    const url = a.newDocUrl || "https://alidocs.dingtalk.com/i/nodes/new";
    const nav = await bridge.sendCommand("navigate", { url, newTab: true });
    await sleep(3000);
    const tabId = nav.tabId;
    // 标题: 钉钉文档进入后焦点通常在标题, 直接输入
    await bridge.sendCommand("type_text", { tabId, text: a.title });
    await bridge.sendCommand("press_key", { tabId, key: "Enter" });
    await sleep(400);
    if (a.content) {
      const lines = a.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await bridge.sendCommand("type_text", { tabId, text: lines[i] });
        if (i < lines.length - 1) await bridge.sendCommand("press_key", { tabId, key: "Enter" });
        await sleep(120);
      }
    }
    const cur = await bridge.sendCommand("tab_info", { tabId }).catch(() => null);
    return {
      tabId,
      message: "已新建并写入。请在浏览器中核对; 钉钉为自动保存。",
      url: cur ? cur.url : url,
    };
  });

tool("dingtalk_edit_doc",
  "在已打开的钉钉文档标签页中追加/插入文本。先 browser_snapshot 找到编辑区或直接在末尾输入。返回结果。",
  {
    tabId: z.number().describe("钉钉文档所在标签页 tabId (来自 dingtalk_read_doc / browser_list_tabs)"),
    text: z.string().describe("要写入的文本"),
    atEnd: z.boolean().optional().describe("true 则先跳到文档末尾 (Ctrl+End) 再输入"),
  },
  async (a) => {
    if (a.atEnd) {
      await bridge.sendCommand("press_key", { tabId: a.tabId, key: "End", modifiers: ["Ctrl"] });
      await sleep(200);
    }
    const lines = a.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await bridge.sendCommand("type_text", { tabId: a.tabId, text: lines[i] });
      if (i < lines.length - 1) await bridge.sendCommand("press_key", { tabId: a.tabId, key: "Enter" });
      await sleep(120);
    }
    return { ok: true, written: a.text.length };
  });

// ---------------------------------------------------------------------------
// 启动 stdio 传输
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
bridge.log("MCP 服务已就绪 (stdio)。等待 Claude Code 调用。");
