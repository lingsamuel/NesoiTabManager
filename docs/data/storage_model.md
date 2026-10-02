# 存储结构与数据流

## 位置
- `chrome.storage.local`：持久化列表与配置。
- `chrome.storage.session`：自动冻结会话状态（随浏览器会话生命周期变化）。

## 核心数据结构

### 列表（lists）
- 存放在 `chrome.storage.local` 的 `lists` 键。
- 结构：`Array<List>`。
- `List`：
  - `id`：列表唯一标识。
  - `name`：列表名称。
  - `description`：列表描述（用于 AI 分组提示）。
  - `items`：保存的标签条目数组。
- `ListItem`：
  - `url`：标签链接。
  - `title`：标题或 URL 兜底。
  - `iconKey`：图标在全局图标表 `favIcons` 中的短键（可为空字符串）。
    **落盘结构里不再有 `favIconUrl`**；面向 UI 的读取出口会把它解析回 `favIconUrl`，因此调用方看到的字段与旧结构一致。
  - `savedAt`：保存时间（ISO 字符串）。

### 图标表（favIcons）
- 存放在 `chrome.storage.local` 的 `favIcons` 键。
- 结构：`{ [iconKey]: favIconUrl }`，**全局一张表**，跨列表共享。
- 用途：消除"同一张 favicon 在每个条目里各存一份"的重复。实测 `favIconUrl` 主要是
  `data:image/...;base64,...`，同一站点的大量标签页会成倍占用 `storage.local` 配额。
- `iconKey` 规则（详见 `docs/data/favicon_dedup.md`）：
  - `d:<内容指纹>`：`data:` 形态，按图片内容去重；
  - `p:<origin>`：`page-icon:<pageUrl>` 形态，归一到页面 origin（协议+主机+端口，**不同子域名各自独立**）；
  - `u:<去掉 fragment 的 URL>`：其它形态；
  - `""`：无图标。
- 与 `lists` 在**同一次 `storageSet`** 中写入；每次写列表时顺带裁剪掉不再被引用的表项（GC）。
- 旧数据里的 `favIconUrl` 采用**懒迁移**：读取时原样返回，下一次列表写操作时转成 `iconKey` 并登记入表。
- 导出的 JSON 仍是内联 `favIconUrl` 的自包含格式，不包含 `favIcons`（见 `docs/data/favicon_dedup.md`）。

### AI 配置（aiConfig）
- 存放在 `chrome.storage.local` 的 `aiConfig` 键。
- 字段：
  - `endpoint`：API 端点。
  - `apiKey`：API Key。
  - `model`：模型名称。
  - `apiMode`：Responses / Codex / Chat。
  - `maxTabs`：单次最多标签数。
  - `includeListTitles`：是否附带已有列表参考。

### 自动冻结配置（discardConfig）
- 存放在 `chrome.storage.local` 的 `discardConfig` 键。
- 字段：
  - `enabled`：是否启用自动冻结。
  - `idleMinutes`：闲置阈值（分钟）。
  - `sweepMinutes`：扫描间隔（分钟）。
  - `batchLimit`：单次最多冻结数量。
  - `historyLimit`：冻结历史上限（0 为不限制）。
  - `allowPinned`：是否允许冻结已固定标签。
  - `allowAudible`：是否允许冻结正在发声标签。
  - `matchMode`：白名单匹配方式（domain / url / full）。
  - `regexMode`：是否使用正则匹配。
  - `whitelist`：白名单条目数组或文本行。

### 近期标签页配置（recentTabsConfig）
- 存放在 `chrome.storage.local` 的 `recentTabsConfig` 键。
- 字段：
  - `reminderIntervalMin`：提醒间隔（分钟）。
  - `startupDelaySec`：startup 期结束后的额外延后（秒）。
  - `startupQuietSec`：无新标签的静默窗口（秒）。
  - `startupMaxGraceSec`：startup 最长宽限（秒）。

### 近期标签页状态（recentTabsState）
- 存放在 `chrome.storage.local` 的 `recentTabsState` 键。
- 字段：
  - `lastReviewedAt`：最近一次“已阅”的时间戳（毫秒）。
  - `startupAt`：本次启动期开始时间戳（毫秒）。
  - `startupActive`：是否处于 startup 期。
  - `startupEndAt`：startup 期结束时间戳（毫秒，自动结束时写入）。
  - `bubblePosition`：气泡位置记忆（全局一份）。
    - `left`：距视口左侧像素值。
    - `top`：距视口顶部像素值。
    - `updatedAt`：最近一次拖动写入时间（毫秒）。
  - 行为约束：
    - 仅在内容脚本初始化时读取一次位置。
    - 拖动结束后即时写入。
    - 已打开页面不主动同步其他页面的新位置。

### 近期标签页打开时间（recentTabsOpenAt）
- 存放在 `chrome.storage.session` 的 `recentTabsOpenAt` 键。
- 结构：`{ [tabId]: openAtEpochMs }`。
- 用途：记录每个标签页的最近打开/查看时间（激活时会更新），用于筛选 `openAt > lastReviewedAt`。

### 冻结会话（discardSession）
- 存放在 `chrome.storage.session` 的 `discardSession` 键。
- 字段：
  - `startEpoch`：会话开始时间戳。
  - `lastDiscarded`：最近一次冻结条目。
  - `lastDiscardedAt`：最近冻结时间（ISO）。
  - `historyBatches`：冻结批次数组（含时间与条目）。
  - `freezeCounts`：标签冻结次数映射。

### 标签活动（discardTabActivity）
- 存放在 `chrome.storage.session` 的 `discardTabActivity` 键。
- 结构：`{ [tabId]: firstSeenTimestamp }`。
- 用途：与 `lastAccessed` 结合用于估算闲置时间。

### 树结构快照（treeStructure:&lt;windowId&gt;）
- 存放在 `chrome.storage.local`，**每个窗口一个键**，键名前缀 `treeStructure:`。
- 结构：
  - `v`：结构版本（v2 起含 `i` / `sid`）。
  - `at`：写入时间戳（毫秒）。
  - `n`：标签数。
  - `sid`：写入时的会话令牌（`storage.session` 的 `treeSessionToken.token`）。
  - `items`：按浏览器 `index` 升序的数组，每项 `{ u: url, t: title, p: parentIndex, i: tabId }`；
    `p` 为父标签在 `items` 中的下标，`-1` 表示顶层；`i` 是写入时的标签 id。
- 说明：
  - `u` 是**跨浏览器重启**唯一的配对依据（重启后 tabId 全部重新分配）；`i` 只在同一浏览器会话内有效，
    与 `sid` 配合用于"后台被回收后精确重建父子"：地址栏导航改了 URL、标签被 discard、URL 重复都不影响身份。
  - `sid` 与会话令牌不一致（浏览器重启、或环境没有会话存储）时，读取端完全忽略 `i`，退回按 URL 对齐。
  - 按窗口分键，使一次写入只覆盖发生变化的窗口，避免重写整份快照。
  - 序列化超过 4MB 时降级为不写 `t`（`u` / `p` / `i` 不能丢）。
  - 写入经过空闲防抖与批量抑制（见 `docs/ui/tree_style_tabs.md`）。10K 标签单窗口约 1~2MB。

### 树结构窗口索引（treeStructureWindows）
- 存放在 `chrome.storage.local` 的 `treeStructureWindows` 键。
- 结构：`{ [windowId]: updatedAt }`。
- 用途：记录哪些窗口存在快照键，便于窗口关闭时清理，避免使用 `storage.local.get(null)` 全量读取。

### 树结构会话令牌（treeSessionToken）
- 存放在 `chrome.storage.session` 的 `treeSessionToken` 键，值为一个随机字符串（会话令牌）。
- 用途：判断快照里的 `tabId`（`items[].i`）是否还在同一浏览器会话内可信。
- 会话存储跨 SW 回收存活、浏览器重启即清空，因此"令牌一致"恰好等价于"仍是同一批 tabId"。

### 树折叠状态（treeCollapsed）
- 存放在 `chrome.storage.session` 的 `treeCollapsed` 键。
- 结构：`{ [windowId]: [tabId, ...] }`。
- 用途：管理页树状视图的折叠（子树收起）状态，仅当前浏览器会话有效，重启后重置为全部展开。
- 会话存储为内存态，写入不落盘，因此可以高频更新（写前仍做 500ms 防抖）。

### 树视图模式（treeViewMode）
- 存放在 `chrome.storage.local` 的 `treeViewMode` 键，取值 `"tree"` 或 `"flat"`，全局一份。
- 用途：管理页「打开的窗口」视图记住用户上次选择的展示模式。

### 关闭标签记录（closedTabLog）
- 存放在 `chrome.storage.session` 的 `closedTabLog` 键，**栈式**（新记录在栈顶），容量 `CLOSED_LOG_MAX`（拟 50）。
- 结构：`[{ tabId, windowId, parentId, prevId, nextId, index, pinned, url, title, at }]`。
- 用途：浏览器原生「重新打开已关闭的标签页」时，把恢复出来的标签挂回原父节点与原物理位置。
- **必须在关闭事件里同步抓取**：调用方紧接着就会执行"关闭提升"改写树、并删除 recent_tabs 的标签缓存，
  中间插入一个 await 就取不到父标签与 url/标题了。
- **直接存 `tabId` 即可**：同一浏览器会话内 `tabId` 不复用，且该记录只在这个会话内有效，因此不需要稳定身份映射。
- 记录带 TTL（拟 5 分钟）；关闭组记录见下条。写入在关闭动作**之前**完成（此刻树还完整）。

### 关闭组记录（closedGroups）
- 存放在 `chrome.storage.session` 的 `closedGroups` 键，**栈式**，容量 `CLOSED_GROUP_MAX`（拟 5）。
- 结构：`[{ groupId, windowId, at, label, structure, members: [...] }]`，成员为
  `{ tabId, url, title, index, parentIndex, parentId, prevId, nextId, pinned, collapsed }`。
  `parentIndex` 为父成员在组内的下标（`-1` 表示父不在这组里）；`parentId` 用于"原父还开着但不在这一组里"；
  `prevId` / `nextId` 是关闭那一刻的原物理邻居，用于把标签放回原位附近；`structure` 为 false 表示降级为只记成员。
- 用途：撤销本插件自己发起的批量关闭（关闭整棵子树 / 多选批量关闭 / 保存后关闭），整组恢复父子关系与物理位置。
- 只有走后台 `closeTabsAsGroup` 的关闭才成组；其余关闭入口只写 `closedTabLog`。
- 单组超过 `GROUP_MAX_MEMBERS`（拟 500）时降级为只记成员 URL、不记结构，避免撑爆 `storage.session` 配额。

### 筛选模式（filterMode）
- 存放在 `chrome.storage.local` 的 `filterMode` 键，取值 `"filter"` 或 `"jump"`，全局一份。
- 用途：记住「过滤 / 跳转」的选择。
- **全局一份**的原因：`useFilterQuery` 是模块级共享的，管理页一次会创建 4 个实例
  （Windows / 列表 / 最近 / 历史），侧边栏另有 1 个，但它们表达的是同一个用户偏好，
  共用同一个 ref 与同一个键（与 `treeViewMode` 的做法一致）。
- 只在切换时写一次；非法取值一律归一化为 `"filter"`。
- 各页面在初始化时读取（异步、只读一次），**不做跨页实时同步**：管理页与侧边栏同时打开时，
  在一边切换模式，另一边要等下次加载才跟上。

## 数据流
- 保存标签：UI/右键/悬浮组件 -> `saveTabs` -> 写入 `lists`。
- favicon：写列表的路径统一经 `setLists` 归一化（`favIconUrl` -> `iconKey` + 登记 `favIcons` + 裁剪未引用项）；
  面向 UI 的 `getLists` 出口把 `iconKey` 解析回 `favIconUrl` 后返回。详见 `docs/data/favicon_dedup.md`。
- 列表管理：`createList / renameList / deleteList / moveListItems` -> 更新 `lists`。
- AI 分组：`aiGroupTabs` -> 生成分组 -> `saveGroupedTabs` 写入新列表。
- 自动冻结：定时扫描 -> `discardSession` + `historyBatches` 更新。
- 近期标签页：监听 tabs 事件 -> 更新 `recentTabsOpenAt`；“已阅”更新 `recentTabsState.lastReviewedAt`；提醒定时器读取统计并触发气泡。
- 树结构：tabs 事件（创建/关闭/移动/跨窗口） -> 后台内存树更新 -> 脏窗口空闲防抖 -> `treeStructure:<windowId>` 覆盖写（含会话令牌 `sid` 与每项 `i`）+ `treeStructureWindows` 索引更新。
- 树视图：管理页 `getTreeStructure` 读取内存树 -> 本地 DFS 扁平化 + 折叠（`treeCollapsed`） -> 渲染。
- 撤销关闭：批量关闭前写 `closedGroups`（关闭组）或关闭时写 `closedTabLog`（单标签） -> 撤销时按记录重开标签、
  重建父子关系、`chrome.tabs.move` 移回原物理位置。详见 `docs/ui/tree_style_tabs.md` 的「撤销关闭与树恢复」。
