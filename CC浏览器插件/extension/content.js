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
  function pickMainContainer() {
    // 钉钉文档 / 语雀类编辑器优先
    const candidates = [
      '[data-testid="editor"]', ".ant-doc-editor", ".lake-editor", ".ne-engine",
      ".doc-editor", "article", "main", '[role="main"]', "#content",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || "").trim().length > 40) return el;
    }
    return document.body;
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
    const result = { url: location.href, title: document.title, text };
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
        case "cursorTo": sendResponse(cursorTo(msg.x, msg.y)); break;
        default: sendResponse({ error: "unknown action " + msg.action });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
    return false; // 同步响应
  });
})();
