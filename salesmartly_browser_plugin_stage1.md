# SaleSmartly 浏览器插件监听工具 - 第一阶段说明

## 1. 项目目的

当前使用 SaleSmartly 作为客服消息聚合工具，客户会从 WhatsApp、Facebook、Instagram、TikTok 等渠道进入 SaleSmartly 客服后台。

由于当前套餐暂时没有使用 SaleSmartly Webhook/API 的权限，因此第一阶段不接后端、不做复杂系统，只先做一个浏览器插件，用来监听 SaleSmartly 网页里的实时对话信息。

目标是先验证：

- 是否能稳定监听到新客户消息
- 是否能实时看到消息内容
- 是否能把监听到的消息保存下来
- 后续是否方便接入 AI 建议、知识库和自动化分析

## 2. 第一阶段范围

第一阶段只做一个本地浏览器插件。

插件运行在客服电脑的 Chrome / Edge 浏览器中，客服正常打开 SaleSmartly 网页并保持登录，插件负责监听页面中的聊天内容变化。

暂时不做：

- 不接后端服务器
- 不接 AI 接口
- 不自动回复客户
- 不调用 SaleSmartly API
- 不修改 SaleSmartly 系统数据

只做：

- 监听当前 SaleSmartly 页面
- 识别新出现的客户消息
- 在插件面板中实时显示监听结果
- 将消息保存到本地文件或本地存储
- 支持导出为 JSON / CSV / TXT 文件

## 3. 基本工作流程

```text
客服打开 SaleSmartly 网页
↓
浏览器插件开始运行
↓
插件监听页面聊天区域变化
↓
发现新的客户消息
↓
提取消息内容、时间、客户名、渠道等信息
↓
在插件面板中实时显示
↓
保存到本地记录
↓
需要时导出文件
```

## 4. 需要监听的信息

优先监听这些字段：

```json
{
  "time": "2026-05-27 15:30:00",
  "channel": "WhatsApp / Messenger / Instagram / TikTok",
  "customer_name": "客户名称",
  "conversation_id": "页面中可识别的会话标识",
  "sender": "customer",
  "message_type": "text",
  "message": "客户发送的消息内容",
  "page_url": "当前 SaleSmartly 页面地址"
}
```

如果页面暂时无法稳定识别全部字段，第一版可以先保证：

- 消息时间
- 客户名
- 消息内容
- 当前页面地址

## 5. 插件主要功能

### 5.1 实时监听

使用浏览器插件的 content script 注入 SaleSmartly 页面，通过 `MutationObserver` 监听聊天区域 DOM 变化。

当页面出现新的消息气泡时，插件尝试判断是否为客户消息，并提取文本内容。

### 5.2 实时显示

插件提供一个简单的侧边栏或弹窗，显示最近监听到的消息。

示例：

```text
[15:30:00] Ali: How much shipping to UAE?
[15:31:12] Maria: Do you have catalog?
[15:33:05] Ahmed: What is the MOQ?
```

### 5.3 本地保存

插件把监听到的消息先保存在本地，例如：

- Chrome Extension local storage
- IndexedDB
- 临时内存 + 手动导出

第一版建议使用本地存储，避免一刷新页面数据就丢失。

### 5.4 文件导出

支持手动导出文件：

- JSON：方便后续程序处理
- CSV：方便用 Excel / 表格查看
- TXT：方便快速查看原始聊天记录

## 6. 去重逻辑

页面刷新、切换会话、滚动加载历史消息时，可能会重复读取同一条消息。

因此插件需要做简单去重。

建议生成消息指纹：

```text
fingerprint = hash(customer_name + sender + message + approximate_time)
```

如果同一条指纹已经出现过，就不再重复保存。

## 7. 第一版界面设想

插件界面保持简单：

```text
SaleSmartly 消息监听器

状态：正在监听

最近消息：
1. [WhatsApp] Ali: How much shipping to UAE?
2. [Instagram] Maria: Please send catalog.
3. [Messenger] John: What is the price?

按钮：
[开始监听]
[暂停监听]
[清空记录]
[导出 JSON]
[导出 CSV]
[导出 TXT]
```

## 8. 技术实现思路

浏览器插件组成：

```text
manifest.json
content.js
popup.html
popup.js
storage.js
```

核心逻辑：

- `content.js` 注入 SaleSmartly 页面
- 使用 `MutationObserver` 监听聊天区域变化
- 提取新消息文本
- 发送给插件后台或本地存储
- `popup.html` 展示监听结果
- 用户点击按钮导出文件

## 9. 第一阶段成功标准

第一阶段完成后，需要达到：

- 客服打开 SaleSmartly 后，插件可以正常运行
- 客户新消息出现时，插件能捕捉到
- 插件界面能实时显示新消息
- 消息不会大量重复
- 可以导出本地消息文件
- 不影响客服正常使用 SaleSmartly

## 10. 后续扩展方向

第一阶段完成后，可以继续扩展：

- 接入后端服务器
- 接入 AI 回复建议
- 接入产品知识库
- 自动识别客户意图
- 生成多条客服回复
- 一键填入 SaleSmartly 输入框
- 多客服统一消息汇总
- 客户标签和成交数据分析

## 11. 当前结论

当前阶段的目标不是做完整 AI 客服系统，而是先做一个轻量的本地监听工具。

最小可行版本是：

```text
浏览器插件
+
监听 SaleSmartly 页面新消息
+
实时显示
+
本地保存
+
手动导出文件
```

这样可以在不购买 Max 套餐、不接 SaleSmartly API、不搭建后端的情况下，先验证消息监听和数据采集是否可行。
