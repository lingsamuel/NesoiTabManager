# 后台服务与存储

## 模块定位
- 入口：`background.js`（Manifest V3 service worker）。
- 子模块：`background/context_menu.js`、`background/lists.js`、`background/ai.js`、`background/discard.js`、`background/recent_tabs.js`、`background/tree.js`、`background/tree_core.js`、`background/storage.js`。
- 职责：统一事件监听、消息路由、持久化、自动冻结调度与树状结构维护。
- `background/tree_core.js` 为**无 chrome API 依赖的纯逻辑**（建树、对齐、提升、移动推断、扁平化），既被 `tree.js` 调用，也被 `scripts/bench_tree.mjs` 直接引用，保证基准测的就是生产代码。

## 核心功能
- 扩展启动与安装：清理 action 弹窗、重建右键菜单、重置冻结跟踪状态并初始化自动冻结定时器。
- 扩展按钮：点击后打开 `ui/manager.html`；若已打开则聚焦现有窗口与标签页。
- 右键菜单：根据列表动态生成“保存到列表 / 关闭并保存到列表”子项；Firefox 下额外注册一组 `contexts: ["tab"]` 的
  标签菜单项（刷新/固定/静音/冻结/复制链接/移动到窗口），供侧边栏用 `menus.overrideContext` 以原生菜单外壳呈现，
  并在 `menus.onShown` 中按被右键标签的状态刷新文案与可用性。
- 自动冻结：监听 `chrome.alarms`、标签激活与窗口焦点变化、标签增删替换，用于计算闲置与冻结候选。
- 近期标签页提醒：监听标签新增/关闭、维护打开时间与启动期状态、按间隔触发提醒，并向内容脚本广播气泡展示。
- 树状结构：监听标签创建/关闭/移动/跨窗口/`openerTabId` 变化，按窗口懒加载并维护内存树，空闲防抖后写入 `chrome.storage.local`。
- 消息接口：统一处理 UI 与内容脚本的运行时消息（保存标签、列表管理、AI 分组、冻结配置、树结构等）。

## 树状结构维护
- 采用**按窗口懒加载**：后台顶层只注册监听，不做计算；首次需要某窗口的树时才读取快照 + 当前标签做一次 O(n log n) 对齐。
- 浏览器启动/会话恢复期间进入「启动静默期」，结构事件只置「需要重建」标记，不加载、不对齐、不写盘，避免 10K 标签恢复时产生逐事件处理与磁盘写入。
- 结构变化只改内存并置脏；落盘由空闲防抖（默认 5s，突发批量操作时延长到 15s）、兜底 alarm `treeFlush`、`runtime.onSuspend` 触发，且只覆盖发生变化的窗口。
- 详细规则（父子推断、promote intelligently、不变量、对齐算法）见 `docs/ui/tree_style_tabs.md`。

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
- `getTreeStructure`：读取指定（或缺省全部）窗口的树父子映射（仅含有父标签的条目，缺省即顶层），供管理页渲染树状视图。
- `moveTabTree`：管理页拖拽改变父子关系，并同步 `chrome.tabs.move` 移动被拖标签及其整棵子树。
- `createRootTab`：在窗口末尾新建一个**顶层**标签页（侧边栏底部 New Tab 使用）。
  创建前会打一个短时效标记，使 `tabs.onCreated` 跳过"无 opener 挂到活动标签下"的默认规则；
  并显式指定 `index = 当前标签数`，避免 Firefox 的 `insertAfterCurrent` 偏好把新标签插到当前标签之后。
  该标记已泛化为"下一个新标签的落位（parentId）"，`createRootTab` 只是"落位 = 顶层"的特例。
- `createPlacedTab`：按指定落位新建标签页（侧边栏外部拖放使用）——可指定 `parentId` / `beforeTabId` / `afterTabId` /
  `pinned`，后台用与 `moveTabTree` 同一套下标口径算出物理位置，并让 `tabs.onCreated` **同步**套用父子关系
  （路径中没有 await），避免与随后的事件处理竞争导致层级被改回默认规则。
- `openDroppedItem`：执行一次外部拖放的结果——覆盖指定标签（`tabs.update({url})`）或按落位新建标签页；
  传入的是搜索词时改用 `chrome.search.search({ query, tabId })`，让结果落在指定的那个标签上。

## 存储模型
- 详细存储结构与字段说明见：`docs/data/storage_model.md`。

## 交互要点
- 右键菜单与悬浮组件共享 `saveCurrentTab`，确保保存逻辑一致。
- 列表变化触发 `chrome.storage.onChanged` 自动刷新右键菜单。
- 自动冻结配置变更会即时更新定时器与历史上限裁剪。
- 非可冻结 URL（如 `chrome://`、`edge://`）会被过滤，避免误操作。
- 树状结构不新增任何浏览器权限：只使用已有的 `tabs` / `storage` / `alarms`。
- 非用户操作时，后台不会主动移动标签页；只有管理页拖拽改父子、跨窗口子树迁移、以及右键菜单的“移动到窗口”会调用 `chrome.tabs.move`。
- `chrome.windows.onCreated` / `onRemoved` 除维护树结构外，还会重建右键菜单的“移动到窗口”子菜单；
  `menus.onShown` 仅在“期望呈现状态”真的变化时才写回并 `menus.refresh()`，避免刷新死循环。
