import { storageGet, storageSet } from "./storage.js";
import { STORAGE_KEY } from "./constants.js";
import {
  ensureUniqueListName,
  generateId,
  normalizeListDescription,
  normalizeListName,
} from "./utils.js";

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

async function getTabById(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

async function getLists() {
  const lists = await storageGet(STORAGE_KEY);
  return Array.isArray(lists) ? lists : [];
}

async function setLists(lists) {
  await storageSet({ [STORAGE_KEY]: lists });
}

async function renameList(listId, name) {
  const trimmed = normalizeListName(name);
  if (!trimmed) {
    throw new Error("列表名称不能为空。");
  }
  const lists = await getLists();
  const target = lists.find((list) => list.id === listId);
  if (!target) {
    throw new Error("未找到对应列表。");
  }
  target.name = trimmed;
  await setLists(lists);
  return { listId, name: trimmed };
}

async function deleteList(listId) {
  const lists = await getLists();
  const next = lists.filter((list) => list.id !== listId);
  if (next.length === lists.length) {
    throw new Error("未找到对应列表。");
  }
  await setLists(next);
  return { listId };
}

async function deleteListItems(listId, indices) {
  const lists = await getLists();
  const target = lists.find((list) => list.id === listId);
  if (!target) {
    throw new Error("未找到对应列表。");
  }
  const indexSet = new Set(
    (Array.isArray(indices) ? indices : [])
      .map((item) => Number(item))
      .filter((num) => Number.isFinite(num))
  );
  if (indexSet.size === 0) {
    throw new Error("没有有效的删除索引。");
  }
  const originalCount = target.items.length;
  target.items = target.items.filter((_, index) => !indexSet.has(index));
  await setLists(lists);
  return { removed: originalCount - target.items.length };
}

async function moveListItems(listId, indices, targetListId, newListName) {
  const lists = await getLists();
  const source = lists.find((list) => list.id === listId);
  if (!source) {
    throw new Error("未找到源列表。");
  }
  const indexSet = new Set(
    (Array.isArray(indices) ? indices : [])
      .map((item) => Number(item))
      .filter((num) => Number.isFinite(num))
  );
  if (indexSet.size === 0) {
    throw new Error("没有有效的移动索引。");
  }

  let target = null;
  if (targetListId) {
    target = lists.find((list) => list.id === targetListId) || null;
  }
  if (target && target.id === source.id) {
    throw new Error("目标列表不能是当前列表。");
  }
  if (!target) {
    const name = normalizeListName(newListName);
    if (!name) {
      throw new Error("需要目标列表名称。");
    }
    target = { id: generateId(), name, description: "", items: [] };
    lists.push(target);
  }

  const sorted = Array.from(indexSet).sort((a, b) => a - b);
  const itemsToMove = sorted.map((index) => source.items[index]).filter(Boolean);
  if (itemsToMove.length === 0) {
    throw new Error("没有可移动的标签。");
  }

  source.items = source.items.filter((_, index) => !indexSet.has(index));
  target.items.push(...itemsToMove);
  await setLists(lists);

  return { moved: itemsToMove.length, targetListId: target.id };
}

async function updateListDescription(listId, description) {
  const lists = await getLists();
  const target = lists.find((list) => list.id === listId);
  if (!target) {
    throw new Error("未找到对应列表。");
  }
  target.description = normalizeListDescription(description);
  await setLists(lists);
  return { listId, description: target.description };
}

async function createList(name, description) {
  const trimmed = normalizeListName(name);
  if (!trimmed) {
    throw new Error("列表名称不能为空。");
  }
  const lists = await getLists();
  const list = {
    id: generateId(),
    name: trimmed,
    description: normalizeListDescription(description),
    items: [],
  };
  lists.push(list);
  await setLists(lists);
  return { list };
}

function sanitizeImportedList(rawList) {
  const name = normalizeListName(rawList && rawList.name ? rawList.name : "");
  if (!name) {
    return null;
  }
  const description = normalizeListDescription(
    rawList && rawList.description ? rawList.description : ""
  );
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
    description,
    items: sanitizedItems,
  };
}

async function importLists(rawLists, mode) {
  const incoming = rawLists.map(sanitizeImportedList).filter(Boolean);
  if (incoming.length === 0) {
    throw new Error("没有可导入的有效列表。");
  }
  if (mode === "replace") {
    await setLists(incoming);
    return { imported: incoming.length, mode };
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
  return { imported: incoming.length, mode };
}

async function saveTabs({ tabIds, listId, newListName, closeTabs, newListDescription }) {
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
    targetList = {
      id: generateId(),
      name,
      description: normalizeListDescription(newListDescription),
      items: [],
    };
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
  return saveTabs({
    tabIds: [tab.id],
    listId,
    newListName,
    closeTabs: closeTab,
  });
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
    createdLists.push({ id: generateId(), name, description: "", items });
  }

  if (createdLists.length > 0) {
    lists.push(...createdLists);
    await setLists(lists);
  }

  return { created: createdLists.length };
}

export {
  getLists,
  setLists,
  renameList,
  deleteList,
  deleteListItems,
  moveListItems,
  updateListDescription,
  createList,
  importLists,
  saveTabs,
  saveCurrentTab,
  saveGroupedTabs,
  getTabsByIds,
  getTabById,
};
