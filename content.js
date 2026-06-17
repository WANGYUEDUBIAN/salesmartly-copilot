// content.js - 注入 SaleSmartly 页面，监听消息
(function () {
  if (window.__ssContentLoaded) return;
  window.__ssContentLoaded = true;

  // ========== 1. 注入 WebSocket 拦截脚本 ==========
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ========== 2. 接收 WebSocket 拦截数据 ==========
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;

    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "__ss_ws_message") {
      chrome.runtime.sendMessage({
        action: "ws_message",
        wsUrl: msg.wsUrl,
        event: msg.event,
        data: msg.data,
        rawStr: msg.rawStr,
        timestamp: msg.timestamp,
        pageUrl: window.location.href,
      });
    }

    if (msg.type === "__ss_ws_send") {
      chrome.runtime.sendMessage({
        action: "ws_send",
        wsUrl: msg.wsUrl,
        event: msg.event,
        data: msg.data,
        rawStr: msg.rawStr,
        timestamp: msg.timestamp,
        pageUrl: window.location.href,
      });
    }

    if (msg.type === "__ss_ws_connected") {
      chrome.runtime.sendMessage({
        action: "ws_connected",
        wsUrl: msg.wsUrl,
        timestamp: msg.timestamp,
      });
    }

    if (msg.type === "__ss_fetch_message" || msg.type === "__ss_xhr_message") {
      chrome.runtime.sendMessage({
        action: "http_message",
        source: msg.type === "__ss_fetch_message" ? "fetch" : "xhr",
        url: msg.url,
        data: msg.data,
        timestamp: msg.timestamp,
        pageUrl: window.location.href,
      });
    }

    if (msg.type === "__ss_fetch_messages") {
      chrome.runtime.sendMessage({
        action: "api_messages",
        url: msg.url,
        data: msg.data,
        timestamp: msg.timestamp,
        pageUrl: window.location.href,
      });
    }

    if (msg.type === "__ss_fetch_translate") {
      chrome.runtime.sendMessage({
        action: "api_translate",
        url: msg.url,
        data: msg.data,
        timestamp: msg.timestamp,
        pageUrl: window.location.href,
      });
    }

    if (msg.type === "__ss_user_info") {
      chrome.runtime.sendMessage({
        action: "user_info",
        url: msg.url,
        data: msg.data,
        timestamp: msg.timestamp,
        pageUrl: window.location.href,
      });
    }

    if (msg.type === "__ss_msglist_request") {
      chrome.runtime.sendMessage({
        action: "msglist_request_template",
        url: msg.url,
        method: msg.method,
        body: msg.body,
        headers: msg.headers,
        timestamp: msg.timestamp,
      });
    }
  });

  // ========== 3. MutationObserver DOM 监听（备用方案） ==========
  let observerActive = false;

  function startDOMObserver() {
    if (observerActive) return;

    // 等待页面加载完成
    const waitForBody = setInterval(() => {
      if (!document.body) return;
      clearInterval(waitForBody);

      observerActive = true;

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            // 尝试识别消息节点
            extractDOMMessage(node);
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      console.log("[SS-Listener] DOM Observer 已启动");
    }, 500);
  }

  // 从 DOM 节点提取消息（需要根据实际页面结构调整选择器）
  function extractDOMMessage(node) {
    // 尝试多种可能的消息容器选择器
    const selectors = [
      '[class*="message"]',
      '[class*="chat"]',
      '[class*="bubble"]',
      '[class*="msg"]',
      '[class*="text"]',
      '[data-type="message"]',
    ];

    for (const selector of selectors) {
      try {
        const elements = node.matches?.(selector)
          ? [node]
          : Array.from(node.querySelectorAll?.(selector) || []);
        for (const el of elements) {
          const text = el.textContent?.trim();
          if (!text || text.length < 1 || text.length > 5000) continue;

          // 尝试获取更多上下文信息
          const message = {
            action: "dom_message",
            text: text,
            timestamp: Date.now(),
            pageUrl: window.location.href,
            selector: selector,
            className: el.className?.toString()?.substring(0, 200) || "",
            tagName: el.tagName,
            parentInfo: el.parentElement?.className?.toString()?.substring(0, 200) || "",
          };

          // 去重检查
          const fingerprint = "dom_" + simpleHash(text + message.timestamp);
          message.fingerprint = fingerprint;

          chrome.runtime.sendMessage(message);
        }
      } catch (e) {
        // 忽略选择器错误
      }
    }
  }

  // 简单哈希用于去重
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(36);
  }

  // ========== 4. 监听来自 popup 的指令 ==========
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "start_listening") {
      startDOMObserver();
      sendResponse({ status: "started" });
    }
    if (msg.action === "stop_listening") {
      observerActive = false;
      sendResponse({ status: "stopped" });
    }
    if (msg.action === "get_page_info") {
      sendResponse({
        url: window.location.href,
        title: document.title,
        observerActive: observerActive,
      });
    }
    if (msg.action === "ping") {
      sendResponse({ alive: true });
    }
    if (msg.action === "replay_msglist") {
      window.postMessage({ type: "__ss_replay_msglist", template: msg.template }, "*");
      var waitReplay = function (ev) {
        if (ev.source !== window) return;
        var r = ev.data;
        if (r && r.type === "__ss_replay_msglist_result") {
          window.removeEventListener("message", waitReplay);
          sendResponse({ ok: r.ok, list: r.list, error: r.error });
        }
      };
      window.addEventListener("message", waitReplay);
      setTimeout(function () {
        window.removeEventListener("message", waitReplay);
        sendResponse({ ok: false, error: "重放超时(120s)" });
      }, 120000);
      return true; // 异步 sendResponse
    }
  });

  // 自动启动 DOM Observer
  startDOMObserver();

  console.log("[SS-Listener] Content script 已加载");
})();
