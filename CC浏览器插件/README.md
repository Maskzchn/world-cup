# CC Browser Bridge（合并版 v2）

让本地 **Claude Code** 通过你**已登录的 Chrome 浏览器**读取内部文档、新建/编辑文档（含**钉钉文档**）。

这是把两版合并后的结果：
- **架构基座**取自「独立常驻桥 + 手写 MCP」版本：多会话路由、零重依赖（只 `ws`）、桥 daemon 自动拉起；
- **能力增强**取自「CDP 版本」：真实鼠标/键盘事件、整段粘贴、钉钉/语雀 Lake 适配、已授权标签页安全开关、侧边栏实时活动、代理光标。

## 架构

```
Claude Code(多会话)  ⇄ MCP(stdio)  ⇄  server.js
                                         │  (每会话一个, 自动 spawn 桥)
                                         ▼
                                      bridge.js (常驻, ws://127.0.0.1:8765, 多会话路由)
                                         ▲
                          (role:extension) │ WebSocket
                                         ▼
                                   Chrome 扩展  ⇄ CDP + DOM  ⇄  你的浏览器
```

- 读取/探查走 **DOM 注入**（`executeScript`）；点击/输入/按键/滚动走 **CDP**（真实事件，兼容钉钉 Lake 富文本）。
- 多个 Claude Code 会话共用同一个桥与同一个浏览器扩展。

## 目录
```
CC浏览器插件/
├── extension/     Chrome MV3 扩展 (manifest / background / popup / sidepanel / icons)
└── mcp-server/    server.js(MCP) + bridge.js(常驻桥) + cc.js(调试CLI) + package.json
```

## 安装

**1. 加载扩展**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`。

**2. 装依赖**：
```bash
cd CC浏览器插件/mcp-server
npm install         # 只装 ws
```

**3. 注册到 Claude Code**（路径换成你的绝对路径）：
```bash
claude mcp add cc-browser -- node /绝对路径/CC浏览器插件/mcp-server/server.js
# 改端口: claude mcp add cc-browser -e CC_BRIDGE_PORT=8765 -- node /.../server.js
```
> `server.js` 启动时会自动 spawn 常驻桥 `bridge.js`，无需手动常驻。也可手动 `node bridge.js` 调试。

**4. 连接并授权**：扩展弹窗里端口与桥一致（默认 8765）→ 点「保存并连接」→ 绿点亮。切到目标标签页 → 点「在当前标签页启用」（或勾「允许全部标签页」关闭限制）。

## 工具（19 个）

读取/探查：`browser_list_tabs` · `browser_get_content` · `browser_get_html` · `browser_query` · `browser_snapshot` · `browser_get_selection` · `browser_screenshot`

交互：`browser_navigate` · `browser_click`（selector/text/ref/坐标，`real=true` 走 CDP 真实点击）· `browser_fill`（表单）· `browser_type`（CDP 真实输入）· `browser_paste`（整段粘贴，富文本更稳）· `browser_focus`（聚焦正文/标题）· `browser_press_key` · `browser_scroll` · `browser_execute_js`（MAIN world 万能逃生舱）

钉钉封装：`dingtalk_read_doc` · `dingtalk_create_doc` · `dingtalk_edit_doc`

### 示例
- 「用 `dingtalk_read_doc` 读这篇：<钉钉链接>，总结 5 条要点。」
- 「`dingtalk_create_doc` 新建『周报-本周』，正文是……」
- 「在我打开的钉钉文档（tabId=…）末尾追加结论」→ `dingtalk_edit_doc atEnd=true`。

## 调试 CLI（来自原版）
不经 Claude Code，直接驱动桥：
```bash
node mcp-server/cc.js list_tabs
node mcp-server/cc.js navigate '{"url":"https://alidocs.dingtalk.com/...","newTab":true}'
node mcp-server/cc.js execute_js -    # 从 stdin 读大段 JS
```

## 注意
- 用了 `debugger` 权限，浏览器顶部会出现「正在调试此浏览器」黄条——CDP 控制的正常提示（与 Codex 一致）。
- 钉钉/语雀 Lake 富文本：新建/编辑优先「整段粘贴」，失败自动退回「逐行真实输入」。复杂排版建议人工核对；钉钉自动保存。
- Lake 选择器是基于语雀惯例的最佳猜测。若定位不准，按 F12 把标题输入框/正文容器的 class 发来即可精修。
- 安全：默认只对「已授权」标签页执行写操作（读操作不限制）；新开标签页（`navigate newTab`）自动授权；可在弹窗勾「允许全部标签页」。

## 卸载
```bash
claude mcp remove cc-browser
```
并在 `chrome://extensions` 移除扩展。
