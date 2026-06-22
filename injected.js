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

  // 把 fetch/XHR 的 headers 统一序列化为普通对象（录制请求头，重放时带回以通过鉴权）
  function extractHeaders(h) {
    var out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== "undefined" && h instanceof Headers) {
        h.forEach(function (v, k) { out[k] = v; });
      } else if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) {
          if (Array.isArray(h[i])) out[h[i][0]] = h[i][1];
        }
      } else if (typeof h === "object") {
        for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) out[k] = h[k]; }
      }
    } catch (e) {}
    return out;
  }

  // ==================== fetch 拦截 ====================
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    return origFetch.apply(this, arguments).then(function (response) {
      try {
        var url = typeof input === "string" ? input : (input.url || "");
        if (url.includes("get-user-info")) {
          console.log("[SS-Listener] FETCH get-user-info 命中!");
          var clonedUser = response.clone();
          clonedUser.json().then(function (json) {
            console.log("[SS-Listener] 用户信息 (fetch):", json.data ? json.data.name : "无数据");
            window.postMessage({
              type: "__ss_user_info",
              url: url,
              data: json,
              timestamp: Date.now(),
            }, "*");
          }).catch(function (e) { console.error("[SS-Listener] fetch user-info JSON解析失败:", e); });
        }
        if (url.includes("get-message-list")) {
          // ===== 录制请求模板（供档案功能分页重放）=====
          var reqBody = null;
          try {
            reqBody = init && init.body ? (typeof init.body === "string" ? init.body : JSON.stringify(init.body)) : null;
          } catch (e) {}
          var reqHeaders = extractHeaders(init && init.headers);
          window.postMessage({
            type: "__ss_msglist_request",
            url: url,
            method: (init && init.method) || "GET",
            body: reqBody,
            headers: reqHeaders,
            timestamp: Date.now(),
          }, "*");
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
  var origSetReqHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ssUrl = url;
    this.__ssMethod = method;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { (this.__ssHeaders || (this.__ssHeaders = {}))[name] = value; } catch (e) {}
    return origSetReqHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    var url = this.__ssUrl || "";
    if (url.includes("get-user-info")) {
      console.log("[SS-Listener] XHR get-user-info 命中!", url);
      this.addEventListener("load", function () {
        try {
          var json = JSON.parse(self.responseText);
          console.log("[SS-Listener] 用户信息 (xhr):", json.data ? json.data.name : "无数据");
          window.postMessage({
            type: "__ss_user_info",
            url: url,
            data: json,
            timestamp: Date.now(),
          }, "*");
        } catch (e) { console.error("[SS-Listener] XHR user-info JSON解析失败:", e); }
      });
    }
    if (url.includes("get-message-list")) {
      console.log("[SS-Listener] XHR get-message-list 命中!", url);
      // ===== 录制请求模板 =====
      var xhrReqBody = null;
      try {
        xhrReqBody = body ? (typeof body === "string" ? body : (body.toString ? body.toString() : null)) : null;
      } catch (e) {}
      window.postMessage({
        type: "__ss_msglist_request",
        url: url,
        method: self.__ssMethod || "GET",
        body: xhrReqBody,
        headers: self.__ssHeaders || {},
        timestamp: Date.now(),
      }, "*");
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

  // ==================== 分页重放（客户档案功能）====================
  // SaleSmartly 的 get-message-list 实测为 GET + 游标分页：
  //   - 游标参数 sequence_id，方向参数 direction_type（0/1），每页 page_size（默认20）
  //   - 响应 data.next_pk = {chat_user_id, sequence_id} 为下一页游标；为空对象 {} 表示该方向到头
  //   - 故从模板 sequence_id 起，向 direction_type=1/0 两个方向各追尽 next_pk，按 sequence_id 去重合并，即得完整历史。
  // （计划原文假设 POST body + page 页码，与实测不符；此处按实测机制实现，即计划 Task3 Step4 所述「cursor 分页需调」。）
  async function replayMsgList(template) {
    if (!template || !template.url) throw new Error("无请求模板");
    var base = new URL(template.url);
    var anchorSeq = base.searchParams.get("sequence_id");
    if (!anchorSeq) throw new Error("模板 URL 缺少 sequence_id");
    var MAX_PAGES = 100; // 每方向兜底

    var all = [];
    var seen = Object.create(null); // 按 sequence_id 去重
    var dirs = ["1", "0"];

    for (var d = 0; d < dirs.length; d++) {
      var dir = dirs[d];
      var cursor = anchorSeq;
      for (var page = 0; page < MAX_PAGES; page++) {
        base.searchParams.set("sequence_id", cursor);
        base.searchParams.set("direction_type", dir);
        // 直接用原始 fetch，避免触发本脚本自身的请求录制/响应处理（防模板被覆盖、消息重复入库）
        var resp = await origFetch(base.toString(), { method: "GET", headers: template.headers || {}, credentials: "include" });
        if (!resp.ok) throw new Error("重放失败 HTTP " + resp.status);
        var json = await resp.json();
        var data = (json && json.data) ? json.data : {};
        var list = data.list || [];
        for (var i = 0; i < list.length; i++) {
          var seq = list[i] && list[i].sequence_id;
          if (seq && seen[seq]) continue;
          if (seq) seen[seq] = true;
          all.push(list[i]);
        }
        var nextSeq = data.next_pk && data.next_pk.sequence_id;
        console.log("[SS-Listener] 重放 dir=" + dir + " 第" + (page + 1) + "页 +" + list.length + " 累计" + all.length + (nextSeq ? "" : " (该方向结束)"));
        if (!nextSeq) break;      // next_pk 为空 → 该方向到头
        if (!list.length) break;  // 空页 → 停止
        cursor = nextSeq;
      }
    }
    console.log("[SS-Listener] 重放完成: 共 " + all.length + " 条");
    return all;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var m = event.data;
    if (m && m.type === "__ss_replay_msglist") {
      replayMsgList(m.template).then(function (list) {
        window.postMessage({ type: "__ss_replay_msglist_result", ok: true, list: list, chatUserId: m.template.chatUserId }, "*");
      }).catch(function (e) {
        window.postMessage({ type: "__ss_replay_msglist_result", ok: false, error: e.message, chatUserId: m.template.chatUserId }, "*");
      });
    }
  });

  // ==================== 填写备注栏（客户档案功能）====================
  // 实测 SaleSmartly 客户备注栏为 <textarea placeholder="请输入客户备注" class="arco-textarea">（Arco Design 受控组件）
  var REMARK_SELECTORS = [
    'textarea[placeholder*="客户备注"]',
    'textarea[placeholder*="备注"]',
    'textarea.arco-textarea',
    'textarea[placeholder*="remark" i]',
    'textarea[class*="remark" i]',
    'textarea[class*="note" i]',
  ];

  function findRemarkEl() {
    for (var i = 0; i < REMARK_SELECTORS.length; i++) {
      try { var el = document.querySelector(REMARK_SELECTORS[i]); if (el) return el; } catch (e) {}
    }
    return null;
  }

  function setNativeValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // 备注：SaleSmartly 备注区默认是“预览态” div.edit-textarea__preview（只读），点它才切换成可编辑 textarea。
  // 这里先自动点开预览态、轮询等 textarea 出现再填值，免去用户手动点页面（手动点会让扩展弹窗关闭）。
  async function fillRemark(text) {
    var el = findRemarkEl();
    if (!el) {
      var preview = document.querySelector('.edit-textarea__preview');
      if (preview) { try { preview.click(); } catch (e) {} }
      // Vue 切换编辑态是异步的（nextTick），轮询等待 textarea 出现（最多约 1.5s）
      for (var i = 0; i < 30; i++) {
        await new Promise(function (r) { setTimeout(r, 50); });
        el = findRemarkEl();
        if (el) break;
      }
    }
    if (!el) return false;
    try { el.focus(); } catch (e) {}
    setNativeValue(el, text);
    // 轮询等“确认(勾)”按钮出现并点击保存
    var root = el.closest('[class*="edit-textarea"]');
    var saveBtn = null;
    for (var j = 0; j < 20; j++) {
      await new Promise(function (r) { setTimeout(r, 50); });
      saveBtn = (root && root.querySelector('.icon-confirm-circle')) || document.querySelector('.icon-confirm-circle');
      if (saveBtn) break;
    }
    if (saveBtn) {
      // 优先点它的按钮/包裹父元素（比点 SVG 本身更可靠触发 Vue @click）
      var clickTarget = saveBtn.closest('button, [role="button"]') || saveBtn.parentElement || saveBtn;
      try { clickTarget.click(); } catch (e) {}
      console.log("[SS-DBG-FILL] 已点保存:", clickTarget.tagName, clickTarget.className);
    } else {
      console.log("[SS-DBG-FILL] 未找到 .icon-confirm-circle");
    }
    return true;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var m = event.data;
    if (m && m.type === "__ss_fill_remark") {
      fillRemark(m.text).then(function (ok) {
        window.postMessage({ type: "__ss_fill_remark_result", ok: ok, timestamp: Date.now() }, "*");
      });
    }
  });

  console.log("[SS-Listener] 拦截已注入 (WS + fetch + XHR)");
})();
