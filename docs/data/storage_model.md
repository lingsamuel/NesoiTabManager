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

## 数据流
- 保存标签：UI/右键/悬浮组件 -> `saveTabs` -> 写入 `lists`。
- 列表管理：`createList / renameList / deleteList / moveListItems` -> 更新 `lists`。
- AI 分组：`aiGroupTabs` -> 生成分组 -> `saveGroupedTabs` 写入新列表。
- 自动冻结：定时扫描 -> `discardSession` + `historyBatches` 更新。
- 近期标签页：监听 tabs 事件 -> 更新 `recentTabsOpenAt`；“已阅”更新 `recentTabsState.lastReviewedAt`；提醒定时器读取统计并触发气泡。
