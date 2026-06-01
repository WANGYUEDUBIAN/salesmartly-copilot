// background.js - Service Worker

var CHANNEL_MAP = {
  "1": "WhatsApp", "2": "Facebook", "3": "Messenger", "4": "Instagram",
  "5": "Telegram", "6": "Line", "7": "WeChat", "8": "Email", "9": "SMS",
  "10": "Web", "11": "TikTok", "12": "WhatsApp", "13": "WeChat",
  "14": "Shopee", "15": "Lazada",
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.action === "ws_message" || msg.action === "ws_send" || msg.action === "api_messages" || msg.action === "api_translate") {
    saveMessage(msg);
  }
  if (msg.action === "user_info") {
    saveUserInfo(msg);
  }
  if (msg.action === "get_messages") {
    getMessages(msg.limit || 200).then(sendResponse);
    return true;
  }
  if (msg.action === "clear_messages") {
    chrome.storage.local.set({ messages: [], fingerprints: [] }, function () { sendResponse({ status: "cleared" }); });
    return true;
  }
  if (msg.action === "clear_all") {
    chrome.storage.local.clear(function () { sendResponse({ status: "cleared" }); });
    return true;
  }
  if (msg.action === "export_messages") {
    getMessages().then(function (messages) { sendResponse({ messages: messages }); });
    return true;
  }
  if (msg.action === "get_ai_suggestions") {
    getAISuggestions(msg.chatUserId).then(sendResponse).catch(function (e) {
      sendResponse({ error: e.message || "AI请求失败" });
    });
    return true;
  }
  if (msg.action === "get_user_info") {
    chrome.storage.local.get(["userInfo"], function (result) {
      sendResponse(result.userInfo || null);
    });
    return true;
  }
});

async function saveMessage(msg) {
  var fp = generateFingerprint(msg);
  var result = await chrome.storage.local.get(["messages", "fingerprints"]);
  var messages = result.messages || [];
  var fingerprints = new Set(result.fingerprints || []);

  if (fingerprints.has(fp)) return;
  fingerprints.add(fp);

  // api_messages 是一个批量消息列表，需要逐条处理
  if (msg.action === "api_messages" && msg.data && msg.data.data && msg.data.data.list) {
    var list = msg.data.data.list;
    for (var i = 0; i < list.length; i++) {
      var record = parseAPIMessage(list[i], msg);
      if (record) {
        var rfp = "api_" + simpleHash(record.chat_user_id + record.message + record.send_time);
        if (!fingerprints.has(rfp)) {
          fingerprints.add(rfp);
          messages.push(record);
        }
      }
    }
  } else if (msg.action === "api_translate" && msg.data && msg.data.data) {
    // 翻译数据
    var transList = Array.isArray(msg.data.data) ? msg.data.data : [];
    for (var j = 0; j < transList.length; j++) {
      var t = transList[j];
      if (t.translate_msg) {
        var trfp = "trans_" + simpleHash(t.sequence_id + t.translate_msg);
        if (!fingerprints.has(trfp)) {
          fingerprints.add(trfp);
          messages.push({
            id: trfp,
            time: formatTime(Date.now()),
            timestamp: Date.now(),
            source: "translate",
            sio_event: "",
            channel: "",
            channel_name: "",
            customer_name: "",
            phone: "",
            email: "",
            sender: "system",
            message: t.translate_msg,
            is_snippet: "false",
            chat_session_id: "",
            chat_user_id: "",
            unread_count: "",
            page_url: msg.pageUrl || "",
            raw: t,
          });
        }
      }
    }
  } else if (msg.event === "receive-notice" && msg.data && msg.data.data && msg.data.data.notice) {
    var record2 = parseNotice(msg);
    if (record2) messages.push(record2);
  }

  if (messages.length > 5000) messages.splice(0, messages.length - 5000);
  await chrome.storage.local.set({ messages: messages, fingerprints: Array.from(fingerprints) });
}

// 解析 get-message-list API 返回的单条消息（完整内容）
function parseAPIMessage(item, msg) {
  if (!item) return null;

  var text = "";
  if (item.text) {
    text = item.text;
  } else if (item.content) {
    if (typeof item.content === "string") {
      text = item.content;
    } else if (item.content.msg) {
      if (typeof item.content.msg === "string") {
        text = item.content.msg;
      } else if (item.content.msg.caption) {
        text = "[图片] " + item.content.msg.caption;
      } else if (item.content.msg.file_url) {
        text = "[" + (item.content.msg.file_type || "文件") + "] " + item.content.msg.file_url;
      }
    }
  }

  if (!text && item.msg_type !== "1") {
    if (item.msg_type === "40") text = "[图片]";
    else text = "[非文本消息 type=" + item.msg_type + "]";
  }

  var senderType = String(item.sender_type || "1");

  // 过滤机器人自动回复: sender_type=3 或有 auto_info
  if (senderType === "3") return null;
  if (item.content && typeof item.content === "object" && item.content.auto_info) return null;
  // 过滤系统消息: msg_type=8 或 [系统消息]
  if (String(item.msg_type) === "8") return null;
  if (item.text === "[系统消息]") return null;

  return {
    id: "api_" + simpleHash((item.chat_user_id || "") + text + (item.send_time || "")),
    time: formatTime(item.send_time),
    timestamp: item.send_time ? parseInt(item.send_time) : Date.now(),
    source: "api",
    sio_event: "",
    channel: "",
    channel_name: "",
    customer_name: item.sender_name || "",
    phone: "",
    email: "",
    sender: senderType === "2" ? "agent" : "customer",
    message: text,
    is_snippet: "false",
    chat_session_id: item.chat_session_id || "",
    chat_user_id: item.chat_user_id || "",
    unread_count: "",
    page_url: msg.pageUrl || "",
    raw: item,
  };
}

// 解析 receive-notice（新消息通知 - snippet 预览）
function parseNotice(msg) {
  var notice = msg.data.data.notice;
  var pushTime = msg.data.push_time || msg.timestamp;
  var channelNum = String(notice.channel || "");
  var senderType = String(notice.sender_type || "1");

  // 过滤机器人自动回复
  if (notice.robot_reply === "1") return null;

  return {
    id: generateFingerprint(msg),
    time: formatTime(pushTime),
    timestamp: pushTime,
    source: "notice",
    sio_event: "receive-notice",
    channel: CHANNEL_MAP[channelNum] || "ch_" + channelNum,
    channel_name: notice.channel_name || "",
    customer_name: notice.sender_name || notice.title || notice.nickname || "",
    phone: notice.phone || "",
    email: notice.email || "",
    sender: senderType === "2" ? "agent" : "customer",
    message: notice.snippet || "",
    is_snippet: "true",
    chat_session_id: notice.chat_session_id || "",
    chat_user_id: notice.chat_user_id || "",
    unread_count: notice.unread_count || "0",
    page_url: msg.pageUrl || "",
    raw: msg.data,
  };
}

function formatTime(ts) {
  if (!ts) return new Date().toLocaleString("zh-CN");
  var d = new Date(typeof ts === "string" ? parseInt(ts) : ts);
  return isNaN(d.getTime()) ? new Date().toLocaleString("zh-CN") : d.toLocaleString("zh-CN");
}

function generateFingerprint(msg) {
  var content = msg.rawStr || JSON.stringify(msg.data) || "";
  var time = msg.timestamp || Date.now();
  var timeKey = Math.floor(time / 3000);
  return msg.action + "_" + simpleHash(content) + "_" + timeKey;
}

function simpleHash(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

async function saveUserInfo(msg) {
  if (!msg.data || !msg.data.data) return;
  var data = msg.data.data;
  var chatUserId = data.chat_user_id;
  if (!chatUserId) return;

  var result = await chrome.storage.local.get(["userInfos"]);
  var userInfos = result.userInfos || {};

  userInfos[chatUserId] = {
    chatUserId: chatUserId,
    name: data.name || "",
    nickname: data.nickname || "",
    phone: data.phone || "",
    phone_number: data.phone_number || "",
    area_code: data.area_code || "",
    email: (data.channel_info && data.channel_info.content) ? (JSON.parse(data.channel_info.content).email || "") : "",
    country: data.country || "",
    channel: CHANNEL_MAP[String(data.channel)] || "ch_" + data.channel,
    channel_name: data.channel_name || "",
    remark: data.remark || "",
    labels: (data.labels || []).map(function (l) { return l.label_name; }),
    avatar: (data.channel_info && data.channel_info.avatar) || "",
    translate_language: data.translate_language || "",
    chat_session_code: data.chat_session_code || "",
    session_id: data.session_id || "",
    ad_referral: data.channel_info && data.channel_info.ad_referral ? {
      source: data.channel_info.ad_referral.source || "",
      ad_title: data.channel_info.ad_referral.ad_title || "",
      ad_link: data.channel_info.ad_referral.ad_link || "",
    } : null,
    raw: data,
    timestamp: Date.now(),
    savedAt: new Date().toLocaleString("zh-CN"),
  };

  // 同时保存为"当前用户信息"
  await chrome.storage.local.set({ userInfos: userInfos, userInfo: userInfos[chatUserId] });
}

async function getMessages(limit) {
  var result = await chrome.storage.local.get(["messages"]);
  var messages = result.messages || [];
  if (limit) return messages.slice(-limit);
  return messages;
}

// ==================== AI 建议功能 ====================

// ====== 模型切换：改成 "gemini" 或 "qwen" ======
var AI_PROVIDER = "gemini";

var AI_CONFIGS = {
  qwen: {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    key: "sk-2ad8ac812dc54f4db62610cb520b9a56",
    model: "qwen-plus",
  },
  gemini: {
    url: "http://192.168.31.220:7861/antigravity/v1/chat/completions",
    key: "sk-pwd",
    model: "gemini-3-flash-agent",
  },
};

var AI_API_URL = AI_CONFIGS[AI_PROVIDER].url;
var AI_API_KEY = AI_CONFIGS[AI_PROVIDER].key;
var AI_API_MODEL = AI_CONFIGS[AI_PROVIDER].model;

async function getAISuggestions(chatUserId) {
  var allMessages = await getMessages(500);

  // 找到目标对话的消息
  var chatMsgs;
  if (chatUserId) {
    chatMsgs = allMessages.filter(function (m) {
      return m.chat_user_id === chatUserId && m.message;
    });
  } else {
    // 没指定就用最新客户消息的对话
    var lastCustomer = null;
    for (var i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].sender === "customer" && allMessages[i].message) {
        lastCustomer = allMessages[i];
        break;
      }
    }
    if (!lastCustomer) return { error: "没有找到客户消息" };
    chatMsgs = allMessages.filter(function (m) {
      return m.chat_user_id === lastCustomer.chat_user_id && m.message;
    });
  }

  if (chatMsgs.length === 0) return { error: "没有对话记录" };

  // 按时间排序，取最近 40 条
  chatMsgs.sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
  var recent = chatMsgs.slice(-40);

  // 获取上下文信息（只从客户消息取客户名）
  var customerName = "";
  var channel = "";
  for (var j = recent.length - 1; j >= 0; j--) {
    if (!customerName && recent[j].sender === "customer" && recent[j].customer_name) {
      customerName = recent[j].customer_name;
    }
    if (!channel && recent[j].channel) channel = recent[j].channel;
  }

  // 格式化对话上下文
  var contextLines = [];
  for (var k = 0; k < recent.length; k++) {
    var m = recent[k];
    var role = m.sender === "agent" ? "客服" : "客户";
    var text = m.message || "";
    if (text) contextLines.push("[" + role + "] " + text);
  }

  var contextText = "渠道: " + (channel || "未知") + "\n客户: " + (customerName || "未知") + "\n\n" + contextLines.join("\n");

  // 调用 AI API
  var skillsText = "";
  try {
    var skillsResp = await fetch(chrome.runtime.getURL("skills.md"));
    skillsText = await skillsResp.text();
  } catch (e) {
    console.error("[SS-Listener] skills.md 加载失败:", e);
  }

  var taskPrompt = "根据对话上下文完成两个任务。\n\n任务一：结合上述技能体系，分析客服在对话中的回复表现，指出哪些地方说得不够好、可以改进的地方。用中文给出2-3条具体建议，每条建议要指出具体哪句话有问题以及怎么改更好。\n\n任务二：根据对话上下文和上述技能体系，提供3条专业的下一条回复建议。\n要求：\n1. 根据客户使用的语言自动用相同语言回复\n2. 三条建议风格不同：第一条直接回答，第二条更热情详细，第三条可附带促销或追问\n3. 回复要专业、友好、有帮助\n4. 不要重复已经说过的内容\n5. 每条建议控制在2-4句话\n6. 每条建议后面附上中文翻译\n\n请严格按以下格式返回：\n【客服表现分析】\n分析: [中文分析内容，可以多行]\n\n【回复建议】\n建议1: [回复内容]\n中文: [中文翻译]\n建议2: [回复内容]\n中文: [中文翻译]\n建议3: [回复内容]\n中文: [中文翻译]";

  var systemPrompt = skillsText
    ? "你是一个专业的跨境旅游客服助手。请参考以下销售技能体系来完成任务：\n\n" + skillsText + "\n\n" + taskPrompt
    : "你是一个专业的旅游客服助手。" + taskPrompt;

  var response = await fetch(AI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + AI_API_KEY,
    },
    body: JSON.stringify({
      model: AI_API_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "对话上下文：\n" + contextText },
      ],
      temperature: 0.7,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    var errText = await response.text();
    return { error: "API错误: " + response.status + " " + errText };
  }

  var data = await response.json();
  var aiContent = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";

  // 解析 AI 返回内容（分离客服分析和回复建议）
  var analysis = "";
  var suggestions = [];
  var lines = aiContent.split("\n");
  var section = ""; // "analysis" or "suggestions"
  var currentText = null;
  var currentZh = null;

  for (var l = 0; l < lines.length; l++) {
    var line = lines[l].trim();
    if (line.match(/【客服表现分析】/)) {
      section = "analysis";
      continue;
    }
    if (line.match(/【回复建议】/)) {
      section = "suggestions";
      continue;
    }
    if (section === "analysis") {
      if (line.match(/^分析[：:]/)) {
        analysis += line.replace(/^分析[：:]\s*/, "") + "\n";
      } else if (line) {
        analysis += line + "\n";
      }
    }
    if (section === "suggestions") {
      if (line.match(/^建议[123][：:]/)) {
        if (currentText) suggestions.push({ reply: currentText, zh: currentZh || "" });
        currentText = line.replace(/^建议[123][：:]\s*/, "");
        currentZh = null;
      } else if (line.match(/^中文[：:]/)) {
        currentZh = line.replace(/^中文[：:]\s*/, "");
      } else if (currentZh !== null && line) {
        currentZh += "\n" + line;
      } else if (currentText !== null && line) {
        currentText += "\n" + line;
      }
    }
  }
  if (currentText) suggestions.push({ reply: currentText, zh: currentZh || "" });
  analysis = analysis.trim();

  return {
    analysis: analysis,
    suggestions: suggestions,
    context: contextText,
    customerName: customerName,
    channel: channel,
    chatUserId: chatUserId || (recent.length > 0 ? recent[0].chat_user_id : ""),
    savedAt: new Date().toLocaleString("zh-CN"),
  };
}
