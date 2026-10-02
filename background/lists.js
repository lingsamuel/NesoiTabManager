import { storageGet, storageSet } from "./storage.js";
import { EXPORT_FORMAT_VERSION, FAVICONS_KEY, STORAGE_KEY } from "./constants.js";
import { closeTabsAsGroup } from "./closed_groups.js";
import { listsNeedMigration, normalizeListsForWrite, resolveLists } from "./favicons.js";
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

/**
 * 读取落盘原样的列表（条目里是 `iconKey`，可能是懒迁移前的 `favIconUrl`）。
 * 这是**内部**读取入口：写路径与只需要名字/数量的地方用它；
 * 任何要把列表交给 UI 的地方必须用 `getListsForUi`，否则前端拿不到图标地址。
 */
async function getLists() {
  const lists = await storageGet(STORAGE_KEY);
  return Array.isArray(lists) ? lists : [];
}

/**
 * 写盘：先读图标表，再"归一化 + 登记 + 裁剪未引用项"，最后一次写两个键。
 *
 * 顺序不能颠倒：先归一化才能把新条目里的 `favIconUrl` 登记进表，裁剪也就不会把它当成孤儿删掉；
 * 两次写入合并成一次，避免"列表已写、图标表未写"时前端看到一堆没有图标的条目。
 *
 * @param {Array} lists 即将落盘的列表
 * @param {object} [extraIcons] 额外的图标表（导入文件里带来的），先并入当前表再归一化，
 *   否则导入条目引用的 iconKey 会因为"表里没有"被当成脏键清掉，图标全部丢失。
 */
async function writeListsOnce(lists, extraIcons) {
  const storedIcons = await storageGet(FAVICONS_KEY);
  const base = storedIcons && typeof storedIcons === "object" ? storedIcons : {};
  const merged =
    extraIcons && typeof extraIcons === "object" ? { ...base, ...extraIcons } : base;
  const normalized = normalizeListsForWrite(lists, merged);
  await storageSet({
    [STORAGE_KEY]: normalized.lists,
    [FAVICONS_KEY]: normalized.favIcons,
  });
}

// 写盘串行化：一次写盘是"读表 → 归一化 → 裁剪 → 写两个键"的复合操作，
// 两次保存并发交错时，后一次会拿着过期的图标表把前一次刚登记的图标裁掉。
// 用一个 promise 链把整段串起来；失败不毒化队列（异常只交给对应调用方）。
let writeChain = Promise.resolve();

async function setLists(lists, extraIcons) {
  const task = writeChain.then(() => writeListsOnce(lists, extraIcons));
  writeChain = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

/**
 * 面向 UI 的读取出口：把 `iconKey` 解析回 `favIconUrl`（并删掉 `iconKey`）。
 * 返回结构与未做去重时完全一致，管理页 / 弹窗的渲染代码不需要改动。
 * **导出不走这里**：逐条展开会让同一个图标按条目数重复 N 份。
 */
async function getListsForUi() {
  const [lists, storedIcons] = await Promise.all([getLists(), storageGet(FAVICONS_KEY)]);
  return resolveLists(lists, storedIcons);
}

/**
 * 导出用的载荷（只读，不写盘）。
 *
 * 与 `getListsForUi` 的关键区别：条目保持 `iconKey`、图标集中在顶层 `favIcons` 表里只出现一次，
 * 因此文件体积与"库里的去重结果"一致，而不是按条目数把 base64 重复 N 份。
 * 这里对内存副本做一次归一化，所以**升级前的旧数据导出的文件同样是紧凑的**（不会写回存储）。
 */
async function getListsExport() {
  const [lists, storedIcons] = await Promise.all([getLists(), storageGet(FAVICONS_KEY)]);
  const normalized = normalizeListsForWrite(lists, storedIcons);
  return {
    version: EXPORT_FORMAT_VERSION,
    lists: normalized.lists,
    favIcons: normalized.favIcons,
  };
}

/**
 * 一次性迁移已落盘的旧列表数据：把条目里的 `favIconUrl` 收进图标表、条目只留 `iconKey`。
 *
 * 为什么需要它：懒迁移只在"下一次写列表"时发生，用户升级后如果只是查看/导出列表，
 * 存储里的旧数据会一直逐条重复，看上去就像"根本没去重"。这里在扩展安装/更新与浏览器启动时各检查一次，
 * 先用一次廉价的字段探测（没有任何旧结构就直接返回），有旧结构才真正重写一遍；幂等。
 *
 * @returns {Promise<boolean>} 是否真的执行了迁移
 */
async function migrateListsFavicons() {
  const lists = await getLists();
  if (!listsNeedMigration(lists)) {
    return false;
  }
  await setLists(lists);
  return true;
}

/**
 * 列表摘要：只要 id / 名称 / 条目数（侧边栏「保存到列表」清单与网页悬浮组件用）。
 * 去重后 `getListsForUi` 会把图标重新展开，对"只要几个名字"的调用方是纯粹的浪费
 * （一次消息可能携带数 MB 的 base64），因此单列这个轻量出口。
 */
async function getListSummaries() {
  const lists = await getLists();
  return lists.map((list) => ({
    id: list && list.id ? String(list.id) : "",
    name: list && list.name ? String(list.name) : "",
    count: list && Array.isArray(list.items) ? list.items.length : 0,
  }));
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
  // 两种格式都接受：
  // - v2 导出（`iconKey` + 顶层 `favIcons` 表）→ 沿用 iconKey，由写盘路径把导入文件里的表并进来；
  // - v1 导出 / 其它来源（内联 `favIconUrl`）→ 写盘时归一化成 iconKey 并登记。
  const sanitizedItems = items
    .map((item) => ({
      url: item && item.url ? String(item.url) : "",
      title: item && item.title ? String(item.title) : "",
      favIconUrl: item && item.favIconUrl ? String(item.favIconUrl) : "",
      iconKey: item && item.iconKey ? String(item.iconKey) : "",
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

/** 清洗导入文件里的图标表：只接受"非空字符串 → 非空字符串"，其余一律忽略。 */
function sanitizeImportedFavicons(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (typeof key === "string" && key && typeof value === "string" && value) {
      result[key] = value;
    }
  });
  return result;
}

/**
 * @param {Array} rawLists 导入的列表（v1 内联 favIconUrl / v2 iconKey 都可）
 * @param {"merge"|"replace"} mode
 * @param {object} [rawFavIcons] v2 文件顶层的图标表；必须并入本次写盘，
 *   否则条目里的 iconKey 在表里查不到，会被当成脏键清掉、图标全部丢失
 */
async function importLists(rawLists, mode, rawFavIcons) {
  const incoming = rawLists.map(sanitizeImportedList).filter(Boolean);
  if (incoming.length === 0) {
    throw new Error("没有可导入的有效列表。");
  }
  const extraIcons = sanitizeImportedFavicons(rawFavIcons);
  if (mode === "replace") {
    await setLists(incoming, extraIcons);
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
  await setLists(existing, extraIcons);
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
      // 走"关闭组"路径：保存后关闭的这批标签之后可以由「撤销关闭」整组恢复（含层级与物理位置）。
      // 不再直接 chrome.tabs.remove，否则撤销时只剩逐个标签的关闭记录，整棵树回不来。
      await closeTabsAsGroup(null, closeIds, "保存后关闭的标签页");
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
  getListsForUi,
  getListsExport,
  getListSummaries,
  migrateListsFavicons,
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
