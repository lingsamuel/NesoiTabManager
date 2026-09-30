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
  - `favIconUrl`：图标地址（可为空）。
  - `savedAt`：保存时间（ISO 字符串）。

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
  - `v`：结构版本。
  - `at`：写入时间戳（毫秒）。
  - `n`：标签数。
  - `items`：按浏览器 `index` 升序的数组，每项 `{ u: url, t: title, p: parentIndex }`；`p` 为父标签在 `items` 中的下标，`-1` 表示顶层。
- 说明：
  - 不存 `tabId`（Chrome 重启后会变化），改为「顺序 + URL/标题」在会话恢复时对齐。
  - 按窗口分键，使一次写入只覆盖发生变化的窗口，避免重写整份快照。
  - 序列化超过 4MB 时降级为不写 `t`，只用 URL 对齐。
  - 写入经过空闲防抖与批量抑制（见 `docs/ui/tree_style_tabs.md`）。10K 标签单窗口约 1~2MB。

### 树结构窗口索引（treeStructureWindows）
- 存放在 `chrome.storage.local` 的 `treeStructureWindows` 键。
- 结构：`{ [windowId]: updatedAt }`。
- 用途：记录哪些窗口存在快照键，便于窗口关闭时清理，避免使用 `storage.local.get(null)` 全量读取。

### 树折叠状态（treeCollapsed）
- 存放在 `chrome.storage.session` 的 `treeCollapsed` 键。
- 结构：`{ [windowId]: [tabId, ...] }`。
- 用途：管理页树状视图的折叠（子树收起）状态，仅当前浏览器会话有效，重启后重置为全部展开。
- 会话存储为内存态，写入不落盘，因此可以高频更新（写前仍做 500ms 防抖）。

### 树视图模式（treeViewMode）
- 存放在 `chrome.storage.local` 的 `treeViewMode` 键，取值 `"tree"` 或 `"flat"`，全局一份。
- 用途：管理页「打开的窗口」视图记住用户上次选择的展示模式。

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
- 列表管理：`createList / renameList / deleteList / moveListItems` -> 更新 `lists`。
- AI 分组：`aiGroupTabs` -> 生成分组 -> `saveGroupedTabs` 写入新列表。
- 自动冻结：定时扫描 -> `discardSession` + `historyBatches` 更新。
- 近期标签页：监听 tabs 事件 -> 更新 `recentTabsOpenAt`；“已阅”更新 `recentTabsState.lastReviewedAt`；提醒定时器读取统计并触发气泡。
- 树结构：tabs 事件（创建/关闭/移动/跨窗口） -> 后台内存树更新 -> 脏窗口空闲防抖 -> `treeStructure:<windowId>` 覆盖写 + `treeStructureWindows` 索引更新。
- 树视图：管理页 `getTreeStructure` 读取内存树 -> 本地 DFS 扁平化 + 折叠（`treeCollapsed`） -> 渲染。
