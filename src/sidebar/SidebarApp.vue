<script setup>
// Firefox 侧边栏（`sidebar_action` 面板）。
//
// 与网页浮层最大的不同：侧边栏文档是**扩展自身的页面**，拥有与后台同等的特权 API，
// 因此可以直接监听 chrome.tabs.* 并调用 chrome.tabs.*，不需要"所有操作经后台转发"。
// 只有树本身（父子映射）仍从后台取，避免在前端再实现一套父子推断。
//
// 生命周期：Firefox 每个窗口各有一份独立的侧边栏文档实例，窗口关闭或用户收起侧边栏时文档被卸载，
// 监听器随之销毁——所以这个页面不常驻，对浏览器启动零开销。

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import FilterInput from "../manager/components/FilterInput.vue";
import { useFilterQuery } from "../manager/composables/useFilterQuery.js";
import { useMatchNavigation } from "../manager/composables/useMatchNavigation.js";
import { useTree } from "../manager/composables/useTree.js";
import { matchesTabQuery } from "../manager/utils/helpers.js";
import { request } from "../manager/utils/request.js";
import { getTreeDiagnostics, copyTreeDiagnosticLog } from "../manager/utils/tree_diagnostics.js";
import {
  applySelectionClick,
  clearSelection,
  pruneSelection,
} from "../manager/utils/selection.js";
// 视口高度变化后的滚动补偿（多选条出现会压小列表视口）
import {
  computeBottomAnchorScrollTop,
  computeRevealScrollTop,
} from "../manager/utils/virtual_range.js";
// 与管理页树状视图、后台、基准测试共用同一份行模型（筛选补祖先 + DFS + 折叠）
import { buildTreeRows } from "../../background/tree_core.js";
import { computePinnedReorderIndex, groupPinnedTabs } from "./pinned_data.js";
import {
  buildAppendDropPayload,
  buildPinnedDropPayload,
  buildTreeDropPayload,
  isExternalDropData,
  parseDroppedItem,
} from "./dropped_data.js";
// 行内「发声 / 静音 / 需要关注」标记的纯逻辑（判定与 changeInfo → 本地补丁都在这里）
import {
  audioIndicator,
  isTabAttention,
  isTabMuted,
  mutedPatch,
  statePatchFromChangeInfo,
} from "./audio_state.js";
import {
  pickCurrentMatchFromVisibleRange,
  resolveActiveRow,
  shouldFollowActiveRow,
} from "../manager/utils/scroll_markers.js";
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
const diagnostics = getTreeDiagnostics();
const diagnosticState = diagnostics.state;
let diagnosticEpoch = 0;
let tabStructureEpoch = 0;
let refreshGeneration = 0;
let diagnosticQueries = 0;
let diagnosticAligned = false;
const diagnosticRevisions = new Map();
const filter = useFilterQuery();
// 列表的模板引用：侧边栏关闭了列表的自动滚动，导航动作需要显式滚过去。
const treeRef = ref(null);

// ---------------------------------------------------------------------------
// 多选模式
// ---------------------------------------------------------------------------

// 是否处于多选模式：**仅本次会话有效**（不写 storage，侧边栏文档卸载后重开即回到普通模式）。
const multiSelect = ref(false);
// 选中集合：固定标签区与树区域**共用同一份**，键为标签 id 的字符串形式。
const selectedTabIds = reactive({});
// 连续选择的锚点：最近一次被置为选中的那一项（规则与"锚点失效退化"见 manager/utils/selection.js）。
const selectionAnchor = ref(null);
// 进入多选模式前"列表视口下边缘"对应的内容坐标（scrollTop + viewportHeight）。
// 多选条是 .sb-app 的 flex 兄弟节点，一出现就压小列表视口、把底部若干行移出视野；记下这个坐标，
// 才能等 DOM 落地后把原来贴底的内容顶回新视口下边缘（见 revealAfterEnterMultiSelect）。
// null 表示当前没有可补偿的滚动容器。不需要参与渲染，因此用普通变量。
let pendingBottomAnchor = null;

/**
 * 当前活动标签的 id（字符串形式）；窗口里暂时取不到活动标签时为 null。
 * 只用于"普通模式下 Shift+点击 = 隐式进入多选"这条入口：那一次的区间起点是活动标签本身，
 * 而不是 selectionAnchor（普通模式下选择集合保证为空，没有可用的历史锚点）。
 */
const activeTabId = computed(() => {
  const tab = tabs.value.find((entry) => entry.active);
  return tab && tab.id !== undefined && tab.id !== null ? String(tab.id) : null;
});

// 保存到列表的弹出清单状态。
const saveMenu = reactive({
  mode: "",
  lists: [],
  loading: false,
  creating: false,
  newListName: "",
});

const selectedCount = computed(() => Object.keys(selectedTabIds).length);

/** 树区域的渲染顺序（区间选择与界面顺序必须完全一致）。 */
const treeOrderedIds = computed(() => items.value.map((item) => String(item.id)));

/** 固定标签区的渲染顺序：按分组、组内按 index，与 groupPinnedTabs 的显示顺序一致。 */
const pinnedOrderedIds = computed(() =>
  pinnedGroups.value.flatMap((group) => group.tabs.map((tab) => String(tab.id)))
);

/** 当前仍存在的全部标签 id（本窗口标签 + 跨窗口聚合的固定标签），用于剪枝选中集合。 */
const knownTabIds = computed(() => {
  const ids = new Set(tabs.value.map((tab) => String(tab.id)));
  pinnedGroups.value.forEach((group) => {
    group.tabs.forEach((tab) => ids.add(String(tab.id)));
  });
  return ids;
});

/**
 * 选中项对应的标签对象（批量动作的数据源）。
 * 顺序上以本窗口标签在前、其它窗口的固定标签在后；固定标签同时出现在两处时去重。
 */
const selectedTabs = computed(() => {
  const result = [];
  const seen = new Set();
  const push = (tab) => {
    if (!tab || tab.id === undefined || tab.id === null) {
      return;
    }
    const key = String(tab.id);
    if (!selectedTabIds[key] || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(tab);
  };
  tabs.value.forEach(push);
  pinnedGroups.value.forEach((group) => group.tabs.forEach(push));
  return result;
});

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
function treeRowOptions(tabById) {
  const keyword = filter.committed.value;
  const hasKeyword = Boolean(String(keyword || "").trim());
  const matchId = hasKeyword
    ? (tabIdValue) => {
        const tab = tabById.get(Number(tabIdValue));
        return Boolean(tab && matchesTabQuery(tab, keyword));
      }
    : null;
  return {
    collapsedIds: tree.collapsedSetFor(windowId.value),
    forceExpand: hasKeyword,
    matchId,
    // 跳转模式必须保留完整树、只标记匹配项。
    pruneToMatches: filter.mode.value === "filter",
  };
}

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
  const rows = buildTreeRows(list, parentMap, treeRowOptions(tabById));
  return { rows, tabById };
});

/** 完整行、显示行、浏览器顺序各有独立基线，折叠和筛选不能被当成树节点消失。 */
function observeDiagnosticRows() {
  if (!diagnosticState.enabled || windowId.value === null || document.visibilityState !== "visible") return;
  const id = windowId.value;
  const parents = tree.parentsFor(id);
  const tabById = new Map(treeTabs.value.map((tab) => [Number(tab.id), tab]));
  const parentById = new Map(treeTabs.value.map((tab) => [Number(tab.id), parents[tab.id] ?? null]));
  const applied = tree.diagnosticContextFor(id);
  const aligned = diagnosticAligned && diagnosticQueries === 0 && !applied.pending;
  const observe = (source, rows) => {
    const baseline = diagnosticRevisions.get(source);
    const sameInstance = baseline?.sourceToken === applied.sourceToken;
    const operations = sameInstance ? (applied.operations || []).filter((operation) =>
      operation.revision > baseline.revision && operation.revision <= applied.revision).map((operation) => {
        if (!Array.isArray(operation.expectedOrderIds)) return operation;
        const expectedTabs = operation.expectedOrderIds.map((tabId) => tabById.get(tabId)).filter(Boolean);
        // 操作登记的是浏览器物理顺序；必须经相同投影才能与 DFS/筛选行比较。
        const options = source === "rows" ? { forceExpand: true } : treeRowOptions(tabById);
        return { ...operation, expectedOrderIds: buildTreeRows(expectedTabs, parentById, options).map((row) => row.id) };
      }) : [];
    diagnostics.observe({
      windowId: id, source, sourceToken: applied.sourceToken, parentById,
      // 完整物理序列留在客户端，用于关闭预期计算；不能用筛选/折叠后的行顺序代替。
      physicalOrderIds: treeTabs.value.map((tab) => Number(tab.id)),
      entries: rows.map((row, index) => ({ id: row.id, parentId: parentById.get(row.id) ?? null,
        index, depth: row.depth, collapsed: Boolean(row.collapsed),
        title: tabById.get(row.id)?.title, url: tabById.get(row.id)?.url })),
    }, { ...applied, operations, aligned, phase: aligned ? "complete" : "pending",
      filterActive: Boolean(filter.committed.value), filterMode: filter.mode.value,
      collapsedCount: tree.collapsedSetFor(id)?.size || 0,
      visibleCount: rowModel.value.rows.length, completeCount: treeTabs.value.length,
      pinnedCount: tabs.value.length - treeTabs.value.length });
    // 处理中不能推进已对齐版本，否则后续真实观测会失去关闭提升的解释链。
    if (aligned) diagnosticRevisions.set(source, { sourceToken: applied.sourceToken, revision: applied.revision });
  };
  observe("rows", buildTreeRows(treeTabs.value, parentById, { forceExpand: true }));
  observe("visibleRows", rowModel.value.rows);
}

// 关闭时不求值任何用于诊断的快照；开启期间复用正常行模型的变更通知。
watch(() => diagnosticState.enabled ? rowModel.value : null, () => observeDiagnosticRows(), { flush: "post" });
watch(() => diagnosticState.enabled ? [filter.committed.value, filter.mode.value,
  JSON.stringify(tree.collapsedSetFor(windowId.value) ? [...tree.collapsedSetFor(windowId.value)] : [])] : null,
() => {
  if (!diagnosticState.enabled) return;
  diagnostics.gap({ windowId: windowId.value, source: "visibleRows", reason: "view-projection-change" });
  diagnosticRevisions.delete("visibleRows");
}, { flush: "pre" });

async function copyDiagnosticLog() {
  try {
    await diagnostics.flush();
    const count = await copyTreeDiagnosticLog();
    setStatus(`已复制 ${count} 行诊断日志。`, "ok");
  } catch (error) {
    setStatus(error?.message || "复制诊断日志失败。", "error");
  }
}

const items = computed(() => {
  const { rows, tabById } = rowModel.value;
  const result = [];
  for (const row of rows) {
    const tab = tabById.get(row.id);
    if (!tab) {
      continue;
    }
    // 展示态（发声/静音喇叭、需要关注圆点）在这里算一次：模板不必重复调用判定函数，
    // 而且这里读过 tab 的这几个字段，标签状态被增量补丁改掉时行模型会自动重算。
    result.push({
      ...row,
      key: `tab-${row.id}`,
      tab,
      audio: audioIndicator(tab),
      attention: isTabAttention(tab),
    });
  }
  return result;
});

/**
 * 活动标签在行序列里的位置 + 它的标签 id，供滚动条轨道标记与"跟随活动标签"共用。
 *
 * 固定标签常驻在顶部固定区、不随列表滚动，因此行号记为 -1 并带上 pinned 标记——
 * 但它**必须**出现在这里：自动跟随活动标签要知道"上一个活动标签是不是固定标签"。
 * 固定标签始终可见，从它切走等同于"用户没有滚走"，可以直接跟随
 * （典型场景：停在固定标签上按 Ctrl+T，新标签立刻成为活动标签，应当跟过去）。
 *
 * 之所以要带上 tabId：行号会因为折叠子树、前后增删标签而变化，行号变了并不等于
 * "换了活动标签"。只有 tabId 真的变了才值得滚动跟随，否则用户折叠一棵子树、
 * 或关掉上面一个标签，列表都会毫无理由地跳位置。
 */
const activeEntry = computed(() => {
  const id = windowId.value;
  if (id === null) {
    return null;
  }
  const activeTab = tabs.value.find((tab) => tab.active);
  if (!activeTab) {
    return null;
  }
  const tabId = Number(activeTab.id);
  if (activeTab.pinned) {
    return { tabId, index: -1, isAncestor: false, pinned: true };
  }
  const row = resolveActiveRow(tabId, items.value, tree.parentsFor(id));
  if (!row) {
    return null;
  }
  return { tabId, index: Number(row.index), isAncestor: Boolean(row.isAncestor), pinned: false };
});

/**
 * 活动标签所在行（对外形状与 resolveActiveRow 的结果一致），供轨道刻度使用。
 * 固定标签不在行序列里，也不必在轨道上标出——它的活动态由固定标签区的方块表示。
 */
const activeRow = computed(() => {
  const entry = activeEntry.value;
  if (!entry || entry.pinned || entry.index < 0) {
    return null;
  }
  return { index: entry.index, isAncestor: entry.isAncestor };
});

/**
 * 所有"匹配行"的行号（升序）。
 * 一次扫描缓存下来，滚动时就不用每帧重新遍历整份行数据。
 */
const matchRowIndexes = computed(() => {
  const result = [];
  items.value.forEach((item, index) => {
    if (item.matched) {
      result.push(index);
    }
  });
  return result;
});

const hasCommittedQuery = computed(() => Boolean(String(filter.committed.value || "").trim()));
const isJumpMode = computed(() => filter.mode.value === "jump" && hasCommittedQuery.value);

/**
 * 匹配行高亮只在"列表里混有非匹配行"时才需要（与管理页同一条规则）：
 * 树状模式的祖先行、跳转模式下的完整列表都会让这个条件成立；
 * 而过滤模式下的树如果只渲染匹配项本身，就不会有多余的高亮噪声。
 */
const highlightMatches = computed(() => {
  if (!hasCommittedQuery.value) {
    return false;
  }
  return items.value.some((item) => !item.matched);
});

const {
  matchCount,
  currentMatchIndex,
  currentMatchPosition,
  goToNext,
  goToPrev,
  setCurrentMatchByRowIndex,
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

/** 把某一行滚动到可视区并居中。 */
function scrollToRow(index) {
  if (index < 0 || !treeRef.value || typeof treeRef.value.scrollToIndex !== "function") {
    return;
  }
  treeRef.value.scrollToIndex(index);
}

/** 滚动到当前跳转项（导航动作专用；滚动同步本身不会调用它）。 */
function scrollToCurrentMatch() {
  scrollToRow(currentMatchIndex.value);
}

function goToNextMatch() {
  goToNext();
  scrollToCurrentMatch();
}

function goToPrevMatch() {
  goToPrev();
  scrollToCurrentMatch();
}

/**
 * 切换筛选模式。
 * 切到跳转模式时 useMatchNavigation 会把当前项重置为第一个匹配；因为侧边栏关闭了列表的
 * 自动滚动，这里必须显式滚过去，否则会退化回"切模式后停在原地"。
 */
async function setFilterMode(mode) {
  filter.setMode(mode);
  await nextTick();
  scrollToCurrentMatch();
}

/**
 * 提交新的搜索词后，把"当前跳转项"带到眼前。
 *
 * 跳转模式下 useMatchNavigation 会在关键词（或匹配集合）变化时把当前项重置为**第一个匹配**，
 * 而侧边栏关闭了列表自身的"当前项变化即滚动"（见 SidebarTabTree 的 auto-scroll-to-match），
 * 于是出现"输入的关键词明明有匹配，列表却停在原地，要先按一下 ↓ 才会跳过去"。
 * 这里补上显式滚动，与切模式、↑/↓、点刻度保持同一口径。
 *
 * 只监听**提交的关键词**：滚动同步（onVisibleRange）同样会改写当前项，那种改写绝不能反过来
 * 触发滚动，否则用户一滚就被拉回去；关键词没变、只是标签增删导致匹配集合变化时也不动，
 * 免得用户正看着别处时列表突然跳走。
 */
watch(
  () => filter.committed.value,
  async () => {
    if (!isJumpMode.value) {
      return;
    }
    await nextTick();
    scrollToCurrentMatch();
  }
);

/**
 * 可见行区间变化 → 让"当前跳转项"跟随可见范围。
 * 只在跳转模式下有意义；当前项仍可见、或可见范围内没有匹配项时都不动。
 * 这里**只改状态、不滚动**：一旦滚动就会变成"用户一滚就被拉回去"。
 */
function onVisibleRange(range) {
  if (!isJumpMode.value || !range) {
    return;
  }
  const next = pickCurrentMatchFromVisibleRange({
    matchRowIndexes: matchRowIndexes.value,
    currentMatchRowIndex: currentMatchIndex.value,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
  });
  if (next !== null) {
    setCurrentMatchByRowIndex(next);
  }
}

/**
 * 点击滚动条刻度。
 * 点匹配刻度时要**同步当前跳转项**——这样 ↑/↓ 会从用户点的那一项继续（例：3 个匹配项、
 * 当前在第 2 项，点了第 1 项的刻度后当前项变成第 1 项，此时"上一条"是第 3 项、"下一条"是第 2 项）。
 * 合并过的刻度由 buildTrackMarkers 给出 matchIndex：只有"点击目标本身就是匹配项"时才有值，
 * 因此点活动标签的蓝色刻度不会碰搜索状态。
 */
function onMarkerClick(marker) {
  if (!marker) {
    return;
  }
  if (isJumpMode.value && Number.isFinite(marker.matchIndex)) {
    setCurrentMatchByRowIndex(marker.matchIndex);
  }
  scrollToRow(marker.index);
}

/**
 * 工具栏「定位」：把当前活动标签所在的行滚到可视区中间。
 *
 * 行号直接复用 activeRow：活动标签被折叠或被筛选隐藏时，resolveActiveRow 已经退回到它最近的
 * 可见祖先，所以这里不必再判断可见性；固定标签不在行序列里，那时 activeRow 为 null，
 * 必须给一句提示而不是静默失败，否则按钮看起来像坏了。
 *
 * 处于跳转模式、且该行本身是匹配项时顺带同步"当前跳转项"，让用户接着按 ↑/↓ 从眼前这一项继续；
 * 其余情况一律不碰搜索状态——一次定位不应该丢掉用户的搜索上下文。
 */
function locateActiveTab() {
  const row = activeRow.value;
  const index = row ? Number(row.index) : Number.NaN;
  if (!Number.isFinite(index) || index < 0) {
    setStatus("当前标签页不在列表中。", "error");
    return;
  }
  if (isJumpMode.value && matchRowIndexes.value.includes(index)) {
    setCurrentMatchByRowIndex(index);
  }
  scrollToRow(index);
  // 清掉上一次定位失败留下的提示，否则用户切换标签后再定位，仍会看到那句旧报错。
  setStatus("", "");
}

/**
 * 自动跟随活动标签：把当前活动行滚到视口中间。
 *
 * 与上面的「定位」按钮（用户显式要求，无论如何都要滚）分开：自动跟随必须先确认
 * "可以动滚动位置"，规则全部交给纯函数 shouldFollowActiveRow——
 * 目标行已经完整可见就不动；只有"列表刚重建"、"旧活动标签是固定标签"或"旧活动行仍在视野里"时才动。
 *
 * @param {{previousIndex?: number, previousPinned?: boolean, listRecreated?: boolean}} options
 *   previousIndex：变化之前那条活动行的行号（没有就传 -1）。
 *   previousPinned：变化之前的活动标签是固定标签（它始终可见，等同于"用户没滚走"）。
 *   listRecreated：列表是不是刚建立/重建（此时滚动位置必然是初始值，不代表用户意图）。
 */
async function followActiveTab(options = {}) {
  const { previousIndex = -1, previousPinned = false, listRecreated = false } = options;
  // 等本轮渲染落地再判断和滚动：行序列、行高、视口高度都要用渲染后的真实值。
  await nextTick();
  const entry = activeEntry.value;
  const list = treeRef.value;
  if (!entry || !list || typeof list.getScrollState !== "function") {
    return;
  }
  const geometry = list.getScrollState();
  if (!geometry) {
    return;
  }
  if (
    shouldFollowActiveRow({
      activeIndex: entry.index,
      previousActiveIndex: previousIndex,
      previousPinned,
      listRecreated,
      ...geometry,
    })
  ) {
    scrollToRow(entry.index);
  }
}

/**
 * 初始化（以及列表被重建）时的定位。
 *
 * 树组件的实例出现，就说明列表刚刚（重新）挂载：此刻滚动位置必然是默认值 0。
 * 这个值不代表用户的任何意图——可能只是页面刚打开，也可能是筛选把树清空后又恢复——
 * 所以直接换成活动标签的位置，而不是让用户对着列表顶部找当前标签。
 */
watch(treeRef, (instance) => {
  if (instance) {
    followActiveTab({ listRecreated: true });
  }
});

/**
 * 切换标签（以及任何导致活动标签变化的事件）时跟随定位。
 *
 * 只在"允许移动滚动位置"时才滚：旧活动标签是固定标签（始终可见），或者旧活动行还在视野里
 * （说明列表本来就停在用户关心的位置上，他并没有滚去别处看）；其余情况一律不动。
 * 新活动标签是固定标签时也不动——它本来就在固定区里看得见。
 *
 * 行号变化但 tabId 没变（折叠子树、前后增删标签）不算活动标签变化，直接跳过，
 * 否则这些操作会让列表莫名其妙地跳位置。
 */
watch(activeEntry, (next, previous) => {
  if (!next || next.pinned || next.index < 0) {
    return;
  }
  if (previous && previous.tabId === next.tabId) {
    return;
  }
  followActiveTab({
    previousIndex: previous ? previous.index : -1,
    // 固定标签作为"上一个活动标签"时视作在视野里：停在固定标签上按 Ctrl+T
    // 就是这条分支——新标签成为活动标签，列表应当跟过去。
    previousPinned: Boolean(previous && previous.pinned),
  });
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

/** 同一次正常查询在结构响应后再对齐，无需为了诊断另查整窗。 */
function observeDiagnosticPhysical(id, list, aligned) {
  if (!diagnosticState.enabled) return;
  const applied = tree.diagnosticContextFor(id);
  const baseline = diagnosticRevisions.get("physical");
  const sameInstance = baseline?.sourceToken === applied.sourceToken;
  const operations = sameInstance ? (applied.operations || []).filter((operation) =>
    operation.revision > baseline.revision && operation.revision <= applied.revision) : [];
  const complete = aligned && !applied.pending && diagnosticQueries === 0;
  diagnostics.observe({ windowId: id, source: "physical", sourceToken: applied.sourceToken,
    entries: list.map((tab) => ({ id: tab.id, parentId: null, index: tab.index, pinned: Boolean(tab.pinned),
      title: tab.title, url: tab.url })),
  }, { ...applied, operations, aligned: complete, phase: complete ? "complete" : "pending" });
  if (complete) diagnosticRevisions.set("physical", { sourceToken: applied.sourceToken, revision: applied.revision });
}

async function refresh() {
  const id = windowId.value;
  if (id === null) {
    return;
  }
  const refreshId = ++refreshGeneration;
  const structureEpoch = tabStructureEpoch;
  const diagnosticQuery = diagnosticState.enabled;
  const queryEpoch = diagnosticEpoch;
  if (diagnosticQuery) diagnosticQueries += 1;
  const list = await queryWindowTabs(id);
  // 关闭定位会产生原生移动事件；迟到的旧 query 不能覆盖新列表或复活已关闭项。
  if (refreshId !== refreshGeneration || structureEpoch !== tabStructureEpoch) {
    if (diagnosticQuery) diagnosticQueries -= 1;
    if (refreshId === refreshGeneration) scheduleRefresh("full");
    return;
  }
  if (diagnosticQuery) {
    diagnosticAligned = queryEpoch === diagnosticEpoch;
    observeDiagnosticPhysical(id, list, false);
  }
  tabs.value = list;
  // 折叠状态是与管理页共用的会话级记录，标签关闭后要顺手裁掉无效条目，避免越积越多。
  tree.pruneCollapsed(new Set(list.map((tab) => String(tab.id))));
  // 父子映射仍由后台提供：树是后台维护的唯一真相，前端不再自行推断。
  const ok = await tree.loadForWindows([id]);
  if (diagnosticQuery) {
    diagnosticQueries -= 1;
    diagnosticAligned = ok && queryEpoch === diagnosticEpoch;
    observeDiagnosticPhysical(id, list, diagnosticAligned);
    observeDiagnosticRows();
  }
  if (!ok) {
    setStatus(tree.status.message || "树状结构加载失败。", "error");
  }
  await refreshPinned();
  // 标签被关闭/移出后选中项与锚点都可能已不存在：一起剪掉，避免留下幽灵选中项，
  // 也避免下一次 Shift 区间从一个已经消失的锚点算起。
  selectionAnchor.value = pruneSelection(selectedTabIds, knownTabIds.value, selectionAnchor.value);
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
  // 「只刷新固定区」这条路径不会走整窗刷新，因此其它窗口的固定标签被关掉时
  // 也要在这里剪一次，否则选中集合会留下一个点不动的幽灵项（批量动作会把它算成"跳过"）。
  selectionAnchor.value = pruneSelection(selectedTabIds, knownTabIds.value, selectionAnchor.value);
}

/**
 * 切换标签时只需改动高亮，不必重新查询整窗标签。
 * 10K 标签下这一优化把"切标签"从一次 IPC + 整窗序列化降成一次 O(n) 内存遍历。
 *
 * 但"目标标签不在列表里"时必须退化去刷新：那说明本地数据已经过时，最常见的是**刚新建的
 * 标签**——`onCreated` 的防抖刷新还没跑，新标签尚未进列表，而切换事件已经到了；也可能是
 * 刚从别的窗口移入本窗口的标签。
 *
 * 这种情况下**绝不能**把其它标签的活动标记清掉，原因有两条：
 *   1. 界面会先进入一段"没有任何活动标签"的错误状态，直到刷新回来才恢复；
 *   2. 自动跟随活动标签要靠"变化前的活动行还在不在视野里"判断用户有没有滚走，
 *      清掉标记等于把这条信息一起丢掉——新建标签后就永远不跟随（表现为跟随功能没生效）。
 * 因此这里保持原样，只补排一次整窗刷新（onCreated / onAttached 通常已经排过，防抖会合并）。
 */
function applyActiveTab(tabId) {
  const list = tabs.value;
  const targetIndex = list.findIndex((tab) => Number(tab.id) === Number(tabId));
  if (targetIndex < 0) {
    scheduleRefresh("full");
    return;
  }
  let changed = false;
  list.forEach((tab, index) => {
    const shouldBeActive = index === targetIndex;
    if (Boolean(tab.active) !== shouldBeActive) {
      tab.active = shouldBeActive;
      changed = true;
    }
  });
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
  if (diagnosticState.enabled && document.visibilityState !== "visible") {
    for (const source of ["physical", "rows", "visibleRows"]) {
      diagnostics.gap({ windowId: windowId.value, source, reason: "hidden" });
    }
    diagnosticAligned = false;
    diagnosticRevisions.clear();
  }
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
      // onUpdated 在页面加载期间会连续触发（status 等字段连续变化），
      // 只有真正影响"列表结构或文本"的字段才值得重取数据。
      // 发声 / 静音 / 需要关注这三个展示态字段**刻意不在这里**：它们由 bindTabStateEvents
      // 做本地增量补丁，用一次整窗查询去换一个布尔值不成比例（见该函数注释）。
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

/**
 * 把一组状态补丁写进本地标签对象（本窗口标签 + 跨窗口聚合的固定标签）。
 *
 * 为什么需要它：`audible` / `mutedInfo` / `attention` 只影响行内的小标记，却可能随播放状态频繁变化，
 * 而一次整窗刷新在 10K 标签下要序列化约 2MB 并附带父子映射——用这个代价换一个布尔值完全不成比例。
 * 这里直接在内存里改那一个标签的字段，是 O(标签数) 的遍历。
 *
 * 找不到该标签时什么都不做：说明本地数据已经过时（例如新标签的 onCreated 防抖刷新还没跑），
 * 那次刷新本来就会取回权威值。
 */
function applyTabStatePatch(tabId, patch) {
  if (!patch || Object.keys(patch).length === 0) {
    return;
  }
  const id = Number(tabId);
  let changed = false;
  const patchOne = (tab) => {
    if (!tab || Number(tab.id) !== id) {
      return;
    }
    Object.assign(tab, patch);
    changed = true;
  };
  tabs.value.forEach(patchOne);
  pinnedGroups.value.forEach((group) => group.tabs.forEach(patchOne));
  if (changed) {
    // 显式换一次数组引用：与 applyActiveTab 同一手法，保证依赖"整份列表"的计算属性也一定重算。
    tabs.value = tabs.value.slice();
  }
}

/**
 * 展示态专用监听器：`onUpdated` 的 changeInfo 直接补进本地对象，不参与 250ms 防抖刷新。
 *
 * 与 TAB_EVENT_SOURCES 里的 onUpdated 监听器并存是有意的——那个负责"结构/文本变化 → 重取数据"，
 * 这个负责"展示态变化 → 改内存"。两者的触发条件与代价完全不同，混在一个函数里会让刷新策略难以读懂。
 */
function bindTabStateEvents() {
  const target = chrome.tabs && chrome.tabs.onUpdated;
  if (!target || typeof target.addListener !== "function") {
    return;
  }
  const listener = (tabId, changeInfo) => {
    applyTabStatePatch(tabId, statePatchFromChangeInfo(changeInfo));
  };
  target.addListener(listener);
  cleanups.push(() => target.removeListener(listener));
}

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
      if (eventWindowId === Number(windowId.value)) tabStructureEpoch += 1;
      if (diagnosticState.enabled && eventWindowId === Number(windowId.value)) {
        diagnosticEpoch += 1;
        diagnosticAligned = false;
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

/**
 * 订阅后台的**结构变更通知**（`storage.session` 的树结构版本号）。
 *
 * 为什么不能只靠 tabs 事件：后台会在落盘前做一次静默的不变量纠偏（把"父排在子之后"这类非法关系
 * 改回顶层），它不产生任何 tabs 事件。只靠事件驱动刷新时，侧边栏会一直显示纠偏前的旧层级，
 * 用户必须 Reload 扩展才能对齐——"看到的必须等于真实结构"这条要求就是靠这条通知保证的。
 *
 * `revision` 由 useTree 在拉取时比对：更旧的结果会被丢弃，避免慢请求把新结构覆盖回旧结构。
 */
function bindTreeStructureEvents() {
  const unsubscribe = tree.onStructureChanged((changedWindowIds) => {
    const ids = Array.isArray(changedWindowIds) ? changedWindowIds : [];
    if (ids.length === 0 || ids.includes(Number(windowId.value))) {
      tabStructureEpoch += 1;
      if (diagnosticState.enabled) {
        diagnosticEpoch += 1;
        diagnosticAligned = false;
      }
      scheduleRefresh("full");
      return;
    }
    // 只影响其它窗口时，固定标签区是唯一可能受影响的区域。
    scheduleRefresh("pinned");
  });
  cleanups.push(unsubscribe);
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

/**
 * 切换某个标签的静音状态（行内喇叭按钮的唯一动作）。
 *
 * 采用"乐观更新 + 权威校正"：先本地打补丁让界面立刻响应（静音必须是点一下就有反馈的操作），
 * 再用 tabs.update 的回调结果校正；失败时把本地补丁视为脏数据，重取一次权威状态。
 * 这里直接调 chrome.tabs.update 而不是经后台转发：侧边栏文档拥有与后台同等的特权 API
 * （和关闭标签、重排固定标签同一取舍）。
 */
function toggleMute(tab) {
  if (!tab || !Number.isFinite(Number(tab.id))) {
    return;
  }
  const tabId = Number(tab.id);
  const nextMuted = !isTabMuted(tab);
  applyTabStatePatch(tabId, mutedPatch(tab, nextMuted));
  chrome.tabs.update(tabId, { muted: nextMuted }, (updated) => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message || "切换静音失败。", "error");
      // 本地补丁可能已经写脏，重取一次权威状态把它纠正回来（固定标签也可能来自其它窗口）。
      if (Number(tab.windowId) === Number(windowId.value)) {
        scheduleRefresh("full");
      } else {
        scheduleRefresh("pinned");
      }
      return;
    }
    setStatus("", "");
    // 回调返回的就是更新后的标签；用它的 mutedInfo 覆盖乐观值，reason 等字段也一并跟上。
    if (updated && updated.mutedInfo) {
      applyTabStatePatch(tabId, { mutedInfo: updated.mutedInfo });
    }
  });
}

// ---------------------------------------------------------------------------
// 多选模式：选择与批量动作
// ---------------------------------------------------------------------------

/**
 * 开关多选模式。关闭时一并清空选择与弹出清单，避免下次开启看到上次的残留。
 * 开启时会顺带修正列表滚动位置：多选条一出现就压小列表视口，底部若干行会被移出视野（见
 * revealAfterEnterMultiSelect）。关闭时视口变大、内容只会多出来，因此不做反向补偿。
 */
function toggleMultiSelect() {
  if (multiSelect.value) {
    multiSelect.value = false;
    clearSidebarSelection();
    return;
  }
  enterMultiSelect();
  revealAfterEnterMultiSelect();
}

/** 清空选择（「取消选择」按钮、退出多选模式都用它）：锚点与弹出清单一起复位。 */
function clearSidebarSelection() {
  clearSelection(selectedTabIds);
  selectionAnchor.value = null;
  closeSaveMenu();
}

/**
 * 进入多选模式的统一准备（工具栏开关与 Shift+点击隐式进入都走这里）。
 *
 * 除了打开开关，还要记下"进入前列表视口下边缘的内容坐标"：多选条是 .sb-app 的 flex 兄弟节点，
 * 它一出现就从列表手里拿走高度，而浏览器只会把 maxScroll 变大、不会自己移动 scrollTop，
 * 底部若干行于是直接落到视口之外。记下这个坐标，revealAfterEnterMultiSelect 才能在 DOM
 * 落地后把原来的底部内容顶回视口下边缘。
 *
 * @returns {string|null} 本次 Shift 区间要用的锚点（当前活动标签 id）
 */
function enterMultiSelect() {
  const state =
    treeRef.value && typeof treeRef.value.getScrollState === "function"
      ? treeRef.value.getScrollState()
      : null;
  pendingBottomAnchor =
    state && state.viewportHeight > 0 ? state.scrollTop + state.viewportHeight : null;
  multiSelect.value = true;
  return activeTabId.value;
}

/**
 * 多选条出现后修正列表滚动位置。
 *
 * 时机必须是 nextTick：多选条要真的进了 DOM，读到的 clientHeight 才是被压小后的高度。
 * 不能等 ResizeObserver 回调（时机不确定），也不能把多选条高度写死成常量。
 *
 * 两条规则，先粗后细：
 * 1. **底边锚定**：让进入前贴在视口下边缘的内容继续贴住新的下边缘（列表整体上移约一个多选条
 *    的高度），这样"列表正好滚到底部"时最下面那几行不会被凭空吃掉；
 * 2. **选中区间尽量可见**：把本次选中的行（树区域里的连续区间）尽量完整滚进视野，并保证
 *    **被点行**完整可见；区间长过视口时退化为"视口完全落在区间内部"（可见的选中行最多）。
 *
 * @param {string|number|null} clickedId 隐式入口里被点的那一行 id；
 *   工具栏 / 固定标签区入口传 null（被点项不在这个滚动列表里，只做底边锚定）
 */
async function revealAfterEnterMultiSelect(clickedId = null) {
  await nextTick();
  const list = treeRef.value;
  const anchorBottom = pendingBottomAnchor;
  pendingBottomAnchor = null;
  if (!list || typeof list.getScrollState !== "function" || typeof list.scrollToOffset !== "function") {
    return;
  }
  const state = list.getScrollState();
  if (!state || state.viewportHeight <= 0 || state.itemCount === 0) {
    return;
  }
  // 第一步：底边锚定。取不到进入前的坐标时保持原位。
  const base =
    anchorBottom === null
      ? state.scrollTop
      : computeBottomAnchorScrollTop({
          anchorBottom,
          itemCount: state.itemCount,
          itemHeight: state.itemHeight,
          viewportHeight: state.viewportHeight,
        });
  // 第二步：选中区间尽量可见（固定标签区与树区共用一份选中集合，这里只关心树区域的行）。
  const selectedIndexes = [];
  items.value.forEach((item, index) => {
    if (selectedTabIds[item.id]) {
      selectedIndexes.push(index);
    }
  });
  if (clickedId === null || selectedIndexes.length === 0) {
    list.scrollToOffset(base);
    return;
  }
  const clickedIndex = items.value.findIndex((item) => String(item.id) === String(clickedId));
  list.scrollToOffset(
    computeRevealScrollTop({
      scrollTop: base,
      itemCount: state.itemCount,
      itemHeight: state.itemHeight,
      viewportHeight: state.viewportHeight,
      firstIndex: selectedIndexes[0],
      lastIndex: selectedIndexes[selectedIndexes.length - 1],
      // 被点行理论上一定在选中集合里；万一数据刚好被刷新过，退化为区间首行。
      focusIndex: clickedIndex >= 0 ? clickedIndex : selectedIndexes[0],
    })
  );
}

/**
 * 树区域的选择动作。
 * 区间必须用**树区域自己的**渲染顺序计算：固定标签区是另一个（跨窗口聚合的）序列，
 * 锚点落在另一个区域时 orderedKeys 里找不到它，区间会自动退化为普通点击。
 */
function onTreeSelect(payload) {
  if (!payload) {
    return;
  }
  const shiftKey = Boolean(payload.shiftKey);
  // 普通模式下的 Shift+点击先隐式进入多选，并把这次区间的起点强制设为当前活动标签；
  // 已在多选模式里的 Shift+点击沿用既有锚点（最近一次被置为选中的项），可连续扩选。
  const entering = !multiSelect.value && shiftKey;
  let anchor = selectionAnchor.value;
  if (entering) {
    // 锚点必须是活动标签而不是 selectionAnchor：普通模式下选择集合保证为空（退出多选时已清空），
    // 用户按住 Shift 的意图是"从我正在看的标签一直选到点的那里"。
    // 活动标签不在本区域渲染顺序里时，applySelectionClick 会退化为"只选中被点项"。
    anchor = enterMultiSelect();
  }
  selectionAnchor.value = applySelectionClick(selectedTabIds, {
    key: payload.id,
    shiftKey,
    orderedKeys: treeOrderedIds.value,
    anchor,
  });
  if (entering) {
    // 选中集合已经更新，等多选条进 DOM 后再把选中的行滚回视野。
    revealAfterEnterMultiSelect(payload.id);
  }
}

/** 固定标签区的选择动作：区间按固定区的显示顺序（分组 + 组内 index）计算。 */
function onPinnedSelect(payload) {
  if (!payload) {
    return;
  }
  const shiftKey = Boolean(payload.shiftKey);
  const entering = !multiSelect.value && shiftKey;
  let anchor = selectionAnchor.value;
  if (entering) {
    anchor = enterMultiSelect();
  }
  selectionAnchor.value = applySelectionClick(selectedTabIds, {
    key: payload.id,
    shiftKey,
    orderedKeys: pinnedOrderedIds.value,
    anchor,
  });
  if (entering) {
    // 被点的是固定标签方块（在常驻的固定区里，不随列表滚动），只需补偿列表底边。
    revealAfterEnterMultiSelect();
  }
}

/**
 * 关闭所选。
 * 走后台的 `closeTabsAsGroup`：它会记下一个**关闭组**（含父子层级与物理位置），
 * 之后可以用「撤销关闭」整组恢复；分批与逐条重试都在后台完成，这里不必自己拆批。
 * 选中项可能跨窗口（固定标签区是跨窗口聚合的），后台会按成员各自的窗口分别恢复。
 */
async function closeSelectedTabs() {
  const list = selectedTabs.value;
  if (list.length === 0) {
    return;
  }
  const response = await request("closeTabsAsGroup", {
    tabIds: list.map((tab) => tab.id),
    label: "关闭所选",
  });
  if (!response || !response.ok) {
    setStatus((response && response.error) || "关闭失败。", "error");
    return;
  }
  const removed = Number(response.removed) || 0;
  const skipped = Number(response.skipped) || 0;
  const skippedText = skipped > 0 ? `，跳过 ${skipped} 个` : "";
  setStatus(`已关闭 ${removed} 个标签页${skippedText}。`, skipped > 0 ? "error" : "ok");
  // 不主动刷新：onRemoved 会带本窗口信息回来触发刷新，选中项随之被剪枝。
}

/**
 * 冻结所选：复用后台 manualDiscardTabs（与管理页「冻结所选」同一条路径），
 * 因此冻结次数统计、冻结历史批次都与其它入口完全一致。
 */
async function discardSelectedTabs() {
  const list = selectedTabs.value;
  if (list.length === 0) {
    return;
  }
  const response = await request("manualDiscardTabs", {
    tabIds: list.map((tab) => tab.id),
  });
  if (!response.ok) {
    setStatus(response.error || "冻结失败。", "error");
    return;
  }
  const discarded = Number(response.discarded) || 0;
  const skipped = Number(response.skipped) || 0;
  setStatus(`已冻结 ${discarded} 个标签页${skipped > 0 ? `，跳过 ${skipped} 个` : ""}。`, "ok");
  scheduleRefresh();
}

// ---------------------------------------------------------------------------
// 保存所选到列表（弹出清单 = 与右键菜单同构的交互）
// ---------------------------------------------------------------------------

function closeSaveMenu() {
  saveMenu.mode = "";
  saveMenu.lists = [];
  saveMenu.loading = false;
  saveMenu.creating = false;
  saveMenu.newListName = "";
}

/** Escape 关闭弹出清单：菜单盖在列表上，没有键盘出口会很难受。 */
function onSaveMenuKeydown(event) {
  if (event && event.key === "Escape" && saveMenu.mode) {
    closeSaveMenu();
  }
}

/**
 * 打开「保存到列表 / 关闭并保存到列表」的清单。
 * 每次打开都重新取一次列表：侧边栏与其它入口（管理页 / 右键菜单）共用同一份存储，
 * 缓存一份列表很容易让用户看到已经删掉的列表。
 *
 * 用 `getListSummaries` 而不是 `getLists`：清单只需要列表名与条目数，
 * 而 favicon 去重后 `getLists` 会把 iconKey 重新展开成完整（可能数 MB）的 base64。
 *
 * @param {"save"|"saveClose"} mode 两个按钮的唯一差别是保存后是否关闭标签
 */
async function openSaveMenu(mode) {
  if (selectedTabs.value.length === 0) {
    return;
  }
  saveMenu.mode = mode;
  saveMenu.lists = [];
  saveMenu.loading = true;
  saveMenu.creating = false;
  saveMenu.newListName = "";
  const response = await request("getListSummaries");
  // 等待期间用户可能已经关掉清单或点了另一个按钮，过期的结果直接丢弃。
  if (saveMenu.mode !== mode) {
    return;
  }
  saveMenu.loading = false;
  saveMenu.lists = response.ok && Array.isArray(response.summaries) ? response.summaries : [];
}

function startNewList() {
  saveMenu.creating = true;
  saveMenu.newListName = "";
}

/**
 * 执行保存：复用后台 saveTabs（与右键菜单、管理页同一条路径）。
 *
 * @param {{listId?: string, newListName?: string}} target 二选一
 */
async function runSaveSelected(target) {
  const list = selectedTabs.value;
  if (list.length === 0 || !saveMenu.mode) {
    closeSaveMenu();
    return;
  }
  const closeTabs = saveMenu.mode === "saveClose";
  const response = await request("saveTabs", {
    tabIds: list.map((tab) => tab.id),
    listId: target.listId || "",
    newListName: target.newListName || "",
    closeTabs,
  });
  if (!response.ok) {
    setStatus(response.error || "保存失败。", "error");
    return;
  }
  const savedCount = response.result ? Number(response.result.savedCount) || 0 : list.length;
  setStatus(
    closeTabs ? `已保存并关闭 ${savedCount} 个标签页。` : `已保存 ${savedCount} 个标签页。`,
    "ok"
  );
  closeSaveMenu();
  // 保存并关闭的情况下标签会消失，靠防抖刷新把列表与选中集合一起对齐。
  scheduleRefresh();
}

async function saveSelectedToList(listId) {
  await runSaveSelected({ listId });
}

async function confirmNewList() {
  const name = String(saveMenu.newListName || "").trim();
  if (!name) {
    setStatus("请输入列表名称。", "error");
    return;
  }
  await runSaveSelected({ newListName: name });
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

/**
 * 执行一次 chrome.tabs.query。
 *
 * @returns {Promise<Array|null>} 查询失败（lastError/返回非数组）时返回 null，
 *   调用方据此走降级分支，而不是把"查不到"当成"没有"。
 */
function queryTabsOnce(queryInfo) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query(queryInfo, (list) => {
        // lastError 必须在回调里立刻读掉：否则控制台会留下 Unchecked runtime.lastError 警告。
        resolve(chrome.runtime.lastError || !Array.isArray(list) ? null : list);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

/**
 * 找到已经打开的管理页标签。
 *
 * 为什么用两个精确 URL 查询而不是 `query({})` 再前缀过滤：`query({})` 会把所有窗口的所有标签
 * （10K 标签下是几 MB 的整表序列化）拉过进程边界，而这里只需要知道"管理页在不在"。
 * 管理页只会以两种形态存在：编辑器里的 `ui/manager.html`，以及带 `?mode=overlay` 的浮层形态；
 * chrome.tabs.query 的 url 匹配是前缀语义（`url: "x"` 能匹配 `x?query`），因此 `url` 那一次
 * 已经覆盖了不带参数的常见情况，两次都查不到才认为没有。
 * 网页中嵌入的浮层是 iframe 而非标签页，不会出现在查询结果里。
 *
 * @returns {Promise<{existing: object|null, ok: boolean}>} ok=false 表示查询本身失败（需要降级）。
 */
async function findManagerTab(url) {
  const withParam = await queryTabsOnce({ url: `${url}?mode=overlay` });
  if (withParam === null) {
    return { existing: null, ok: false };
  }
  if (withParam.length > 0) {
    return { existing: withParam[0], ok: true };
  }
  const plain = await queryTabsOnce({ url });
  if (plain === null) {
    return { existing: null, ok: false };
  }
  return { existing: plain.length > 0 ? plain[0] : null, ok: true };
}

/**
 * 打开管理页：优先复用已经开着的那个标签页，没有才新建，并且新建时把它固定（pinned）在最左。
 *
 * 为什么要"像 pinned 一样"：管理页是常驻工具，用户会反复点进来。无条件新建会让它越堆越多，
 * 而普通标签又会被网页标签挤到标签栏深处；pinned 化后它永远占着最左一格，点一下就回到原页面。
 *
 * 查询策略见 findManagerTab：两次精确 URL 查询替代一次全量查询，10K 标签下差别明显。
 */
async function openManager() {
  const url = chrome.runtime.getURL(MANAGER_PAGE);
  const { existing, ok } = await findManagerTab(url);
  if (existing && Number.isFinite(Number(existing.id))) {
    // 顺序与扩展图标点击一致：先聚焦窗口、再激活标签。
    // 只 activate 不 focus 的话，切换发生在未聚焦的窗口里，用户根本看不到。
    const targetWindowId = Number(existing.windowId);
    if (Number.isFinite(targetWindowId)) {
      chrome.windows.update(targetWindowId, { focused: true }, () => {
        // 读掉 lastError：窗口可能刚好被用户关掉，此时不值得打断操作。
        void chrome.runtime.lastError;
      });
    }
    chrome.tabs.update(Number(existing.id), { active: true }, () => {
      void chrome.runtime.lastError;
    });
    return;
  }

  // 注意不能直接 Number(windowId.value)：Number(null) 是 0，会被当成"合法的窗口 0"而漏掉降级分支。
  const hostWindowId =
    windowId.value === null || windowId.value === undefined ? Number.NaN : Number(windowId.value);
  // 拿不到宿主窗口、或查询失败时降级成普通新建：
  // 宁可固定位置不理想，也不能因为一次异步失败就丢功能或抛错。
  if (!ok || !Number.isFinite(hostWindowId)) {
    chrome.tabs.create({ url });
    return;
  }

  // 只查宿主窗口的固定标签，而不是全量标签：同样是为了避免 10K 标签的整表序列化。
  const pinnedTabs = await queryTabsOnce({ windowId: hostWindowId, pinned: true });
  // 查询失败时按"没有固定标签"处理，落到 index: 0 分支；最坏情况是插到已有固定标签之后，不影响可用性。
  const hasPinned = Array.isArray(pinnedTabs) && pinnedTabs.length > 0;

  // 已有固定标签时**不能**指定 index：Chromium/Firefox 会把新 pinned 标签插到最后一个 pinned 之后，
  // 那正是用户自己排好的固定区末尾，硬塞 index:0 会打断他已有的排列。
  // 而一个固定标签都没有时，浏览器把新 pinned 标签追加到"最后一个 pinned 之后"，等价于当前标签之后，
  // 看上去完全没被固定，因此必须显式 index: 0 才能落到最左侧。
  const options = hasPinned ? { url, pinned: true } : { url, index: 0, pinned: true };
  chrome.tabs.create(options, () => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message || "打开管理界面失败。", "error");
      return;
    }
    setStatus("", "");
  });
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
// 外部拖放（网页里拖过来的链接 / 选中文本）
// ---------------------------------------------------------------------------

/** 某个标签在本窗口树里的父标签 id（顶层为 null）。 */
function parentIdOf(tabId) {
  const parents = tree.parentsFor(windowId.value);
  const raw = parents[String(tabId)];
  return raw === undefined || raw === null ? null : raw;
}

/** 把外部数据解析成"后台能执行的布局意图"，并交给后台。 */
async function runExternalDrop(item, layout, targetWindowId) {
  const response = await request("openDroppedItem", {
    windowId: targetWindowId === null || targetWindowId === undefined ? windowId.value : targetWindowId,
    ...layout,
    url: item.kind === "url" ? item.value : "",
    query: item.kind === "query" ? item.value : "",
  });
  if (!response.ok) {
    setStatus(response.error || "拖放打开失败。", "error");
    return;
  }
  setStatus(item.kind === "query" ? "已在默认搜索引擎中搜索。" : "已打开拖放的内容。", "ok");
  // 结构变化会由 onCreated / onAttached 触发防抖刷新；这里再排一次，让层级立刻可见。
  scheduleRefresh();
}

/** 从拖拽数据里取第一条可用内容；取不到时给出提示并返回 null。 */
function readDroppedItem(dataTransfer) {
  const item = parseDroppedItem(dataTransfer);
  if (!item) {
    setStatus("拖放的内容无法识别或不被允许。", "error");
    return null;
  }
  return item;
}

/** 这次拖拽是否带着文件（当前版本不支持，但要吞掉默认行为，避免面板被导航）。 */
function hasDroppedFiles(dataTransfer) {
  return Boolean(dataTransfer && dataTransfer.files && dataTransfer.files.length > 0);
}

/**
 * 外部内容落在树区域的某一行上。
 * - 行上/下 1/4 → 在目标行前后插入（层级与内部拖拽同一口径）；
 * - 行中间 1/2 → 覆盖目标标签。
 */
async function onTreeExternalDrop({ tab, zone, dataTransfer }) {
  const item = readDroppedItem(dataTransfer);
  if (!item) {
    return;
  }
  const layout = buildTreeDropPayload(tab.id, parentIdOf(tab.id), zone);
  await runExternalDrop(item, layout, tab.windowId);
}

/** 外部内容落在固定标签区的某个图标上：两侧 1/4 新建固定标签，中间覆盖。 */
async function onPinnedExternalDrop({ tab, group, position, dataTransfer }) {
  const item = readDroppedItem(dataTransfer);
  if (!item) {
    return;
  }
  const layout = buildPinnedDropPayload(
    { tabId: tab.id, windowId: group.windowId, isCurrentWindow: group.isCurrent },
    position
  );
  if (!layout) {
    setStatus("固定标签区的插入只支持本窗口，已忽略。", "error");
    return;
  }
  await runExternalDrop(item, layout, group.windowId);
}

/** 外部内容落在列表下方空白处：追加到最后一个可见行之后（没有可见行则建为顶层）。 */
async function onBlankExternalDrop(dataTransfer) {
  const item = readDroppedItem(dataTransfer);
  if (!item) {
    return;
  }
  const list = items.value;
  const last = list.length > 0 ? list[list.length - 1] : null;
  const layout = last
    ? buildAppendDropPayload(last.tab.id, parentIdOf(last.tab.id))
    : buildAppendDropPayload(null, null);
  await runExternalDrop(item, layout, windowId.value);
}

/** 侧边栏任意位置的外部拖拽都要 preventDefault：否则 Firefox 可能把面板当成导航目标。 */
function onRootDragOver(event) {
  const dataTransfer = event.dataTransfer;
  if (isExternalDropData(dataTransfer) || hasDroppedFiles(dataTransfer)) {
    event.preventDefault();
  }
}

/**
 * 根节点兜底处理"没有落在行/图标上"的外部拖放。
 * 行与固定标签图标有各自的处理器（冒泡到这里时按 DOM 判断跳过，避免重复处理）。
 */
async function onRootDrop(event) {
  const dataTransfer = event.dataTransfer;
  const external = isExternalDropData(dataTransfer);
  const files = hasDroppedFiles(dataTransfer);
  if (!external && !files) {
    return;
  }
  // 无论落在哪里都先吞掉默认行为：侧边栏面板不能因为一次拖放被导航走。
  event.preventDefault();
  if (!external) {
    // 纯文件拖放当前不支持（见文档「已知限制」）：静默忽略，只吞掉默认行为。
    return;
  }
  const target = event.target;
  const closest =
    target && typeof target.closest === "function"
      ? (selector) => target.closest(selector)
      : () => null;
  // 行与图标自己的处理器已经处理过这次 drop。
  if (closest(".sb-row") || closest(".sb-pin")) {
    return;
  }
  // 固定标签区的空白与分隔条、工具栏、底部按钮都不是落点。
  if (closest(".sb-pinned") || closest(".sb-toolbar") || closest(".sb-newtab-bar")) {
    return;
  }
  await onBlankExternalDrop(dataTransfer);
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
 * 把当前选中项推给后台，供原生标签右键菜单的「复制标题 / 复制链接」输出多行。
 *
 * 顺序按**界面显示顺序**：固定标签区在前、树区域在后（树区域用 `items` 的 DFS 渲染顺序，
 * 过滤模式下天然只含可见行）。未选中任何项时推空数组——**必须推**，否则后台会一直留着上一次的暂存，
 * 把一次单标签复制变成多行。
 *
 * 为什么这里不 await：`menus.overrideContext` 必须在 contextmenu 事件的同步调用栈里执行，
 * 一旦 await 就可能错过这次弹出。消息本身是异步投递的，而用户点菜单项至少在数百毫秒之后，
 * 后台在点击之前一定已经处理完这条消息（后台收到后只做一次内存写入）。
 */
function pushCopySelection() {
  const entries = [];
  const pushTab = (tab) => {
    if (!tab || tab.id === undefined || tab.id === null) {
      return;
    }
    entries.push({ title: tab.title || "", url: tab.url || "" });
  };
  if (multiSelect.value && selectedCount.value > 0) {
    pinnedGroups.value.forEach((group) => {
      group.tabs.forEach((tab) => {
        if (selectedTabIds[String(tab.id)]) {
          pushTab(tab);
        }
      });
    });
    items.value.forEach((item) => {
      if (selectedTabIds[item.id]) {
        pushTab(item.tab);
      }
    });
  }
  request("setCopySelection", { items: entries });
}

/**
 * 右键某个标签：把上下文交给 Firefox 的原生标签菜单。
 *
 * menus.overrideContext({ context: "tab", tabId }) 的语义是**隐藏所有默认 Firefox 菜单项**，
 * 只渲染「本扩展 + 其它扩展注册到 tab 上下文的项」——也就是说它提供的是原生菜单**外壳**
 * （原生外观、键盘导航、自动合并其它扩展的项），菜单**内容**由后台注册的那些项提供。
 * 因此这里只覆盖上下文，绝不 preventDefault：让 Firefox 自己把菜单弹出来。
 *
 * 多选模式下的多行复制依赖"弹出前把选中集合推给后台"，见 pushCopySelection。
 */
function openTabContextMenu(tab) {
  if (!tab || !Number.isFinite(Number(tab.id))) {
    return;
  }
  pushCopySelection();
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
  bindTabStateEvents();
  bindTreeStructureEvents();
  document.addEventListener("visibilitychange", onVisibilityChange);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));
  // 保存清单打开时用 Escape 关闭（清单盖住整个列表，必须给一个键盘出口）。
  document.addEventListener("keydown", onSaveMenuKeydown);
  cleanups.push(() => document.removeEventListener("keydown", onSaveMenuKeydown));
});

onBeforeUnmount(() => {
  for (const source of ["physical", "rows", "visibleRows"]) {
    diagnostics.gap({ windowId: windowId.value, source, reason: "unmounted" });
  }
  void diagnostics.flush();
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
  <div
    class="sb-app"
    @dragover="onRootDragOver"
    @drop="onRootDrop"
  >
    <div v-if="diagnosticState.enabled && (diagnosticState.status.incidentCount || diagnosticState.status.persistError || diagnosticState.status.restoreError || diagnosticState.status.transportError)"
      class="sb-diagnostic-notice" role="status">
      <span>树诊断：{{ diagnosticState.status.incidentCount || 0 }} 条异常记录<span v-if="diagnosticState.status.activeCount">（{{ diagnosticState.status.activeCount }} 条待确认）</span><span v-if="diagnosticState.status.persistError || diagnosticState.status.restoreError || diagnosticState.status.transportError"> · 记录不完整</span></span>
      <button type="button" @click="copyDiagnosticLog">复制日志</button>
    </div>
    <div class="sb-toolbar">
      <FilterInput
        :model-value="filter.query.value"
        placeholder="筛选标题或网址"
        @update:model-value="filter.update"
        @commit="filter.commit"
        @next="goToNextMatch"
        @prev="goToPrevMatch"
      />
      <div class="sb-toolbar-row">
        <div class="sb-mode">
          <button
            type="button"
            :class="{ active: filter.mode.value === 'filter' }"
            title="过滤：只显示匹配项及其祖先"
            @click="setFilterMode('filter')"
          >
            过滤
          </button>
          <button
            type="button"
            :class="{ active: filter.mode.value === 'jump' }"
            title="跳转：保持完整树，在匹配项之间跳转"
            @click="setFilterMode('jump')"
          >
            跳转
          </button>
        </div>
        <span v-if="isJumpMode" class="sb-match-nav">
          <button type="button" title="上一个匹配（Shift+Enter）" @click="goToPrevMatch">↑</button>
          <span class="sb-match-count">{{ matchLabel }}</span>
          <button type="button" title="下一个匹配（Enter）" @click="goToNextMatch">↓</button>
        </span>
        <span class="sb-spacer"></span>
        <button type="button" class="sb-tool" title="在当前标签页下新建（工具栏入口）" @click="createTab">＋</button>
        <button
          type="button"
          class="sb-tool"
          title="定位到当前标签页所在的行"
          @click="locateActiveTab"
        >
          定位
        </button>
        <button
          type="button"
          class="sb-tool"
          :class="{ active: multiSelect }"
          :title="multiSelect ? '退出多选模式（点击行不再跳转）' : '多选模式：点击标签页为选中，便于批量管理（也可直接 Shift+点击圈选）'"
          @click="toggleMultiSelect"
        >
          多选
        </button>
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
        :multi-select="multiSelect"
        :selected-map="selectedTabIds"
        @activate="activateTab"
        @select="onPinnedSelect"
        @close="closeTab"
        @context-menu="openTabContextMenu"
        @reorder="onPinnedReorder"
        @external-drop="onPinnedExternalDrop"
      />
      <SidebarTabTree
        v-if="items.length > 0"
        ref="treeRef"
        :items="items"
        :active-row="activeRow"
        :multi-select="multiSelect"
        :selected-map="selectedTabIds"
        :highlight-matches="highlightMatches"
        :current-match-index="currentMatchIndex"
        :is-tree-descendant="isTreeDescendant"
        @activate="activateTab"
        @select="onTreeSelect"
        @close="closeTab"
        @discard="discardTab"
        @toggle-mute="toggleMute"
        @toggle-collapse="toggleCollapse"
        @tree-drop="onTreeDrop"
        @external-drop="onTreeExternalDrop"
        @context-menu="openTabContextMenu"
        @marker-click="onMarkerClick"
        @visible-range="onVisibleRange"
      />
      <div v-else class="sb-empty">{{ treeEmptyText }}</div>
    </template>

    <!--
      多选模式的批量操作条：位于底部「新建标签页」之上、滚动容器之外，
      因此列表再长也不会把它顶出视野（与底部新建按钮同一套布局约束）。
    -->
    <div v-if="multiSelect" class="sb-bulk">
      <div class="sb-bulk-row">
        <span class="sb-bulk-count">已选 {{ selectedCount }} 项</span>
        <span class="sb-spacer"></span>
        <button
          type="button"
          class="sb-bulk-link"
          :disabled="selectedCount === 0"
          @click="clearSidebarSelection"
        >
          取消选择
        </button>
      </div>
      <div class="sb-bulk-row actions">
        <button
          type="button"
          class="sb-bulk-btn danger"
          :disabled="selectedCount === 0"
          @click="closeSelectedTabs"
        >
          关闭所选
        </button>
        <button
          type="button"
          class="sb-bulk-btn"
          :disabled="selectedCount === 0"
          @click="discardSelectedTabs"
        >
          冻结所选
        </button>
        <button
          type="button"
          class="sb-bulk-btn"
          :disabled="selectedCount === 0"
          @click="openSaveMenu('save')"
        >
          保存到列表
        </button>
        <button
          type="button"
          class="sb-bulk-btn"
          :disabled="selectedCount === 0"
          @click="openSaveMenu('saveClose')"
        >
          关闭并保存
        </button>
      </div>

      <!--
        保存清单：与右键菜单同构（列出全部列表，点某一项即执行），末尾多一项「新建列表…」。
        用透明遮罩承接"点击别处关闭"，避免在窄侧边栏里还要找关闭按钮。
      -->
      <template v-if="saveMenu.mode">
        <div class="sb-save-backdrop" @click="closeSaveMenu"></div>
        <div class="sb-save-menu">
          <div class="sb-save-title">
            {{ saveMenu.mode === "saveClose" ? "关闭并保存到列表" : "保存到列表" }}
          </div>
          <div v-if="saveMenu.loading" class="sb-save-empty">正在载入列表…</div>
          <template v-else>
            <div v-if="saveMenu.lists.length === 0" class="sb-save-empty">暂无列表</div>
            <button
              v-for="list in saveMenu.lists"
              :key="list.id"
              type="button"
              class="sb-save-item"
              @click="saveSelectedToList(list.id)"
            >
              {{ list.name }}（{{ list.count }}）
            </button>
            <div v-if="saveMenu.creating" class="sb-save-new">
              <input
                v-model="saveMenu.newListName"
                type="text"
                placeholder="列表名称"
                @keydown.enter="confirmNewList"
              />
              <button type="button" class="sb-save-item confirm" @click="confirmNewList">确定</button>
              <button type="button" class="sb-save-item" @click="saveMenu.creating = false">取消</button>
            </div>
            <button v-else type="button" class="sb-save-item new" @click="startNewList">
              新建列表…
            </button>
          </template>
        </div>
      </template>
    </div>

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
