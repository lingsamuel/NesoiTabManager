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
import { resolveActiveRow } from "./scroll_markers.js";
import SidebarPinnedTabs from "./components/SidebarPinnedTabs.vue";
import SidebarTabTree from "./components/SidebarTabTree.vue";

// 结构类事件合并窗口：10K 标签下一次刷新要取回整窗标签，必须避免逐事件刷新。
const REFRESH_DEBOUNCE_MS = 250;
const MANAGER_PAGE = "ui/manager.html";

const windowId = ref(null);
const tabs = ref([]);
// groupPinnedTabs() 的结果：跨窗口聚合、按窗口分组、只用于固定标签区。
const pinnedGroups = ref([]);
const ready = ref(false);
const status = reactive({ message: "", type: "" });

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
    // 跳转模式必须保留完整树、只标记匹配项；否则会退化成过滤。
    pruneToMatches: filter.mode.value === "filter",
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

/**
 * 活动标签在行序列里的位置，供滚动条轨道标记使用。
 * 固定标签常驻可见（在固定标签区里，不随列表滚动），因此不参与轨道标记。
 */
const activeRow = computed(() => {
  const id = windowId.value;
  if (id === null) {
    return null;
  }
  const activeTab = tabs.value.find((tab) => tab.active && !tab.pinned);
  if (!activeTab) {
    return null;
  }
  return resolveActiveRow(activeTab.id, items.value, tree.parentsFor(id));
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
  // 工具栏的 ＋：父子归属完全交给后台既有的创建规则（无 opener 的新标签挂到当前活动标签下）。
  chrome.tabs.create({ windowId: windowId.value, active: true });
}

/**
 * 底部固定的 New Tab：在**窗口末尾**新建一个**顶层**标签页。
 *
 * 与工具栏 ＋ 的区别是有意的：＋ 走后台默认规则（挂在当前标签的子树里），
 * 这里则要求"顶层 + 最末尾"，因此必须由后台创建（它要显式指定 index 并跳过挂载规则）。
 *
 * 创建后**不**滚动列表：用户把列表滚到别处通常是有原因的，硬把他拉到底部会打断浏览。
 * 新标签是活动标签，滚动条轨道上的活动标记会直接指出它在哪，用户想跳过去点一下即可。
 */
async function createRootTab() {
  if (windowId.value === null) {
    return;
  }
  const response = await request("createRootTab", { windowId: windowId.value });
  if (!response.ok) {
    setStatus(response.error || "新建标签页失败。", "error");
    return;
  }
  setStatus("", "");
  await refresh();
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
 * 右键某个标签：把上下文交给 Firefox 的原生标签菜单。
 *
 * menus.overrideContext({ context: "tab", tabId }) 的语义是**隐藏所有默认 Firefox 菜单项**，
 * 只渲染「本扩展 + 其它扩展注册到 tab 上下文的项」——也就是说它提供的是原生菜单**外壳**
 * （原生外观、键盘导航、自动合并其它扩展的项），菜单**内容**由后台注册的那些项提供。
 * 因此这里只覆盖上下文，绝不 preventDefault：让 Firefox 自己把菜单弹出来。
 */
function openTabContextMenu(tab) {
  if (!tab || !Number.isFinite(Number(tab.id))) {
    return;
  }
  // 使用 contextMenus 别名时 API 挂在 chrome.contextMenus 下；若浏览器暴露 chrome.menus 也一并兼容。
  const api = (typeof chrome.menus !== "undefined" &&
    chrome.menus &&
    typeof chrome.menus.overrideContext === "function")
    ? chrome.menus
    : (chrome.contextMenus && typeof chrome.contextMenus.overrideContext === "function"
      ? chrome.contextMenus
      : null);
  if (!api) {
    // 没有该能力时什么都不做，浏览器会退回默认菜单。
    return;
  }
  try {
    api.overrideContext({ context: "tab", tabId: Number(tab.id) });
  } catch (error) {
    console.warn("切换右键菜单上下文失败：", String(error && error.message ? error.message : error));
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
        <button type="button" class="sb-tool" title="在当前标签页下新建（工具栏入口）" @click="createTab">＋</button>
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
        :active-row="activeRow"
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

    <!-- 固定在底部、不参与滚动：在窗口末尾新建一个顶层标签页 -->
    <div class="sb-newtab-bar">
      <button
        type="button"
        class="sb-newtab"
        title="在窗口末尾新建一个顶层标签页"
        :disabled="windowId === null"
        @click="createRootTab"
      >
        <svg class="sb-newtab-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        新建标签页
      </button>
    </div>
  </div>
</template>
