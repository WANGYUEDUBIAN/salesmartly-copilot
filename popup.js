// popup.js
document.addEventListener("DOMContentLoaded", function () {
  initTabs();
  initAI();
  initUserInfo();
  checkStatus();
  loadCurrentSuggestions();
  initProfile();

  document.getElementById("btnClear").addEventListener("click", function () {
    chrome.runtime.sendMessage({ action: "clear_all" }, function () {
      document.getElementById("aiContent").innerHTML = '<div class="empty"><div>数据已清空</div></div>';
      document.getElementById("aiInfo").textContent = "数据已清空";
      document.getElementById("userInfoContent").innerHTML = "";
      document.getElementById("statusText").textContent = "已清空";
    });
  });
});

// ==================== Tab 切换 ====================
function initTabs() {
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var panel = tab.dataset.tab;
      ["Current", "History", "Profile"].forEach(function (p) {
        document.getElementById("panel" + p).classList.toggle("active", panel === p.toLowerCase());
      });
      if (panel === "history") loadHistory();
      if (panel === "profile") loadCachedProfile();
    });
  });
}

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

// ==================== 当前对话 AI 建议 ====================
function initAI() {
  document.getElementById("btnGetAI").addEventListener("click", requestAI);
}

// ==================== 客户信息 ====================
function initUserInfo() {
  document.getElementById("btnGetUser").addEventListener("click", function () {
    var btn = document.getElementById("btnGetUser");
    btn.disabled = true;
    btn.textContent = "处理中...";
    document.getElementById("userInfoContent").innerHTML = '<div class="loading" style="padding:10px;">请先在 SaleSmartly 中打开一个客户对话...</div>';

    chrome.runtime.sendMessage({ action: "get_user_info" }, function (resp) {
      if (!resp || !resp.name) {
        btn.disabled = false;
        btn.textContent = "抓取并发送";
        document.getElementById("userInfoContent").innerHTML = '<div class="empty" style="padding:12px;"><div>暂无客户数据</div><div class="hint">请先在 SaleSmartly 中打开一个客户对话</div></div>';
        return;
      }

      renderUserInfo(resp);

      btn.textContent = "发送中...";
      fetch("http://192.168.31.108:3000/api/quick-create-customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: resp.name, remark: resp.remark || "" }),
      }).then(function (r) {
        return r.json();
      }).then(function (data) {
        btn.disabled = false;
        btn.textContent = "抓取并发送";
        var msgEl = document.getElementById("sendResultMsg");
        if (msgEl) msgEl.textContent = "发送成功";
        if (msgEl) msgEl.style.color = "#4caf50";
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = "抓取并发送";
        var msgEl = document.getElementById("sendResultMsg");
        if (msgEl) msgEl.textContent = "发送失败: " + e.message;
        if (msgEl) msgEl.style.color = "#d32f2f";
      });
    });
  });
}

function renderUserInfo(info) {
  var html = '<div class="user-info-card">';

  html += '<div class="ui-row"><span class="ui-label">姓名</span><span class="ui-value">' + esc(info.name || "-") + '</span></div>';
  if (info.nickname) html += '<div class="ui-row"><span class="ui-label">昵称</span><span class="ui-value">' + esc(info.nickname) + '</span></div>';
  html += '<div class="ui-row"><span class="ui-label">渠道</span><span class="ui-value">' + esc(info.channel || "-") + (info.channel_name ? " (" + esc(info.channel_name) + ")" : "") + '</span></div>';
  if (info.phone) html += '<div class="ui-row"><span class="ui-label">电话</span><span class="ui-value">' + esc((info.area_code ? "+" + info.area_code + " " : "") + info.phone) + '</span></div>';
  if (info.email) html += '<div class="ui-row"><span class="ui-label">邮箱</span><span class="ui-value">' + esc(info.email) + '</span></div>';
  if (info.country) html += '<div class="ui-row"><span class="ui-label">国家</span><span class="ui-value">' + esc(info.country) + '</span></div>';
  if (info.translate_language) html += '<div class="ui-row"><span class="ui-label">语言</span><span class="ui-value">' + esc(info.translate_language) + '</span></div>';
  if (info.labels && info.labels.length > 0) html += '<div class="ui-row"><span class="ui-label">标签</span><span class="ui-value">' + esc(info.labels.join(", ")) + '</span></div>';
  if (info.remark) html += '<div class="ui-row" style="flex-direction:column;"><span class="ui-label" style="margin-bottom:4px;">备注</span><span class="ui-value" style="white-space:pre-wrap;background:#f8f9fa;padding:6px 8px;border-radius:4px;font-size:11px;">' + esc(info.remark) + '</span></div>';
  if (info.ad_referral) {
    html += '<div class="ui-row" style="flex-direction:column;"><span class="ui-label" style="margin-bottom:4px;">广告来源</span>';
    html += '<span class="ui-value" style="font-size:11px;">';
    if (info.ad_referral.ad_title) html += esc(info.ad_referral.ad_title);
    if (info.ad_referral.source) html += ' [' + esc(info.ad_referral.source) + ']';
    html += '</span></div>';
  }

  html += '<div style="margin-top:6px;font-size:10px;color:#aaa;">抓取时间: ' + esc(info.savedAt || "") + '</div>';
  html += '<div id="sendResultMsg" style="font-size:11px;margin-top:4px;"></div>';
  html += '</div>';

  document.getElementById("userInfoContent").innerHTML = html;
}

function loadCurrentSuggestions() {
  chrome.storage.local.get(["aiCurrent"], function (result) {
    if (result.aiCurrent && result.aiCurrent.suggestions && result.aiCurrent.suggestions.length > 0) {
      renderCurrent(result.aiCurrent);
    }
  });
}

function requestAI() {
  var btn = document.getElementById("btnGetAI");
  btn.disabled = true;
  btn.textContent = "生成中...";
  document.getElementById("aiContent").innerHTML = '<div class="loading">AI 正在分析对话...</div>';
  document.getElementById("aiInfo").textContent = "正在生成...";

  chrome.runtime.sendMessage({ action: "get_ai_suggestions" }, function (resp) {
    btn.disabled = false;
    btn.textContent = "重新生成";

    if (chrome.runtime.lastError) { showError("连接失败"); return; }
    if (!resp) { showError("无响应"); return; }
    if (resp.error) { showError(resp.error); return; }

    // 保存当前建议
    chrome.storage.local.set({ aiCurrent: resp });

    // 保存到历史记录
    saveToHistory(resp);

    renderCurrent(resp);
  });
}

function renderCurrent(data) {
  var info = "";
  if (data.channel) info += data.channel + " ";
  if (data.customerName) info += data.customerName;
  document.getElementById("aiInfo").textContent = info || "已生成";

  var html = "";

  // 客服表现分析
  if (data.analysis) {
    html += '<div style="background:#fff3e0;border-radius:6px;padding:10px 12px;margin-bottom:10px;border-left:3px solid #ff9800;">';
    html += '<div style="font-size:11px;color:#e65100;font-weight:600;margin-bottom:6px;">客服表现分析</div>';
    html += '<div style="font-size:11px;color:#333;line-height:1.5;white-space:pre-wrap;">' + esc(data.analysis) + '</div>';
    html += '</div>';
  }

  if (data.context) {
    var lines = data.context.split("\n");
    var shortCtx = lines.slice(Math.max(0, lines.length - 20)).join("\n");
    html += '<div class="context-box" style="max-height:140px"><div class="ctx-label">对话上下文 (最近' + Math.min(lines.length, 20) + '条)</div>' + esc(shortCtx) + '</div>';
  }

  if (data.suggestions && data.suggestions.length > 0) {
    for (var i = 0; i < data.suggestions.length; i++) {
      var s = data.suggestions[i];
      var replyText = typeof s === "object" ? s.reply : s;
      var zhText = typeof s === "object" ? s.zh : "";
      html += '<div class="suggestion">';
      html += '<div class="s-label">建议 ' + (i + 1) + '</div>';
      html += '<div class="s-text">' + esc(replyText) + '</div>';
      if (zhText) html += '<div style="font-size:11px;color:#888;margin-top:4px;padding-top:4px;border-top:1px dashed #e0e0e0;">中文: ' + esc(zhText) + '</div>';
      html += '<span class="s-copy" data-idx="' + i + '" data-source="current">复制</span>';
      html += '</div>';
    }
  }
  document.getElementById("aiContent").innerHTML = html;
  bindCopy(data.suggestions || []);
}

// ==================== 历史记录 ====================
function saveToHistory(data) {
  if (!data.chatUserId && !data.customerName) return;

  var key = data.chatUserId || data.customerName;

  chrome.storage.local.get(["aiHistory"], function (result) {
    var history = result.aiHistory || {};
    history[key] = {
      customerName: data.customerName || "",
      channel: data.channel || "",
      chatUserId: data.chatUserId || "",
      suggestions: data.suggestions || [],
      savedAt: data.savedAt || new Date().toLocaleString("zh-CN"),
      timestamp: Date.now(),
    };
    chrome.storage.local.set({ aiHistory: history });
  });
}

function loadHistory() {
  chrome.storage.local.get(["aiHistory"], function (result) {
    var history = result.aiHistory || {};
    var keys = Object.keys(history);

    if (keys.length === 0) {
      document.getElementById("historyList").innerHTML = '<div class="empty"><div>暂无历史记录</div><div class="hint">生成建议后会自动保存</div></div>';
      return;
    }

    // 按时间倒序
    keys.sort(function (a, b) { return (history[b].timestamp || 0) - (history[a].timestamp || 0); });

    var html = "";
    for (var i = 0; i < keys.length; i++) {
      var item = history[keys[i]];
      var firstS = item.suggestions && item.suggestions[0];
      var previewText = typeof firstS === "object" ? firstS.reply : (firstS || "");
      var preview = previewText ? previewText.substring(0, 60) + "..." : "";

      html += '<div class="history-item" data-key="' + esc(keys[i]) + '">';
      html += '<div class="hi-header">';
      html += '<div>';
      html += '<span class="hi-name">' + esc(item.customerName || "未知客户") + '</span> ';
      if (item.channel) html += '<span class="hi-channel">' + esc(item.channel) + '</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="hi-time">' + esc(item.savedAt || "") + '</div>';
      if (preview) html += '<div class="hi-preview">' + esc(preview) + '</div>';

      // 展开详情
      html += '<div class="hi-detail">';
      for (var j = 0; j < (item.suggestions || []).length; j++) {
        var hs = item.suggestions[j];
        var hsReply = typeof hs === "object" ? hs.reply : hs;
        var hsZh = typeof hs === "object" ? hs.zh : "";
        html += '<div class="hi-suggestion">';
        html += '<div class="his-label">建议 ' + (j + 1) + '</div>';
        html += '<div class="his-text">' + esc(hsReply) + '</div>';
        if (hsZh) html += '<div style="font-size:10px;color:#888;margin-top:3px;padding-top:3px;border-top:1px dashed #e0e0e0;">中文: ' + esc(hsZh) + '</div>';
        html += '<span class="s-copy" data-idx="' + j + '" data-source="history">复制</span>';
        html += '</div>';
      }
      html += '<div class="hi-actions"><span class="s-copy" data-action="delete" data-key="' + esc(keys[i]) + '" style="color:#d32f2f;border-color:#d32f2f;">删除记录</span></div>';
      html += '</div>';

      html += '</div>';
    }

    document.getElementById("historyList").innerHTML = html;
    bindHistoryEvents(history);
  });
}

function bindHistoryEvents(history) {
  // 点击展开/收起
  document.querySelectorAll(".history-item").forEach(function (item) {
    item.addEventListener("click", function (e) {
      // 如果点的是复制或删除按钮，不展开/收起
      if (e.target.classList.contains("s-copy")) return;
      item.classList.toggle("expanded");
    });
  });

  // 复制按钮
  document.querySelectorAll('.hi-detail .s-copy[data-source="history"]').forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var idx = parseInt(btn.dataset.idx);
      var key = btn.closest(".history-item").dataset.key;
      var suggestions = history[key] ? history[key].suggestions || [] : [];
      var s = suggestions[idx];
      var text = typeof s === "object" ? s.reply : (s || "");
      copyText(text, btn);
    });
  });

  // 删除按钮
  document.querySelectorAll('.s-copy[data-action="delete"]').forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var key = btn.dataset.key;
      chrome.storage.local.get(["aiHistory"], function (result) {
        var h = result.aiHistory || {};
        delete h[key];
        chrome.storage.local.set({ aiHistory: h }, function () {
          loadHistory();
        });
      });
    });
  });
}

// ==================== 通用工具 ====================
function bindCopy(suggestions) {
  document.querySelectorAll('.s-copy[data-source="current"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      var idx = parseInt(btn.dataset.idx);
      var s = suggestions[idx];
      var text = typeof s === "object" ? s.reply : (s || "");
      copyText(text, btn);
    });
  });
}

function copyText(text, btn) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(function () {
    btn.textContent = "已复制";
    btn.classList.add("copied");
    setTimeout(function () { btn.textContent = "复制"; btn.classList.remove("copied"); }, 1500);
  });
}

function showError(msg) {
  document.getElementById("aiContent").innerHTML = '<div class="error-box">' + esc(msg) + '</div>';
  document.getElementById("aiInfo").textContent = "出错";
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
  var msgEl = document.getElementById("profileActionMsg");
  chrome.tabs.query({ url: "https://app.salesmartly.com/*" }, function (tabs) {
    if (!tabs.length) { copyFallbackAndWarn("未找到 SaleSmartly 页面"); return; }
    chrome.tabs.sendMessage(tabs[0].id, { action: "fill_remark", text: _currentProfile.rawText }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        copyFallbackAndWarn("未找到备注栏，已复制，请手动粘贴");
      } else {
        showProfileActionMsg("已填入备注栏", "#4caf50");
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
  var msgEl = document.getElementById("profileActionMsg");
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
