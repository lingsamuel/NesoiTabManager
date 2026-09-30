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
import SidebarTabTree from "./components/SidebarTabTree.vue";

// 结构类事件合并窗口：10K 标签下一次刷新要取回整窗标签，必须避免逐事件刷新。
const REFRESH_DEBOUNCE_MS = 250;
const MANAGER_PAGE = "ui/manager.html";

const windowId = ref(null);
const tabs = ref([]);
const ready = ref(false);
const status = reactive({ message: "", type: "" });

const tree = useTree();
const filter = useFilterQuery();

let refreshTimer = null;
let pendingWhileHidden = false;
const cleanups = [];

function setStatus(message, type) {
  status.message = message || "";
  status.type = type || "";
}

/**
 * 行模型：标签列表 + 父子映射 + 折叠状态 + 关键词 → 扁平行。
 * 这里不复制任何渲染逻辑，全部交给后台/管理页共用的 buildTreeRows。
 */
const rowModel = computed(() => {
  const list = tabs.value;
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

// ---------------------------------------------------------------------------
// 数据刷新
// ---------------------------------------------------------------------------

async function queryWindowTabs(id) {
  const list = await new Promise((resolve) => {
    chrome.tabs.query({ windowId: id }, (result) => resolve(Array.isArray(result) ? result : []));
  });
  return list.slice().sort((left, right) => (left.index || 0) - (right.index || 0));
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
  ready.value = true;
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
 * 事件驱动的延迟刷新。
 * 侧边栏被收起或切到别的侧边栏时文档可能仍存在但不可见，此时跳过刷新，等重新可见再补一次，
 * 避免用户在其它面板工作时持续付出整窗查询的成本。
 */
function scheduleRefresh() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    pendingWhileHidden = true;
    return;
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, REFRESH_DEBOUNCE_MS);
}

function onVisibilityChange() {
  if (document.visibilityState === "visible" && pendingWhileHidden) {
    pendingWhileHidden = false;
    scheduleRefresh();
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
      // 只有真正影响显示的字段才值得重取整窗标签。
      if (!changeInfo) {
        return undefined;
      }
      const relevant =
        "title" in changeInfo ||
        "url" in changeInfo ||
        "favIconUrl" in changeInfo ||
        "discarded" in changeInfo ||
        "pinned" in changeInfo;
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
      if (!Number.isFinite(eventWindowId) || eventWindowId !== Number(windowId.value)) {
        return;
      }
      scheduleRefresh();
    };
    target.addListener(listener);
    cleanups.push(() => target.removeListener(listener));
  }

  // 切换标签走本地高亮更新，避免每次点标签都重取整窗数据。
  const activated = chrome.tabs && chrome.tabs.onActivated;
  if (activated && typeof activated.addListener === "function") {
    const listener = (activeInfo) => {
      if (!activeInfo || Number(activeInfo.windowId) !== Number(windowId.value)) {
        return;
      }
      applyActiveTab(activeInfo.tabId);
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
  // 复用后台的激活逻辑：它会先聚焦窗口再激活标签，行为与管理页完全一致。
  const response = await request("activateTab", {
    tabId: tab.id,
    windowId: tab.windowId === undefined ? windowId.value : tab.windowId,
  });
  if (!response.ok) {
    setStatus(response.error || "跳转失败。", "error");
    return;
  }
  setStatus("", "");
  // 立刻刷新一次，让活动标记跟上，不必等防抖。
  refresh();
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
  scheduleRefresh();
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
    <div v-else-if="items.length === 0" class="sb-empty">{{ emptyText }}</div>
    <SidebarTabTree
      v-else
      :items="items"
      :highlight-matches="isJumpMode"
      :current-match-index="currentMatchIndex"
      :is-tree-descendant="isTreeDescendant"
      @activate="activateTab"
      @close="closeTab"
      @discard="discardTab"
      @toggle-collapse="toggleCollapse"
      @tree-drop="onTreeDrop"
    />
  </div>
</template>
