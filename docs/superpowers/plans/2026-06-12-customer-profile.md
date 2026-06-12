# 客户档案生成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 SaleSmartly 浏览器插件中新增「客户档案」功能：拉取单个客户的完整分页历史，由 AI 按固定字段模板抽取需求档案，支持一键填入备注栏 / 复制 / 发送后端。

**Architecture:** 延续现有四层注入式架构（injected.js 页面主世界 → content.js 中转 → background.js Service Worker → popup UI）。核心新增：录制 `get-message-list` 请求模板并分页重放拿完整历史；background 调 AI 抽取结构化字段；popup 新增第三 Tab 展示并操作。

**Tech Stack:** Chrome Extension Manifest V3、原生 JS（无构建、无测试框架）、OpenAI 兼容 API（qwen / gemini）。

**Spec:** `docs/superpowers/specs/2026-06-12-customer-profile-design.md`

---

## 重要前置说明（执行前必读）

1. **无测试框架**：每个任务的"验证"步骤是**手动**的——重载插件、打开 SaleSmartly、看控制台（日志前缀 `[SS-Listener]`）和网络面板。没有 `pytest` 之类。
2. **工作树已有未提交改动**：`background.js / manifest.json / popup.html / popup.js` 在本会话开始前就处于 modified 状态。本计划各任务的 `git add` 只 add 该任务明确列出的文件；这些既有未提交改动会随之一起进 commit，执行时留意（可在第一个 commit 前先 `git status` 确认）。
3. **两个需对真实页面确认的点**（已在 spec 标注）：
   - 备注栏 DOM 选择器（Task 5 含发现步骤）
   - 分页参数名（Task 3 的重放代码**自动从录到的请求体推断**，无需硬编码）
4. **AI 模型**：复用 `background.js` 顶部 `AI_PROVIDER`（当前 `gemini`）。如需切换改那一行即可，本计划不动它。

## 文件结构

| 文件 | 责任 | 本计划改动 |
|------|------|-----------|
| `profile-template.md` | 字段模板（可增减，不改代码） | 新建 |
| `manifest.json` | 把 `profile-template.md` 加入 web_accessible_resources | 改 |
| `injected.js` | 页面主世界：录制请求模板、分页重放、填备注栏 | 改 |
| `content.js` | 中转：请求模板上报、重放/填备注指令双向传递 | 改 |
| `background.js` | 主流程：存模板、编排重放、AI 抽取、解析 | 改 |
| `popup.html` / `popup.js` | 第三 Tab + 生成/展示/复制/填入/发送 | 改 |

## 消息协议（全计划统一命名，勿改）

- injected → content（`window.postMessage`）：
  - `__ss_msglist_request`（录到的 get-message-list 请求模板）
  - `__ss_replay_msglist_result`（重放结果 `{ok, list, error}`）
  - `__ss_fill_remark_result`（填备注结果 `{ok}`）
- content → background（`chrome.runtime.sendMessage`）：
  - `action: "msglist_request_template"`（带 url/method/body）
- background/popup → content（`chrome.tabs.sendMessage`）：
  - `action: "replay_msglist"`（带 `template`）
  - `action: "fill_remark"`（带 `text`）
- content → injected（`window.postMessage`）：
  - `__ss_replay_msglist`（带 `template`）
  - `__ss_fill_remark`（带 `text`）

---

## Task 1: 创建字段模板文件 + 注册资源

**Files:**
- Create: `profile-template.md`
- Modify: `manifest.json:29`

- [ ] **Step 1: 创建 `profile-template.md`**

文件内容（每行一个字段，括号内是给 AI 的值类型提示，解析时会被自动剥离）：

```markdown
国籍
出发地
机票是否需要代订 (是/否)
签证是否需要代订 (是/否)
是否首次来华 (是/否)
人数房型年龄
出行日期
游玩天数
旅行城市(行程)
导游(语言)
交通
```

- [ ] **Step 2: 修改 `manifest.json`，把 `profile-template.md` 加入 web_accessible_resources**

把：
```json
      "resources": ["injected.js", "skills.md"],
```
改为：
```json
      "resources": ["injected.js", "skills.md", "profile-template.md"],
```

- [ ] **Step 3: 验证**

重载插件（chrome://extensions → 该扩展 → 刷新）。打开任意 SaleSmartly 标签页控制台执行：
```js
fetch(chrome.runtime.getURL("profile-template.md")).then(r=>r.text()).then(console.log)
```
预期：打印出上面 11 行字段文本。若报错 `Cannot read properties of undefined`，说明资源没注册成功，检查 manifest。

- [ ] **Step 4: Commit**

```bash
git add profile-template.md manifest.json
git commit -m "feat(profile): 新增字段模板文件 profile-template.md 并注册为 web resource"
```

---

## Task 2: 录制 get-message-list 请求模板

目的：当 SaleSmartly 自己请求消息列表时，把**请求**（url/method/body）录下来存到 storage，供 Task 3 重放。

**Files:**
- Modify: `injected.js`（fetch 拦截段 ~59-92、XHR 拦截段 ~95-137）
- Modify: `content.js`（message 监听段 ~13-91）
- Modify: `background.js`（onMessage 监听段 ~10-45，新增 saveMsgListTemplate）

- [ ] **Step 1: injected.js — fetch 路径录制请求**

在 fetch 拦截里，找到：
```js
        if (url.includes("get-message-list")) {
          console.log("[SS-Listener] FETCH get-message-list 命中!");
```
在其**上方**插入录制请求的代码（注意在 `return origFetch.apply` 之后、response 处理之前的同一作用域；这里 `init` 可用）：

```js
        if (url.includes("get-message-list")) {
          // ===== 录制请求模板（供档案功能分页重放）=====
          var reqBody = null;
          try {
            reqBody = init && init.body ? (typeof init.body === "string" ? init.body : JSON.stringify(init.body)) : null;
          } catch (e) {}
          window.postMessage({
            type: "__ss_msglist_request",
            url: url,
            method: (init && init.method) || "GET",
            body: reqBody,
            timestamp: Date.now(),
          }, "*");
          console.log("[SS-Listener] FETCH get-message-list 命中!");
```

- [ ] **Step 2: injected.js — XHR 路径录制请求**

XHR 的 `open` 当前只存了 url。先在 `XMLHttpRequest.prototype.open` 里补存 method：
找到：
```js
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ssUrl = url;
    return origOpen.apply(this, arguments);
  };
```
改为：
```js
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ssUrl = url;
    this.__ssMethod = method;
    return origOpen.apply(this, arguments);
  };
```

再在 XHR `send` 里 `get-message-list` 命中处补录制。找到：
```js
    if (url.includes("get-message-list")) {
      console.log("[SS-Listener] XHR get-message-list 命中!", url);
```
改为（在其 load 监听之后、不影响原有逻辑；这里 `body` 是 send 的入参）：
```js
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
        timestamp: Date.now(),
      }, "*");
```
> 注：`send` 函数体开头有 `var self = this;`，所以用 `self.__ssMethod`。

- [ ] **Step 3: content.js — 上报请求模板给 background**

在 content.js 的 `window.addEventListener("message", ...)` 回调里（现有若干 `if (msg.type === ...)` 之后）追加：
```js
    if (msg.type === "__ss_msglist_request") {
      chrome.runtime.sendMessage({
        action: "msglist_request_template",
        url: msg.url,
        method: msg.method,
        body: msg.body,
        timestamp: msg.timestamp,
      });
    }
```

- [ ] **Step 4: background.js — 接收并存储模板**

在 `chrome.runtime.onMessage.addListener` 里（现有 if 链中）追加一个分支：
```js
  if (msg.action === "msglist_request_template") {
    saveMsgListTemplate(msg);
  }
```

在 background.js 文件末尾（`getAISuggestions` 之后）新增函数：
```js
async function saveMsgListTemplate(msg) {
  var bodyObj = {};
  try { bodyObj = msg.body ? JSON.parse(msg.body) : {}; } catch (e) { bodyObj = {}; }
  var chatUserId = bodyObj.chat_user_id || bodyObj.chatUserId || "";
  if (!chatUserId) return;
  var result = await chrome.storage.local.get(["msgListTemplates"]);
  var templates = result.msgListTemplates || {};
  templates[chatUserId] = {
    chatUserId: chatUserId,
    url: msg.url,
    method: msg.method || "POST",
    body: msg.body,
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ msgListTemplates: templates });
  console.log("[SS-Listener] 已存请求模板: chatUserId=" + chatUserId);
}
```

- [ ] **Step 5: 验证**

重载插件。在 SaleSmartly 打开**任意一个客户对话**（触发 get-message-list）。控制台应看到 `已存请求模板: chatUserId=...`。然后在扩展的 service worker 控制台（chrome://extensions → 检查视图 service worker）执行：
```js
chrome.storage.local.get(["msgListTemplates"], r => console.log(JSON.stringify(r.msgListTemplates, null, 2)))
```
预期：看到该 chatUserId 的模板对象，含 url/method/body（body 是含 chat_user_id 和分页参数的 JSON 字符串）。把 body 内容截图/抄下——**Task 3 要据此确认分页参数名**。

- [ ] **Step 6: Commit**

```bash
git add injected.js content.js background.js
git commit -m "feat(profile): 录制 get-message-list 请求模板并按客户存入 storage"
```

---

## Task 3: 分页重放拿完整历史

目的：点档案功能时，用录到的模板在页面上下文里分页重放，拼出完整消息数组。分页参数名**自动从录到的 body 推断**，不硬编码。

**Files:**
- Modify: `injected.js`（新增重放函数 + 指令监听）
- Modify: `content.js`（relay `replay_msglist` 指令与结果）
- Modify: `background.js`（新增 `replayViaContent`）

- [ ] **Step 1: injected.js — 新增分页重放函数与指令监听**

在 injected.js 文件末尾、`console.log("[SS-Listener] 拦截已注入...")` **之前**插入：

```js
  // ==================== 分页重放（客户档案功能）====================
  async function replayMsgList(template) {
    if (!template || !template.url) throw new Error("无请求模板");
    var baseBody = {};
    try { baseBody = template.body ? JSON.parse(template.body) : {}; } catch (e) { baseBody = {}; }

    // 从 body 推断分页参数名
    var keys = Object.keys(baseBody);
    var pageKey = keys.find(function (k) {
      return /page(_?no|_?num|_?index)?$/.test(k) && !/size/i.test(k);
    });
    if (!pageKey) pageKey = keys.find(function (k) { return /offset|cursor|pageno|pagenum/i.test(k); });
    var sizeKey = keys.find(function (k) { return /page_?size|per_?page|limit|count|size$/i.test(k); });
    var pageSize = (sizeKey && parseInt(baseBody[sizeKey])) || 20;
    var startPage = pageKey ? (parseInt(baseBody[pageKey]) || 1) : 1;

    var all = [];
    var maxPages = 50;
    var page = startPage;
    while (page - startPage < maxPages) {
      var bodyCopy = Object.assign({}, baseBody);
      if (pageKey) bodyCopy[pageKey] = page;
      var resp = await fetch(template.url, {
        method: template.method || "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyCopy),
        credentials: "include",
      });
      if (!resp.ok) throw new Error("重放失败 HTTP " + resp.status);
      var json = await resp.json();
      var list = (json && json.data && json.data.list) ? json.data.list
               : (json && Array.isArray(json.data)) ? json.data
               : [];
      if (!list.length) break;
      all = all.concat(list);
      if (list.length < pageSize) break; // 最后一页
      page++;
    }
    console.log("[SS-Listener] 重放完成: 共 " + all.length + " 条 (pageKey=" + (pageKey||"无") + ")");
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
```

- [ ] **Step 2: content.js — relay replay 指令（background→injected）与结果回传**

在 content.js 的 `chrome.runtime.onMessage.addListener` 回调里（现有 `if (msg.action === ...)` 链中）追加：
```js
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
        sendResponse({ ok: false, error: "重放超时(30s)" });
      }, 30000);
      return true; // 异步 sendResponse
    }
```

- [ ] **Step 3: background.js — replayViaContent 封装**

在 background.js 末尾新增（找 SaleSmartly tab 并发 replay 指令、等结果）：
```js
async function replayViaContent(template) {
  var tabs = await chrome.tabs.query({ url: "https://app.salesmartly.com/*" });
  if (!tabs.length) throw new Error("SaleSmartly 页面未打开");
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabs[0].id, { action: "replay_msglist", template: template }, function (resp) {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || "重放失败"));
      resolve(resp.list || []);
    });
  });
}
```

- [ ] **Step 4: 验证（需真实客户 + 已录到模板）**

确保 Task 2 已为某客户录到模板。重载插件。在 **service worker 控制台**执行（替换真实 chatUserId）：
```js
chrome.storage.local.get(["msgListTemplates"], async r => {
  const t = r.msgListTemplates["<真实chatUserId>"];
  const tabs = await chrome.tabs.query({url:"https://app.salesmartly.com/*"});
  chrome.tabs.sendMessage(tabs[0].id, {action:"replay_msglist", template:t}, res => console.log(res));
});
```
预期：`{ok:true, list:[...大量消息...]}`，且页面控制台打印 `重放完成: 共 N 条 (pageKey=...)`。
- 若 `pageKey=无` 且只拿到一页：说明 body 里没有显式分页参数（可能是 cursor/时间戳分页）。**此时需回看 Step 5（Task 2）抄下的 body**，手动确认分页机制，再调整 `replayMsgList` 的推断正则。把确认结果记在该任务的执行笔记里。
- 若 `重放失败 HTTP 401/403`：鉴权依赖 cookie 之外的头（如 Authorization）。回看 fetch 路径录到的 `init.headers`，必要时把 headers 也录进模板并在重放时带上。

- [ ] **Step 5: Commit**

```bash
git add injected.js content.js background.js
git commit -m "feat(profile): 分页重放 get-message-list 拿完整历史（参数名自动推断）"
```

---

## Task 4: background AI 抽取主流程

目的：新增 `get_customer_profile` —— 拉历史（失败降级）→ 格式化截断 → 读字段模板 → 调 AI → 解析为 `{label:value}`。

**Files:**
- Modify: `background.js`（onMessage 加分支 + 新增 getCustomerProfile / parseProfileFields / normLabel + DEFAULT_FIELDS 常量）

- [ ] **Step 1: background.js — onMessage 加分支**

在 onMessage 监听里追加：
```js
  if (msg.action === "get_customer_profile") {
    getCustomerProfile(msg.chatUserId).then(sendResponse).catch(function (e) {
      sendResponse({ error: e.message || "档案生成失败" });
    });
    return true;
  }
```

- [ ] **Step 2: background.js — 顶部加 DEFAULT_FIELDS（模板加载失败兜底）**

在 `var CHANNEL_MAP = {...};` 之后加：
```js
var DEFAULT_FIELDS = "国籍\n出发地\n机票是否需要代订 (是/否)\n签证是否需要代订 (是/否)\n是否首次来华 (是/否)\n人数房型年龄\n出行日期\n游玩天数\n旅行城市(行程)\n导游(语言)\n交通";
```

- [ ] **Step 3: background.js — 文件末尾加 normLabel + parseProfileFields**

```js
function normLabel(s) {
  return String(s).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function parseProfileFields(text, fieldsText) {
  var labels = fieldsText.split("\n").map(function (l) { return normLabel(l); }).filter(Boolean);
  var fields = {};
  labels.forEach(function (l) { fields[l] = "未提及"; });
  for (var i = 0; i < text.split("\n").length; i++) {
    var m = text.split("\n")[i].trim().match(/^(.+?)[:：]\s*(.+)$/);
    if (m) {
      var label = normLabel(m[1]);
      var value = m[2].trim();
      if (fields.hasOwnProperty(label)) fields[label] = value;
    }
  }
  return fields;
}
```

- [ ] **Step 4: background.js — 文件末尾加 getCustomerProfile**

```js
async function getCustomerProfile(chatUserId) {
  // 1. 解析 chatUserId
  if (!chatUserId) {
    var ui = await chrome.storage.local.get(["userInfo"]);
    chatUserId = ui.userInfo && ui.userInfo.chatUserId;
  }
  if (!chatUserId) return { error: "请先在 SaleSmartly 打开一个客户对话" };

  // 2. 取请求模板
  var tplRes = await chrome.storage.local.get(["msgListTemplates"]);
  var template = tplRes.msgListTemplates && tplRes.msgListTemplates[chatUserId];

  // 3. 拉完整历史（失败则 incomplete）
  var fullList = null;
  var incomplete = false;
  if (template) {
    try { fullList = await replayViaContent(template); }
    catch (e) { console.error("[SS-Listener] 重放失败，降级:", e); fullList = null; incomplete = true; }
  } else {
    incomplete = true;
  }

  // 4. 组消息列表：优先 fullList，否则降级用已存消息
  var chatMsgs = [];
  if (fullList && fullList.length) {
    fullList.forEach(function (item) {
      var rec = parseAPIMessage(item, { pageUrl: "" });
      if (rec && rec.message) chatMsgs.push(rec);
    });
  } else {
    var stored = await getMessages(2000);
    chatMsgs = stored.filter(function (m) { return m.chat_user_id === chatUserId && m.message; });
  }
  if (!chatMsgs.length) {
    return { error: incomplete ? "无请求模板且无已抓取消息，请先在 SaleSmartly 打开该客户对话" : "无对话记录" };
  }

  // 5. 排序 + 截断（保留最早 20 条 + 最近大头，上限 60k 字符）
  chatMsgs.sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
  var contextLines = chatMsgs.map(function (m) {
    return "[" + (m.sender === "agent" ? "客服" : "客户") + "] " + (m.message || "");
  });
  var contextText = contextLines.join("\n");
  var truncated = false;
  var MAX = 60000;
  if (contextText.length > MAX) {
    truncated = true;
    var firstPart = contextLines.slice(0, 20).join("\n");
    var tail = contextText.slice(-(MAX - firstPart.length - 50));
    contextText = firstPart + "\n…(中间部分省略)…\n" + tail;
  }

  // 客户名
  var customerName = "";
  for (var j = chatMsgs.length - 1; j >= 0; j--) {
    if (chatMsgs[j].customer_name) { customerName = chatMsgs[j].customer_name; break; }
  }

  // 6. 读字段模板
  var fieldsText = "";
  try {
    var r = await fetch(chrome.runtime.getURL("profile-template.md"));
    fieldsText = (await r.text()).trim() || DEFAULT_FIELDS;
  } catch (e) { fieldsText = DEFAULT_FIELDS; }

  // 7. 调 AI
  var systemPrompt = "你是跨境游客服需求分析助手。从客服与客户的对话中提取客户需求档案，只根据对话中明确出现或能合理推断的信息，不要编造。";
  var userPrompt = "请按下面的字段列表逐行提取客户需求档案。\n规则：1) 未提及的字段填\"未提及\"；2) 是/否类字段能从上下文判断就判断，判断不出填\"未提及\"；3) 严格只输出\"字段: 值\"格式，每行一个字段，字段名与下面给出的一致（不要带括号提示），不要输出任何多余解释或前后缀。\n\n字段列表：\n" + fieldsText + "\n\n对话上下文：\n" + contextText;

  var response = await fetch(AI_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + AI_API_KEY },
    body: JSON.stringify({
      model: AI_API_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 500,
    }),
  });
  if (!response.ok) {
    var errText = await response.text();
    return { error: "AI API错误: " + response.status + " " + errText };
  }
  var data = await response.json();
  var aiContent = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";

  // 8. 解析
  var fields = parseProfileFields(aiContent, fieldsText);

  // 9. 组装
  var rawText = Object.keys(fields).map(function (label) { return label + ": " + fields[label]; }).join("\n");
  return {
    fields: fields,
    rawText: rawText,
    chatUserId: chatUserId,
    customerName: customerName,
    truncated: truncated,
    incomplete: incomplete,
    savedAt: new Date().toLocaleString("zh-CN"),
  };
}
```

- [ ] **Step 5: 验证（service worker 控制台直调）**

重载插件。在 service worker 控制台执行：
```js
chrome.runtime.sendMessage({action:"get_customer_profile"}, r => console.log(r))
```
预期：返回 `{fields:{国籍:"印尼",...}, rawText:"...", chatUserId, customerName, truncated, incomplete, savedAt}`。
- 若 `error:"请先在 SaleSmartly 打开一个客户对话"`：说明 storage 里没 `userInfo`，去 SaleSmartly 打开一个客户对话（触发 get-user-info）再试。
- 若 `fields` 全是 `未提及`：看 `rawText` 和 service worker 网络面板里 AI 的实际返回，多半是对话上下文为空（重放没拿到消息，见 Task 3 Step 4 排查）或 AI 没遵守格式。
- 若 `incomplete:true` 且字段稀少：符合预期（降级路径），打开该客户对话让模板录上后再试。

- [ ] **Step 6: Commit**

```bash
git add background.js
git commit -m "feat(profile): get_customer_profile 主流程（拉历史+AI抽取+解析+降级）"
```

---

## Task 5: 填入备注栏（DOM 写入 + 降级复制）

> ⚠️ 选择器需对真实 SaleSmartly 页面确认。Step 1 是发现步骤。

**Files:**
- Modify: `injected.js`（新增 findRemarkEl / setNativeValue / fillRemark + 指令监听）
- Modify: `content.js`（relay `fill_remark`）

- [ ] **Step 1: 发现备注栏真实 DOM（手动）**

在 SaleSmartly 打开一个客户、让备注栏进入**可编辑**状态（点一下备注区）。F12 选中那个输入框元素，记录它的标签名（textarea/input）、placeholder、class、name 属性。把结果填进 Step 2 的 `REMARK_SELECTORS`（把猜的选择器替换/补充成真实的，真实选择器放最前）。

- [ ] **Step 2: injected.js — 新增填备注函数与指令监听**

在 injected.js 末尾（重放监听之后、`拦截已注入` 日志之前）插入（先把 `REMARK_SELECTORS` 按 Step 1 结果调整）：

```js
  // ==================== 填写备注栏（客户档案功能）====================
  var REMARK_SELECTORS = [
    'textarea[placeholder*="备注"]',
    'textarea[placeholder*="remark" i]',
    'textarea[name*="remark" i]',
    '[class*="remark" i] textarea',
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

  function fillRemark(text) {
    var el = findRemarkEl();
    if (!el) return false;
    try { el.focus(); } catch (e) {}
    setNativeValue(el, text);
    try { el.blur(); } catch (e) {}
    return true;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var m = event.data;
    if (m && m.type === "__ss_fill_remark") {
      var ok = fillRemark(m.text);
      window.postMessage({ type: "__ss_fill_remark_result", ok: ok, timestamp: Date.now() }, "*");
    }
  });
```

- [ ] **Step 3: content.js — relay fill_remark**

在 content.js 的 `chrome.runtime.onMessage.addListener` 里追加：
```js
    if (msg.action === "fill_remark") {
      window.postMessage({ type: "__ss_fill_remark", text: msg.text }, "*");
      var waitFill = function (ev) {
        if (ev.source !== window) return;
        var r = ev.data;
        if (r && r.type === "__ss_fill_remark_result") {
          window.removeEventListener("message", waitFill);
          sendResponse({ ok: r.ok });
        }
      };
      window.addEventListener("message", waitFill);
      setTimeout(function () {
        window.removeEventListener("message", waitFill);
        sendResponse({ ok: false });
      }, 5000);
      return true;
    }
```

- [ ] **Step 4: 验证**

重载插件。在 SaleSmartly 页面控制台直接测：
```js
window.postMessage({type:"__ss_fill_remark", text:"测试备注内容"}, "*")
```
预期：备注栏被填入"测试备注内容"。若没填上：`findRemarkEl()` 返回 null → 回 Step 1 校准选择器；填上了但 SaleSmartly 没保存 → 可能要点页面别处触发 blur 或点保存按钮，在 `fillRemark` 末尾补触发逻辑。

- [ ] **Step 5: Commit**

```bash
git add injected.js content.js
git commit -m "feat(profile): 填入 SaleSmartly 备注栏（原生 setter 写值 + 找不到降级复制）"
```

---

## Task 6: popup 新增「客户档案」Tab + 生成/展示/复制/填入/发送

**Files:**
- Modify: `popup.html`（tab 栏加第三个 tab、加第三 panel）
- Modify: `popup.js`（initTabs 改通用、initProfile / renderProfile / fillRemark / sendProfile / copyProfile / loadCachedProfile）

- [ ] **Step 1: popup.html — tab 栏加第三个**

找到：
```html
    <div class="tab active" data-tab="current">当前对话</div>
    <div class="tab" data-tab="history">历史记录</div>
```
改为：
```html
    <div class="tab active" data-tab="current">当前对话</div>
    <div class="tab" data-tab="history">历史记录</div>
    <div class="tab" data-tab="profile">客户档案</div>
```

- [ ] **Step 2: popup.html — 加第三 panel**

在 `<!-- 历史记录 -->` 那个 `panelHistory` div **之前**插入：
```html
  <!-- 客户档案 -->
  <div class="panel" id="panelProfile">
    <div class="ai-panel">
      <div class="ai-toolbar">
        <div class="ai-info" id="profileInfo">点击"生成档案"</div>
        <button class="btn primary" id="btnGetProfile">生成档案</button>
      </div>
      <div id="profileContent">
        <div class="empty">
          <div>打开客户对话后，点击"生成档案"</div>
          <div class="hint">AI 从完整对话抽取需求档案</div>
        </div>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: popup.js — 改 initTabs 通用化 + 触发 profile 缓存加载**

把现有 `initTabs` 整体替换为：
```js
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
```

- [ ] **Step 4: popup.js — DOMContentLoaded 里挂载 profile 初始化**

找到 `DOMContentLoaded` 回调里的：
```js
  initTabs();
  initAI();
  initUserInfo();
  checkStatus();
  loadCurrentSuggestions();
```
在其后加一行：
```js
  initProfile();
```

- [ ] **Step 5: popup.js — 文件末尾加 profile 全套逻辑**

```js
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
```

> 注：`esc()` 已存在于 popup.js 末尾，直接复用。

- [ ] **Step 6: 验证**

重载插件。点扩展图标 → 切到「客户档案」Tab → 点「生成档案」。
预期：先显示 loading，随后渲染字段卡片（`未提及` 灰色），底部三个按钮。
- 点「复制」→ 粘贴到任意处确认是 `字段: 值` 多行文本。
- 点「填入备注栏」→ SaleSmartly 备注栏被填入（或提示降级复制）。
- 点「发送后端」→ 提示"已发送后端"（需后端 `192.168.31.108:3000` 在线）。

- [ ] **Step 7: Commit**

```bash
git add popup.html popup.js
git commit -m "feat(profile): popup 新增客户档案 Tab（生成/展示/复制/填入备注/发送后端）"
```

---

## Task 7: 端到端验证

**Files:** 无（纯验证）

- [ ] **Step 1: 完整链路**

1. 重载插件
2. SaleSmartly 打开一个**有较多历史**的老客户对话（触发 get-message-list 录到模板、触发 get-user-info 存 userInfo）
3. 扩展 popup → 客户档案 → 生成档案
4. 核对：
   - 字段抽取与对话内容吻合、`未提及` 合理
   - service worker 控制台有 `重放完成: 共 N 条`，N 与该客户实际历史量级一致
   - 非 `incomplete`、非 `truncated`（若客户历史超大则 truncated 正常）

- [ ] **Step 2: 降级路径**

1. 清空 storage（popup 右上角「清空」或 service worker 控制台 `chrome.storage.local.clear()`）
2. 不打开新客户，直接对一个**没有模板**的 chatUserId 生成（或先清 msgListTemplates）
3. 核对：提示信息或档案顶部出现 `⚠ 未取到完整历史...（数据可能不完整）`，不报错崩溃

- [ ] **Step 3: 字段模板增减生效**

编辑 `profile-template.md` 加一行测试字段（如 `预算`），重载插件，重新生成 → 确认新字段出现在档案里。验证后改回。

- [ ] **Step 4: 最终 commit（如有末尾微调）**

```bash
git add -A
git commit -m "chore(profile): 端到端验证后的微调"
```
（无微调则跳过）

---

## Self-Review（已执行）

- **Spec 覆盖**：拉完整历史(Task 2+3) ✅、AI 抽取不含 skills.md(Task 4 systemPrompt) ✅、固定字段模板可增减(Task 1+4 Step6) ✅、60k 截断保留首20条(Task 4 Step4) ✅、客户档案 Tab(Task 6) ✅、填入备注+降级复制(Task 5+6 doFillRemark/copyFallbackAndWarn) ✅、发送后端默认走 quick-create-customer(Task 6 doSendProfile) ✅、无自动同步（未实现任何自动触发，符合需求）✅、错误处理（无模板/重放失败/空对话/解析/找不到备注栏 全覆盖）✅。
- **占位符扫描**：无 TBD/TODO；备注栏选择器与分页参数两个"真实页面确认项"已落到 Task 5 Step 1 与 Task 3 Step 4，非占位。
- **命名一致性**：消息协议块统一；`getCustomerProfile / parseProfileFields / normLabel / replayViaContent / saveMsgListTemplate / findRemarkEl / setNativeValue / fillRemark` 定义与调用一致；popup 的 `_currentProfile / profileCurrent / btnGetProfile / profileContent` 前后一致。
