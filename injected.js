// injected.js - 拦截 WebSocket + fetch + XHR
(function () {
  if (window.__ssListenerInjected) return;
  window.__ssListenerInjected = true;

  // ==================== WebSocket 拦截 ====================
  var OrigWebSocket = window.WebSocket;

  window.WebSocket = function (url, protocols) {
    var ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
    console.log("[SS-Listener] WebSocket 连接:", url);

    ws.addEventListener("message", function (event) {
      var rawData = event.data;
      if (typeof rawData !== "string") return;
      var parsed = tryParse(rawData);
      if (parsed) {
        window.postMessage({
          type: "__ss_ws_message",
          wsUrl: url,
          event: parsed.event,
          data: parsed.data,
          rawStr: rawData,
          timestamp: Date.now(),
        }, "*");
      }
    });

    var origSend = ws.send.bind(ws);
    ws.send = function (data) {
      if (typeof data === "string" && data.length > 1) {
        var parsed = tryParse(data);
        if (parsed && parsed.event !== "unknown") {
          window.postMessage({
            type: "__ss_ws_send",
            wsUrl: url,
            event: parsed.event,
            data: parsed.data,
            rawStr: data,
            timestamp: Date.now(),
          }, "*");
        }
      }
      return origSend(data);
    };

    window.postMessage({ type: "__ss_ws_connected", wsUrl: url, timestamp: Date.now() }, "*");
    return ws;
  };

  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  // ==================== fetch 拦截 ====================
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    return origFetch.apply(this, arguments).then(function (response) {
      try {
        var url = typeof input === "string" ? input : (input.url || "");
        if (url.includes("get-message-list")) {
          console.log("[SS-Listener] FETCH get-message-list 命中!");
          var cloned = response.clone();
          cloned.json().then(function (json) {
            console.log("[SS-Listener] 完整消息列表 (fetch):", json.data ? json.data.list.length + "条" : "无数据");
            window.postMessage({
              type: "__ss_fetch_messages",
              url: url,
              data: json,
              timestamp: Date.now(),
            }, "*");
          }).catch(function (e) { console.error("[SS-Listener] fetch JSON解析失败:", e); });
        }
      } catch (e) { console.error("[SS-Listener] fetch拦截出错:", e); }
      return response;
    });
  };

  // ==================== XHR 拦截 ====================
  var origOpen = XMLHttpRequest.prototype.open;
  var origSendXHR = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ssUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    var url = this.__ssUrl || "";
    if (url.includes("get-message-list")) {
      console.log("[SS-Listener] XHR get-message-list 命中!", url);
      this.addEventListener("load", function () {
        try {
          var json = JSON.parse(self.responseText);
          console.log("[SS-Listener] 完整消息列表 (xhr):", json.data ? json.data.list.length + "条" : "无数据");
          window.postMessage({
            type: "__ss_fetch_messages",
            url: url,
            data: json,
            timestamp: Date.now(),
          }, "*");
        } catch (e) { console.error("[SS-Listener] XHR JSON解析失败:", e); }
      });
    }
    return origSendXHR.apply(this, arguments);
  };

  // ==================== Socket.IO 解析 ====================
  function tryParse(raw) {
    if (typeof raw !== "string" || raw.length === 0) return null;
    if (raw === "2" || raw === "3" || raw === "41") return null;

    var bracketIdx = raw.indexOf("[");
    if (bracketIdx === -1) {
      if (raw === "40") return { event: "connect", data: {} };
      if (raw.charAt(0) === "0") {
        try { return { event: "open", data: JSON.parse(raw.substring(1)) }; } catch (e) {}
      }
      return null;
    }

    var jsonStr = raw.substring(bracketIdx);
    try {
      var arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr) || arr.length < 1) return null;
      var eventName = String(arr[0]);
      var eventData = arr[1];
      if (typeof eventData === "string") {
        try { eventData = JSON.parse(eventData); } catch (e) {}
      }
      return { event: eventName, data: eventData || {} };
    } catch (e) {
      return null;
    }
  }

  console.log("[SS-Listener] 拦截已注入 (WS + fetch + XHR)");
})();
