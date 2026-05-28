// popup.js
var currentTab = "customer";

document.addEventListener("DOMContentLoaded", function () {
  initMainTabs();
  initMsgTabs();
  initControls();
  initAI();
  refreshMessages();
  setInterval(refreshMessages, 2000);

  document.getElementById("messageList").addEventListener("click", function (e) {
    if (e.target.classList.contains("raw-toggle")) {
      var rawDiv = e.target.nextElementSibling;
      if (rawDiv) rawDiv.style.display = rawDiv.style.display === "block" ? "none" : "block";
    }
  });
});

// ==================== 主 Tab 切换 ====================
function initMainTabs() {
  document.querySelectorAll(".tab-bar .tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab-bar .tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var panel = tab.dataset.tab;
      document.getElementById("panelMessages").classList.toggle("active", panel === "messages");
      document.getElementById("panelAI").classList.toggle("active", panel === "ai");
    });
  });
}

// ==================== 消息子 Tab ====================
function initMsgTabs() {
  document.querySelectorAll(".msg-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".msg-tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      currentTab = tab.dataset.msgtab;
      refreshMessages();
    });
  });
}

// ==================== 控制按钮 ====================
function initControls() {
  document.getElementById("btnStart").addEventListener("click", function () {
    getSaleSmartlyTab(function (tab) {
      if (!tab) { alert("请先打开 SaleSmartly 页面"); return; }
      chrome.tabs.sendMessage(tab.id, { action: "start_listening" }, function (resp) {
        if (chrome.runtime.lastError) { alert("连接失败，请刷新页面"); return; }
        document.getElementById("btnStart").disabled = true;
        document.getElementById("btnStop").disabled = false;
        updateStatus(true);
      });
    });
  });

  document.getElementById("btnStop").addEventListener("click", function () {
    getSaleSmartlyTab(function (tab) {
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, { action: "stop_listening" }, function () {
        document.getElementById("btnStart").disabled = false;
        document.getElementById("btnStop").disabled = true;
        updateStatus(false);
      });
    });
  });

  document.getElementById("btnClear").addEventListener("click", function () {
    if (!confirm("确认清空所有记录？")) return;
    chrome.runtime.sendMessage({ action: "clear_messages" }, refreshMessages);
  });

  document.getElementById("btnExportJSON").addEventListener("click", function () { exportFile("json"); });
  document.getElementById("btnExportCSV").addEventListener("click", function () { exportFile("csv"); });
  document.getElementById("btnExportTXT").addEventListener("click", function () { exportFile("txt"); });
}

// ==================== AI 面板 ====================
function initAI() {
  document.getElementById("btnGetAI").addEventListener("click", function () {
    var btn = document.getElementById("btnGetAI");
    btn.disabled = true;
    btn.textContent = "生成中...";
    document.getElementById("aiContent").innerHTML = '<div class="ai-loading">AI 正在生成建议...</div>';

    chrome.runtime.sendMessage({ action: "get_ai_suggestions" }, function (resp) {
      btn.disabled = false;
      btn.textContent = "获取建议";
      if (chrome.runtime.lastError) {
        document.getElementById("aiContent").innerHTML = '<div class="ai-error">连接失败: ' + chrome.runtime.lastError.message + '</div>';
        return;
      }
      if (!resp) {
        document.getElementById("aiContent").innerHTML = '<div class="ai-error">无响应</div>';
        return;
      }
      if (resp.error) {
        document.getElementById("aiContent").innerHTML = '<div class="ai-error">' + esc(resp.error) + '</div>';
        return;
      }
      renderAI(resp);
    });
  });
}

function renderAI(data) {
  var html = "";

  // 标题显示客户和渠道
  if (data.customerName || data.channel) {
    document.getElementById("aiTitle").textContent = "AI 建议 - " + (data.channel || "") + " " + (data.customerName || "");
  }

  // 对话上下文预览
  if (data.context) {
    var shortCtx = data.context.split("\n").slice(-8).join("\n");
    html += '<div class="ai-context">' + esc(shortCtx) + '</div>';
  }

  // 建议列表
  if (data.suggestions && data.suggestions.length > 0) {
    for (var i = 0; i < data.suggestions.length; i++) {
      html += '<div class="suggestion">';
      html += '<div class="s-label">建议 ' + (i + 1) + '</div>';
      html += '<div class="s-text">' + esc(data.suggestions[i]) + '</div>';
      html += '<div class="s-actions"><span class="s-copy" data-text="' + esc(data.suggestions[i]).replace(/"/g, "&quot;") + '">复制</span></div>';
      html += '</div>';
    }
  } else {
    html += '<div class="empty"><div>AI 未返回建议</div></div>';
  }

  document.getElementById("aiContent").innerHTML = html;

  // 绑定复制按钮
  document.querySelectorAll(".s-copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.dataset.text;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = "已复制";
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = "复制"; btn.classList.remove("copied"); }, 1500);
      });
    });
  });
}

// ==================== 消息列表 ====================
function refreshMessages() {
  getSaleSmartlyTab(function (tab) {
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "ping" }, function (resp) {
        if (chrome.runtime.lastError) { updateStatus(false, "未连接"); return; }
        updateStatus(true);
      });
    } else {
      updateStatus(false, "页面未打开");
    }
  });

  chrome.runtime.sendMessage({ action: "get_messages", limit: 200 }, function (resp) {
    if (chrome.runtime.lastError || !resp) return;
    renderMessages(resp);
  });
}

function renderMessages(messages) {
  var list = document.getElementById("messageList");
  var filtered = messages;
  if (currentTab === "customer") {
    filtered = messages.filter(function (m) { return m.sender === "customer"; });
  } else if (currentTab === "agent") {
    filtered = messages.filter(function (m) { return m.sender === "agent"; });
  }

  document.getElementById("msgCount").textContent = messages.length;
  document.getElementById("customerCount").textContent = messages.filter(function (m) { return m.sender === "customer"; }).length;
  document.getElementById("unreadCount").textContent = messages.filter(function (m) { return m.unread_count && m.unread_count !== "0"; }).length;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty"><div>等待消息...</div></div>';
    return;
  }

  var recent = filtered.slice(-80).reverse();
  var html = "";
  for (var i = 0; i < recent.length; i++) {
    var m = recent[i];
    var isAgent = m.sender === "agent";
    html += '<div class="message-item ' + (isAgent ? "agent-msg" : "") + '">';
    html += '<div class="meta"><div>';
    if (m.channel) html += '<span class="tag tag-channel">' + esc(m.channel) + '</span> ';
    if (m.source === "notice") html += '<span class="tag tag-snippet">预览</span> ';
    if (m.source === "api") html += '<span class="tag tag-full">完整</span> ';
    html += '<span class="' + (isAgent ? "tag-agent" : "tag-customer") + '">' + esc(m.customer_name || (isAgent ? "客服" : "客户")) + '</span>';
    html += '</div><div>' + esc(m.time) + '</div></div>';
    html += '<div class="text">' + esc(m.message || "(无文本)") + '</div>';
    if (m.phone) html += '<div class="phone">' + esc(m.phone) + '</div>';
    if (m.raw) {
      html += '<div class="raw-toggle">[原始数据]</div>';
      html += '<div class="raw-data">' + esc(typeof m.raw === "string" ? m.raw : JSON.stringify(m.raw, null, 2)) + '</div>';
    }
    html += '</div>';
  }
  list.innerHTML = html;
}

function updateStatus(active, text) {
  var dot = document.getElementById("statusDot");
  var label = document.getElementById("statusText");
  dot.className = "status-dot " + (active ? "active" : "inactive");
  label.textContent = text || (active ? "监听中" : "已暂停");
}

// ==================== 导出 ====================
function exportFile(format) {
  chrome.runtime.sendMessage({ action: "export_messages" }, function (resp) {
    if (!resp || !resp.messages) return;
    var messages = resp.messages;
    var content, filename, mimeType;

    if (format === "json") {
      content = JSON.stringify(messages, null, 2);
      filename = "salesmartly_" + formatDate() + ".json";
      mimeType = "application/json";
    } else if (format === "csv") {
      var headers = ["time", "channel", "customer_name", "phone", "sender", "message", "chat_session_id"];
      var rows = messages.map(function (m) {
        return headers.map(function (h) { return '"' + (m[h] || "").toString().replace(/"/g, '""') + '"'; });
      });
      content = "﻿" + headers.join(",") + "\n" + rows.join("\n");
      filename = "salesmartly_" + formatDate() + ".csv";
      mimeType = "text/csv";
    } else {
      content = messages.map(function (m) {
        return "[" + m.time + "] [" + m.channel + "] " + (m.sender === "agent" ? "客服" : m.customer_name) + ": " + (m.message || "");
      }).join("\n");
      filename = "salesmartly_" + formatDate() + ".txt";
      mimeType = "text/plain";
    }

    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  });
}

// ==================== 工具 ====================
function getSaleSmartlyTab(callback) {
  chrome.tabs.query({ url: "https://app.salesmartly.com/*" }, function (tabs) {
    callback(tabs.length > 0 ? tabs[0] : null);
  });
}

function formatDate() {
  var d = new Date();
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes());
}

function pad(n) { return n.toString().padStart(2, "0"); }

function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
