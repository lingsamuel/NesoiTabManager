const STORAGE_KEY = "lists";

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function generateId() {
  return `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeListName(name) {
  return (name || "").trim();
}

function tabToItem(tab) {
  const url = tab && tab.url ? tab.url : "";
  const title = tab && tab.title ? tab.title : url || "Untitled";
  return {
    url,
    title,
    favIconUrl: tab && tab.favIconUrl ? tab.favIconUrl : "",
    savedAt: new Date().toISOString(),
  };
}

async function getLists() {
  const lists = await storageGet(STORAGE_KEY);
  return Array.isArray(lists) ? lists : [];
}

async function setLists(lists) {
  await storageSet({ [STORAGE_KEY]: lists });
}

function sanitizeImportedList(rawList) {
  const name = normalizeListName(rawList && rawList.name ? rawList.name : "");
  if (!name) {
    return null;
  }
  const items = Array.isArray(rawList.items) ? rawList.items : [];
  const sanitizedItems = items
    .map((item) => ({
      url: item && item.url ? String(item.url) : "",
      title: item && item.title ? String(item.title) : "",
      favIconUrl: item && item.favIconUrl ? String(item.favIconUrl) : "",
      savedAt: item && item.savedAt ? String(item.savedAt) : new Date().toISOString(),
    }))
    .filter((item) => item.url);
  return {
    id: rawList && rawList.id ? String(rawList.id) : generateId(),
    name,
    items: sanitizedItems,
  };
}

async function getTabsByIds(tabIds) {
  const results = await Promise.all(
    tabIds.map(
      (tabId) =>
        new Promise((resolve) => {
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(tab || null);
          });
        })
    )
  );
  return results.filter(Boolean);
}

async function saveTabs({ tabIds, listId, newListName, closeTabs }) {
  const lists = await getLists();
  let targetList = null;

  if (listId) {
    targetList = lists.find((list) => list.id === listId) || null;
  }

  if (!targetList) {
    const name = normalizeListName(newListName);
    if (!name) {
      throw new Error("List name is required.");
    }
    targetList = { id: generateId(), name, items: [] };
    lists.push(targetList);
  }

  const tabs = await getTabsByIds(tabIds);
  const items = tabs.map(tabToItem).filter((item) => item.url);

  if (items.length === 0) {
    throw new Error("No valid tabs to save.");
  }

  targetList.items.push(...items);
  await setLists(lists);

  if (closeTabs) {
    const closeIds = tabs.map((tab) => tab.id).filter(Boolean);
    if (closeIds.length > 0) {
      chrome.tabs.remove(closeIds);
    }
  }

  return { listId: targetList.id, savedCount: items.length };
}

async function saveCurrentTab({ tab, listId, newListName, closeTab }) {
  if (!tab || !tab.id) {
    throw new Error("No active tab.");
  }
  const result = await saveTabs({
    tabIds: [tab.id],
    listId,
    newListName,
    closeTabs: closeTab,
  });
  return result;
}

async function rebuildContextMenus() {
  const lists = await getLists();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "saveTo",
      title: "Save to list",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "saveCloseTo",
      title: "Close and save to list",
      contexts: ["page"],
    });

    if (lists.length === 0) {
      chrome.contextMenus.create({
        id: "saveTo-empty",
        title: "No lists yet",
        parentId: "saveTo",
        contexts: ["page"],
        enabled: false,
      });
      chrome.contextMenus.create({
        id: "saveCloseTo-empty",
        title: "No lists yet",
        parentId: "saveCloseTo",
        contexts: ["page"],
        enabled: false,
      });
      return;
    }

    lists.forEach((list) => {
      chrome.contextMenus.create({
        id: `save:${list.id}`,
        title: list.name,
        parentId: "saveTo",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: `saveClose:${list.id}`,
        title: list.name,
        parentId: "saveCloseTo",
        contexts: ["page"],
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  rebuildContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenus();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    rebuildContextMenus();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId || !tab || !tab.id) {
    return;
  }
  const menuId = String(info.menuItemId);
  if (menuId.includes("-empty")) {
    return;
  }
  const [action, listId] = menuId.split(":");
  if (!listId) {
    return;
  }
  const closeTab = action === "saveClose";
  try {
    await saveCurrentTab({ tab, listId, closeTab });
  } catch (error) {
    console.warn("Failed to save tab from context menu:", error);
  }
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
    saveCurrentTab(payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "importLists") {
    const mode = message.mode === "replace" ? "replace" : "merge";
    const rawLists = message.lists;
    if (!Array.isArray(rawLists)) {
      sendResponse({ ok: false, error: "Invalid import format." });
      return false;
    }
    (async () => {
      const incoming = rawLists.map(sanitizeImportedList).filter(Boolean);
      if (incoming.length === 0) {
        sendResponse({ ok: false, error: "No valid lists to import." });
        return;
      }
      if (mode === "replace") {
        await setLists(incoming);
        sendResponse({ ok: true, result: { imported: incoming.length, mode } });
        return;
      }
      const existing = await getLists();
      const existingIds = new Set(existing.map((list) => list.id));
      incoming.forEach((list) => {
        if (existingIds.has(list.id)) {
          list.id = generateId();
        }
        existingIds.add(list.id);
        existing.push(list);
      });
      await setLists(existing);
      sendResponse({ ok: true, result: { imported: incoming.length, mode } });
    })().catch((error) =>
      sendResponse({ ok: false, error: String(error.message || error) })
    );
    return true;
  }

  return false;
});
