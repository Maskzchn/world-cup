# CC Browser Bridge

让本地 **Claude Code** 通过你**已登录的 Chrome 浏览器**读取内部文档、新建/编辑文档（含**钉钉文档**）。对标 OpenAI Codex 的 Chrome 扩展，但接到 Claude Code 的 MCP 上。

## 架构

```
Claude Code  ⇄ MCP(stdio) ⇄  本地桥接进程(Node)  ⇄ WebSocket(127.0.0.1)  ⇄  Chrome 扩展  ⇄ CDP+DOM ⇄  你的浏览器
   server/index.js  +  server/bridge.js                         extension/
```

- **复用真实登录会话**：直接操作你浏览器里已登录的标签页，所以能读需要登录的内部文档。
- **CDP + DOM 混合**：读取/快照走 DOM；点击、输入、截图、按键走 Chrome DevTools Protocol（真实输入事件，兼容钉钉富文本编辑器）。
- **安全开关**：只有在扩展弹窗中“启用”的标签页才允许被操作。

## 目录

```
CC浏览器插件/
├── extension/        Chrome MV3 扩展 (manifest / background / content / popup / icons)
└── server/           本地 Node 桥接 + MCP 服务
```

## 安装

### 1. 加载 Chrome 扩展
1. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择本目录下的 `extension/` 文件夹。
3. 记下扩展 ID（可选）。扩展默认连接桥接端口 **8765**（可在弹窗中修改）。

### 2. 启动本地桥接 + MCP 服务
```bash
cd CC浏览器插件/server
npm install            # 安装 @modelcontextprotocol/sdk / ws / zod
```

### 3. 注册到 Claude Code
在任意项目下执行（把路径换成你的绝对路径）：
```bash
claude mcp add cc-browser -- node /绝对路径/CC浏览器插件/server/index.js
```
> 桥接进程由 Claude Code 作为 MCP 子进程自动拉起，无需单独常驻运行。
> 想改端口：`claude mcp add cc-browser -e CC_BRIDGE_PORT=8765 -- node /.../server/index.js`，并在扩展弹窗里填同样端口。

### 4. 连接并授权
1. 在 Claude Code 中开始会话，MCP 服务启动后会在 `127.0.0.1:8765` 监听。
2. 打开扩展弹窗，状态应显示 **● 已连接**（否则点“重新连接”）。
3. 切到你要操作的标签页，点击 **在当前标签页启用**。

## Claude Code 里可用的工具

| 工具 | 说明 |
|------|------|
| `browser_list_tabs` | 列出所有标签页及其 tabId / 授权状态 |
| `browser_navigate` | 打开 URL（`newTab` 新开并自动授权） |
| `browser_get_content` | 读正文 → markdown / 纯文本 |
| `browser_snapshot` | 可交互元素快照（带 `ref`，供点击/输入定位） |
| `browser_screenshot` | 可见区域截图 PNG |
| `browser_click` | 按 `ref` / `selector` / 坐标点击（CDP 真实点击） |
| `browser_type` | 真实输入文本（兼容 contenteditable / 钉钉编辑器） |
| `browser_paste` | 整段文本一次性粘贴（合成 paste 事件，富文本更稳更快） |
| `browser_focus` | 聚焦文档正文/标题编辑区（CDP 真实点击） |
| `browser_fill` | 直接设置 input/textarea 值（表单） |
| `browser_press_key` | 功能键（Enter/Tab/方向键…，可带 modifiers） |
| `browser_scroll` | 滚动 |
| `browser_eval` | 在页面执行 JS（谨慎） |
| `dingtalk_read_doc` | 打开并读取钉钉文档 → markdown |
| `dingtalk_create_doc` | 新建钉钉文档并写入标题/正文 |
| `dingtalk_edit_doc` | 在已打开的钉钉文档中追加/插入文本 |

### 示例对话
- “用 dingtalk_read_doc 读这篇文档：<钉钉链接>，总结成 5 条要点。”
- “新建一个钉钉文档，标题‘周报-本周’，正文是下面这些内容……”（→ `dingtalk_create_doc`）
- “在我当前打开的钉钉文档末尾追加一段结论。”（→ `browser_list_tabs` 找 tabId，再 `dingtalk_edit_doc atEnd=true`）

## 注意 / 已知限制
- 使用 `debugger` 权限后，浏览器顶部会出现 **“CC Browser Bridge 正在调试此浏览器”** 黄条 —— 这与 Codex 扩展一致，是 CDP 控制的正常提示。
- 钉钉文档基于语雀 Lake 富文本编辑器，**新建/编辑优先用「整段粘贴」**（合成 paste 事件）写入，更稳更快；粘贴被编辑器拒绝时自动退回「逐行真实输入」。复杂排版（表格/样式）建议人工核对；钉钉自动保存。
- 点扩展弹窗里的 **打开侧边栏 (实时活动)** 可常驻查看连接状态、已授权标签页，并**实时滚动显示 Claude Code 正在执行的每条浏览器命令**（方法/标签页/耗时/成败）。
- 端口、`newDocUrl` 等可按需调整；钉钉新建入口若有变化，传 `newDocUrl` 覆盖默认值。
- 扩展只操作**已授权**标签页，关闭标签页会自动取消授权。

## 卸载
```bash
claude mcp remove cc-browser
```
在 `chrome://extensions` 移除扩展即可。
