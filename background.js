import {
  DISCARD_CONFIG_KEY,
  MANAGER_PAGE,
  RECENT_CONFIG_KEY,
  STORAGE_KEY,
} from "./background/constants.js";
import {
  getDiscardCandidates,
  getDiscardConfig,
  getDiscardHistory,
  handleDiscardAlarm,
  handleDiscardConfigChanged,
  handleTabActivated,
  handleTabCreated,
  handleTabRemoved,
  handleTabReplaced,
  handleWindowFocusChanged,
  initializeDiscardSystem,
  manualDiscard,
  manualDiscardTabs,
  resetDiscardSession,
  resetTabActivity,
  setDiscardConfig,
} from "./background/discard.js";
import {
  clearActionPopup,
  handleContextMenuClick,
  handleContextMenuHidden,
  handleContextMenuShown,
  handleWindowsChanged,
  rebuildContextMenus,
  setCopySelection,
} from "./background/context_menu.js";
import {
  createList,
  deleteList,
  deleteListItems,
  getListsForUi,
  getListSummaries,
  importLists,
  moveListItems,
  renameList,
  saveGroupedTabs,
  saveTabs,
  updateListDescription,
} from "./background/lists.js";
import { aiGroupTabs, getAiConfig, setAiConfig } from "./background/ai.js";
import {
  closeTabsAsGroup,
  handleClosedTabRecorded,
  handlePromotionAfterClose,
  handleTabStructureChanged,
  hasRestorableGroup,
  initializeClosedGroups,
  restoreClosedGroup,
} from "./background/closed_groups.js";
import { openDroppedItem } from "./background/dropped_item.js";
import {
  createRootTab,
  getTreeStructure,
  handleTreeAlarm,
  handleTreeSuspend,
  handleTreeTabActivated,
  handleTreeTabAttached,
  handleTreeTabCreated,
  handleTreeTabDetached,
  handleTreeTabMoved,
  handleTreeTabRemoved,
  handleTreeWindowFocusChanged,
  handleTreeWindowRemoved,
  initializeTreeSystem,
  moveTabTree,
} from "./background/tree.js";
import {
  getRecentConfig,
  getRecentBubblePosition,
  getRecentTabsSnapshot,
  handleRecentAlarm,
  handleRecentTabActivated,
  handleRecentConfigChanged,
  handleRecentTabCreated,
  handleRecentTabRemoved,
  handleRecentTabReplaced,
  handleRecentTabUpdated,
  handleRecentWindowFocusChanged,
  initializeRecentSystem,
  markRecentReviewed,
  snoozeRecentReminder,
  setRecentConfig,
  setRecentBubblePosition,
} from "./background/recent_tabs.js";

chrome.runtime.onInstalled.addListener(() => {
  clearActionPopup();
  rebuildContextMenus();
  resetTabActivity();
  resetDiscardSession().then(() => initializeDiscardSystem());
  initializeRecentSystem({ forceStartup: true });
  initializeTreeSystem({ forceStartup: true });
});

chrome.runtime.onStartup.addListener(() => {
  clearActionPopup();
  rebuildContextMenus();
  resetTabActivity();
  resetDiscardSession().then(() => initializeDiscardSystem());
  initializeRecentSystem({ forceStartup: true });
  // 浏览器启动会恢复大量标签页：树系统据此进入静默期，避免逐事件对齐与写盘。
  initializeTreeSystem({ forceStartup: true });
});

// 激活指定标签页：先把其所在窗口前置，再激活该标签。
// 管理页浮层（网页内嵌 iframe）中 chrome.windows/chrome.tabs 不可用，
// 因此跳转必须经由后台执行，前端只通过 runtime 消息触发。
function activateTabById(tabId, windowId) {
  const id = Number(tabId);
  const winId = Number(windowId);
  const focusWindow = Number.isFinite(winId)
    ? new Promise((resolve) => {
        chrome.windows.update(winId, { focused: true }, () => {
          resolve(!chrome.runtime.lastError);
        });
      })
    : Promise.resolve(true);
  return focusWindow.then(
    () =>
      new Promise((resolve, reject) => {
        chrome.tabs.update(id, { active: true }, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            reject(
              new Error(
                chrome.runtime.lastError
                  ? chrome.runtime.lastError.message
                  : "标签页不存在或已被关闭。"
              )
            );
            return;
          }
          resolve({ ok: true });
        });
      })
  );
}

chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL(MANAGER_PAGE);
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length > 0) {
      const target = tabs[0];
      if (target && Number.isFinite(Number(target.id))) {
        activateTabById(target.id, target.windowId);
      }
      return;
    }
    chrome.tabs.create({ url });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes[STORAGE_KEY]) {
    rebuildContextMenus();
  }
  if (changes[DISCARD_CONFIG_KEY]) {
    handleDiscardConfigChanged(changes[DISCARD_CONFIG_KEY].newValue || {});
  }
  if (changes[RECENT_CONFIG_KEY]) {
    handleRecentConfigChanged(changes[RECENT_CONFIG_KEY].newValue || {});
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab);
});

// 菜单即将弹出时按被右键标签的真实状态刷新文案/可用性（Firefox 专有事件，Chrome 需判空）。
if (chrome.contextMenus.onShown) {
  chrome.contextMenus.onShown.addListener((info, tab) => {
    handleContextMenuShown(info, tab);
  });
}

// 菜单关闭即作废侧边栏推来的选中集合：原生菜单不告诉后台"这次是谁弹的"，
// 因此只能在菜单生命周期结束时整体清空，再加上复制消费与 TTL 兜底（见 background/context_menu.js）。
// onHidden 是 Firefox 才有的能力（与这组 tab 菜单项同一适用范围）。
if (chrome.contextMenus.onHidden) {
  chrome.contextMenus.onHidden.addListener(() => {
    handleContextMenuHidden();
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  handleDiscardAlarm(alarm);
  handleRecentAlarm(alarm);
  handleTreeAlarm(alarm);
});

// MV3 的 SW 会在空闲后被回收，此时把尚未落盘的树结构尽力写出去。
chrome.runtime.onSuspend.addListener(() => {
  handleTreeSuspend();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  handleTabActivated(activeInfo);
  handleRecentTabActivated(activeInfo);
  handleTreeTabActivated(activeInfo);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  handleWindowFocusChanged(windowId);
  handleRecentWindowFocusChanged(windowId);
  handleTreeWindowFocusChanged(windowId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  handleTreeWindowRemoved(windowId);
  // 「移动到窗口」子菜单里要移除已关闭的窗口。
  handleWindowsChanged();
});

chrome.windows.onCreated.addListener(() => {
  handleWindowsChanged();
});

chrome.tabs.onCreated.addListener((tab) => {
  handleTabCreated(tab);
  handleRecentTabCreated(tab);
  handleTreeTabCreated(tab);
  // Firefox 的每标签会话值：新标签先登记一份父标签引用，之后被撤销关闭时才认得出来。
  if (tab && Number.isFinite(Number(tab.windowId)) && Number.isFinite(Number(tab.id))) {
    handleTabStructureChanged(Number(tab.windowId), [Number(tab.id)]);
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // 顺序很重要：
  // 1. 撤销关闭必须在树执行"关闭提升"**之前**抓取父标签/前后邻居/物理下标，
  //    且 url 与标题来自 recent_tabs 的标签缓存（它在下面这一步就被删掉了）；
  // 2. 被关闭标签的子标签会被提升，它们的父标签引用要在树改写前把 id 取出来。
  handleClosedTabRecorded(tabId, removeInfo);
  handlePromotionAfterClose(tabId, removeInfo.windowId);
  handleTabRemoved(tabId);
  handleRecentTabRemoved(tabId);
  handleTreeTabRemoved(tabId, removeInfo);
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  handleTreeTabMoved(tabId, moveInfo);
  // 原生拖动会按新位置重新推断父标签，因此这里要刷新该标签的持久引用。
  handleTabStructureChanged(moveInfo.windowId, [Number(tabId)]);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  handleTreeTabDetached(tabId, detachInfo);
  handleTabStructureChanged(detachInfo.oldWindowId, [Number(tabId)]);
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  handleTreeTabAttached(tabId, attachInfo);
  handleTabStructureChanged(attachInfo.newWindowId, [Number(tabId)]);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  handleTabReplaced(addedTabId, removedTabId);
  handleRecentTabReplaced(addedTabId, removedTabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  handleRecentTabUpdated(tabId, changeInfo, tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message && message.action ? message.action : "";

  if (action === "activateTab") {
    const tabId = Number(message.tabId);
    const windowId = Number(message.windowId);
    if (!Number.isFinite(tabId)) {
      sendResponse({ ok: false, error: "标签页参数无效。" });
      return false;
    }
    activateTabById(tabId, windowId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  // 面向 UI 的读取出口：把条目的 iconKey 解析回 favIconUrl，调用方看到的结构与去重前一致。
  if (action === "getLists") {
    getListsForUi()
      .then((lists) => sendResponse({ ok: true, lists }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  // 轻量列表摘要：侧边栏保存清单与网页悬浮组件只需要名字与数量，
  // 避免把去重后的图标数据整份展开传输。
  if (action === "getListSummaries") {
    getListSummaries()
      .then((summaries) => sendResponse({ ok: true, summaries }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  // 侧边栏在弹出原生标签右键菜单前推来当前选中项，供「复制标题 / 复制链接」输出多行。
  // 纯内存暂存、不做校验失败以外的处理：侧边栏只关心"推到了"，失败也无处提示（菜单已弹出）。
  if (action === "setCopySelection") {
    setCopySelection({ items: Array.isArray(message.items) ? message.items : [] });
    sendResponse({ ok: true });
    return false;
  }

  if (action === "saveTabs") {
    const payload = {
      tabIds: Array.isArray(message.tabIds) ? message.tabIds : [],
      listId: message.listId || "",
      newListName: message.newListName || "",
      newListDescription: message.newListDescription || "",
      closeTabs: Boolean(message.closeTabs),
    };
    saveTabs(payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveCurrentTab") {
    const payload = {
      tab: sender.tab,
      listId: message.listId || "",
      newListName: message.newListName || "",
      closeTab: Boolean(message.closeTab),
    };
    saveTabs({
      tabIds: payload.tab && payload.tab.id ? [payload.tab.id] : [],
      listId: payload.listId,
      newListName: payload.newListName,
      closeTabs: payload.closeTab,
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "renameList") {
    const listId = message.listId || "";
    const name = message.name || "";
    renameList(listId, name)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "updateListDescription") {
    const listId = message.listId || "";
    const description = message.description || "";
    updateListDescription(listId, description)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "createList") {
    const name = message.name || "";
    const description = message.description || "";
    createList(name, description)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "deleteList") {
    const listId = message.listId || "";
    deleteList(listId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "deleteListItems") {
    const listId = message.listId || "";
    const indices = message.indices || [];
    deleteListItems(listId, indices)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "moveListItems") {
    const listId = message.listId || "";
    const indices = message.indices || [];
    const targetListId = message.targetListId || "";
    const newListName = message.newListName || "";
    moveListItems(listId, indices, targetListId, newListName)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getAiConfig") {
    getAiConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveAiConfig") {
    setAiConfig(message.config || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "aiGroupTabs") {
    aiGroupTabs(Array.isArray(message.items) ? message.items : [])
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveGroupedTabs") {
    const groups = Array.isArray(message.groups) ? message.groups : [];
    if (groups.length === 0) {
      sendResponse({ ok: false, error: "没有可应用的分组。" });
      return false;
    }
    saveGroupedTabs(groups)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "importLists") {
    const mode = message.mode === "replace" ? "replace" : "merge";
    const rawLists = message.lists;
    if (!Array.isArray(rawLists)) {
      sendResponse({ ok: false, error: "导入格式无效。" });
      return false;
    }
    importLists(rawLists, mode)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getDiscardConfig") {
    getDiscardConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveDiscardConfig") {
    setDiscardConfig(message.config || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getDiscardCandidates") {
    const limit = Number.isFinite(Number(message.limit)) ? Math.max(1, Number(message.limit)) : 200;
    getDiscardCandidates(limit)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getDiscardHistory") {
    getDiscardHistory()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "manualDiscard") {
    const tabId = message.tabId;
    manualDiscard(tabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "manualDiscardTabs") {
    const tabIds = Array.isArray(message.tabIds) ? message.tabIds : [];
    manualDiscardTabs(tabIds)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getRecentTabs") {
    getRecentTabsSnapshot()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "markRecentReviewed") {
    markRecentReviewed()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "snoozeRecentReminder") {
    snoozeRecentReminder()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getRecentConfig") {
    getRecentConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getRecentBubblePosition") {
    getRecentBubblePosition()
      .then((position) => sendResponse({ ok: true, position }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveRecentConfig") {
    setRecentConfig(message.config || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveRecentBubblePosition") {
    setRecentBubblePosition(message.position || {})
      .then((position) => sendResponse({ ok: true, position }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getTreeStructure") {
    getTreeStructure(Array.isArray(message.windowIds) ? message.windowIds : null)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "moveTabTree") {
    moveTabTree(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  // 侧边栏底部 New Tab：在窗口末尾新建一个顶层标签页（与工具栏＋的"挂到当前标签下"不同）。
  if (action === "createRootTab") {
    createRootTab({ windowId: message.windowId })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  // 侧边栏外部拖放：覆盖目标标签，或按落位新建标签页（搜索词走默认搜索引擎）。
  if (action === "openDroppedItem") {
    openDroppedItem(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  // 撤销关闭：把一批标签关掉并记为一个「关闭组」（关闭整棵子树 / 多选批量关闭 / 保存后关闭）。
  if (action === "closeTabsAsGroup") {
    closeTabsAsGroup(message.windowId, message.tabIds, message.label, {
      subtreeOf: message.subtreeOf,
    })
      .then((result) => sendResponse({ ok: result.ok !== false, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  // 撤销关闭：恢复最近一个关闭组（含父子层级、兄弟顺序与物理位置）。
  if (action === "restoreClosedGroup") {
    restoreClosedGroup(message.windowId)
      .then((result) => sendResponse({ ok: result.ok !== false, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  // 供 UI 判断「撤销关闭」是否可用（无记录时按钮/菜单项置灰）。
  if (action === "getClosedGroupState") {
    hasRestorableGroup()
      ? sendResponse({ ok: true, restorable: true })
      : sendResponse({ ok: true, restorable: false });
    return false;
  }

  return false;
});

initializeDiscardSystem();
initializeRecentSystem();
initializeTreeSystem();
// 撤销关闭的记录存在 storage.session：SW 每次冷启动内存都是空的，必须重新读回来。
// 这里刻意放在顶层（而不是 onStartup）——onStartup 只在浏览器启动时触发一次。
initializeClosedGroups();
