# 后台服务与存储

## 模块定位
- 入口：`background.js`（Manifest V3 service worker）。
- 子模块：`background/context_menu.js`、`background/lists.js`、`background/ai.js`、`background/discard.js`、`background/storage.js`。
- 职责：统一事件监听、消息路由、持久化与自动冻结调度。

## 核心功能
- 扩展启动与安装：清理 action 弹窗、重建右键菜单、重置冻结跟踪状态并初始化自动冻结定时器。
- 扩展按钮：点击后打开 `ui/manager.html`；若已打开则聚焦现有窗口与标签页。
- 右键菜单：根据列表动态生成“保存到列表 / 关闭并保存到列表”子项。
- 自动冻结：监听 `chrome.alarms`、标签激活与窗口焦点变化、标签增删替换，用于计算闲置与冻结候选。
- 近期标签页提醒：监听标签新增/关闭、维护打开时间与启动期状态、按间隔触发提醒，并向内容脚本广播气泡展示。
- 消息接口：统一处理 UI 与内容脚本的运行时消息（保存标签、列表管理、AI 分组、冻结配置等）。

## 标签跳转
- 激活标签页统一由后台执行（`activateTab` 消息）：先前置标签所在窗口，再激活标签。
- 原因：管理页浮层是嵌入网页的 iframe，该上下文中 `chrome.windows`/`chrome.tabs` 不可用，必须经 `chrome.runtime` 消息委托后台处理。

## 消息协议（runtime message）
- `activateTab`：激活指定标签页（参数 `tabId`、`windowId`），用于管理页点击跳转。
- `getLists`：读取全部列表。
- `saveTabs`：按列表保存指定 tabIds，可选择新建列表、可选关闭标签。
- `saveCurrentTab`：保存当前页面（用于右键菜单与悬浮组件）。
- `createList` / `renameList` / `deleteList`：列表增删改。
- `updateListDescription`：更新列表描述。
- `deleteListItems`：删除列表内指定索引的标签。
- `moveListItems`：跨列表移动选中标签，可创建新列表。
- `importLists`：导入列表（merge/replace）。
- `getAiConfig` / `saveAiConfig`：读取/保存 AI 配置。
- `aiGroupTabs`：执行 AI 分组，返回分组结果与截断数量。
- `saveGroupedTabs`：把 AI 分组结果生成新列表。
- `getDiscardConfig` / `saveDiscardConfig`：读取/保存自动冻结配置。
- `getDiscardCandidates` / `getDiscardHistory`：查询冻结候选与历史记录。
- `manualDiscard` / `manualDiscardTabs`：手动冻结单个或批量标签。
- `getRecentTabs`：读取近期标签页列表与统计信息。
- `markRecentReviewed`：标记“已阅”，更新 `lastReviewedAt` 并结束 startup 期。
- `getRecentBubblePosition` / `saveRecentBubblePosition`：读取/写入气泡拖动位置。
- `getRecentConfig` / `saveRecentConfig`：读取/保存近期标签页提醒配置。

## 存储模型
- 详细存储结构与字段说明见：`docs/data/storage_model.md`。

## 交互要点
- 右键菜单与悬浮组件共享 `saveCurrentTab`，确保保存逻辑一致。
- 列表变化触发 `chrome.storage.onChanged` 自动刷新右键菜单。
- 自动冻结配置变更会即时更新定时器与历史上限裁剪。
- 非可冻结 URL（如 `chrome://`、`edge://`）会被过滤，避免误操作。
