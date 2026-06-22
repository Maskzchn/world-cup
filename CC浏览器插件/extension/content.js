// CC Browser Bridge - content script
// 在页面里执行 DOM 层操作: 读正文(转 markdown)、生成可交互元素快照、解析点击坐标、
// 填充表单/富文本，以及显示“代理光标”视觉反馈。
(() => {
  if (window.__ccBridgeInjected) return;
  window.__ccBridgeInjected = true;

  // ref -> element 映射，snapshot 时重建
  const refMap = new Map();
  let refCounter = 0;

  // -------------------------------------------------------------------------
  // 工具: 元素是否可见
  // -------------------------------------------------------------------------
  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    if (rect.bottom < 0 || rect.top > (window.innerHeight + 2000)) return false;
    return true;
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.getAttribute("placeholder")) return el.getAttribute("placeholder").trim();
    if (el.getAttribute("title")) return el.getAttribute("title").trim();
    if (el.tagName === "INPUT" && el.value) return el.value.trim();
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return text.slice(0, 120);
  }

  // -------------------------------------------------------------------------
  // 快照: 收集可交互元素，赋 ref
  // -------------------------------------------------------------------------
  function snapshot(maxElements) {
    refMap.clear();
    refCounter = 0;
    const SEL = [
      "a[href]", "button", "input", "textarea", "select",
      "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
      "[role=textbox]", "[contenteditable=true]", "[contenteditable='']",
      "summary", "label",
    ].join(",");
    const out = [];
    const seen = new Set();
    document.querySelectorAll(SEL).forEach((el) => {
      if (out.length >= maxElements) return;
      if (seen.has(el) || !isVisible(el)) return;
      seen.add(el);
      const ref = "e" + ++refCounter;
      refMap.set(ref, el);
      const rect = el.getBoundingClientRect();
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || el.type || el.tagName.toLowerCase(),
        name: accessibleName(el),
        editable: el.isContentEditable || ["INPUT", "TEXTAREA"].includes(el.tagName),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    });
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      elements: out,
    };
  }

  // -------------------------------------------------------------------------
  // 解析点击坐标 (供 background 用 CDP 派发真实鼠标事件)
  // -------------------------------------------------------------------------
  function resolvePoint({ ref, selector }) {
    let el = null;
    if (ref && refMap.has(ref)) el = refMap.get(ref);
    else if (selector) el = document.querySelector(selector);
    if (!el) throw new Error(`找不到元素 (ref=${ref}, selector=${selector})`);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  }

  // -------------------------------------------------------------------------
  // 读正文 -> markdown (轻量转换) + 纯文本
  // -------------------------------------------------------------------------
  // 钉钉文档基于语雀 Lake 编辑器, 这里覆盖常见的正文容器选择器
  const DINGTALK_BODY_SELECTORS = [
    ".ne-viewer-body", ".ne-engine", ".lake-engine-view", ".lakex-engine",
    ".lake-engine", '[data-lake-id]', '[data-lake-element="root"]',
    ".doc-content", '[data-testid="editor"]', ".ant-doc-editor", ".lake-editor",
  ];
  const DINGTALK_TITLE_SELECTORS = [
    'textarea[placeholder*="标题"]', 'input[placeholder*="标题"]',
    ".doc-title-input textarea", ".doc-title textarea", ".doc-title input",
    '[data-testid="title"] textarea', "h1.title", ".title-editor",
  ];

  function pickMainContainer() {
    const candidates = [
      ...DINGTALK_BODY_SELECTORS,
      "article", "main", '[role="main"]', "#content",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || "").trim().length > 20) return el;
    }
    return document.body;
  }

  function findTitleEl() {
    for (const sel of DINGTALK_TITLE_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findEditorEl() {
    for (const sel of DINGTALK_BODY_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        // 优先找到内部可编辑节点
        const editable = el.querySelector('[contenteditable="true"]') ||
          (el.getAttribute("contenteditable") === "true" ? el : null);
        return editable || el;
      }
    }
    return document.querySelector('[contenteditable="true"]');
  }

  // 聚焦标题/正文, 返回点击坐标 (供 CDP 真实点击聚焦)
  function focusTarget({ target }) {
    let el = target === "title" ? findTitleEl() : findEditorEl();
    if (!el) throw new Error(`找不到${target === "title" ? "标题" : "正文"}编辑区`);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    // 正文点末尾区域, 标题点中部
    const y = target === "title" ? rect.y + rect.height / 2 : Math.min(rect.y + rect.height - 16, rect.y + rect.height / 2);
    return { x: Math.round(rect.x + Math.min(40, rect.width / 2)), y: Math.round(y), found: true };
  }

  // 粘贴通道: 用合成 paste 事件 (带 DataTransfer) 写入, 富文本编辑器通常优先处理 paste,
  // 比逐字符 insertText 更稳、更快; 失败再回退 execCommand。
  function pasteText({ text, html, ref, selector }) {
    let el = null;
    if (ref && refMap.has(ref)) el = refMap.get(ref);
    else if (selector) el = document.querySelector(selector);
    else el = findEditorEl() || document.activeElement;
    if (!el) throw new Error("paste: 找不到目标编辑区");
    el.focus();
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text || "");
      if (html) dt.setData("text/html", html);
      const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      const handled = !el.dispatchEvent(ev); // 被 preventDefault 视为已处理
      if (!handled) {
        // 回退: execCommand
        document.execCommand("insertText", false, text || "");
      }
    } catch (e) {
      document.execCommand("insertText", false, text || "");
    }
    return { ok: true, length: (text || "").length };
  }

  function toMarkdown(root) {
    const lines = [];
    function walk(node) {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) return;
        if (!(child instanceof Element)) return;
        if (!isVisible(child) && child.innerText && child.innerText.trim() === "") return;
        const tag = child.tagName.toLowerCase();
        const text = (child.innerText || "").trim().replace(/\s+\n/g, "\n");
        if (/^h[1-6]$/.test(tag)) {
          lines.push("\n" + "#".repeat(+tag[1]) + " " + text + "\n");
        } else if (tag === "li") {
          lines.push("- " + text);
        } else if (tag === "pre" || tag === "code") {
          if (text) lines.push("\n```\n" + text + "\n```\n");
        } else if (tag === "p") {
          if (text) lines.push(text + "\n");
        } else if (["div", "section", "article", "main", "ul", "ol", "table", "tbody", "tr"].includes(tag)) {
          walk(child);
        } else if (text && child.children.length === 0) {
          lines.push(text);
        } else {
          walk(child);
        }
      });
    }
    walk(root);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function readContent({ format }) {
    const root = pickMainContainer();
    const text = (root.innerText || "").trim();
    const titleEl = findTitleEl();
    const docTitle = titleEl ? (titleEl.value || titleEl.innerText || "").trim() : "";
    const result = { url: location.href, title: docTitle || document.title, pageTitle: document.title, text };
    if (format === "markdown") result.markdown = toMarkdown(root);
    return result;
  }

  // -------------------------------------------------------------------------
  // 填充表单 / 简单富文本 (复杂富文本建议走 type_text 的 CDP 真实输入)
  // -------------------------------------------------------------------------
  function fill({ selector, ref, text }) {
    let el = null;
    if (ref && refMap.has(ref)) el = refMap.get(ref);
    else if (selector) el = document.querySelector(selector);
    if (!el) throw new Error("fill: 找不到元素");
    el.focus();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(el.__proto__, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      throw new Error("fill: 元素不可编辑");
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 代理光标 overlay
  // -------------------------------------------------------------------------
  let cursorEl = null;
  function cursorTo(x, y) {
    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.className = "cc-bridge-cursor";
      document.documentElement.appendChild(cursorEl);
    }
    cursorEl.style.transform = `translate(${x}px, ${y}px)`;
    cursorEl.style.opacity = "1";
    clearTimeout(cursorEl.__hideTimer);
    cursorEl.__hideTimer = setTimeout(() => { if (cursorEl) cursorEl.style.opacity = "0"; }, 2500);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 消息路由
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      switch (msg.action) {
        case "ping": sendResponse({ ok: true }); break;
        case "snapshot": sendResponse(snapshot(msg.maxElements || 200)); break;
        case "resolvePoint": sendResponse(resolvePoint(msg)); break;
        case "readContent": sendResponse(readContent(msg)); break;
        case "fill": sendResponse(fill(msg)); break;
        case "paste": sendResponse(pasteText(msg)); break;
        case "focusTarget": sendResponse(focusTarget(msg)); break;
        case "cursorTo": sendResponse(cursorTo(msg.x, msg.y)); break;
        default: sendResponse({ error: "unknown action " + msg.action });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
    return false; // 同步响应
  });
})();
