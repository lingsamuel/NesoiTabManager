const STORAGE_KEY = "lists";
const MANAGER_PAGE = "popup.html";

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

function ensureUniqueListName(existingNames, baseName) {
  let name = baseName;
  let counter = 2;
  while (existingNames.has(name)) {
    name = `${baseName}（${counter}）`;
    counter += 1;
  }
  return name;
}

function extractKeywords(title) {
  if (!title) {
    return [];
  }
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "into",
    "your",
    "about",
    "guide",
    "docs",
    "news",
    "home",
    "index",
    "登录",
    "注册",
    "首页",
    "官网",
    "官方",
    "文档",
    "教程",
    "指南",
    "下载",
    "专题",
  ]);
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((token) => token.length >= 2 && !stopwords.has(token));
  const unique = [];
  tokens.forEach((token) => {
    if (!unique.includes(token)) {
      unique.push(token);
    }
  });
  return unique;
}

function countKeywordOverlap(keywordSet, keywords) {
  let count = 0;
  keywords.forEach((keyword) => {
    if (keywordSet.has(keyword)) {
      count += 1;
    }
  });
  return count;
}

function getDominantDomain(domainCounts) {
  let topDomain = "";
  let topCount = 0;
  Object.entries(domainCounts).forEach(([domain, count]) => {
    if (count > topCount) {
      topDomain = domain;
      topCount = count;
    }
  });
  return topDomain;
}

function createGroupFromItem(item) {
  const domainCounts = {};
  if (item.domain) {
    domainCounts[item.domain] = 1;
  }
  return {
    tabIds: [item.tabId],
    domainCounts,
    dominantDomain: item.domain || "",
    keywords: new Set(item.keywords),
  };
}

function addItemToGroup(group, item) {
  group.tabIds.push(item.tabId);
  if (item.domain) {
    group.domainCounts[item.domain] = (group.domainCounts[item.domain] || 0) + 1;
    group.dominantDomain = getDominantDomain(group.domainCounts);
  }
  item.keywords.forEach((keyword) => group.keywords.add(keyword));
}

function shouldJoinGroup(group, item) {
  const domainMatch = item.domain && item.domain === group.dominantDomain;
  const keywordOverlap = countKeywordOverlap(group.keywords, item.keywords);
  if (domainMatch) {
    return true;
  }
  if (keywordOverlap >= 2) {
    return true;
  }
  if (keywordOverlap >= 1 && group.tabIds.length <= 2) {
    return true;
  }
  return false;
}

function mergeAdjacentGroups(groups) {
  const merged = [];
  groups.forEach((group) => {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.dominantDomain &&
      last.dominantDomain === group.dominantDomain &&
      (last.tabIds.length <= 2 || group.tabIds.length <= 2)
    ) {
      group.tabIds.forEach((tabId) => last.tabIds.push(tabId));
      Object.entries(group.domainCounts).forEach(([domain, count]) => {
        last.domainCounts[domain] = (last.domainCounts[domain] || 0) + count;
      });
      last.dominantDomain = getDominantDomain(last.domainCounts);
      group.keywords.forEach((keyword) => last.keywords.add(keyword));
      return;
    }
    merged.push(group);
  });
  return merged;
}

function pickGroupLabel(group, fallbackIndex) {
  const domain = group.dominantDomain;
  if (domain) {
    return domain;
  }
  const keyword = group.keywords.values().next().value;
  if (keyword) {
    return keyword;
  }
  return `分组 ${fallbackIndex + 1}`;
}

function aiGroupTabs(items) {
  const normalized = items
    .map((item) => ({
      tabId: item.tabId,
      title: item.title || "",
      domain: item.domain || "",
      index: Number.isFinite(item.index) ? item.index : 0,
      keywords: extractKeywords(item.title || ""),
    }))
    .filter((item) => item.tabId);

  normalized.sort((a, b) => a.index - b.index);

  const groups = [];
  normalized.forEach((item) => {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && shouldJoinGroup(lastGroup, item)) {
      addItemToGroup(lastGroup, item);
      return;
    }
    groups.push(createGroupFromItem(item));
  });

  const merged = mergeAdjacentGroups(groups);

  return merged.map((group, index) => ({
    label: pickGroupLabel(group, index),
    tabIds: group.tabIds,
  }));
}

async function saveGroupedTabs(groups) {
  const lists = await getLists();
  const existingNames = new Set(lists.map((list) => list.name));
  const createdLists = [];

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const label = normalizeListName(group.label) || `分组 ${i + 1}`;
    const baseName = `AI 分组：${label}`;
    const name = ensureUniqueListName(existingNames, baseName);
    existingNames.add(name);
    const tabs = await getTabsByIds(Array.isArray(group.tabIds) ? group.tabIds : []);
    const items = tabs.map(tabToItem).filter((item) => item.url);
    if (items.length === 0) {
      continue;
    }
    createdLists.push({ id: generateId(), name, items });
  }

  if (createdLists.length > 0) {
    lists.push(...createdLists);
    await setLists(lists);
  }

  return { created: createdLists.length };
}

function tabToItem(tab) {
  const url = tab && tab.url ? tab.url : "";
  const title = tab && tab.title ? tab.title : url || "未命名";
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
      throw new Error("需要列表名称。");
    }
    targetList = { id: generateId(), name, items: [] };
    lists.push(targetList);
  }

  const tabs = await getTabsByIds(tabIds);
  const items = tabs.map(tabToItem).filter((item) => item.url);

  if (items.length === 0) {
    throw new Error("没有可保存的标签页。");
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
    throw new Error("没有活动标签页。");
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
      title: "保存到列表",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "saveCloseTo",
      title: "关闭并保存到列表",
      contexts: ["page"],
    });

    if (lists.length === 0) {
      chrome.contextMenus.create({
        id: "saveTo-empty",
        title: "暂无列表",
        parentId: "saveTo",
        contexts: ["page"],
        enabled: false,
      });
      chrome.contextMenus.create({
        id: "saveCloseTo-empty",
        title: "暂无列表",
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

chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: chrome.runtime.getURL(MANAGER_PAGE),
    type: "popup",
    width: 980,
    height: 760,
  });
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
    console.warn("右键菜单保存失败：", error);
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

  if (action === "aiGroupTabs") {
    const items = Array.isArray(message.items) ? message.items : [];
    if (items.length === 0) {
      sendResponse({ ok: false, error: "没有可分组的标签页。" });
      return false;
    }
    try {
      const groups = aiGroupTabs(items);
      if (!groups.length) {
        sendResponse({ ok: false, error: "未生成有效分组。" });
        return false;
      }
      sendResponse({ ok: true, result: { groups } });
    } catch (error) {
      sendResponse({ ok: false, error: String(error.message || error) });
    }
    return false;
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
    (async () => {
      const incoming = rawLists.map(sanitizeImportedList).filter(Boolean);
      if (incoming.length === 0) {
        sendResponse({ ok: false, error: "没有可导入的有效列表。" });
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
