import { DISCARD_CONFIG_KEY, MANAGER_PAGE, STORAGE_KEY } from "./background/constants.js";
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

chrome.runtime.onInstalled.addListener(() => {
  clearActionPopup();
  rebuildContextMenus();
  resetTabActivity();
  resetDiscardSession().then(() => initializeDiscardSystem());
});

chrome.runtime.onStartup.addListener(() => {
  clearActionPopup();
  rebuildContextMenus();
  resetTabActivity();
  resetDiscardSession().then(() => initializeDiscardSystem());
});

chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL(MANAGER_PAGE);
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length > 0) {
      const target = tabs[0];
      if (target.windowId) {
        chrome.windows.update(target.windowId, { focused: true });
      }
      if (target.id) {
        chrome.tabs.update(target.id, { active: true });
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
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handleDiscardAlarm(alarm);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  handleTabActivated(activeInfo);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  handleWindowFocusChanged(windowId);
});

chrome.tabs.onCreated.addListener((tab) => {
  handleTabCreated(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  handleTabReplaced(addedTabId, removedTabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message && message.action ? message.action : "";

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

  return false;
});

initializeDiscardSystem();
