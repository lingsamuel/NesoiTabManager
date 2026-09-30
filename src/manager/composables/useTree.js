// 管理页的树状视图状态。
//
// 职责边界：
// - 后台只提供"父标签映射"这一份数据；层级深度、折叠、渲染顺序全部在前端算，
//   这样切换页面/折叠展开都不需要再走 IPC（10K 标签下一次往返就是几百 KB）。
// - 折叠状态只放在 chrome.storage.session：重启后自动清空，且是内存态存储，写入不落盘，
//   因此可以放心做高频（防抖）写入。
// - 视图模式（树状/平铺）需要跨重启记住，放 chrome.storage.local，且只在切换时写一次。

import { reactive, ref } from "vue";
import { request } from "../utils/request.js";
import {
  HAS_SESSION_STORAGE,
  storageLocalGet,
  storageLocalSet,
  storageSessionGet,
  storageSessionSet,
} from "../utils/storage.js";

const MODE_STORAGE_KEY = "treeViewMode";
const COLLAPSED_STORAGE_KEY = "treeCollapsed";
const MODE_TREE = "tree";
const MODE_FLAT = "flat";
// 折叠切换的写入防抖：连点折叠时只在停下来后写一次。
const COLLAPSED_SAVE_DEBOUNCE_MS = 500;

function useTree() {
  const mode = ref(true);
  // windowId -> { [childId]: parentId }，只包含"有父标签"的条目，缺省即顶层。
  const parentsByWindow = reactive({});
  // windowId -> { [tabId]: true }，折叠的子树根。
  const collapsedByWindow = reactive({});
  const status = reactive({ message: "", type: "" });

  let collapsedSaveTimer = null;

  function setStatus(message, type) {
    status.message = message || "";
    status.type = type || "";
  }

  /** 读取用户偏好：视图模式（local）与折叠状态（session）。 */
  async function loadPreferences() {
    const modeValue = await storageLocalGet(MODE_STORAGE_KEY);
    // 缺省为树状（首次使用即展示树）。
    mode.value = modeValue !== MODE_FLAT;
    await loadCollapsed();
  }

  /**
   * 只读取折叠状态。
   * Firefox 侧边栏恒为树状、不关心"树状/平铺"这个管理页偏好，因此单独提供这一个入口。
   */
  async function loadCollapsed() {
    const collapsedValue = await storageSessionGet(COLLAPSED_STORAGE_KEY);
    applyCollapsed(collapsedValue);
  }

  /**
   * 折叠状态放在 storage.session，管理页与 Firefox 侧边栏会用同一份记录，
   * 两边同时打开时需要互相跟随，因此这里监听远端变更。
   * 自己写入的内容也会回流到这里，比较签名后跳过，避免无意义的重新渲染。
   */
  function watchCollapsedChanges() {
    if (!HAS_SESSION_STORAGE || typeof chrome.storage.onChanged === "undefined") {
      return;
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session" || !changes[COLLAPSED_STORAGE_KEY]) {
        return;
      }
      const incoming = changes[COLLAPSED_STORAGE_KEY].newValue;
      if (collapsedSignature(incoming) === collapsedSignature(serializeCollapsed())) {
        return;
      }
      applyCollapsed(incoming);
    });
  }

  function applyCollapsed(raw) {
    Object.keys(collapsedByWindow).forEach((key) => delete collapsedByWindow[key]);
    if (!raw || typeof raw !== "object") {
      return;
    }
    for (const [windowId, ids] of Object.entries(raw)) {
      const map = {};
      if (Array.isArray(ids)) {
        for (const id of ids) {
          map[String(id)] = true;
        }
      }
      collapsedByWindow[windowId] = map;
    }
  }

  async function setMode(nextMode) {
    mode.value = Boolean(nextMode);
    await storageLocalSet({ [MODE_STORAGE_KEY]: mode.value ? MODE_TREE : MODE_FLAT });
  }

  /**
   * 拉取指定窗口的父子映射。
   * 不传 windowIds 时后台会返回全部窗口；管理页通常传当前实际展示的窗口，避免做无用的对齐。
   */
  async function loadForWindows(windowIds) {
    const payload = Array.isArray(windowIds) && windowIds.length > 0 ? { windowIds } : {};
    const response = await request("getTreeStructure", payload);
    if (!response || !response.ok) {
      setStatus((response && response.error) || "树状结构加载失败。", "error");
      return false;
    }
    for (const [windowId, data] of Object.entries(response.structures || {})) {
      parentsByWindow[windowId] = (data && data.parents) || {};
    }
    setStatus("", "");
    return true;
  }

  function parentsFor(windowId) {
    return parentsByWindow[String(windowId)] || {};
  }

  function isCollapsed(windowId, tabId) {
    const map = collapsedByWindow[String(windowId)];
    return Boolean(map && map[String(tabId)]);
  }

  /** 供 flattenTree 使用的折叠集合；没有任何折叠时返回 null，省去一次 Set 构造。 */
  function collapsedSetFor(windowId) {
    const map = collapsedByWindow[String(windowId)];
    if (!map) {
      return null;
    }
    const ids = Object.keys(map);
    if (ids.length === 0) {
      return null;
    }
    return new Set(ids.map(Number).filter(Number.isFinite));
  }

  function toggleCollapse(windowId, tabId) {
    const windowKey = String(windowId);
    const tabKey = String(tabId);
    if (!collapsedByWindow[windowKey]) {
      collapsedByWindow[windowKey] = {};
    }
    if (collapsedByWindow[windowKey][tabKey]) {
      delete collapsedByWindow[windowKey][tabKey];
    } else {
      collapsedByWindow[windowKey][tabKey] = true;
    }
    scheduleCollapsedSave();
  }

  function scheduleCollapsedSave() {
    if (collapsedSaveTimer) {
      clearTimeout(collapsedSaveTimer);
    }
    collapsedSaveTimer = setTimeout(() => {
      collapsedSaveTimer = null;
      saveCollapsed();
    }, COLLAPSED_SAVE_DEBOUNCE_MS);
  }

  /** 把当前折叠状态整理成可持久化的形状：只保留非空窗口，并对 id 排序以便比较。 */
  function serializeCollapsed() {
    const payload = {};
    for (const [windowId, map] of Object.entries(collapsedByWindow)) {
      const ids = Object.keys(map)
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (ids.length > 0) {
        payload[windowId] = ids;
      }
    }
    return payload;
  }

  /** 把任意来源的折叠记录归一成字符串，用于判断"远端变更"是否就是自己刚写的内容。 */
  function collapsedSignature(raw) {
    if (!raw || typeof raw !== "object") {
      return "";
    }
    const parts = [];
    for (const windowId of Object.keys(raw).sort()) {
      const ids = Array.isArray(raw[windowId])
        ? raw[windowId].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
        : [];
      if (ids.length > 0) {
        parts.push(`${windowId}:${ids.join(",")}`);
      }
    }
    return parts.join("|");
  }

  async function saveCollapsed() {
    await storageSessionSet({ [COLLAPSED_STORAGE_KEY]: serializeCollapsed() });
  }

  /**
   * 清理已经关闭标签的折叠记录。
   * 折叠状态是会话级的，会随着用户不断开关标签而积累无用条目，这里在每次刷新窗口列表时顺手裁剪。
   */
  function pruneCollapsed(aliveTabIds) {
    let changed = false;
    for (const map of Object.values(collapsedByWindow)) {
      for (const tabId of Object.keys(map)) {
        if (!aliveTabIds.has(tabId)) {
          delete map[tabId];
          changed = true;
        }
      }
    }
    if (changed) {
      scheduleCollapsedSave();
    }
  }

  // 组装阶段就挂上远端变更监听：管理页与侧边栏谁先改动，另一边都能跟上。
  watchCollapsedChanges();

  return {
    mode,
    status,
    loadPreferences,
    loadCollapsed,
    setMode,
    loadForWindows,
    parentsFor,
    isCollapsed,
    collapsedSetFor,
    toggleCollapse,
    pruneCollapsed,
  };
}

export { useTree };
