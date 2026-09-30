// 外部拖放（链接 / 文本）的执行层。
//
// 侧边栏负责"读懂拖的是什么、落在哪一行"（src/sidebar/dropped_data.js，纯逻辑），
// 本模块负责真正把标签页建出来 / 覆盖掉：
// - 落位（父标签、物理下标、是否固定）必须在这里算：树的真相在后台，前端只提交布局意图；
// - "非链接文本 → 默认搜索引擎"必须走 `chrome.search.search({ query, tabId })`：
//   先由我们自己创建/定位标签页、再让搜索落在这个 tabId 上，这样插入位置、是否固定、
//   覆盖哪个标签都由我们控制，而不是让搜索 API 自己开一个新标签。

import { getTabById } from "./lists.js";
import { createPlacedTab } from "./tree.js";

// 与前端同一口径：不允许拖放变成脚本执行入口（前端已过滤，这里再兜一层）。
const UNSAFE_URL_PATTERN = /^\s*(javascript|data):/i;

function normalizeUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || UNSAFE_URL_PATTERN.test(value)) {
    return "";
  }
  return value;
}

function normalizeQuery(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function focusWindow(windowId) {
  if (!Number.isFinite(windowId) || !chrome.windows || typeof chrome.windows.update !== "function") {
    return;
  }
  chrome.windows.update(windowId, { focused: true }, () => {
    void chrome.runtime.lastError;
  });
}

/** 把某个标签设为活动，并聚焦它所在的窗口。 */
function activateTabById(tabId, windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { active: true }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "激活标签页失败。"));
        return;
      }
      resolve();
    });
  }).then(() => {
    focusWindow(windowId);
  });
}

function updateTabUrl(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "打开链接失败。"));
        return;
      }
      resolve(tab || null);
    });
  });
}

/**
 * 在指定标签里用默认搜索引擎出结果。
 *
 * `search.search` 在 Firefox 的 schema 里是 `"async": true`（Promise 形式、没有 callback），
 * 与 `tabs.discard` 同一类坑，因此同样只传一个参数并优先按 Promise 处理。
 * 极老实现若不返回 Promise，调用本身已经发出，按成功处理。
 */
function searchInTab(query, tabId) {
  const api = chrome.search;
  if (!api || typeof api.search !== "function") {
    return Promise.reject(new Error("当前浏览器不支持 search API，无法用默认搜索引擎打开。"));
  }
  return new Promise((resolve, reject) => {
    let result;
    try {
      result = api.search({ query, tabId });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (result && typeof result.then === "function") {
      result.then(
        () => resolve(),
        (error) => reject(error instanceof Error ? error : new Error(String(error)))
      );
      return;
    }
    resolve();
  });
}

/**
 * 执行一次外部拖放。
 *
 * 使用场景：侧边栏树行、固定标签图标、列表下方空白处的 drop。
 * 前置要求：`url` 与 `query` 至多给一个；`replaceTabId` 有值时忽略落位参数。
 *
 * @param {{windowId?: number, replaceTabId?: number|null, parentId?: number|null,
 *   beforeTabId?: number|null, afterTabId?: number|null, pinned?: boolean,
 *   url?: string, query?: string}} payload
 * @returns {Promise<{mode: "replace"|"insert", tabId: number}>}
 */
export async function openDroppedItem(payload = {}) {
  const url = normalizeUrl(payload.url);
  const query = normalizeQuery(payload.query);
  if (!url && !query) {
    throw new Error("拖放的内容为空或不被允许。");
  }

  const replaceTabId = Number(payload.replaceTabId);
  if (Number.isFinite(replaceTabId)) {
    const target = await getTabById(replaceTabId);
    if (!target) {
      throw new Error("目标标签页不存在或已被关闭。");
    }
    if (url) {
      await updateTabUrl(replaceTabId, url);
      await activateTabById(replaceTabId, Number(target.windowId));
    } else {
      // 覆盖成搜索：直接在目标标签里出结果（不需要先清空页面）。
      await activateTabById(replaceTabId, Number(target.windowId));
      await searchInTab(query, replaceTabId);
    }
    return { mode: "replace", tabId: replaceTabId };
  }

  const windowId = Number(payload.windowId);
  if (!Number.isFinite(windowId)) {
    throw new Error("窗口参数无效。");
  }
  const created = await createPlacedTab({
    windowId,
    parentId: payload.parentId,
    beforeTabId: payload.beforeTabId,
    afterTabId: payload.afterTabId,
    pinned: Boolean(payload.pinned),
    // 搜索词先落一个空白页：位置/固定/层级都由这次创建决定，随后把搜索结果灌进这个标签。
    url: url || "about:blank",
  });
  if (query) {
    await searchInTab(query, created.tabId);
  }
  focusWindow(windowId);
  return { mode: "insert", tabId: created.tabId };
}
