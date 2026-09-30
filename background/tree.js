// 树状结构的后台集成层。
//
// 职责划分：
// - 本文件只负责"与浏览器打交道"的部分：事件监听、按窗口懒加载、内存树缓存、
//   空闲防抖落盘、以及管理页的读写消息；
// - 真正的算法（建树、快照对齐、关闭提升、位置推断、扁平化）全部在 tree_core.js，
//   那里是纯函数，既能被基准脚本直接复用，也便于单独推理。
//
// 三条硬性约束（对应需求）：
// 1. 面向 10K 级标签页：不维护全局下标、不做逐事件的 O(n) 重排，所有热点都是 O(1) 或按需 O(n)；
// 2. 持久化但控制写入量：结构变化只改内存并置脏，空闲若干秒后只覆盖"变化的窗口"；
// 3. 不拖慢浏览器初始化：启动/会话恢复期进入静默期，不加载快照、不对齐、不写盘。

import {
  TREE_FLUSH_ALARM,
  TREE_INDEX_KEY,
  TREE_KEY_PREFIX,
} from "./constants.js";
import { storageGet, storageRemove, storageSet } from "./storage.js";
import { delay } from "./utils.js";
import {
  alignSnapshotToTabs,
  applyRemovePromotion,
  buildChildIndex,
  collectSubtreeIds,
  dropTab,
  encodeSnapshot,
  inferParentFromNewPosition,
  setParent,
  sanitizeTreeState,
  toParentsPayload,
  validateNewParent,
} from "./tree_core.js";

// ---------------------------------------------------------------------------
// 调参常量
// ---------------------------------------------------------------------------

// 结构稳定多久之后落盘。5 秒远小于 SW 的 30 秒空闲回收，因此正常使用不会丢写入。
const FLUSH_IDLE_MS = 5000;
// 批量操作（一次关掉几百个标签）期间会持续置脏，此时延长等待，避免边操作边写盘。
const FLUSH_BURST_IDLE_MS = 15000;
const FLUSH_BURST_CHANGES = 200;
// 兜底闹钟：只在有脏数据时创建，周期 5 分钟，防止 SW 被回收导致定时器丢失。
const FLUSH_ALARM_MINUTES = 5;
// 启动静默期：连续多久没有结构事件算恢复完成；以及最长宽限。
const STARTUP_QUIET_MS = 10000;
const STARTUP_MAX_GRACE_MS = 60000;
// 冷启动后这段时间内若出现结构事件风暴，也判定为"正在恢复会话"。
const STARTUP_BURST_WINDOW_MS = 5000;
const STARTUP_BURST_THRESHOLD = 20;
// 单窗口快照的上限，超出则降级为不写标题。
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
// 跨窗口迁移与拖拽移动的分批大小与间隔。
const MOVE_BATCH_SIZE = 100;
const MOVE_BATCH_GAP_MS = 50;
// 插件自身发起的 move 在多久内忽略对应的 onMoved 事件（事件是异步派发的）。
const INTERNAL_MOVE_TTL_MS = 2000;

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

// windowId -> { windowId, parentById, childIdsById }
const trees = new Map();
// 正在加载中的窗口，避免同一窗口被并发重复对齐。
const loadingTrees = new Map();
// 启动静默期内观察到结构变化的窗口，静默期结束后统一重建。
const pendingWindows = new Set();
// 等待延迟加载的窗口（把短时间内的多次创建合并成一次 O(n) 对齐）。
const pendingWindowsForEnsure = [];
// 需要落盘的窗口。
const dirtyWindows = new Set();
// windowId -> 最近一次活动标签，用于"无 opener 的新标签挂到当前标签下"。
const activeTabByWindow = new Map();
// 插件自身发起的 move：这些 tabId 的 onMoved 事件必须忽略，否则会把刚设好的父子关系又推断回去。
const internalMoveIds = new Set();
// tabId -> { fromWindowId, parents: Map<tabId, parentId|null> }
// 跨窗口迁移时，Chrome 只会移动被拖的那一个标签，子树需要我们自己搬，父子关系也要自己保留。
const migratingSubtrees = new Map();
// treeStructureWindows 索引的内存副本。
let indexCache = null;

let startupActive = false;
let startupQuietTimer = null;
let startupMaxTimer = null;
let ensureTimer = null;
let flushTimer = null;
let flushAlarmActive = false;
let changesSinceFlush = 0;
let flushInProgress = false;
const moduleStartedAt = Date.now();
let recentStructuralEvents = [];

// ---------------------------------------------------------------------------
// 对外初始化
// ---------------------------------------------------------------------------

/**
 * 初始化树系统。
 *
 * @param {{forceStartup?: boolean}} options forceStartup 为 true 表示"浏览器刚启动/刚安装"，
 *   此时进入启动静默期：会话恢复期间会产生上万次 tabs 事件，若逐个处理会退化成 O(n²) 并对磁盘
 *   产生大量写入。静默期内只记录"哪些窗口变了"，等恢复结束再统一重建一次。
 */
export function initializeTreeSystem(options = {}) {
  if (options.forceStartup) {
    enterStartupPhase();
  }
}

/** 浏览器启动/安装：进入启动静默期。 */
function enterStartupPhase() {
  startupActive = true;
  recentStructuralEvents = [];
  if (startupQuietTimer) {
    clearTimeout(startupQuietTimer);
  }
  if (startupMaxTimer) {
    clearTimeout(startupMaxTimer);
  }
  startupQuietTimer = setTimeout(finishStartupPhase, STARTUP_QUIET_MS);
  startupMaxTimer = setTimeout(finishStartupPhase, STARTUP_MAX_GRACE_MS);
}

/** 静默期内每来一个结构事件就把"安静计时"往后推，直到真正没有动静。 */
function touchStartupQuiet() {
  if (!startupActive) {
    return;
  }
  if (startupQuietTimer) {
    clearTimeout(startupQuietTimer);
  }
  startupQuietTimer = setTimeout(finishStartupPhase, STARTUP_QUIET_MS);
}

/** 记录一次结构事件，并对"冷启动时的事件风暴"做兜底判定。 */
function noteStructuralEvent() {
  if (startupActive) {
    touchStartupQuiet();
    return;
  }
  // 有些场景下 runtime.onStartup 可能晚于会话恢复的首批 tabs 事件，这里用事件密度兜底：
  // 仅限"SW 刚刚冷启动"的几秒内，避免正常使用中批量关闭标签被误判成恢复期。
  if (Date.now() - moduleStartedAt > STARTUP_BURST_WINDOW_MS) {
    return;
  }
  const now = Date.now();
  recentStructuralEvents.push(now);
  while (recentStructuralEvents.length > 0 && now - recentStructuralEvents[0] > STARTUP_BURST_WINDOW_MS) {
    recentStructuralEvents.shift();
  }
  if (recentStructuralEvents.length >= STARTUP_BURST_THRESHOLD) {
    enterStartupPhase();
  }
}

function finishStartupPhase() {
  startupActive = false;
  recentStructuralEvents = [];
  if (startupQuietTimer) {
    clearTimeout(startupQuietTimer);
    startupQuietTimer = null;
  }
  if (startupMaxTimer) {
    clearTimeout(startupMaxTimer);
    startupMaxTimer = null;
  }
  const windowIds = [...pendingWindows];
  pendingWindows.clear();
  if (windowIds.length > 0) {
    scheduleEnsureTrees(windowIds);
  }
}

// ---------------------------------------------------------------------------
// 树加载与缓存
// ---------------------------------------------------------------------------

/**
 * 确保某窗口的树已加载。首次调用会读取快照并与当前标签对齐（O(n log n)），之后直接命中缓存。
 * 使用场景：管理页请求树数据、任一需要知道父子关系的事件。
 */
async function ensureTree(windowId) {
  const cached = trees.get(windowId);
  if (cached) {
    return cached;
  }
  if (loadingTrees.has(windowId)) {
    return loadingTrees.get(windowId);
  }
  const promise = loadTree(windowId)
    .catch((error) => {
      console.warn("树结构加载失败：", String(error && error.message ? error.message : error));
      return null;
    })
    .finally(() => {
      loadingTrees.delete(windowId);
    });
  loadingTrees.set(windowId, promise);
  return promise;
}

async function loadTree(windowId) {
  const tabs = await queryWindowTabs(windowId);
  const snapshot = await storageGet(`${TREE_KEY_PREFIX}${windowId}`);
  const result = alignSnapshotToTabs(tabs, snapshot || null);
  const state = {
    windowId,
    parentById: result.state.parentById,
    childIdsById: result.state.childIdsById,
    // tabId -> 物理下标。只用于两件事：promote intelligently 里判断"第一个子标签"，
    // 以及拖拽时找"父标签整棵子树的末尾"。除此之外不参与任何决策。
    indexById: new Map(),
  };
  rebuildIndexes(state, tabs);
  trees.set(windowId, state);
  if (!result.exact) {
    // 快照与实际不一致（首次使用、或恢复后结构有变化）：需要回写一次纠正后的结构。
    markDirty(windowId);
  }
  return state;
}

/** 用一次实际的标签序列重建下标表。 */
function rebuildIndexes(tree, tabs) {
  const indexById = new Map();
  for (let i = 0; i < tabs.length; i += 1) {
    indexById.set(Number(tabs[i].id), i);
  }
  tree.indexById = indexById;
}

/** 新标签插入后，其后所有标签的下标整体 +1。 */
function shiftIndexesForInsert(tree, atIndex) {
  if (!tree.indexById || !Number.isFinite(atIndex)) {
    return;
  }
  for (const [id, value] of tree.indexById) {
    if (value >= atIndex) {
      tree.indexById.set(id, value + 1);
    }
  }
}

/** 标签在窗口内移动后同步下标表。 */
function applyIndexMove(tree, tabId, fromIndex, toIndex) {
  if (!tree.indexById || !Number.isFinite(fromIndex) || !Number.isFinite(toIndex)) {
    return;
  }
  for (const [id, value] of tree.indexById) {
    if (id === tabId) {
      continue;
    }
    if (fromIndex < toIndex && value > fromIndex && value <= toIndex) {
      tree.indexById.set(id, value - 1);
    } else if (toIndex < fromIndex && value >= toIndex && value < fromIndex) {
      tree.indexById.set(id, value + 1);
    }
  }
  tree.indexById.set(tabId, toIndex);
}

/**
 * 把某个父标签的子标签按物理顺序排好。
 * childIdsById 平时是"挂载顺序"，对判断"第一个子标签"来说不够确定（拖拽挂载的标签会排到末尾），
 * 因此凡是需要"第一个/最后一个"的地方都先按物理下标注排序。
 */
function sortChildrenByIndex(tree, parentId) {
  const children = tree.childIdsById.get(parentId);
  if (!children || children.length < 2) {
    return children || null;
  }
  const indexById = tree.indexById || new Map();
  children.sort((a, b) => (indexById.get(a) || 0) - (indexById.get(b) || 0));
  return children;
}

/** 延迟批量加载：避免一次创建几十个标签时反复触发对齐。 */
function scheduleEnsureTrees(windowIds) {
  pendingWindowsForEnsure.push(...windowIds);
  if (ensureTimer) {
    clearTimeout(ensureTimer);
  }
  ensureTimer = setTimeout(async () => {
    ensureTimer = null;
    const unique = [...new Set(pendingWindowsForEnsure)];
    pendingWindowsForEnsure.length = 0;
    for (const windowId of unique) {
      await ensureTree(windowId);
    }
  }, 500);
}

function forgetWindow(windowId) {
  trees.delete(windowId);
  loadingTrees.delete(windowId);
  pendingWindows.delete(windowId);
  dirtyWindows.delete(windowId);
  activeTabByWindow.delete(windowId);
}

/** 读取窗口内所有标签并按 index 升序排列。 */
function queryWindowTabs(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.query({ windowId }, (tabs) => {
      const list = Array.isArray(tabs) ? tabs.slice() : [];
      list.sort((a, b) => (a.index || 0) - (b.index || 0));
      resolve(list);
    });
  });
}

/** 按 index 精确取一个标签。用 query 的 index 过滤，避免为此维护整窗下标表。 */
function queryTabAtIndex(windowId, index) {
  if (!Number.isFinite(index) || index < 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    chrome.tabs.query({ windowId, index }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function getTabById(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      resolve(chrome.runtime.lastError ? null : tab || null);
    });
  });
}

// ---------------------------------------------------------------------------
// tabs 事件
// ---------------------------------------------------------------------------

/**
 * 标签刚创建：确定它的初始父标签。
 * 只有这一刻 openerTabId 参与决策；之后父子关系由本插件自己的树数据决定，不再跟随 opener 变化。
 */
export async function handleTreeTabCreated(tab) {
  if (!tab || !Number.isFinite(Number(tab.windowId)) || !Number.isFinite(Number(tab.id))) {
    return;
  }
  const windowId = Number(tab.windowId);
  noteStructuralEvent();
  if (startupActive) {
    pendingWindows.add(windowId);
    return;
  }
  const tree = trees.get(windowId);
  if (!tree) {
    // 树还没加载：推迟到稍后统一对齐，避免一次开很多标签时反复做 O(n) 对齐。
    scheduleEnsureTrees([windowId]);
    return;
  }
  const parentId = await pickParentForNewTab(tree, tab);
  if (parentId != null) {
    setParent(tree, Number(tab.id), parentId);
  } else if (!tree.parentById.has(Number(tab.id))) {
    tree.parentById.set(Number(tab.id), null);
  }
  const atIndex = Number(tab.index);
  if (Number.isFinite(atIndex)) {
    shiftIndexesForInsert(tree, atIndex);
    tree.indexById.set(Number(tab.id), atIndex);
  }
  markDirty(windowId);
}

/**
 * 为新标签挑选父标签。
 * 优先级：合法 opener → 创建时刻的活动标签（对应 TST 的"新标签页命令 open as child"）→ 顶层。
 * 固定标签永远是顶层。
 */
async function pickParentForNewTab(tree, tab) {
  const tabId = Number(tab.id);
  if (tab.pinned) {
    return null;
  }
  const openerId = Number(tab.openerTabId);
  if (Number.isFinite(openerId) && openerId !== tabId && tree.parentById.has(openerId)) {
    return openerId;
  }
  const windowId = tree.windowId;
  let activeId = activeTabByWindow.has(windowId) ? activeTabByWindow.get(windowId) : undefined;
  if (activeId === undefined) {
    const active = await new Promise((resolve) => {
      chrome.tabs.query({ windowId, active: true }, (tabs) => resolve(tabs && tabs[0] ? tabs[0].id : null));
    });
    activeId = active;
    activeTabByWindow.set(windowId, active);
  }
  if (Number.isFinite(activeId) && activeId !== tabId && tree.parentById.has(activeId)) {
    return activeId;
  }
  return null;
}

/**
 * 标签被关闭：按 promote intelligently 修正树。
 * 整窗关闭时直接丢弃该窗口的树与快照。
 */
export function handleTreeTabRemoved(tabId, removeInfo = {}) {
  const windowId = Number(removeInfo.windowId);
  if (removeInfo.isWindowClosing) {
    if (Number.isFinite(windowId)) {
      forgetWindow(windowId);
      forgetWindowSnapshot(windowId);
    }
    return;
  }
  noteStructuralEvent();
  if (!Number.isFinite(windowId)) {
    return;
  }
  if (startupActive) {
    pendingWindows.add(windowId);
    return;
  }
  const tree = trees.get(windowId);
  if (!tree) {
    return;
  }
  tree.indexById.delete(Number(tabId));
  // 提升"第一个子标签"前先按物理顺序排序，保证结果确定且符合直觉。
  sortChildrenByIndex(tree, Number(tabId));
  applyRemovePromotion(tree, Number(tabId));
  markDirty(windowId);
}

/**
 * 用户在浏览器原生标签栏拖动了标签：按新位置的邻居重新推断父标签（移植自 TST）。
 * 注意这里**不会**回滚物理位置——插件不为"子树物理连续"擅自改动用户的标签栏。
 */
export async function handleTreeTabMoved(tabId, moveInfo = {}) {
  if (internalMoveIds.has(Number(tabId))) {
    return;
  }
  const windowId = Number(moveInfo.windowId);
  if (!Number.isFinite(windowId)) {
    return;
  }
  noteStructuralEvent();
  if (startupActive) {
    pendingWindows.add(windowId);
    return;
  }
  const tree = trees.get(windowId);
  if (!tree) {
    scheduleEnsureTrees([windowId]);
    return;
  }
  const toIndex = Number(moveInfo.toIndex);
  const fromIndex = Number(moveInfo.fromIndex);
  // 位置变了就要同步下标表（哪怕父子关系最终不变）。
  applyIndexMove(tree, Number(tabId), fromIndex, toIndex);
  const [prevTab, nextTab] = await Promise.all([
    queryTabAtIndex(windowId, toIndex - 1),
    queryTabAtIndex(windowId, toIndex + 1),
  ]);
  const result = inferParentFromNewPosition({
    toIndex,
    fromIndex,
    prevTabId: prevTab ? Number(prevTab.id) : null,
    nextTabId: nextTab ? Number(nextTab.id) : null,
    movedTabId: Number(tabId),
    state: tree,
    depthCache: new Map(),
  });
  if (result.invalid || result.unchanged) {
    return;
  }
  setParent(tree, Number(tabId), result.parentId);
  markDirty(windowId);
}

/**
 * 标签离开窗口（跨窗口拖拽或"移动到窗口"）。
 * Chrome 只会移动被拖的那一个标签，因此这里先记录下整棵子树的父子关系，再把它从原窗口树上摘除；
 * 真正的物理搬运放到 onAttached 里进行（那时才知道目标窗口）。
 */
export function handleTreeTabDetached(tabId, detachInfo = {}) {
  const id = Number(tabId);
  if (internalMoveIds.has(id)) {
    return;
  }
  const windowId = Number(detachInfo.oldWindowId);
  if (!Number.isFinite(windowId)) {
    return;
  }
  noteStructuralEvent();
  const tree = trees.get(windowId);
  if (!tree) {
    return;
  }
  const subtreeIds = collectSubtreeIds(tree, id);
  const parents = new Map();
  for (const subtreeId of subtreeIds) {
    parents.set(subtreeId, tree.parentById.has(subtreeId) ? tree.parentById.get(subtreeId) : null);
  }
  // 必须在删除下标之前算好顺序，否则搬过去的子树相对顺序会变成随机的。
  const orderedDescendantIds = orderIdsByIndex(tree, subtreeIds.filter((item) => item !== id));
  migratingSubtrees.set(id, { fromWindowId: windowId, parents, orderedDescendantIds });
  for (const subtreeId of subtreeIds) {
    dropTab(tree, subtreeId);
    tree.indexById.delete(subtreeId);
  }
  markDirty(windowId);
}

/**
 * 把跨窗口迁移的子树按原窗口的物理顺序排好。
 * collectSubtreeIds 只保证"包含正确的一组标签"，顺序是不确定的；若不排序，
 * 子树搬到新窗口后的相对顺序会随机变化，用户会看到标签莫名其妙地换了位置。
 */
function orderIdsByIndex(tree, ids) {
  const indexById = tree.indexById || new Map();
  return ids.slice().sort((a, b) => {
    const left = indexById.has(a) ? indexById.get(a) : Number.MAX_SAFE_INTEGER;
    const right = indexById.has(b) ? indexById.get(b) : Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

/**
 * 标签进入窗口：把之前记录下来的子树整体迁移过来，父子关系保持。
 * 被拖标签本身在新窗口的父标签按位置推断，推断不出则作为顶层。
 */
export async function handleTreeTabAttached(tabId, attachInfo = {}) {
  const id = Number(tabId);
  if (internalMoveIds.has(id)) {
    return;
  }
  const newWindowId = Number(attachInfo.newWindowId);
  if (!Number.isFinite(newWindowId)) {
    return;
  }
  noteStructuralEvent();
  const record = migratingSubtrees.get(id);
  migratingSubtrees.delete(id);
  const parents = record ? record.parents : new Map([[id, null]]);
  const descendantIds = record && Array.isArray(record.orderedDescendantIds)
    ? record.orderedDescendantIds
    : [...parents.keys()].filter((subtreeId) => subtreeId !== id);

  // 先把子树搬到目标窗口，否则后续的父子关系在浏览器看来是跨窗口的非法状态。
  if (descendantIds.length > 0) {
    const newPosition = Number(attachInfo.newPosition);
    await moveTabsInternally(
      descendantIds,
      newWindowId,
      Number.isFinite(newPosition) ? newPosition + 1 : -1
    );
  }

  if (startupActive) {
    pendingWindows.add(newWindowId);
    return;
  }
  const tree = await ensureTree(newWindowId);
  if (!tree) {
    return;
  }
  for (const [subtreeId, parentId] of parents) {
    if (subtreeId === id) {
      continue;
    }
    tree.parentById.set(subtreeId, parentId);
  }
  const newPosition = Number(attachInfo.newPosition);
  const inferred = await inferParentForAttachedTab(tree, id, newPosition);
  tree.parentById.set(id, inferred);
  tree.childIdsById = buildChildIndex(tree.parentById);
  // 子树是被分批搬过来的，逐个推算下标容易错，这里直接按实际标签重建一次（跨窗口本就很少发生）。
  rebuildIndexes(tree, await queryWindowTabs(newWindowId));
  markDirty(newWindowId);
}

async function inferParentForAttachedTab(tree, tabId, position) {
  const windowId = tree.windowId;
  const [prevTab, nextTab] = await Promise.all([
    queryTabAtIndex(windowId, position - 1),
    queryTabAtIndex(windowId, position + 1),
  ]);
  const result = inferParentFromNewPosition({
    toIndex: position,
    fromIndex: position,
    prevTabId: prevTab ? Number(prevTab.id) : null,
    nextTabId: nextTab ? Number(nextTab.id) : null,
    movedTabId: tabId,
    state: tree,
    depthCache: new Map(),
  });
  return result.invalid ? null : result.parentId;
}

export function handleTreeTabActivated(activeInfo = {}) {
  const windowId = Number(activeInfo.windowId);
  const tabId = Number(activeInfo.tabId);
  if (Number.isFinite(windowId) && Number.isFinite(tabId)) {
    activeTabByWindow.set(windowId, tabId);
  }
}

export function handleTreeWindowFocusChanged(windowId) {
  const id = Number(windowId);
  if (!Number.isFinite(id) || id < 0) {
    return;
  }
  // 焦点变化后活动标签可能已经变了，下次需要时重新查询。
  activeTabByWindow.delete(id);
}

export function handleTreeWindowRemoved(windowId) {
  const id = Number(windowId);
  if (!Number.isFinite(id)) {
    return;
  }
  forgetWindow(id);
  forgetWindowSnapshot(id);
}

export function handleTreeAlarm(alarm) {
  if (!alarm || alarm.name !== TREE_FLUSH_ALARM) {
    return;
  }
  flushDirtyWindows();
}

/** SW 即将被回收：尽力把脏数据写出去（不保证一定完成，但能覆盖绝大多数情况）。 */
export function handleTreeSuspend() {
  flushDirtyWindows();
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

function markDirty(windowId) {
  dirtyWindows.add(windowId);
  changesSinceFlush += 1;
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  // 批量操作期间变化次数会迅速堆高，此时延长等待，等操作停下来再一次性写。
  const idleMs = changesSinceFlush > FLUSH_BURST_CHANGES ? FLUSH_BURST_IDLE_MS : FLUSH_IDLE_MS;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDirtyWindows();
  }, idleMs);
  ensureFlushAlarm();
}

function ensureFlushAlarm() {
  if (flushAlarmActive) {
    return;
  }
  flushAlarmActive = true;
  chrome.alarms.create(TREE_FLUSH_ALARM, { periodInMinutes: FLUSH_ALARM_MINUTES });
}

function clearFlushAlarm() {
  if (!flushAlarmActive) {
    return;
  }
  flushAlarmActive = false;
  chrome.alarms.clear(TREE_FLUSH_ALARM);
}

/**
 * 把脏窗口逐个写成快照。
 * 只覆盖发生变化的窗口（按窗口分键），因此一次写入的成本与该窗口的标签数成正比，
 * 而不是所有窗口的总和。
 */
async function flushDirtyWindows() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushInProgress) {
    return;
  }
  if (dirtyWindows.size === 0) {
    changesSinceFlush = 0;
    clearFlushAlarm();
    return;
  }
  flushInProgress = true;
  const targets = [...dirtyWindows];
  dirtyWindows.clear();
  changesSinceFlush = 0;
  try {
    const index = await loadIndexCache();
    let indexChanged = false;
    for (const windowId of targets) {
      const tree = trees.get(windowId);
      if (!tree) {
        continue;
      }
      const tabs = await queryWindowTabs(windowId);
      if (tabs.length === 0) {
        if (index[windowId]) {
          delete index[windowId];
          await storageRemove(`${TREE_KEY_PREFIX}${windowId}`);
          indexChanged = true;
        }
        forgetWindow(windowId);
        continue;
      }
      // 落盘前统一做一次不变量校验，保证磁盘上的数据永远合法（父在子前、固定标签不参与父子）。
      const pinnedIds = new Set();
      const orderedIds = [];
      for (const tab of tabs) {
        orderedIds.push(Number(tab.id));
        if (tab.pinned) {
          pinnedIds.add(Number(tab.id));
        }
      }
      sanitizeTreeState(tree, orderedIds, pinnedIds);
      rebuildIndexes(tree, tabs);
      const result = encodeSnapshot(tabs, tree, { maxBytes: SNAPSHOT_MAX_BYTES });
      if (!result.payload) {
        console.warn(`树结构快照超出存储上限，已跳过写入：窗口 ${windowId}`);
        continue;
      }
      await storageSet({ [`${TREE_KEY_PREFIX}${windowId}`]: result.payload });
      index[windowId] = Date.now();
      indexChanged = true;
    }
    if (indexChanged) {
      indexCache = index;
      await storageSet({ [TREE_INDEX_KEY]: index });
    }
  } finally {
    flushInProgress = false;
    if (dirtyWindows.size > 0) {
      scheduleFlush();
    } else {
      clearFlushAlarm();
    }
  }
}

async function loadIndexCache() {
  if (indexCache) {
    return { ...indexCache };
  }
  const stored = await storageGet(TREE_INDEX_KEY);
  indexCache = stored && typeof stored === "object" ? { ...stored } : {};
  return { ...indexCache };
}

async function forgetWindowSnapshot(windowId) {
  const index = await loadIndexCache();
  if (!index[windowId]) {
    return;
  }
  delete index[windowId];
  indexCache = index;
  await storageSet({ [TREE_INDEX_KEY]: index });
  await storageRemove(`${TREE_KEY_PREFIX}${windowId}`);
}

// ---------------------------------------------------------------------------
// 消息接口
// ---------------------------------------------------------------------------

/**
 * 读取树结构（管理页渲染树状视图用）。
 * 只返回"有父标签"的条目，缺省即顶层——10K 标签下这样可以省掉约一半的载荷。
 * 深度、折叠等都在前端本地计算，避免为此增加 IPC 体积。
 *
 * @param {number[]|null} windowIds 为空表示全部窗口
 */
export async function getTreeStructure(windowIds = null) {
  const ids = Array.isArray(windowIds) && windowIds.length > 0
    ? [...new Set(windowIds.map(Number).filter(Number.isFinite))]
    : await listWindowIds();
  const structures = {};
  for (const windowId of ids) {
    const tree = await ensureTree(windowId);
    if (tree) {
      structures[windowId] = { parents: toParentsPayload(tree) };
    }
  }
  return { structures };
}

function listWindowIds() {
  return new Promise((resolve) => {
    chrome.windows.getAll((windows) => {
      const list = Array.isArray(windows) ? windows : [];
      resolve(list.map((win) => Number(win.id)).filter(Number.isFinite));
    });
  });
}

/**
 * 管理页拖拽改变父子关系。
 *
 * 使用场景：树状视图里把标签拖到某行上（成为子标签）或某行之间（成为兄弟）。
 * 前置要求：只允许同窗口操作；固定标签与"拖到自己的子孙下面"会被拒绝。
 *
 * 副作用：这是插件唯一会主动移动用户标签页的场景之一（另一个是跨窗口子树迁移），
 * 因此只在用户显式拖拽时执行，并把被拖标签的整棵子树按 DFS 顺序一次性落到目标位置。
 *
 * @param {{tabId: number, parentId?: number|null, afterTabId?: number|null, beforeTabId?: number|null}} payload
 */
export async function moveTabTree(payload = {}) {
  const tabId = Number(payload.tabId);
  if (!Number.isFinite(tabId)) {
    throw new Error("标签页参数无效。");
  }
  const parentId = payload.parentId === null || payload.parentId === undefined || payload.parentId === ""
    ? null
    : Number(payload.parentId);
  const afterTabId = payload.afterTabId === null || payload.afterTabId === undefined
    ? null
    : Number(payload.afterTabId);
  const beforeTabId = payload.beforeTabId === null || payload.beforeTabId === undefined
    ? null
    : Number(payload.beforeTabId);
  if (parentId !== null && !Number.isFinite(parentId)) {
    throw new Error("父标签参数无效。");
  }

  const tab = await getTabById(tabId);
  if (!tab) {
    throw new Error("标签页不存在或已被关闭。");
  }
  const windowId = Number(tab.windowId);
  const tree = await ensureTree(windowId);
  if (!tree) {
    throw new Error("树结构尚未就绪，请稍后重试。");
  }
  const tabs = await queryWindowTabs(windowId);
  const pinnedIds = new Set();
  const windowTabIds = new Set();
  for (const item of tabs) {
    windowTabIds.add(Number(item.id));
    if (item.pinned) {
      pinnedIds.add(Number(item.id));
    }
  }

  const invalidReason = validateNewParent(tree, tabId, parentId, { pinnedIds, windowTabIds });
  if (invalidReason) {
    throw new Error(invalidReason);
  }
  if (pinnedIds.has(tabId) && parentId !== null) {
    throw new Error("固定标签不能参与父子关系。");
  }
  for (const anchorId of [afterTabId, beforeTabId]) {
    if (anchorId !== null && !windowTabIds.has(anchorId)) {
      throw new Error("落点标签不在同一窗口。");
    }
  }

  const subtreeIds = orderSubtreeByWindow(tabs, tree, tabId);
  const subtreeSet = new Set(subtreeIds);
  // 插入位置必须基于"改父子关系之前"的树来计算：
  // 若先改父子，lastDescendantOf(parentId) 可能落回被拖子树内部，锚点就失效了。
  const insertIndex = computeInsertIndex(tabs, tree, {
    subtreeSet,
    parentId,
    afterTabId,
    beforeTabId,
  });
  setParent(tree, tabId, parentId);
  markDirty(windowId);

  const result = await moveTabsInternally(subtreeIds, windowId, insertIndex);
  // 插件自己发起的移动同样改变了物理顺序，必须同步下标表：
  // 否则后续基于下标排序的操作（跨窗口迁移、promote 的首个子标签）会用到过期数据。
  updateIndexesAfterMove(tree, tabs, subtreeSet, insertIndex, subtreeIds);
  // 物理移动后，被拖标签与子树的父子关系不变，但子树在新位置上的兄弟顺序可能变化；
  // 这里不做额外推断，等下一次事件或落盘时的校验统一收敛。
  return { moved: result.moved, skipped: result.skipped, parentId };
}

/** 按"移除被拖子树后再插入"的规则重算下标表，口径与 computeInsertIndex 完全一致。 */
function updateIndexesAfterMove(tree, tabs, subtreeSet, insertIndex, subtreeIds) {
  const remaining = tabs
    .map((tab) => Number(tab.id))
    .filter((id) => !subtreeSet.has(id));
  const position = Math.max(0, Math.min(insertIndex, remaining.length));
  remaining.splice(position, 0, ...subtreeIds);
  tree.indexById = new Map(remaining.map((id, index) => [id, index]));
}

/**
 * 计算物理插入下标。
 * 注意要在"移除被拖子树之后"的坐标空间里计算，否则下标会被自身占位带偏
 * （与现有平铺拖拽 handleWindowDrop 的口径保持一致）。
 */
function computeInsertIndex(tabs, tree, { subtreeSet, parentId, afterTabId, beforeTabId }) {
  const remaining = tabs
    .map((tab) => Number(tab.id))
    .filter((id) => !subtreeSet.has(id));

  let anchorId = null;
  if (afterTabId !== null && Number.isFinite(afterTabId)) {
    anchorId = lastDescendantOf(tree, afterTabId);
  } else if (beforeTabId !== null && Number.isFinite(beforeTabId)) {
    const position = remaining.indexOf(beforeTabId);
    return position >= 0 ? position : 0;
  } else if (parentId !== null) {
    // 成为父标签的最后一个子标签：落到父标签整棵子树之后。
    anchorId = lastDescendantOf(tree, parentId);
  } else {
    // 顶层且没有落点：放到最前。
    return 0;
  }

  if (anchorId === null || subtreeSet.has(anchorId)) {
    return remaining.length;
  }
  const position = remaining.indexOf(anchorId);
  return position >= 0 ? position + 1 : remaining.length;
}

/** 沿 childIdsById 找出物理位置最靠后的那个后代（用于"落到子树之后"的锚点）。 */
function lastDescendantOf(tree, tabId) {
  let current = Number(tabId);
  let guard = 0;
  while (guard <= tree.parentById.size) {
    const children = sortChildrenByIndex(tree, current);
    if (!children || children.length === 0) {
      return current;
    }
    current = children[children.length - 1];
    guard += 1;
  }
  return current;
}

/**
 * 把子树按"DFS + 兄弟按物理顺序"排好。
 * chrome.tabs.move 会按数组顺序连续放置标签，因此这个顺序决定了移动后子树的物理连续性。
 */
function orderSubtreeByWindow(tabs, tree, rootId) {
  const subtreeSet = new Set(collectSubtreeIds(tree, rootId));
  const childrenByParent = new Map();
  for (const tab of tabs) {
    const id = Number(tab.id);
    if (id === rootId || !subtreeSet.has(id)) {
      continue;
    }
    const parentId = tree.parentById.has(id) ? tree.parentById.get(id) : null;
    const effectiveParent = parentId !== null && subtreeSet.has(parentId) ? parentId : rootId;
    let children = childrenByParent.get(effectiveParent);
    if (!children) {
      children = [];
      childrenByParent.set(effectiveParent, children);
    }
    children.push(id);
  }
  const ordered = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop();
    ordered.push(current);
    const children = childrenByParent.get(current);
    if (children) {
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i]);
      }
    }
  }
  return ordered;
}

/**
 * 由插件自身发起的标签移动。
 * 参与移动的 tabId 会被登记到 internalMoveIds，使随后异步派发的 onMoved / onDetached / onAttached
 * 不会把刚设好的结构再推断一遍（否则会形成"移动→推断→再移动"的震荡）。
 */
async function moveTabsInternally(tabIds, windowId, index) {
  let moved = 0;
  let skipped = 0;
  for (let offset = 0; offset < tabIds.length; offset += MOVE_BATCH_SIZE) {
    const batch = tabIds.slice(offset, offset + MOVE_BATCH_SIZE);
    markInternalMove(batch);
    const targetIndex = index >= 0 ? index + offset : -1;
    try {
      await new Promise((resolve, reject) => {
        chrome.tabs.move(batch, { windowId, index: targetIndex }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "移动失败"));
            return;
          }
          resolve();
        });
      });
      moved += batch.length;
    } catch (error) {
      // 整批失败时逐个重试：个别标签（例如已被关闭）失败不应拖累其余标签。
      for (const tabId of batch) {
        try {
          await new Promise((resolve, reject) => {
            chrome.tabs.move(tabId, { windowId, index: -1 }, () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message || "移动失败"));
                return;
              }
              resolve();
            });
          });
          moved += 1;
        } catch (innerError) {
          skipped += 1;
        }
      }
    }
    if (offset + MOVE_BATCH_SIZE < tabIds.length) {
      await delay(MOVE_BATCH_GAP_MS);
    }
  }
  return { moved, skipped };
}

function markInternalMove(tabIds) {
  for (const tabId of tabIds) {
    internalMoveIds.add(tabId);
  }
  setTimeout(() => {
    for (const tabId of tabIds) {
      internalMoveIds.delete(tabId);
    }
  }, INTERNAL_MOVE_TTL_MS);
}
