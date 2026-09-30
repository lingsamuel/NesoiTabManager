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
  handleContextMenuShown,
  handleWindowsChanged,
  rebuildContextMenus,
} from "./background/context_menu.js";
import {
  createList,
  deleteList,
  deleteListItems,
  getLists,
  importLists,
  moveListItems,
  renameList,
  saveGroupedTabs,
  saveTabs,
  updateListDescription,
} from "./background/lists.js";
import { aiGroupTabs, getAiConfig, setAiConfig } from "./background/ai.js";
import {
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
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  handleTabRemoved(tabId);
  handleRecentTabRemoved(tabId);
  handleTreeTabRemoved(tabId, removeInfo);
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  handleTreeTabMoved(tabId, moveInfo);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  handleTreeTabDetached(tabId, detachInfo);
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  handleTreeTabAttached(tabId, attachInfo);
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

  if (action === "getLists") {
    getLists()
      .then((lists) => sendResponse({ ok: true, lists }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
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

  return false;
});

initializeDiscardSystem();
initializeRecentSystem();
initializeTreeSystem();
