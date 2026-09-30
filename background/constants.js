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
export const TREE_FLUSH_ALARM = "treeFlush";
export const HAS_SESSION_STORAGE = Boolean(chrome.storage && chrome.storage.session);
