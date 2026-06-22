// popup.js — 客户档案
document.addEventListener("DOMContentLoaded", function () {
  checkStatus();
  initProfile();
  loadCachedProfile();

  document.getElementById("btnClear").addEventListener("click", function () {
    chrome.runtime.sendMessage({ action: "clear_all" }, function () {
      _currentProfile = null;
      document.getElementById("profileContent").innerHTML = '<div class="empty"><div>数据已清空</div></div>';
      document.getElementById("profileInfo").textContent = "已清空";
      document.getElementById("statusText").textContent = "已清空";
    });
  });
});

// ==================== 连接状态 ====================
function checkStatus() {
  chrome.tabs.query({ url: "https://app.salesmartly.com/*" }, function (tabs) {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "ping" }, function (resp) {
        if (chrome.runtime.lastError) { setStatus(false, "未连接"); return; }
        setStatus(true);
      });
    } else {
      setStatus(false, "页面未打开");
    }
  });
}

function setStatus(active, text) {
  document.getElementById("statusDot").className = "status-dot " + (active ? "active" : "inactive");
  document.getElementById("statusText").textContent = text || (active ? "监听中" : "未连接");
}

function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ==================== 客户档案 ====================
function initProfile() {
  var btn = document.getElementById("btnGetProfile");
  if (btn) btn.addEventListener("click", requestProfile);
  // 按钮（渲染后动态绑定，用事件委托）
  document.getElementById("profileContent").addEventListener("click", function (e) {
    var t = e.target;
    if (t.id === "btnFillRemark") { doFillRemark(); }
    else if (t.id === "btnCopyProfile") { doCopyProfile(); }
    else if (t.id === "btnSendProfile") { doSendProfile(); }
  });
  // 自动模式开关
  var toggle = document.getElementById("autoModeToggle");
  if (toggle) {
    chrome.storage.local.get(["autoMode"], function (r) {
      toggle.checked = !!r.autoMode;
      if (toggle.checked) document.getElementById("profileInfo").textContent = "自动模式：点进客户即生成并填入";
    });
    toggle.addEventListener("change", function () {
      chrome.storage.local.set({ autoMode: toggle.checked });
      document.getElementById("profileInfo").textContent = toggle.checked ? "自动模式：点进客户即生成并填入" : '点击"生成档案"';
    });
  }
}

var _currentProfile = null; // 缓存当前档案，供复制/填入/发送用

function requestProfile() {
  var btn = document.getElementById("btnGetProfile");
  btn.disabled = true;
  btn.textContent = "生成中...";
  document.getElementById("profileContent").innerHTML = '<div class="loading">正在拉取完整历史并 AI 抽取...</div>';
  document.getElementById("profileInfo").textContent = "生成中...";

  chrome.runtime.sendMessage({ action: "get_customer_profile" }, function (resp) {
    btn.disabled = false;
    btn.textContent = "重新生成";
    if (chrome.runtime.lastError) { renderProfileError("连接失败"); return; }
    if (!resp) { renderProfileError("无响应"); return; }
    if (resp.error) { renderProfileError(resp.error); return; }
    _currentProfile = resp;
    chrome.storage.local.set({ profileCurrent: resp });
    renderProfile(resp);
  });
}

function loadCachedProfile() {
  chrome.storage.local.get(["profileCurrent"], function (r) {
    if (r.profileCurrent && r.profileCurrent.fields) {
      _currentProfile = r.profileCurrent;
      renderProfile(r.profileCurrent);
    }
  });
}

function renderProfile(data) {
  var info = data.customerName || "已生成";
  if (data.incomplete) info += "（数据可能不完整）";
  document.getElementById("profileInfo").textContent = info;

  var html = "";
  if (data.truncated || data.incomplete) {
    html += '<div class="context-box" style="border-color:#ffcc80;color:#e65100;">';
    if (data.incomplete) html += "⚠ 未取到完整历史，已用已抓取消息生成（可能不全）。";
    if (data.truncated) html += "⚠ 对话过长已截断。";
    html += "</div>";
  }

  html += '<div class="user-info-card">';
  var labels = Object.keys(data.fields || {});
  for (var i = 0; i < labels.length; i++) {
    var label = labels[i];
    var value = data.fields[label];
    var grey = value === "未提及";
    html += '<div class="ui-row"><span class="ui-label">' + esc(label) + '</span>';
    html += '<span class="ui-value"' + (grey ? ' style="color:#bbb;"' : '') + '>' + esc(value) + '</span></div>';
  }
  html += '<div style="margin-top:6px;font-size:10px;color:#aaa;">生成时间: ' + esc(data.savedAt || "") + '</div>';
  html += '</div>';

  html += '<div class="hi-actions" style="margin-top:10px;">';
  html += '<button class="btn" id="btnFillRemark">填入备注栏</button>';
  html += '<button class="btn" id="btnCopyProfile">复制</button>';
  html += '<button class="btn primary" id="btnSendProfile">发送后端</button>';
  html += '</div>';
  html += '<div id="profileActionMsg" style="font-size:11px;margin-top:6px;"></div>';

  document.getElementById("profileContent").innerHTML = html;
}

function renderProfileError(msg) {
  document.getElementById("profileContent").innerHTML = '<div class="error-box">' + esc(msg) + '</div>';
  document.getElementById("profileInfo").textContent = "出错";
}

function doCopyProfile() {
  if (!_currentProfile || !_currentProfile.rawText) return;
  navigator.clipboard.writeText(_currentProfile.rawText).then(function () {
    showProfileActionMsg("已复制", "#4caf50");
  });
}

function doFillRemark() {
  if (!_currentProfile || !_currentProfile.rawText) return;
  chrome.tabs.query({ url: "https://app.salesmartly.com/*" }, function (tabs) {
    if (!tabs.length) { copyFallbackAndWarn("未找到 SaleSmartly 页面"); return; }
    chrome.tabs.sendMessage(tabs[0].id, { action: "fill_remark", text: _currentProfile.rawText }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        copyFallbackAndWarn("未找到备注栏，已复制，请手动粘贴");
      } else {
        showProfileActionMsg("已填入并保存备注栏", "#4caf50");
      }
    });
  });
}

function copyFallbackAndWarn(reason) {
  navigator.clipboard.writeText(_currentProfile.rawText).then(function () {
    showProfileActionMsg(reason, "#e65100");
  });
}

function doSendProfile() {
  if (!_currentProfile) return;
  showProfileActionMsg("发送中...", "#666");
  // 带上客户基础信息（取 storage.userInfo）
  chrome.runtime.sendMessage({ action: "get_user_info" }, function (ui) {
    ui = ui || {};
    fetch("http://192.168.31.108:3000/api/quick-create-customer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: ui.name || _currentProfile.customerName || "",
        channel: ui.channel || "",
        phone: ui.phone || "",
        remark: _currentProfile.rawText,
      }),
    }).then(function (r) { return r.json(); })
      .then(function () { showProfileActionMsg("已发送后端", "#4caf50"); })
      .catch(function (e) { showProfileActionMsg("发送失败: " + e.message, "#d32f2f"); });
  });
}

function showProfileActionMsg(text, color) {
  var el = document.getElementById("profileActionMsg");
  if (el) { el.textContent = text; el.style.color = color; }
}
