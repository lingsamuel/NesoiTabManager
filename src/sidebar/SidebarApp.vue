<script setup>
// Firefox 侧边栏（`sidebar_action` 面板）。
//
// 与网页浮层最大的不同：侧边栏文档是**扩展自身的页面**，拥有与后台同等的特权 API，
// 因此可以直接监听 chrome.tabs.* 并调用 chrome.tabs.*，不需要"所有操作经后台转发"。
// 只有树本身（父子映射）仍从后台取，避免在前端再实现一套父子推断。
//
// 生命周期：Firefox 每个窗口各有一份独立的侧边栏文档实例，窗口关闭或用户收起侧边栏时文档被卸载，
// 监听器随之销毁——所以这个页面不常驻，对浏览器启动零开销。

import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import FilterInput from "../manager/components/FilterInput.vue";
import { useFilterQuery } from "../manager/composables/useFilterQuery.js";
import { useMatchNavigation } from "../manager/composables/useMatchNavigation.js";
import { useTree } from "../manager/composables/useTree.js";
import { matchesTabQuery } from "../manager/utils/helpers.js";
import { request } from "../manager/utils/request.js";
// 与管理页树状视图、后台、基准测试共用同一份行模型（筛选补祖先 + DFS + 折叠）
import { buildTreeRows } from "../../background/tree_core.js";
import { computePinnedReorderIndex, groupPinnedTabs } from "./pinned_data.js";
import SidebarPinnedTabs from "./components/SidebarPinnedTabs.vue";
import SidebarTabTree from "./components/SidebarTabTree.vue";
import TabContextMenu from "./components/TabContextMenu.vue";

// 结构类事件合并窗口：10K 标签下一次刷新要取回整窗标签，必须避免逐事件刷新。
const REFRESH_DEBOUNCE_MS = 250;
const MANAGER_PAGE = "ui/manager.html";

const windowId = ref(null);
const tabs = ref([]);
// groupPinnedTabs() 的结果：跨窗口聚合、按窗口分组、只用于固定标签区。
const pinnedGroups = ref([]);
const ready = ref(false);
const status = reactive({ message: "", type: "" });
// 自建右键菜单的状态：被作用的标签、鼠标位置与按当前标签状态生成的菜单项。
const contextMenu = reactive({ visible: false, x: 0, y: 0, tab: null, items: [] });

const tree = useTree();
const filter = useFilterQuery();

let refreshTimer = null;
let pendingWhileHidden = false;
let pendingFull = false;
let pendingPinned = false;
const cleanups = [];

function setStatus(message, type) {
  status.message = message || "";
  status.type = type || "";
}

// 固定标签单独成区，因此树区域只渲染非固定标签。
// 后台的树里固定标签本来就是顶层、也不会作为父，所以移出后不会产生悬空节点。
const treeTabs = computed(() => tabs.value.filter((tab) => !tab.pinned));

/**
 * 行模型：标签列表 + 父子映射 + 折叠状态 + 关键词 → 扁平行。
 * 这里不复制任何渲染逻辑，全部交给后台/管理页共用的 buildTreeRows。
 */
const rowModel = computed(() => {
  const list = treeTabs.value;
  const id = windowId.value;
  const tabById = new Map(list.map((tab) => [Number(tab.id), tab]));
  if (id === null) {
    return { rows: [], tabById };
  }
  const parents = tree.parentsFor(id);
  const parentMap = new Map();
  for (const [childId, parentId] of Object.entries(parents)) {
    const child = Number(childId);
    const parent = Number(parentId);
    if (Number.isFinite(child) && Number.isFinite(parent)) {
      parentMap.set(child, parent);
    }
  }
  const keyword = filter.committed.value;
  const hasKeyword = Boolean(String(keyword || "").trim());
  const matchId = hasKeyword
    ? (tabIdValue) => {
        const tab = tabById.get(Number(tabIdValue));
        return Boolean(tab && matchesTabQuery(tab, keyword));
      }
    : null;
  const rows = buildTreeRows(list, parentMap, {
    collapsedIds: tree.collapsedSetFor(id),
    forceExpand: hasKeyword,
    matchId,
  });
  return { rows, tabById };
});

const items = computed(() => {
  const { rows, tabById } = rowModel.value;
  const result = [];
  for (const row of rows) {
    const tab = tabById.get(row.id);
    if (!tab) {
      continue;
    }
    result.push({ ...row, key: `tab-${row.id}`, tab });
  }
  return result;
});

const hasCommittedQuery = computed(() => Boolean(String(filter.committed.value || "").trim()));
const isJumpMode = computed(() => filter.mode.value === "jump" && hasCommittedQuery.value);

const {
  matchCount,
  currentMatchIndex,
  currentMatchPosition,
  goToNext,
  goToPrev,
} = useMatchNavigation({
  rows: items,
  isMatchRow: (item) => Boolean(item && item.matched),
  mode: filter.mode,
  hasQuery: hasCommittedQuery,
});

const matchLabel = computed(() => {
  if (matchCount.value === 0) {
    return "无匹配";
  }
  return `${currentMatchPosition.value + 1} / ${matchCount.value}`;
});

const emptyText = computed(() => {
  if (hasCommittedQuery.value && filter.mode.value === "filter") {
    return "未找到匹配的标签页。";
  }
  return "当前窗口没有标签页。";
});

// 固定标签区独立成区后，树区域可能是空的而窗口里其实只有固定标签。
const treeEmptyText = computed(() => {
  if (hasCommittedQuery.value && filter.mode.value === "filter") {
    return "未找到匹配的标签页。";
  }
  if (pinnedGroups.value.length > 0) {
    return "没有其它标签页。";
  }
  return emptyText.value;
});

// ---------------------------------------------------------------------------
// 数据刷新
// ---------------------------------------------------------------------------

async function queryWindowTabs(id) {
  const list = await new Promise((resolve) => {
    chrome.tabs.query({ windowId: id }, (result) => resolve(Array.isArray(result) ? result : []));
  });
  return list.slice().sort((left, right) => (left.index || 0) - (right.index || 0));
}

/** 跨窗口查询所有固定标签：固定标签区是侧边栏唯一的跨窗口区域。 */
async function queryPinnedTabs() {
  const list = await new Promise((resolve) => {
    chrome.tabs.query({ pinned: true }, (result) => resolve(Array.isArray(result) ? result : []));
  });
  return list;
}

async function queryWindows() {
  const list = await new Promise((resolve) => {
    chrome.windows.getAll((result) => resolve(Array.isArray(result) ? result : []));
  });
  return list;
}

/**
 * 取得侧边栏所属窗口。
 * Firefox 会为每个浏览器窗口创建一份独立的侧边栏文档，因此 getCurrent() 拿到的就是宿主窗口——
 * 这正是 MDN 与 Tree Style Tab 采用的判定方式。
 * 这里同时兼容"回调"与"返回 Promise"两种风格，避免不同浏览器版本的行为差异导致卡在载入态。
 */
function getCurrentWindow() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value || null);
    };
    try {
      const maybePromise = chrome.windows.getCurrent((value) => done(value));
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(done).catch(() => done(null));
      }
    } catch (error) {
      done(null);
    }
  });
}

async function refresh() {
  const id = windowId.value;
  if (id === null) {
    return;
  }
  const list = await queryWindowTabs(id);
  tabs.value = list;
  // 折叠状态是与管理页共用的会话级记录，标签关闭后要顺手裁掉无效条目，避免越积越多。
  tree.pruneCollapsed(new Set(list.map((tab) => String(tab.id))));
  // 父子映射仍由后台提供：树是后台维护的唯一真相，前端不再自行推断。
  const ok = await tree.loadForWindows([id]);
  if (!ok) {
    setStatus(tree.status.message || "树状结构加载失败。", "error");
  }
  await refreshPinned();
  ready.value = true;
  pruneContextMenuTarget();
}

/**
 * 只刷新固定标签区。
 * 其它窗口的标签变化只会影响这里，因此不必让它们触发本窗口的整窗查询（10K 标签下差别很大）。
 */
async function refreshPinned() {
  const id = windowId.value;
  if (id === null) {
    return;
  }
  const [pinnedTabs, windows] = await Promise.all([queryPinnedTabs(), queryWindows()]);
  pinnedGroups.value = groupPinnedTabs(pinnedTabs, {
    currentWindowId: id,
    // 窗口编号与组顺序都按 windows.getAll() 的位次，与管理页的「窗口 N」口径一致。
    windowOrder: windows.map((win) => Number(win.id)),
  });
  pruneContextMenuTarget();
}

/**
 * 切换标签时只需改动高亮，不必重新查询整窗标签。
 * 10K 标签下这一优化把"切标签"从一次 IPC + 整窗序列化降成一次 O(n) 内存遍历。
 */
function applyActiveTab(tabId) {
  const list = tabs.value;
  let changed = false;
  for (const tab of list) {
    const shouldBeActive = Number(tab.id) === Number(tabId);
    if (Boolean(tab.active) !== shouldBeActive) {
      tab.active = shouldBeActive;
      changed = true;
    }
  }
  if (changed) {
    tabs.value = list.slice();
  }
}

/**
 * 事件驱动的延迟刷新，按作用范围分流：
 * - 本窗口的事件 → 重取整窗标签 + 父子映射 + 固定标签；
 * - 其它窗口的事件 → 只重取固定标签（固定标签区是唯一的跨窗口区域）。
 * 侧边栏被收起或切到别的侧边栏时文档可能仍存在但不可见，此时跳过刷新，等重新可见再补一次。
 */
function scheduleRefresh(scope = "full") {
  if (scope === "full") {
    pendingFull = true;
  } else {
    pendingPinned = true;
  }
  startRefreshTimer();
}

function startRefreshTimer() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    pendingWhileHidden = true;
    return;
  }
  if (!pendingFull && !pendingPinned) {
    return;
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    runPendingRefresh();
  }, REFRESH_DEBOUNCE_MS);
}

function runPendingRefresh() {
  const full = pendingFull;
  const pinnedOnly = pendingPinned && !full;
  pendingFull = false;
  pendingPinned = false;
  if (full) {
    refresh();
  } else if (pinnedOnly) {
    refreshPinned();
  }
}

function onVisibilityChange() {
  if (document.visibilityState === "visible" && pendingWhileHidden) {
    pendingWhileHidden = false;
    startRefreshTimer();
  }
}

// 各 tabs 事件的窗口信息来源不同，这里统一抽出来，只关心"是否属于本窗口"。
// 提取函数返回 undefined 表示"这个事件不需要刷新"。
const TAB_EVENT_SOURCES = [
  ["onCreated", (tab) => tab && tab.windowId],
  ["onRemoved", (_tabId, removeInfo) => removeInfo && removeInfo.windowId],
  ["onMoved", (_tabId, moveInfo) => moveInfo && moveInfo.windowId],
  ["onAttached", (_tabId, attachInfo) => attachInfo && attachInfo.newWindowId],
  ["onDetached", (_tabId, detachInfo) => detachInfo && detachInfo.oldWindowId],
  [
    "onUpdated",
    (_tabId, changeInfo, tab) => {
      // onUpdated 在页面加载期间会连续触发（status/audible 等变化），
      // 只有真正影响显示的字段才值得重取数据。
      if (!changeInfo) {
        return undefined;
      }
      const relevant =
        "title" in changeInfo ||
        "url" in changeInfo ||
        "favIconUrl" in changeInfo ||
        "discarded" in changeInfo ||
        "pinned" in changeInfo ||
        "mutedInfo" in changeInfo;
      return relevant && tab ? tab.windowId : undefined;
    },
  ],
];

function bindTabEvents() {
  for (const [name, extract] of TAB_EVENT_SOURCES) {
    const target = chrome.tabs && chrome.tabs[name];
    if (!target || typeof target.addListener !== "function") {
      continue;
    }
    const listener = (...args) => {
      const eventWindowId = Number(extract(...args));
      if (!Number.isFinite(eventWindowId)) {
        return;
      }
      scheduleRefresh(eventWindowId === Number(windowId.value) ? "full" : "pinned");
    };
    target.addListener(listener);
    cleanups.push(() => target.removeListener(listener));
  }

  // 切换标签走本地高亮更新，避免每次点标签都重取整窗数据；
  // 其它窗口的切换只影响固定标签区的高亮。
  const activated = chrome.tabs && chrome.tabs.onActivated;
  if (activated && typeof activated.addListener === "function") {
    const listener = (activeInfo) => {
      if (!activeInfo) {
        return;
      }
      if (Number(activeInfo.windowId) === Number(windowId.value)) {
        applyActiveTab(activeInfo.tabId);
        return;
      }
      scheduleRefresh("pinned");
    };
    activated.addListener(listener);
    cleanups.push(() => activated.removeListener(listener));
  }
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

async function activateTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  const targetWindowId = tab.windowId === undefined || tab.windowId === null ? windowId.value : tab.windowId;
  // 复用后台的激活逻辑：它会先聚焦窗口再激活标签，行为与管理页完全一致。
  const response = await request("activateTab", { tabId: tab.id, windowId: targetWindowId });
  if (!response.ok) {
    setStatus(response.error || "跳转失败。", "error");
    return;
  }
  setStatus("", "");
  // 立刻刷新一次，让活动标记跟上，不必等防抖。
  // 固定标签可能来自其它窗口，那种情况只需刷新固定标签区。
  if (Number(targetWindowId) === Number(windowId.value)) {
    refresh();
  } else {
    refreshPinned();
  }
}

function closeTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  chrome.tabs.remove(tab.id, () => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message || "关闭失败。", "error");
      return;
    }
    setStatus("", "");
  });
  // 不主动刷新：onRemoved 会带本窗口信息回来触发刷新。
}

async function discardTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  const response = await request("manualDiscard", { tabId: tab.id });
  if (!response.ok) {
    setStatus(response.error || "冻结失败。", "error");
    return;
  }
  setStatus(response.skipped ? "该标签已冻结。" : "已冻结标签页。", "ok");
  // 固定标签可能来自其它窗口，那种情况只需刷新固定标签区。
  if (Number(tab.windowId) === Number(windowId.value)) {
    scheduleRefresh("full");
  } else {
    scheduleRefresh("pinned");
  }
}

function createTab() {
  // 父子归属完全交给后台既有的创建规则（无 opener 的新标签挂到当前活动标签下）。
  chrome.tabs.create({ windowId: windowId.value, active: true });
}

function openManager() {
  chrome.tabs.create({ url: chrome.runtime.getURL(MANAGER_PAGE) });
}

function toggleCollapse(item) {
  if (windowId.value === null || !item) {
    return;
  }
  tree.toggleCollapse(windowId.value, item.id);
}

/** 沿父链判断 candidateId 是否位于 ancestorId 的子树内，用于禁止把标签拖到自己的子孙上。 */
function isTreeDescendant(ancestorId, candidateId) {
  const parents = tree.parentsFor(windowId.value);
  let cursor = parents[String(candidateId)];
  let guard = 0;
  while (cursor !== undefined && cursor !== null && guard <= 100000) {
    if (String(cursor) === String(ancestorId)) {
      return true;
    }
    cursor = parents[String(cursor)];
    guard += 1;
  }
  return false;
}

/**
 * 拖拽落点处理：规则与管理页树状视图一致（上 1/4 兄弟、下 1/4 兄弟、中间子标签），
 * 复用同一个 moveTabTree 消息，因此校验与"同步移动物理位置"的行为完全相同。
 */
async function onTreeDrop(draggedTab, targetTab, zone) {
  if (!draggedTab || !targetTab || !draggedTab.id || !targetTab.id) {
    return;
  }
  const parents = tree.parentsFor(windowId.value);
  const rawParent = parents[String(targetTab.id)];
  const targetParentId = rawParent === undefined || rawParent === null ? null : rawParent;
  let parentId = targetParentId;
  let afterTabId = null;
  let beforeTabId = null;
  if (zone === "child") {
    parentId = targetTab.id;
    afterTabId = targetTab.id;
  } else if (zone === "before") {
    beforeTabId = targetTab.id;
  } else {
    afterTabId = targetTab.id;
  }
  const response = await request("moveTabTree", {
    tabId: draggedTab.id,
    parentId,
    afterTabId,
    beforeTabId,
  });
  if (!response.ok) {
    setStatus(response.error || "调整标签层级失败。", "error");
    return;
  }
  setStatus("已调整标签层级。", "ok");
  scheduleRefresh();
}

// ---------------------------------------------------------------------------
// 固定标签区
// ---------------------------------------------------------------------------

/**
 * 固定标签的顺序重排。
 * 只处理同一窗口内的重排：跨窗口的目标在组件层就已经不显示落点、不派发事件，
 * 因为那等价于"把标签移动到另一个窗口"，与"重排顺序但不影响窗口"的定位相悖。
 */
function onPinnedReorder(payload) {
  if (!payload) {
    return;
  }
  const group = pinnedGroups.value.find((item) => item.windowId === Number(payload.windowId));
  if (!group) {
    return;
  }
  const index = computePinnedReorderIndex(
    group.tabs,
    payload.draggedId,
    payload.targetId,
    payload.position
  );
  if (index < 0) {
    return;
  }
  chrome.tabs.move(Number(payload.draggedId), { windowId: group.windowId, index }, () => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message || "调整固定标签顺序失败。", "error");
      return;
    }
    setStatus("", "");
    scheduleRefresh("pinned");
  });
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

/**
 * 按被右键标签的当前状态生成菜单项。
 * 固定/取消固定、静音/取消静音各只显示与当前状态相反的那一项；
 * 冻结复用后台的 manualDiscard，与行内按钮、管理页冻结走同一条路径。
 */
function buildContextMenuItems(tab) {
  return [
    { key: "reload", label: "刷新标签页" },
    { key: "duplicate", label: "复制标签页" },
    { key: "pin", label: tab.pinned ? "取消固定" : "固定标签页", separatorBefore: true },
    { key: "mute", label: tab.muted ? "取消静音" : "静音标签页" },
    { key: "freeze", label: "冻结标签页", disabled: Boolean(tab.discarded) },
    { key: "copyUrl", label: "复制链接", disabled: !tab.url },
    { key: "moveToNewWindow", label: "移动到新窗口", separatorBefore: true },
    { key: "close", label: "关闭标签页", danger: true, separatorBefore: true },
    { key: "closeOthers", label: "关闭其他标签页", danger: true },
    { key: "closeRight", label: "关闭右侧标签页", danger: true },
  ];
}

function openTabContextMenu(tab, event) {
  if (!tab || !tab.id) {
    return;
  }
  contextMenu.tab = tab;
  contextMenu.x = event && Number.isFinite(event.clientX) ? event.clientX : 0;
  contextMenu.y = event && Number.isFinite(event.clientY) ? event.clientY : 0;
  contextMenu.items = buildContextMenuItems(tab);
  contextMenu.visible = true;
}

function closeTabContextMenu() {
  contextMenu.visible = false;
  contextMenu.tab = null;
}

/** 被右键的标签消失（被关闭/被移走）时收起菜单；仅数据刷新不打断用户操作。 */
function pruneContextMenuTarget() {
  if (!contextMenu.visible || !contextMenu.tab) {
    return;
  }
  const id = Number(contextMenu.tab.id);
  const alive =
    tabs.value.some((tab) => Number(tab.id) === id) ||
    pinnedGroups.value.some((group) => group.tabs.some((tab) => Number(tab.id) === id));
  if (!alive) {
    closeTabContextMenu();
  }
}

async function closeTabsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return;
  }
  await new Promise((resolve) => {
    chrome.tabs.remove(ids, () => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message || "关闭标签页失败。", "error");
      } else {
        setStatus("", "");
      }
      resolve();
    });
  });
}

/**
 * 关闭其他标签页：保留固定标签（与浏览器原生行为一致）。
 * 目标标签可能来自其它窗口，因此这里按需查询它所在窗口的标签，而不是复用本窗口的缓存。
 */
async function closeOtherTabs(tab) {
  const siblings = await queryWindowTabs(tab.windowId);
  const ids = siblings
    .filter((item) => Number(item.id) !== Number(tab.id) && !item.pinned)
    .map((item) => Number(item.id));
  await closeTabsByIds(ids);
}

/** 关闭右侧标签页：按物理位置在其右侧，同样保留固定标签。 */
async function closeRightTabs(tab) {
  const siblings = await queryWindowTabs(tab.windowId);
  const baseIndex = Number.isFinite(Number(tab.index)) ? Number(tab.index) : -1;
  const ids = siblings
    .filter((item) => !item.pinned && (item.index || 0) > baseIndex)
    .map((item) => Number(item.id));
  await closeTabsByIds(ids);
}

async function copyTabUrl(tab) {
  const url = tab && tab.url ? String(tab.url) : "";
  if (!url) {
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    setStatus("已复制链接。", "ok");
    return;
  } catch (error) {
    // 少数环境（或权限受限）下异步剪贴板不可用，退回到临时文本框方案。
  }
  try {
    const helper = document.createElement("textarea");
    helper.value = url;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    document.body.removeChild(helper);
    setStatus("已复制链接。", "ok");
  } catch (error) {
    setStatus("复制链接失败。", "error");
  }
}

async function runContextAction(key) {
  const tab = contextMenu.tab;
  closeTabContextMenu();
  if (!tab || !tab.id) {
    return;
  }
  switch (key) {
    case "reload":
      chrome.tabs.reload(tab.id);
      break;
    case "duplicate":
      chrome.tabs.duplicate(tab.id);
      break;
    case "pin":
      chrome.tabs.update(tab.id, { pinned: !tab.pinned });
      break;
    case "mute":
      chrome.tabs.update(tab.id, { muted: !tab.muted });
      break;
    case "freeze":
      await discardTab(tab);
      break;
    case "copyUrl":
      await copyTabUrl(tab);
      break;
    case "moveToNewWindow":
      chrome.windows.create({ tabId: tab.id });
      break;
    case "close":
      closeTab(tab);
      break;
    case "closeOthers":
      await closeOtherTabs(tab);
      break;
    case "closeRight":
      await closeRightTabs(tab);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

onMounted(async () => {
  const current = await getCurrentWindow();
  if (!current || !Number.isFinite(Number(current.id))) {
    setStatus("无法确定侧边栏所属窗口。", "error");
    return;
  }
  windowId.value = Number(current.id);
  // 折叠状态与管理页共用同一份 storage.session 记录。
  await tree.loadCollapsed();
  await refresh();
  bindTabEvents();
  document.addEventListener("visibilitychange", onVisibilityChange);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});
</script>

<template>
  <div class="sb-app">
    <div class="sb-toolbar">
      <FilterInput
        :model-value="filter.query.value"
        placeholder="筛选标题或网址"
        @update:model-value="filter.update"
        @commit="filter.commit"
        @next="goToNext"
        @prev="goToPrev"
      />
      <div class="sb-toolbar-row">
        <div class="sb-mode">
          <button
            type="button"
            :class="{ active: filter.mode.value === 'filter' }"
            title="过滤：只显示匹配项及其祖先"
            @click="filter.setMode('filter')"
          >
            过滤
          </button>
          <button
            type="button"
            :class="{ active: filter.mode.value === 'jump' }"
            title="跳转：保持完整树，在匹配项之间跳转"
            @click="filter.setMode('jump')"
          >
            跳转
          </button>
        </div>
        <span v-if="isJumpMode" class="sb-match-nav">
          <button type="button" title="上一个匹配（Shift+Enter）" @click="goToPrev">↑</button>
          <span class="sb-match-count">{{ matchLabel }}</span>
          <button type="button" title="下一个匹配（Enter）" @click="goToNext">↓</button>
        </span>
        <span class="sb-spacer"></span>
        <button type="button" class="sb-tool" title="新建标签页" @click="createTab">＋</button>
        <button type="button" class="sb-tool" title="在管理界面打开" @click="openManager">
          管理
        </button>
      </div>
      <div v-if="status.message" class="sb-status" :class="status.type">{{ status.message }}</div>
    </div>

    <div v-if="!ready" class="sb-empty">正在载入标签…</div>
    <template v-else>
      <!-- 固定标签区：跨窗口聚合，固定不滚动 -->
      <SidebarPinnedTabs
        :groups="pinnedGroups"
        @activate="activateTab"
        @close="closeTab"
        @context-menu="openTabContextMenu"
        @reorder="onPinnedReorder"
      />
      <SidebarTabTree
        v-if="items.length > 0"
        :items="items"
        :highlight-matches="isJumpMode"
        :current-match-index="currentMatchIndex"
        :is-tree-descendant="isTreeDescendant"
        @activate="activateTab"
        @close="closeTab"
        @discard="discardTab"
        @toggle-collapse="toggleCollapse"
        @tree-drop="onTreeDrop"
        @context-menu="openTabContextMenu"
      />
      <div v-else class="sb-empty">{{ treeEmptyText }}</div>
    </template>

    <TabContextMenu
      v-if="contextMenu.visible"
      :items="contextMenu.items"
      :x="contextMenu.x"
      :y="contextMenu.y"
      @select="runContextAction"
      @close="closeTabContextMenu"
    />
  </div>
</template>
