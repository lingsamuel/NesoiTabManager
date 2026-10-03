// 树状结构的后台集成层。
//
// 职责划分：
// - 本文件只负责"与浏览器打交道"的部分：事件监听、按窗口懒加载、内存树缓存、
//   空闲防抖落盘、以及管理页的读写消息；
// - 真正的算法（建树、快照对齐、关闭提升、位置推断、扁平化）全部在 tree_core.js，
//   那里是纯函数，既能被基准脚本直接复用，也便于单独推理。
//
// 三条硬性约束（对应需求）：
// 1. 面向 10K 级标签页：不维护"整窗顺序数组"，不在每次事件做 O(n) 重排；
//    关闭标签是 O(1)（下标天然保持相对有序），只有创建/移动这类低频操作才会 O(n) 刷新下标表，
//    且启动恢复期会整体跳过；
// 2. 持久化但控制写入量：结构变化只改内存并置脏，空闲若干秒后只覆盖"变化的窗口"；
// 3. 不拖慢浏览器初始化：启动/会话恢复期进入静默期，不加载快照、不对齐、不写盘。

import {
  HAS_SESSION_STORAGE,
  TREE_FLUSH_ALARM,
  TREE_INDEX_KEY,
  TREE_KEY_PREFIX,
  TREE_REVISION_KEY,
  TREE_SESSION_TOKEN_KEY,
} from "./constants.js";
import {
  storageGet,
  storageRemove,
  storageSessionGet,
  storageSessionSet,
  storageSet,
} from "./storage.js";
import { delay } from "./utils.js";
import {
  isTreeDebugEnabled,
  recordTreeDiagnostic,
  logFlow,
  logTreeBlock,
} from "./tree_debug.js";
import {
  configureTreeDiagnostics, getTreeDiagnosticContent, recordBrowserTreeEvent,
  beginTreeDiagnosticOperation, endTreeDiagnosticOperation, observeTreeDiagnostics,
  observeTreePhysicalTabs, treeDiagnosticEpoch, forgetTreeDiagnostics, getTreeDiagnosticOperations,
} from "./tree_diagnostic_runtime.js";
import {
  alignSnapshotToTabs,
  applyRemovePromotion,
  buildChildIndex,
  collectSubtreeIds,
  dropTab,
  encodeSnapshot,
  inferParentFromNewPosition,
  isDescendantOf,
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
// 结构变更通知的合并窗口：批量关闭/恢复会连续改结构，逐次通知等于反复刷前端。
const TREE_PUSH_THROTTLE_MS = 200;

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
// windowId -> 该窗口内存树的版本号。每次结构变化自增，随通知与 getTreeStructure 一起发给前端，
// 前端据此丢弃"慢请求先发后到"的旧结果（界面必须等于后台的真实结构）。
const treeRevisionByWindow = new Map();
// 版本号只在本后台实例内单调。后台被回收后重建时版本号会从 0 重新开始，
// 而前端手里的已知版本号还停在旧实例的值上——直接比较会让前端**永久忽略**新结果。
// 因此每次实例启动带一个随机令牌，令牌变了就表示"这些版本号不可与本地值直接比较"，前端必须无条件接受。
const treeRevisionToken = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// windowId -> 待通知的合并定时器。
const pushTimers = new Map();
// windowId -> { at, parentId }[]：记录"由本插件主动创建、且落位已经确定"的创建请求。
// 后台的默认规则是"无 opener 的新标签挂到创建时刻的活动标签下"（对齐 TST 的 open as child），
// 而侧边栏底部的 New Tab 按钮要求新标签是**顶层**、外部拖放要求落在某个标签的同级，
// 因此创建前先打一个短时效标记，onCreated 命中该标记时**同步**套用落位并跳过挂载规则。
// 用数组+时效而不是布尔值：一次失败不会永久污染后续创建。
// 必须是同步套用（路径中不能有 await）：否则可能与随后的事件处理竞争，把刚定的层级改回默认规则。
const pendingPlacements = new Map();
// 标记的有效期：超过这个时间还没被 onCreated 消费就丢弃。
const PENDING_PLACEMENT_TTL_MS = 3000;

// 「撤销关闭恢复」的判定钩子与结构变化钩子：都由 closed_groups.js 在初始化时注册。
//
// 为什么必须是钩子而不是在本文件里 import：
// 撤销关闭需要读会话记录、调 sessions API、并在恢复后写回父子关系，属于另一层职责；
// 而本文件是被 closed_groups.js import 的下层模块，反向 import 会成环。
let undoDetectProvider = null;
let structureRefsHook = null;

/**
 * 注册「撤销关闭判定」钩子（只能由 closed_groups.js 调用）。
 *
 * 语义：**新建标签的同步落位已经完成之后**调用，钩子自己在判定窗口内异步决定
 * "这个标签是不是撤销恢复出来的"，命中就纠正父关系与物理位置。这样：
 * - 落位永远是同步的、**永远不产生非法父**（不必等落盘时静默纠偏）；
 * - 判定所需的依据（Firefox 每标签会话值、标签的真实 URL）在 onCreated 这一刻本来就拿不到，
 *   异步判定才符合 API 的现实。
 *
 * @param {null|((tab: chrome.tabs.Tab, windowId: number) => void)} provider
 */
export function setUndoDetectProvider(provider) {
  undoDetectProvider = typeof provider === "function" ? provider : null;
}

/**
 * 注册「结构变化后需要刷新每标签会话值」的钩子（只能由 closed_groups.js 调用）。
 * 用途：落盘前的静默纠偏改写了父关系之后，必须把新的父写回会话值，
 * 否则过期会话值会在下一次撤销时把错误父重新引回来。
 *
 * @param {null|((windowId: number, tabIds: number[]|null) => void)} hook
 */
export function setStructureRefsHook(hook) {
  structureRefsHook = typeof hook === "function" ? hook : null;
}

/** 触发结构变化钩子（尽力而为，绝不因为钩子报错影响事件链路）。 */
function noteStructureRefsRefresh(windowId, tabIds) {
  if (!structureRefsHook) {
    return;
  }
  try {
    structureRefsHook(windowId, tabIds);
  } catch (_error) {
    // 会话值只是一条辅助信息，失败不影响树本身。
  }
}

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
// 调试：树状态快照与"本次关闭"的变化原因收集
// ---------------------------------------------------------------------------
//
// 快照只用于诊断，保留原始父映射及子索引；不能借清理函数读取，否则现场会被改写。
let activeCloseDebug = null;
configureTreeDiagnostics({ captureState: captureTreeDebugState, readRevision: getTreeRevision });

/** 读取缓存下标来源的快照；元数据正文只在临时比较中使用。 */
export function captureTreeDebugState(windowId) {
  const tree = trees.get(Number(windowId));
  if (!tree) return null;
  const entries = [];
  for (const [id, parentId] of tree.parentById) {
    entries.push({
      id: Number(id), parentId: parentId == null ? null : Number(parentId),
      index: tree.indexById?.has(id) ? tree.indexById.get(id) : -1,
      ...getTreeDiagnosticContent(id),
    });
  }
  entries.sort((a, b) => a.index - b.index);
  return {
    windowId: Number(windowId), source: 'backend-cache', sourceToken: treeRevisionToken,
    revision: getTreeRevision(windowId), at: Date.now(), entries,
    childIdsById: new Map([...tree.childIdsById].map(([id, children]) => [id, [...children]])),
  };
}

/** 原因在决策发生处采集；总开关即保留，详细开关只控制普通局部快照。 */
export function noteTreeChangeReason(text) {
  if (!isTreeDebugEnabled()) return;
  if (activeCloseDebug) activeCloseDebug.reasons.push(text);
  recordTreeDiagnostic({ type: 'tree-change-reason', windowId: activeCloseDebug?.windowId,
    correlationId: activeCloseDebug?.correlationId, reason: text });
}

/** 关闭前先保留观测；正常提升的解释来自算法已有的 onDecision 回调。 */
export function beginTreeCloseDebug(tabId, removeInfo = {}) {
  if (!isTreeDebugEnabled()) return null;
  const windowId = Number(removeInfo.windowId);
  const correlationId = recordBrowserTreeEvent('removed', windowId, [Number(tabId)], {
    isWindowClosing: Boolean(removeInfo.isWindowClosing),
  });
  activeCloseDebug = beginTreeDiagnosticOperation('close', windowId, [Number(tabId)], { correlationId });
  activeCloseDebug.reasons = [];
  activeCloseDebug.expectedParents = [];
  return activeCloseDebug;
}

/** 必须在 finally 中结束，失败时也保留已观察到的现场。 */
export function endTreeCloseDebug(token = activeCloseDebug, details = {}) {
  if (!token) return;
  if (activeCloseDebug === token) activeCloseDebug = null;
  endTreeDiagnosticOperation(token, { ...details, reasons: token.reasons, expectedParents: token.expectedParents });
}

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

/**
 * 标记"下一个在该窗口创建的标签的落位"。
 *
 * @param {number} windowId
 * @param {number|null} parentId 父标签 id；null 表示顶层标签。
 */
function markNextTabPlacement(windowId, parentId) {
  const list = pendingPlacements.get(windowId) || [];
  list.push({ at: Date.now(), parentId: parentId === null ? null : Number(parentId) });
  pendingPlacements.set(windowId, list);
}

/**
 * 消费一个"落位"标记。
 * 过期的标记会被顺带丢弃，避免创建失败后把后续某个无关的新标签误判成这次创建的标签。
 *
 * @returns {{parentId: number|null}|null}
 */
function consumePendingPlacement(windowId) {
  const list = pendingPlacements.get(windowId);
  if (!list || list.length === 0) {
    return null;
  }
  const now = Date.now();
  while (list.length > 0 && now - list[0].at > PENDING_PLACEMENT_TTL_MS) {
    list.shift();
  }
  if (list.length === 0) {
    pendingPlacements.delete(windowId);
    return null;
  }
  const placement = list.shift();
  if (list.length === 0) {
    pendingPlacements.delete(windowId);
  }
  return placement;
}

/**
 * 在窗口末尾新建一个**顶层**标签页（侧边栏底部的 New Tab 按钮使用）。
 *
 * 为什么不能直接在侧边栏调 chrome.tabs.create：
 * - 物理位置：Firefox 的 `browser.tabs.insertAfterCurrent` 偏好会让"不指定 index"的新标签插到当前标签之后，
 *   因此这里显式传 `index = 当前标签数` 来保证追加到窗口末尾；
 * - 树的归属：后台默认会把无 opener 的新标签挂到活动标签下，这里必须预先打标记把它排除在外。
 *
 * @param {{windowId: number}} options
 * @returns {Promise<{tabId: number, windowId: number}>}
 */
export async function createRootTab(options = {}) {
  const windowId = Number(options.windowId);
  if (!Number.isFinite(windowId)) {
    throw new Error("窗口参数无效。");
  }
  const tabs = await queryWindowTabs(windowId);
  markNextTabPlacement(windowId, null);
  const created = await new Promise((resolve, reject) => {
    chrome.tabs.create({ windowId, index: tabs.length, active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        reject(
          new Error(
            chrome.runtime.lastError
              ? chrome.runtime.lastError.message
              : "新建标签页失败。"
          )
        );
        return;
      }
      resolve(tab);
    });
  });
  return { tabId: Number(created.id), windowId };
}

/** 落点 id 归一：缺省/空值一律当作"没有这个锚点"（用 NaN 表示），避免 Number(null) === 0 被当成合法锚点。 */
function normalizeOptionalTabId(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return Number.NaN;
  }
  return Number(raw);
}

/** 固定标签的新建下标：固定标签永远占据窗口最前面若干位，插入点必须落在这个区间内。 */
function computePinnedCreateIndex(tabs, { beforeTabId, afterTabId }) {
  const pinnedIds = tabs.filter((tab) => tab.pinned).map((tab) => Number(tab.id));
  if (Number.isFinite(beforeTabId)) {
    const position = pinnedIds.indexOf(Number(beforeTabId));
    return position >= 0 ? position : pinnedIds.length;
  }
  if (Number.isFinite(afterTabId)) {
    const position = pinnedIds.indexOf(Number(afterTabId));
    return position >= 0 ? position + 1 : pinnedIds.length;
  }
  // 没有落点：追加到现有固定标签之后。
  return pinnedIds.length;
}

/**
 * 按落位新建标签页（侧边栏外部拖放使用）。
 *
 * 与 `createRootTab` 的差别：物理位置与树里的父标签都要按落点算，而不是固定在窗口末尾的顶层。
 * 两者共用同一个"落位标记"机制，因此 `tabs.onCreated` 一定能**同步**套用父子关系，
 * 不会被"无 opener 挂到活动标签下"的默认规则抢先。
 *
 * @param {{windowId: number, parentId?: number|null, beforeTabId?: number|null, afterTabId?: number|null,
 *   pinned?: boolean, url?: string}} options
 * @returns {Promise<{tabId: number, windowId: number, index: number, parentId: number|null}>}
 */
export async function createPlacedTab(options = {}) {
  const windowId = Number(options.windowId);
  if (!Number.isFinite(windowId)) {
    throw new Error("窗口参数无效。");
  }
  const pinned = Boolean(options.pinned);
  const url = typeof options.url === "string" && options.url ? options.url : "about:blank";
  const beforeTabId = normalizeOptionalTabId(options.beforeTabId);
  const afterTabId = normalizeOptionalTabId(options.afterTabId);
  const tree = await ensureTree(windowId);
  if (!tree) {
    throw new Error("树结构尚未就绪，请稍后重试。");
  }
  const tabs = await queryWindowTabs(windowId);

  let parentId = null;
  if (!pinned && options.parentId !== null && options.parentId !== undefined && options.parentId !== "") {
    const candidate = Number(options.parentId);
    // 父标签必须真的在这个窗口的树里：落点可能因为并发关闭/折叠而失效，失效时退化为顶层。
    if (Number.isFinite(candidate) && tree.parentById.has(candidate)) {
      parentId = candidate;
    }
  }

  let index;
  if (pinned) {
    // 固定标签永远是顶层，不参与父子关系。
    parentId = null;
    index = computePinnedCreateIndex(tabs, { beforeTabId, afterTabId });
  } else {
    const hasAnchor =
      Number.isFinite(beforeTabId) || Number.isFinite(afterTabId) || parentId !== null;
    // 没有任何落点（例如列表为空时的空白处拖放）：追加到窗口末尾。
    index = hasAnchor
      ? computeInsertIndex(tabs, tree, {
          subtreeSet: new Set(),
          parentId,
          beforeTabId: Number.isFinite(beforeTabId) ? beforeTabId : null,
          afterTabId: Number.isFinite(afterTabId) ? afterTabId : null,
        })
      : tabs.length;
  }
  index = Math.max(0, Math.min(index, tabs.length));

  markNextTabPlacement(windowId, parentId);
  const created = await new Promise((resolve, reject) => {
    chrome.tabs.create({ windowId, index, url, active: true, pinned }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        reject(
          new Error(
            chrome.runtime.lastError ? chrome.runtime.lastError.message : "新建标签页失败。"
          )
        );
        return;
      }
      resolve(tab);
    });
  });
  return { tabId: Number(created.id), windowId, index, parentId };
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

// 会话令牌的内存缓存：同一次 SW 生命周期里只读/写一次 storage.session。
// 必须在模块级缓存（而不是每次读盘）——它只用于"快照里的 tabId 是否还可信"这一个判断，
// 值在整个浏览器会话内不变，重复读取纯属浪费。
let sessionTokenPromise = null;

/**
 * 取（必要时创建）本次浏览器会话的树结构令牌。
 *
 * 语义：`storage.session` 能跨 Service Worker / 事件页回收存活，但浏览器一重启就清空。
 * 因此"令牌一致"恰好等价于"快照里的 tabId 与当前标签属于同一批身份"，可以放心按 id 配对；
 * 令牌不一致（浏览器重启、或环境没有会话存储）时读取端会完全忽略 id，退回按 URL 对齐。
 *
 * 兼容读取早期写下的 `{ token, at }` 形态，新值一律写纯字符串。
 *
 * @returns {Promise<string>} 拿不到会话存储时返回空串（表示"不可信"，不是错误）。
 */
function getTreeSessionToken() {
  if (!sessionTokenPromise) {
    sessionTokenPromise = (async () => {
      const stored = await storageSessionGet(TREE_SESSION_TOKEN_KEY);
      const existing = typeof stored === "string" ? stored : stored && typeof stored.token === "string" ? stored.token : "";
      if (existing) {
        return existing;
      }
      const token = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      await storageSessionSet({ [TREE_SESSION_TOKEN_KEY]: token });
      return token;
    })().catch(() => "");
  }
  return sessionTokenPromise;
}

async function loadTree(windowId) {
  const [tabs, snapshot, sessionToken] = await Promise.all([
    queryWindowTabs(windowId),
    storageGet(`${TREE_KEY_PREFIX}${windowId}`),
    getTreeSessionToken(),
  ]);
  const snapshotItems = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
  const sidMatches = Boolean(sessionToken) && Boolean(snapshot) && snapshot.sid === sessionToken;
  // 调试：重建来源是排查"层级为何变化"的第一现场，必须说清用了哪条身份依据。
  const repairs = [];
  const result = alignSnapshotToTabs(tabs, snapshot || null, {
    sessionToken,
    onRepair: (info) => repairs.push(info),
  });
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
  observeTreeDiagnostics(windowId, { type: "load", phase: "complete" });
  logFlow(
    `重建窗口 ${windowId}：标签 ${tabs.length}，` +
      `快照 ${snapshotItems.length > 0 ? `有(${snapshotItems.length} 项，sid${sidMatches ? "一致→按 tabId 精确配对" : "不一致→按顺序+URL 猜测"})` : "无→只能按 opener 建树"}，` +
      `匹配 ${result.matched} 新增 ${result.added} 修正 ${result.repaired} exact=${result.exact}`
  );
  if (repairs.length > 0) {
    logTreeBlock(
      `[重建时的不变量修正] 窗口 ${windowId} 共 ${repairs.length} 条`,
      repairs.map((item) => `#${item.tabId}：父 ${item.from ?? "顶层"} → ${item.to ?? "顶层"}（${item.reason}）`)
    );
  }
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

/**
 * 删除标签之后，把其后所有标签的下标前移。
 *
 * 为什么必须做（用一次 O(n) 换正确性）：不重编号的话 `indexById` 就退化成"近似下标"，
 * 而它被两处关键逻辑直接使用——
 * 1. **记录关闭现场**（`getTabStructureInfo` 用 index±1 求前后邻居）→ 撤销恢复按邻居把标签放回原位，
 *    邻居取错就会把标签移到毫不相干的位置（用户表现为"撤销后标签出现在奇怪的地方"，
 *    且"重挂被提升的子标签"会因为物理顺序判断错误而全部跳过）；
 * 2. "第一个子标签"等相对顺序判定。
 * 单个窗口的标签数是有界的（几千），一次 Map 遍历远小于一次 `chrome.tabs` IPC。
 *
 * @param {number[]} removedIndexes 被删除标签当时的下标（可含 undefined / 重复）
 */
function renumberIndexesAfterRemovals(tree, removedIndexes) {
  if (!tree.indexById || !Array.isArray(removedIndexes)) {
    return;
  }
  const removed = [...new Set(removedIndexes.filter((value) => Number.isFinite(value)))].sort(
    (a, b) => a - b
  );
  if (removed.length === 0) {
    return;
  }
  const maxIndex = removed[removed.length - 1];
  // shift[i] = 下标小于 i 的已删除标签数量（前缀和，O(n + 删除数)）。
  const shift = new Int32Array(maxIndex + 2);
  for (const index of removed) {
    shift[index + 1] = 1;
  }
  for (let i = 1; i < shift.length; i += 1) {
    shift[i] += shift[i - 1];
  }
  for (const [id, index] of tree.indexById) {
    const moved = index <= maxIndex ? shift[index] : shift[maxIndex + 1];
    if (moved > 0) {
      tree.indexById.set(id, index - moved);
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
  forgetTreeDiagnostics(windowId);
  trees.delete(windowId);
  loadingTrees.delete(windowId);
  pendingWindows.delete(windowId);
  dirtyWindows.delete(windowId);
  activeTabByWindow.delete(windowId);
}

/** 读取窗口内所有标签并按 index 升序排列。 */
function queryWindowTabs(windowId) {
  const queryEpoch = treeDiagnosticEpoch(windowId);
  return new Promise((resolve) => {
    chrome.tabs.query({ windowId }, (tabs) => {
      const list = Array.isArray(tabs) ? tabs.slice() : [];
      list.sort((a, b) => (a.index || 0) - (b.index || 0));
      observeTreePhysicalTabs(windowId, list, queryEpoch);
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

/**
 * 把标签登记为顶层。
 *
 * 不能直接写 `parentById.set(id, null)`：如果这个标签**已经在树里**（典型情形是对齐刚好把它
 * 挂到了 opener 之下，而创建事件随后才到），直接改父映射会把它的 id 留在前一个父的
 * `childIdsById` 里。那个父之后被关闭时，提升逻辑会把这个其实早已顶层的标签当成它的子标签
 * 提升进树——表现为"关掉一个标签，几个毫不相干的标签突然换了位置"。
 */
function attachAsRoot(tree, tabId) {
  const id = Number(tabId);
  if (!tree.parentById.has(id)) {
    tree.parentById.set(id, null);
    return;
  }
  setParent(tree, id, null);
}

// ---------------------------------------------------------------------------
// tabs 事件
// ---------------------------------------------------------------------------

/**
 * 标签刚创建：确定它的初始父标签。
 * 只有这一刻 openerTabId 参与决策；之后父子关系由本插件自己的树数据决定，不再跟随 opener 变化。
 */
export async function handleTreeTabCreated(tab) {
  const windowId = Number(tab?.windowId);
  const correlationId = recordBrowserTreeEvent('created', windowId, [Number(tab?.id)], {});
  const token = beginTreeDiagnosticOperation('created', windowId, [Number(tab?.id)], { correlationId, registered: false });
  let failed = false;
  try {
    return await handleTreeTabCreatedImpl(tab);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    endTreeDiagnosticOperation(token, { failed });
  }
}

async function handleTreeTabCreatedImpl(tab) {
  if (!tab || !Number.isFinite(Number(tab.windowId)) || !Number.isFinite(Number(tab.id))) {
    return;
  }
  const windowId = Number(tab.windowId);
  noteStructuralEvent();
  if (startupActive) {
    pendingWindows.add(windowId);
    return;
  }
  // 先消费标记：即便这一轮因为树未加载而提前返回，标记也不会泄漏到后续的创建事件上。
  const placement = consumePendingPlacement(windowId);
  const tree = trees.get(windowId);
  if (!tree) {
    // 树还没加载。此时不能把创建事件扔掉：
    // 1) 若它其实是「撤销关闭」恢复出来的，判定机会只有这一次（关闭记录会被消费/过期），
    //    等树懒加载完，标签只会按默认规则（opener / 活动标签）落位，记录里的原父与原位置就白丢了；
    // 2) 因此这里把判定**登记**给 closed_groups.js（它自己会 ensureTreeFor 把树装载好再套用），
    //    同时维持原来的"稍后统一对齐"：判定未命中时由对齐完成默认落位。
    if (!placement && undoDetectProvider) {
      try {
        undoDetectProvider(tab, windowId);
      } catch (_error) {
        // 判定只是尽力而为，失败不影响"稍后统一对齐"。
      }
    }
    noteTreeChangeReason(`新建 #${Number(tab.id)}：内存里没有树 → 推迟到统一对齐（父关系由 opener 兜底）`);
    scheduleEnsureTrees([windowId]);
    return;
  }
  if (placement) {
    // 本插件主动创建、且落位已定：不套用"挂到活动标签下"的规则。
    // 这里**不能有 await**（见 pendingPlacements 的说明）：否则默认规则可能在这之后才跑完并把层级改回去。
    const createdId = Number(tab.id);
    const placedParentId = placement.parentId;
    if (placedParentId !== null && tree.parentById.has(placedParentId)) {
      setParent(tree, createdId, placedParentId);
      noteTreeChangeReason(`新建 #${createdId}：按插件落位标记挂到 #${placedParentId}（本插件主动创建）`);
    } else {
      attachAsRoot(tree, createdId);
      noteTreeChangeReason(
        `新建 #${createdId}：插件落位标记要求顶层${placedParentId !== null ? `（但目标父 #${placedParentId} 已不在树里）` : ""}`
      );
    }
    const forcedIndex = Number(tab.index);
    if (Number.isFinite(forcedIndex)) {
      shiftIndexesForInsert(tree, forcedIndex);
      tree.indexById.set(createdId, forcedIndex);
    }
    markDirty(windowId);
    return;
  }
  // 浏览器创建的新标签：先做**同步的合法落位**（父必须真实存在且物理排在它之前），
  // 再把"这是不是一次撤销恢复"交给 closed_groups.js 在判定窗口内异步确认。
  //
  // 为什么不能像旧实现那样先同步"认领"撤销记录：识别依据（Firefox 每标签会话值、标签真实 URL）
  // 在 tabs.onCreated 这一刻都拿不到（Firefox 给的是 about:blank），同步判定必然失败并退回默认规则；
  // 而默认规则若挂到物理上排在新标签之后的"活动标签"下，就会产生非法父，直到落盘前才被静默纠偏——
  // 这正是"关闭父标签后撤销，两次得到不同结构、界面还停在旧层级"的成因。
  const picked = await pickParentForNewTab(tree, tab);
  if (picked.parentId != null) {
    setParent(tree, Number(tab.id), picked.parentId);
    noteTreeChangeReason(`新建 #${Number(tab.id)}：挂到 #${picked.parentId}（${picked.source}）`);
  } else if (!tree.parentById.has(Number(tab.id))) {
    tree.parentById.set(Number(tab.id), null);
    noteTreeChangeReason(`新建 #${Number(tab.id)}：没有可用父标签（${picked.reason}）→ 顶层`);
  }
  const atIndex = Number(tab.index);
  if (Number.isFinite(atIndex)) {
    shiftIndexesForInsert(tree, atIndex);
    tree.indexById.set(Number(tab.id), atIndex);
  }
  markDirty(windowId);
  if (undoDetectProvider) {
    try {
      undoDetectProvider(tab, windowId);
    } catch (_error) {
      // 同"树未加载"分支：判定失败不影响已经完成的落位。
    }
  }
}

/**
 * 为新标签挑选父标签（同步落位用）。
 * 优先级：合法 opener → 创建时刻的活动标签（对应 TST 的"新标签页命令 open as child"）→ 顶层。
 * 固定标签永远是顶层。
 *
 * 「合法」= 父标签**真实存在**于本窗口、不是自身、不是固定标签，且**物理 index 严格小于新标签**。
 * 物理顺序这一条必须用**真实下标**判断（`chrome.tabs.get`）：内存里的 `indexById` 即便已经维护得
 * 与物理顺序一致，也不如浏览器自己给的这一份可靠，而这条判断决定了会不会产生非法父。
 *
 * 「真实存在但内存树里缺条目」的候选（标签的创建事件落在树加载的空档而被丢弃）
 * 在这里**顺手补为顶层**再挂：否则真实存在的活动标签会被当成不存在，
 * 用户表现为"新标签不再挂到当前标签下"，且只有重建/重载才恢复。
 *
 * @returns {{parentId: number|null, source: string, reason: string}}
 *   `source` 供日志说明父是哪来的；`reason` 在没有可用父时说明各候选被拒的原因。
 */
async function pickParentForNewTab(tree, tab) {
  const tabId = Number(tab.id);
  const windowId = tree.windowId;
  if (tab.pinned) {
    return { parentId: null, source: "", reason: "固定标签一律顶层" };
  }
  const childIndex = Number(tab.index);
  const openerId = Number(tab.openerTabId);
  const rejected = [];

  if (Number.isFinite(openerId) && openerId !== tabId) {
    const verdict = await checkCandidateParent(tree, openerId, childIndex);
    if (verdict.ok) {
      return { parentId: openerId, source: "合法 openerTabId", reason: "" };
    }
    rejected.push(`opener #${openerId} ${verdict.reason}`);
  } else {
    rejected.push("没有 openerTabId");
  }

  let activeId = activeTabByWindow.has(windowId) ? activeTabByWindow.get(windowId) : undefined;
  if (activeId === undefined) {
    activeId = await new Promise((resolve) => {
      chrome.tabs.query({ windowId, active: true }, (list) => resolve(list && list[0] ? list[0].id : null));
    });
    activeTabByWindow.set(windowId, activeId);
  }
  const activeNumeric = Number(activeId);
  if (!Number.isFinite(activeNumeric) || activeNumeric === tabId) {
    rejected.push("活动标签不可用");
  } else {
    const verdict = await checkCandidateParent(tree, activeNumeric, childIndex);
    if (verdict.ok) {
      return { parentId: activeNumeric, source: "创建时刻的活动标签", reason: "" };
    }
    rejected.push(`活动标签 #${activeNumeric} ${verdict.reason}`);
  }
  return { parentId: null, source: "", reason: rejected.join("；") || "无候选" };
}

/**
 * 候选父是否可作为新标签的父：读**真实**标签信息，要求它存在、在本窗口、非固定，且 index 小于新标签。
 * 读不到真实下标（极少数场景）时不否决，保持旧行为（宁可挂上也不要凭空丢层级）。
 *
 * 副作用：候选真实存在、但内存树里没有条目时，把它补为顶层（见 `pickParentForNewTab` 的说明）。
 *
 * @returns {{ok: boolean, reason: string}}
 */
async function checkCandidateParent(tree, parentId, childIndex) {
  const parent = await getTabById(parentId);
  if (!parent) {
    return { ok: false, reason: "已不存在" };
  }
  if (Number(parent.windowId) !== Number(tree.windowId)) {
    return { ok: false, reason: "不在本窗口" };
  }
  if (parent.pinned) {
    return { ok: false, reason: "是固定标签" };
  }
  if (Number.isFinite(childIndex)) {
    const parentIndex = Number(parent.index);
    if (Number.isFinite(parentIndex) && parentIndex >= childIndex) {
      return { ok: false, reason: `排在新标签之后（idx ${parentIndex} >= ${childIndex}）` };
    }
  }
  if (!tree.parentById.has(parentId)) {
    attachAsRoot(tree, parentId);
    noteTreeChangeReason(`#${parentId} 在窗口里但内存树缺条目 → 补为顶层（自愈）`);
  }
  return { ok: true, reason: "" };
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
    noteTreeChangeReason(`关闭 #${tabId}：处于启动静默期 → 本次结构变化推迟到静默期结束后整体重建`);
    return;
  }
  const tree = trees.get(windowId);
  if (!tree) {
    // 树还没进内存：这次关闭不能就这么丢掉。
    // loadTree 的标签列表是「先 queryWindowTabs、再 await storageGet」拿到的——若关闭恰好落在
    // 这个空档里，装好的树里会留下一个"幽灵父标签"（该标签已关闭，却仍作为子标签的父）；
    // 之后任何一次落盘都会触发不变量校验，把它的子标签抬成顶层，并把损坏写进快照。
    // 因此这里挂到正在进行的加载上，等树装好后再补做一次提升，语义与关闭时就地提升完全一致。
    const loading = loadingTrees.get(windowId);
    if (loading) {
      const deferredCorrelationId = activeCloseDebug?.correlationId;
      noteTreeChangeReason(`关闭 #${tabId}：内存里没有树，但有一次加载正在进行 → 挂到它上面，装好后补做提升`);
      loading.then(
        () => {
          const loaded = trees.get(windowId);
          if (loaded) {
            const token = beginTreeDiagnosticOperation('close', windowId, [Number(tabId)], { correlationId: deferredCorrelationId });
            try {
              applyRemovalToTree(loaded, tabId, windowId, token);
            } finally {
              endTreeDiagnosticOperation(token, { reason: 'deferred-until-tree-loaded' });
            }
          }
        },
        () => {}
      );
    } else {
      // 必须把"事件被丢弃"说清楚：后续任何一次重建都会从快照重新推导，
      // 而快照里这个已关闭的标签还在，子标签的归属就由对齐算法决定。
      noteTreeChangeReason(
        `关闭 #${tabId}：内存里没有树、也没有进行中的加载 → 本次关闭就地丢弃；` +
          `下一次重建会从快照推导（快照里这个标签仍在，其子标签的归属由对齐算法决定）`
      );
    }
    return;
  }
  applyRemovalToTree(tree, tabId, windowId);
}

/**
 * 把一次关闭真正落到树上（promote intelligently）。
 *
 * 幂等：树是加载完成后才装上的，那时被关闭的标签可能压根不在树里（列表是在关闭之后查的），
 * 此时无需处理，也不该因此把窗口标脏。
 */
function applyRemovalToTree(tree, tabId, windowId, diagnosticToken = activeCloseDebug) {
  const id = Number(tabId);
  if (!tree.parentById.has(id)) {
    noteTreeChangeReason(`关闭 #${id}：它已经不在内存树里（多半是加载发生在关闭之后）→ 无需提升`);
    return;
  }
  const removedIndex = tree.indexById.get(id);
  tree.indexById.delete(id);
  renumberIndexesAfterRemovals(tree, [removedIndex]);
  // 提升"第一个子标签"前先按物理顺序排序，保证结果确定且符合直觉。
  sortChildrenByIndex(tree, id);
  applyRemovePromotion(tree, id, (info) => {
    if (diagnosticToken) diagnosticToken.expectedParents = info.assignments;
    recordTreeDiagnostic({ type: 'promotion-decision', windowId,
      correlationId: diagnosticToken?.correlationId, tabId: id, ...info });
    const ruleText = {
      "no-children": "该标签没有子标签 → 无需提升",
      "only-child-of-parent": "它是父标签的唯一子标签 → 子标签全部接到父标签下",
      "first-child-takes-place": "父标签还有其他子标签 → 第一个子标签接替它的位置，其余挂到第一个子标签下",
      "closed-was-root": "它自己就是顶层标签 → 第一个子标签接替为顶层，其余挂到第一个子标签下",
    }[info.rule] || info.rule;
    const assignmentText = info.assignments.length > 0
      ? info.assignments.map((item) => `#${item.childId}→${item.parentId ?? "顶层"}`).join("，")
      : "无";
    noteTreeChangeReason(
      `提升 #${id}：父=${info.parentId ?? "顶层"}，子标签=[${info.children.map((child) => `#${child}`).join(",") || "无"}]，` +
        `同父其他子标签数=${info.siblingCountBefore}｜规则：${ruleText}｜结果：${assignmentText}`
    );
  });
  markDirty(windowId);
}

/**
 * 用户在浏览器原生标签栏拖动了标签：按新位置的邻居重新推断父标签（移植自 TST）。
 * 注意这里**不会**回滚物理位置——插件不为"子树物理连续"擅自改动用户的标签栏。
 */
export async function handleTreeTabMoved(tabId, info = {}) {
  const windowId = Number(info.windowId);
  const correlationId = recordBrowserTreeEvent('moved', windowId, [Number(tabId)], { internal: internalMoveIds.has(Number(tabId)), fromIndex: info.fromIndex, toIndex: info.toIndex });
  const token = beginTreeDiagnosticOperation('moved', windowId, [Number(tabId)], { correlationId, registered: false });
  let failed = false;
  try {
    return await handleTreeTabMovedImpl(tabId, info);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    endTreeDiagnosticOperation(token, { failed });
  }
}

async function handleTreeTabMovedImpl(tabId, moveInfo = {}) {
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
    // 无效移动不改树；"判定为没变"也要记录，否则调试时会以为移动事件没到。
    noteTreeChangeReason(
      `位置推断 #${tabId}（idx ${fromIndex}→${toIndex}）：${result.reason}｜` +
        `前一个=#${prevTab ? prevTab.id : "无"}，后一个=#${nextTab ? nextTab.id : "无"}｜${result.invalid ? "无效移动，不改树" : "结果与原来相同，不改树"}`
    );
    return;
  }
  const oldParentId = tree.parentById.has(Number(tabId)) ? tree.parentById.get(Number(tabId)) : null;
  setParent(tree, Number(tabId), result.parentId);
  noteTreeChangeReason(
    `位置推断 #${tabId}（idx ${fromIndex}→${toIndex}）：父 ${oldParentId ?? "顶层"} → ${result.parentId ?? "顶层"}｜` +
      `规则：${result.reason}｜前一个=#${prevTab ? prevTab.id : "无"}，后一个=#${nextTab ? nextTab.id : "无"}`
  );
  markDirty(windowId);
}

/**
 * 标签离开窗口（跨窗口拖拽或"移动到窗口"）。
 * Chrome 只会移动被拖的那一个标签，因此这里先记录下整棵子树的父子关系，再把它从原窗口树上摘除；
 * 真正的物理搬运放到 onAttached 里进行（那时才知道目标窗口）。
 */
export function handleTreeTabDetached(tabId, info = {}) {
  const windowId = Number(info.oldWindowId);
  const correlationId = recordBrowserTreeEvent('detached', windowId, [Number(tabId)], { internal: internalMoveIds.has(Number(tabId)), fromIndex: info.fromIndex, toIndex: info.toIndex });
  const token = beginTreeDiagnosticOperation('detached', windowId, [Number(tabId)], { correlationId, registered: false });
  let failed = false;
  try {
    return handleTreeTabDetachedImpl(tabId, info);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    endTreeDiagnosticOperation(token, { failed });
  }
}

function handleTreeTabDetachedImpl(tabId, detachInfo = {}) {
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
  const removedIndexes = [];
  for (const subtreeId of subtreeIds) {
    dropTab(tree, subtreeId);
    removedIndexes.push(tree.indexById.get(subtreeId));
    tree.indexById.delete(subtreeId);
  }
  renumberIndexesAfterRemovals(tree, removedIndexes);
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
export async function handleTreeTabAttached(tabId, info = {}) {
  const windowId = Number(info.newWindowId);
  const correlationId = recordBrowserTreeEvent('attached', windowId, [Number(tabId)], { internal: internalMoveIds.has(Number(tabId)), fromIndex: info.fromIndex, toIndex: info.toIndex });
  const token = beginTreeDiagnosticOperation('attached', windowId, [Number(tabId)], { correlationId, registered: false });
  let failed = false;
  try {
    return await handleTreeTabAttachedImpl(tabId, info);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    endTreeDiagnosticOperation(token, { failed });
  }
}

async function handleTreeTabAttachedImpl(tabId, attachInfo = {}) {
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
// 结构变更推送（界面必须始终等于后台真实结构）
// ---------------------------------------------------------------------------

/** 该窗口当前的结构版本号（供 getTreeStructure 返回给前端）。 */
export function getTreeRevision(windowId) {
  return treeRevisionByWindow.get(Number(windowId)) || 0;
}

/** 本次后台实例的版本号令牌（见 treeRevisionToken 的说明）。 */
export function getTreeRevisionToken() {
  return treeRevisionToken;
}

/** 结构变化：自增版本号并安排一次（合并后的）通知。 */
function noteTreeStructureChanged(windowId) {
  const winId = Number(windowId);
  if (!Number.isFinite(winId)) {
    return;
  }
  treeRevisionByWindow.set(winId, (treeRevisionByWindow.get(winId) || 0) + 1);
  scheduleTreePush(winId);
}

/**
 * 合并通知：同一窗口 200ms 内的连续变化只发一次。
 *
 * 为什么必须通知而不是只靠 tabs 事件：落盘前的不变量纠偏（把非法父改回顶层）不产生任何 tabs 事件，
 * 前端只靠事件驱动的拉取会一直显示纠偏前的旧结构，用户必须 Reload 扩展才能对齐。
 */
function scheduleTreePush(windowId) {
  if (pushTimers.has(windowId)) {
    return;
  }
  pushTimers.set(
    windowId,
    setTimeout(() => {
      pushTimers.delete(windowId);
      pushTreeStructureChanged(windowId);
    }, TREE_PUSH_THROTTLE_MS)
  );
}

/** 立刻发布一次版本号（不合并）；前端监听 `storage.session` 的该键变化后重拉父子映射。 */
function pushTreeStructureChanged(windowId) {
  if (!HAS_SESSION_STORAGE) {
    // 没有会话存储（极老的环境）：退回"只靠 tabs 事件刷新"，不会因此破坏任何现有行为。
    return;
  }
  const revisions = {};
  for (const [id, revision] of treeRevisionByWindow) {
    revisions[id] = revision;
  }
  // 写失败无补救价值：前端还有 tabs 事件、页面挂载与重新可见三条拉取路径。
  Promise.resolve(
    storageSessionSet({ [TREE_REVISION_KEY]: { token: treeRevisionToken, revisions } })
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

function markDirty(windowId) {
  dirtyWindows.add(windowId);
  changesSinceFlush += 1;
  noteTreeStructureChanged(windowId);
  if (!activeCloseDebug) observeTreeDiagnostics(windowId, { type: "mutation", phase: "applied" });
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
    // 会话令牌随快照一起写：读取端据此判断"快照里的 tabId 是否还在同一浏览器会话内可信"。
    const sessionToken = await getTreeSessionToken();
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
      // 落盘时的纠偏会**静默**改写内存树（用户看不到任何刷新），是排查"层级自己变了"的重点，
      // 因此每一条修正都要带原因打出来。
      observeTreeDiagnostics(windowId, { type: "flush-before", phase: "before" });
      const flushRepairs = [];
      sanitizeTreeState(tree, orderedIds, pinnedIds, (info) => flushRepairs.push(info));
      rebuildIndexes(tree, tabs);
      recordTreeDiagnostic({ type: 'flush-repairs', windowId, repairs: flushRepairs });
      observeTreeDiagnostics(windowId, { type: 'flush-after', phase: 'complete' });
      const result = encodeSnapshot(tabs, tree, { maxBytes: SNAPSHOT_MAX_BYTES, sessionToken });
      if (flushRepairs.length > 0) {
        logTreeBlock(
          `[落盘前的不变量修正] 窗口 ${windowId} 共 ${flushRepairs.length} 条`,
          flushRepairs.map((item) => `#${item.tabId}：父 ${item.from ?? "顶层"} → ${item.to ?? "顶层"}（${item.reason}）`)
        );
        // 静默纠偏改写了结构：必须让前端知道（否则界面停在纠偏前的旧层级），
        // 并把新父写回每标签会话值（否则过期会话值会在下一次撤销时把错误父引回来）。
        noteTreeStructureChanged(windowId);
        noteStructureRefsRefresh(
          windowId,
          flushRepairs.map((item) => Number(item.tabId)).filter(Number.isFinite)
        );
      }
      if (!result.payload) {
        logFlow(`落盘窗口 ${windowId}：跳过（快照超出上限，${result.bytes} 字节）`);
        console.warn(`树结构快照超出存储上限，已跳过写入：窗口 ${windowId}`);
        // 落盘失败也要推送：内存树已经变了，界面必须跟上。
        pushTreeStructureChanged(windowId);
        continue;
      }
      await storageSet({ [`${TREE_KEY_PREFIX}${windowId}`]: result.payload });
      logFlow(
        `落盘窗口 ${windowId}：写入 ${tabs.length} 项（${result.bytes} 字节${result.degraded ? "，已去掉标题" : ""}）`
      );
      // 兜底推送：合并推送的定时器可能因为后台被回收而丢失，落盘是可靠的时间点。
      pushTreeStructureChanged(windowId);
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
export async function getTreeStructure(windowIds = null, diagnosticRequestId = null) {
  const ids = Array.isArray(windowIds) && windowIds.length > 0
    ? [...new Set(windowIds.map(Number).filter(Number.isFinite))]
    : await listWindowIds();
  const structures = {};
  for (const windowId of ids) {
    const tree = await ensureTree(windowId);
    if (tree) {
      observeTreeDiagnostics(windowId, { type: 'structure-response', correlationId: diagnosticRequestId, phase: 'complete' });
      recordTreeDiagnostic({ type: 'structure-response', windowId, correlationId: diagnosticRequestId,
        revision: getTreeRevision(windowId), revisionToken: treeRevisionToken, epoch: treeDiagnosticEpoch(windowId) });
      structures[windowId] = {
        parents: toParentsPayload(tree),
        revision: getTreeRevision(windowId),
        revisionToken: treeRevisionToken,
        ...(isTreeDebugEnabled() ? { diagnosticContext: getTreeDiagnosticOperations(windowId) } : {}),
      };
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
  const diagnosticToken = beginTreeDiagnosticOperation('move', windowId, [tabId], {
    expectedParents: [{ childId: tabId, parentId }],
  });
  let diagnosticFailed = false;
  try {
    setParent(tree, tabId, parentId);
    markDirty(windowId);

    const result = await moveTabsInternally(subtreeIds, windowId, insertIndex);
    // 插件自己发起的移动同样改变了物理顺序，必须同步下标表：
    // 否则后续基于下标排序的操作（跨窗口迁移、promote 的首个子标签）会用到过期数据。
    updateIndexesAfterMove(tree, tabs, subtreeSet, insertIndex, subtreeIds);
    // 物理移动后，被拖标签与子树的父子关系不变，但子树在新位置上的兄弟顺序可能变化；
    // 这里不做额外推断，等下一次事件或落盘时的校验统一收敛。
    if (diagnosticToken && result.skipped === 0) {
      // 复用业务已经计算出的目标序列；后续浏览器观察必须精确匹配才能解释移动。
      diagnosticToken.expectedOrderIds = [...tree.indexById.keys()];
    }
    return { moved: result.moved, skipped: result.skipped, parentId };
  } catch (error) {
    diagnosticFailed = true;
    throw error;
  } finally {
    endTreeDiagnosticOperation(diagnosticToken, { failed: diagnosticFailed });
  }
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

// ---------------------------------------------------------------------------
// 供撤销关闭（closed_groups.js）使用的接口
//
// 这一组接口的存在意义：撤销关闭需要"读当前树的父子关系"和"把恢复出来的标签挂回去"，
// 但这些动作必须经由本文件的内存树与下标表，否则会与事件链路维护的状态脱节。
// 判定与策略留在 closed_groups.js，这里只提供受约束的读写。
// ---------------------------------------------------------------------------

/** 确保某窗口的树已加载（撤销恢复前必须先有树，否则写不进父子关系）。 */
export async function ensureTreeFor(windowId) {
  const winId = Number(windowId);
  if (!Number.isFinite(winId)) {
    return null;
  }
  return ensureTree(winId);
}

/**
 * 取一个标签的结构快照，用于"关闭前"记录现场。
 *
 * **必须在 handleTreeTabRemoved 之前调用**：提交流程一旦执行，父标签信息就被改写了。
 * 树未加载时返回 null（此时本来也没有可信的父子关系可用）。
 *
 * 前后邻居是**物理下标**上的邻居，而不是同一父下的兄弟：恢复时按它们定位可以容忍
 * 「这期间又开了别的标签」带来的下标漂移。
 */
export function getTabStructureInfo(tabId, windowId) {
  const tree = trees.get(Number(windowId));
  const id = Number(tabId);
  if (!tree || !Number.isFinite(id) || !tree.indexById.has(id)) {
    return null;
  }
  const index = tree.indexById.get(id);
  let prevId = null;
  let nextId = null;
  for (const [otherId, otherIndex] of tree.indexById) {
    if (otherIndex === index - 1) {
      prevId = otherId;
    } else if (otherIndex === index + 1) {
      nextId = otherId;
    }
  }
  return {
    windowId: tree.windowId,
    index,
    parentId: tree.parentById.has(id) ? tree.parentById.get(id) : null,
    prevId,
    nextId,
  };
}

/** 取某标签的直接子标签（关闭它之后这些子标签会被提升，需要刷新它们的持久引用）。 */
export function getChildTabIds(tabId, windowId) {
  const tree = trees.get(Number(windowId));
  const id = Number(tabId);
  if (!tree || !Number.isFinite(id)) {
    return [];
  }
  return (tree.childIdsById.get(id) || []).slice();
}

/**
 * 把父子关系套用到内存树上（带不变量校验）。
 *
 * 校验口径与建树时一致：父必须存在于同一窗口、不能是自身或自身后代、且物理下标必须小于子标签。
 * 不满足就降级为顶层——**不报错**，因为撤销恢复本身就是尽力而为：原父可能已被关闭，
 * 或者标签栏顺序在这期间变化过大。
 *
 * @param {{childPinned?: boolean, indexMap?: Map<number, number>}} options
 *   - `childPinned` 为 true 时强制顶层（固定标签不参与父子）；
 *   - `indexMap` 是**实时**的 `tabId -> 物理下标`（由 `refreshTreeIndexes()` 提供）。
 *     必须传它的原因：`indexById` 只反映"事件到达时的顺序"，事件被丢弃（后台被回收、
 *     树未加载时的空档）或刚做过对齐时它可能与物理事实不一致；撤销恢复必须依据**实时查询**的结果。
 * @returns {boolean} 树已加载并写入成功时为 true。
 */
export function applyRestoredParent(windowId, tabId, parentId, options = {}) {
  const tree = trees.get(Number(windowId));
  const id = Number(tabId);
  if (!tree || !Number.isFinite(id) || !tree.parentById.has(id)) {
    return false;
  }
  const indexOf = (targetId) => {
    const map = options.indexMap;
    if (map && map.has(targetId)) {
      return map.get(targetId);
    }
    return tree.indexById.get(targetId) ?? -1;
  };
  let target = parentId === null || parentId === undefined ? null : Number(parentId);
  // 拒绝原因要能被调试日志看见：撤销关闭"层级没恢复"时，第一步就是确认父标签是不是被这里否掉。
  let rejectedReason = "";
  if (target !== null) {
    if (!Number.isFinite(target)) {
      rejectedReason = "父标签参数无效";
    } else if (options.childPinned) {
      rejectedReason = "被恢复的标签是固定标签";
    } else if (target === id) {
      rejectedReason = "父标签是自己";
    } else if (!tree.parentById.has(target)) {
      rejectedReason = "父标签不在树上（可能已被关闭）";
    } else if (isDescendantOf(tree, id, target)) {
      rejectedReason = "父标签是自己的后代（会成环）";
    } else if (indexOf(target) >= indexOf(id)) {
      rejectedReason = `父标签排在它之后（idx ${indexOf(target)} >= ${indexOf(id)}）`;
    }
  }
  if (rejectedReason) {
    target = null;
  }
  setParent(tree, id, target);
  noteTreeChangeReason(
    `恢复父关系 #${id}：记录里的父=${parentId === null || parentId === undefined ? "顶层" : `#${parentId}`} → ` +
      (rejectedReason ? `退化为顶层（${rejectedReason}）` : `#${target}`)
  );
  markDirty(windowId);
  return true;
}

/**
 * 撤销恢复父标签时，把「被提升出去、且仍停在提升结果位置」的直属子标签重新挂回它下面。
 *
 * 场景：A - B - C，关闭 A 时 B 被提升为顶层（C 跟着 B）；原生 Ctrl+Shift+T 只恢复 A 一个标签，
 * 若不重挂就会得到 `A / B-C` 而不是 `A - B-C`。
 *
 * 只处理"登记过、仍存活、且当前父恰好等于提升结果"的子标签——用户后来手动改过父或把它拖走的，
 * 一律保留用户意图（不覆盖）。所有校验与 `applyRestoredParent` 同一口径（存在 / 非自身后代 / 物理在子前）。
 *
 * 副作用：只改父子关系，**不移动物理位置**（插件只为用户显式操作移动标签栏）。
 *
 * @param {number} windowId
 * @param {number} parentId 被恢复的父标签
 * @param {Array<{tabId: number, parentId: number|null}>} expectations 关闭时记录的"子标签 → 提升后父"
 * @param {{indexMap?: Map<number, number>}} options indexMap 由 refreshTreeIndexes() 提供的实时下标
 * @returns {{readopted: number[], skipped: Array<{tabId: number, reason: string}>}}
 */
export function readoptPromotedChildren(windowId, parentId, expectations, options = {}) {
  const tree = trees.get(Number(windowId));
  const winId = Number(windowId);
  const parent = Number(parentId);
  const readopted = [];
  const skipped = [];
  if (!tree || !Number.isFinite(winId) || !Number.isFinite(parent) || !Array.isArray(expectations)) {
    return { readopted, skipped };
  }
  if (!tree.parentById.has(parent)) {
    return { readopted, skipped };
  }
  const indexOf = (targetId) => {
    const map = options.indexMap;
    if (map && map.has(targetId)) {
      return map.get(targetId);
    }
    return tree.indexById.get(targetId) ?? -1;
  };
  for (const item of expectations) {
    const childId = Number(item && item.tabId);
    if (!Number.isFinite(childId)) {
      continue;
    }
    if (!tree.parentById.has(childId)) {
      // 已经被一并关闭、或已不在本窗口：原生撤销只恢复一个标签，插件不会去把它重开。
      skipped.push({ tabId: childId, reason: "子标签已不在树里" });
      continue;
    }
    const currentParent = tree.parentById.get(childId) ?? null;
    const expectedParent = item.parentId === null || item.parentId === undefined ? null : Number(item.parentId);
    if (currentParent !== expectedParent) {
      skipped.push({ tabId: childId, reason: "父关系已被改动，保留现状" });
      continue;
    }
    if (childId === parent) {
      continue;
    }
    if (isDescendantOf(tree, childId, parent)) {
      skipped.push({ tabId: childId, reason: "会成环" });
      continue;
    }
    if (indexOf(parent) < 0 || indexOf(childId) < 0 || indexOf(parent) >= indexOf(childId)) {
      skipped.push({ tabId: childId, reason: "物理顺序不合法（父排在子之后）" });
      continue;
    }
    setParent(tree, childId, parent);
    readopted.push(childId);
  }
  if (readopted.length > 0) {
    noteTreeChangeReason(
      `重挂被提升的子标签 → #${parent}：${readopted.map((id) => `#${id}`).join("，")}` +
        (skipped.length > 0 ? `｜跳过：${skipped.map((item) => `#${item.tabId}（${item.reason}）`).join("，")}` : "")
    );
    markDirty(winId);
  } else if (skipped.length > 0) {
    noteTreeChangeReason(
      `重挂被提升的子标签 → #${parent}：全部跳过（${skipped.map((item) => `#${item.tabId}：${item.reason}`).join("；")}）`
    );
  }
  return { readopted, skipped };
}

/**
 * 用一次真实查询重建某窗口的下标表，并返回实时的 `tabId -> 物理下标` 映射。
 *
 * 为什么需要它：`indexById` 平时与物理顺序一致（插入/移动/删除都会维护），但它只反映
 * "事件到达时的顺序"——事件被丢弃或刚对齐过时可能与物理事实不一致；
 * 撤销关闭要判断"父标签是否真的排在子标签之前"，必须依据一次实时查询。
 */
export async function refreshTreeIndexes(windowId) {
  const winId = Number(windowId);
  if (!Number.isFinite(winId)) {
    return new Map();
  }
  const tabs = await queryWindowTabs(winId);
  const tree = trees.get(winId);
  if (tree) {
    rebuildIndexes(tree, tabs);
  }
  return new Map(tabs.map((tab) => [Number(tab.id), Number(tab.index)]));
}

/** 取某标签的整棵子树（含自身）的 tabId 列表，供「关闭整棵子树」使用。 */
export async function collectSubtreeTabIds(windowId, tabId) {
  const winId = Number(windowId);
  const id = Number(tabId);
  if (!Number.isFinite(winId) || !Number.isFinite(id)) {
    return [];
  }
  const tree = await ensureTree(winId);
  if (!tree || !tree.parentById.has(id)) {
    return [id];
  }
  return collectSubtreeIds(tree, id);
}

/**
 * 把一批标签按给定顺序连续移动到 startIndex。
 *
 * 与 moveTabTree 的区别：这里不推断父子关系，只负责"按顺序排好物理位置"（撤销恢复用），
 * 同时同步内存下标表——否则后续基于下标排序的操作（promote 的"第一个子标签"）会用到过期数据。
 */
export async function moveTabsInternallyTo(windowId, orderedTabIds, startIndex) {
  const winId = Number(windowId);
  const ids = Array.isArray(orderedTabIds) ? orderedTabIds.map(Number).filter(Number.isFinite) : [];
  if (!Number.isFinite(winId) || ids.length === 0) {
    return { moved: 0, skipped: 0 };
  }
  const tree = trees.get(winId);
  const position = Number.isFinite(startIndex) ? Math.max(0, Math.floor(startIndex)) : -1;
  const result = await moveTabsInternally(ids, winId, position);
  if (tree && position >= 0) {
    const movedSet = new Set(ids);
    const rest = [...tree.indexById.entries()]
      .filter(([id]) => !movedSet.has(id))
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
    const insertAt = Math.max(0, Math.min(position, rest.length));
    rest.splice(insertAt, 0, ...ids);
    tree.indexById = new Map(rest.map((id, index) => [id, index]));
  }
  return result;
}

/**
 * 等到这些标签都被登记进内存树（下标表里出现）。
 *
 * 用途：撤销恢复会先创建标签、再套用父子关系；而 `tabs.onCreated` 是异步派发的，
 * 若不等这一步，恢复逻辑写好的父标签可能被随后到达的创建事件覆盖成顶层。
 */
export async function waitUntilTabsTracked(windowId, tabIds, timeoutMs = 2000) {
  const winId = Number(windowId);
  const ids = Array.isArray(tabIds) ? tabIds.map(Number).filter(Number.isFinite) : [];
  if (!Number.isFinite(winId) || ids.length === 0) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tree = trees.get(winId);
    if (tree && ids.every((id) => tree.indexById.has(id))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(20);
  }
}
