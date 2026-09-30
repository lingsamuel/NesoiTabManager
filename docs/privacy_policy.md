# 隐私政策（Nesoi 标签管理器）

最后更新：2026-09-30

本政策适用于浏览器扩展 **Nesoi 标签管理器**（Chrome/Edge 与 Firefox 版本，以下称"本扩展"）。
本政策的中文版本为正式版本；英文版本仅为方便审阅而提供，如有冲突以中文版本为准。

## 一句话概括

本扩展默认**不向任何地方传输任何数据**。唯一的例外是你在设置里自行配置并主动点击的
「AI 分组」功能：它会把所选标签页的标题与基础域名发送到**你自己填写的** API 端点。
开发者不运营任何服务器，不接收、不存储、不转售你的任何数据。

## 1. 开发者直接收集的数据

**无。**

- 没有账号体系，不要求登录或注册。
- 没有统计分析、埋点、遥测、崩溃上报、广告或任何形式的远程配置。
- 本扩展不包含任何指向开发者自有服务器的网络请求。
- 开发者无法看到你的标签页、列表、设置或使用行为。

## 2. 数据保存在哪里

以下数据全部只保存在你本机的浏览器扩展存储（`chrome.storage.local`）中，不会离开你的设备：

- 保存的列表及其名称、描述、条目（标题、URL、保存时间）；
- 标签页树结构与父子关系；
- 近期标签页与冻结历史；
- 扩展设置，包括 AI 端点、模型名与 API Key。

卸载扩展或在浏览器中清除扩展数据即会删除这些内容。开发者没有任何副本。

## 3. 唯一的数据外发：AI 分组（可选、手动触发）

AI 分组是一个需要你自己提供服务的功能，默认不可用，只有同时满足以下条件才会发生数据传输：

1. 你在扩展设置中填写了 API 端点、API Key 与模型名，并且
2. 你主动点击了「AI 分组」按钮，并且
3. 你同意了下方的数据传输授权。

（在 Firefox 140 及以上版本，第 3 步会由浏览器的内置"数据收集与传输"权限提示完成；
你可以随时在 `about:addons` 的"权限与数据"中查看或撤销该授权。撤销后本扩展不会外发数据。）

**发送的内容：**

- 你所选标签页的标题；
- 这些标签页的基础域名（例如 `example.com`，不是完整 URL 与查询参数）；
- 它们的打开顺序；
- 仅当你开启了"发送已有列表标题/描述作为参考"时，你已保存列表的名称与描述。

**发送对象：** 只有你自己填写的那个 API 端点（例如 OpenAI、Azure OpenAI、或你自建的网关）。
开发者不是接收方，也无法访问该请求。该端点如何存储与使用数据，取决于你与该服务商之间的约定，
请查阅其隐私政策。

**用途：** 仅用于生成标签分组建议，返回结果只用于在你本机生成新列表。

**API Key：** 只存放在本机扩展存储中，仅用于向你配置的端点发起上述请求。

## 4. 权限用途说明

| 权限 | 用途 |
| --- | --- |
| `tabs` | 读取标签页的标题/URL/窗口归属，用于展示、保存、移动、冻结与关闭标签页 |
| `storage` | 在本机保存列表、树结构、近期标签与设置 |
| `contextMenus` / `menus.overrideContext`(Firefox) | 在网页与标签栏右键菜单中提供"保存到列表"等入口 |
| `alarms` | 定时检查近期新增标签页，弹出提醒气泡 |
| `<all_urls>` + 内容脚本 | 在页面上渲染右下角的"快捷保存"悬浮组件；见下条 |
| `sidebar_action`(Firefox) | 显示原生标签树侧边栏 |

内容脚本只在页面中创建并管理本扩展自己的悬浮组件与提醒气泡，**不读取、不采集、不传输**页面文本、
表单内容、Cookie 或浏览历史。它不会修改页面原有内容，也不会注入广告。

## 5. 我们不做什么

- 不出售、出租或共享你的任何数据；
- 不加载或执行远程代码（所有代码随扩展一同分发）；
- 不注入广告、不做联属推广、不改变你的主页、搜索引擎或新标签页；
- 不使用 Cookie 或指纹识别技术跟踪你；
- 不将数据传输给开发者或任何第三方，除非是上文第 3 节你主动发起的那一次。

## 6. 儿童隐私

本扩展不面向 13 岁以下儿童，也不会有意收集儿童的任何信息。

## 7. 政策变更

本政策如有变更，会随扩展版本更新一并发布，并在变更涉及数据实践时于扩展的版本说明中提示。

## 8. 联系方式

如有隐私相关问题，请通过本扩展在 addons.mozilla.org / Chrome 应用商店的商店页面
"支持站点"或"支持邮箱"渠道联系开发者。

---

# Privacy Policy (English)

Last updated: 2026-09-30

This policy applies to the browser extension **Nesoi Tab Manager** (Nesoi 标签管理器).
The Chinese version above is authoritative.

**Summary:** the extension transmits nothing by default. The only exception is the optional,
user-triggered "AI grouping" feature, which sends the titles and base domains of the selected tabs to
the API endpoint **you configure yourself**. The developer operates no servers and receives no data.

1. **Data collected by the developer: none.** No accounts, no analytics, no telemetry, no crash
   reporting, no ads, no remote configuration, and no requests to developer-owned servers.
2. **Local storage.** Saved lists, the tab tree, recent-tab/discard history and your settings
   (including the AI endpoint, model and API key) are stored only in `chrome.storage.local` on your
   device. Uninstalling the extension deletes them; the developer keeps no copy.
3. **AI grouping (optional, manual).** Data leaves your device only if you configure an endpoint, an
   API key and a model, then click "AI 分组" and grant the data-transmission permission (Firefox 140+
   shows its built-in consent prompt; you can review or revoke it under *Permissions and data* in
   `about:addons`). What is sent: the titles of the selected tabs, their base domains (for example
   `example.com`, not full URLs or query strings), their open order, and — only if you enabled the
   option — the titles/descriptions of your saved lists. It goes only to the endpoint you entered; the
   developer is not a recipient. Your API key is kept locally and used solely for that request.
4. **Permissions.** `tabs` lists and manages tabs; `storage` persists your data locally;
   `contextMenus` / `menus.overrideContext` add the "save to list" menu entries; `alarms` powers the
   recent-tab reminder; the content script and `<all_urls>` render the in-page quick-save widget and
   never read or transmit page text, form data, cookies or history; `sidebar_action` shows the native
   sidebar.
5. **No selling or sharing of data, no remote code, no ads, no tracking.**
6. **Children.** Not directed to children under 13.
7. **Changes.** Updates are published with new extension versions and called out in the release notes
   when they affect data practices.
8. **Contact.** Use the "support site" or "support email" link on the add-on's store listing.
