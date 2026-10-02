export const STORAGE_KEY = "lists";
export const AI_CONFIG_KEY = "aiConfig";
export const DISCARD_CONFIG_KEY = "discardConfig";
export const DISCARD_ALARM = "discardSweep";
export const RECENT_CONFIG_KEY = "recentTabsConfig";
export const RECENT_STATE_KEY = "recentTabsState";
export const RECENT_OPEN_AT_KEY = "recentTabsOpenAt";
export const RECENT_ALARM = "recentTabsReminder";
export const MANAGER_PAGE = "ui/manager.html";
export const DISCARD_SESSION_KEY = "discardSession";
export const DISCARD_TAB_ACTIVITY_KEY = "discardTabActivity";
// 树状结构：每个窗口一个快照键，避免一次写入覆盖所有窗口。
export const TREE_KEY_PREFIX = "treeStructure:";
// 快照键的索引，用于窗口关闭时清理，避免用 storage.local.get(null) 全量读取。
export const TREE_INDEX_KEY = "treeStructureWindows";
// 管理页窗口视图的展示模式（tree / flat）。
export const TREE_VIEW_MODE_KEY = "treeViewMode";
// 折叠状态：仅当前浏览器会话有效，存放在 storage.session。
export const TREE_COLLAPSED_KEY = "treeCollapsed";
// 树结构的会话令牌：用来判断快照里记录的 tabId 是否还在同一浏览器会话内可信。
// 放在 storage.session —— Service Worker / 事件页被回收后它仍在（tabId 也仍然有效），
// 浏览器重启后它自动清空（tabId 已重新分配，快照里的 id 不能再当身份用）。
export const TREE_SESSION_TOKEN_KEY = "treeSessionToken";
// 层级自动修复的每会话标记：记录哪些窗口已经用每标签会话值扫过一遍。
// 与令牌一样放 storage.session —— 浏览器重启后清空，于是新会话会重新扫一次。
export const TREE_REPAIR_KEY = "treeRepairDone";
export const TREE_FLUSH_ALARM = "treeFlush";
// 撤销关闭：关闭记录只存活于当前浏览器会话，因此同样放 storage.session。
// closedTabLog 记单个标签的关闭现场（供浏览器原生「重新打开已关闭的标签页」恢复父子关系），
// closedGroups 记本插件自己发起的批量关闭（供「撤销关闭」整组恢复）。
export const CLOSED_LOG_KEY = "closedTabLog";
export const CLOSED_GROUPS_KEY = "closedGroups";
export const HAS_SESSION_STORAGE = Boolean(chrome.storage && chrome.storage.session);
