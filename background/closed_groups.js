// 撤销关闭（关闭记录 + 整组恢复）。
//
// 两条能力：
// 1) 单标签：浏览器原生「重新打开已关闭的标签页」（Ctrl+Shift+T / 原生右键菜单）恢复单个标签时，
//    把它挂回原父节点与原物理位置；
// 2) 关闭组：本插件自己发起的批量关闭（关闭整棵子树 / 多选批量关闭 / 保存后关闭）记为一个「关闭组」，
//    「撤销关闭」把整组标签连同父子层级、兄弟顺序与物理位置一起恢复。
//
// 为什么可以直接存 tabId 做引用：
//   同一浏览器会话内 tabId 不复用，而记录只存活于 chrome.storage.session（浏览器重启即清空），
//   因此不需要 Tree Style Tab 那种跨会话的 uniqueId 稳定身份映射——这是「只做会话内撤销」换来的简化。
//
// 识别「这是一次撤销关闭」的两条路径：
//   - Firefox：sessions.setTabValue / getTabValue 是**每标签**的会话值，能精确识别（本文件在结构变化时写入）；
//   - Chrome：没有等价 API，只能用「关闭记录栈顶 + URL 全等 + 有效期」启发式识别。
//   两者最终动作相同：挂回原父节点，再移回原物理位置。
//
// 出口约定：整组恢复会调用 chrome.tabs.move 调整物理位置。这是用户显式点击「撤销关闭」的结果，
// 属于「插件只在用户操作时移动标签页」这条约定的允许范围（见 docs/ui/tree_style_tabs.md）。

import {
  CLOSED_GROUPS_KEY,
  CLOSED_LOG_KEY,
  TREE_COLLAPSED_KEY,
} from "./constants.js";
import { getCachedTabInfo, getCachedTabNeighbors } from "./recent_tabs.js";
import { storageSessionGet, storageSessionSet } from "./storage.js";
import {
  applyRestoredParent,
  collectSubtreeTabIds,
  ensureTreeFor,
  getChildTabIds,
  getTabStructureInfo,
  moveTabsInternallyTo,
  readoptPromotedChildren,
  refreshTreeIndexes,
  setStructureRefsHook,
  setUndoDetectProvider,
  waitUntilTabsTracked,
} from "./tree.js";
import { isTreeDebugPrintEnabled, logFlow } from "./tree_debug.js";
import { delay } from "./utils.js";

// ---------------------------------------------------------------------------
// 调参常量
// ---------------------------------------------------------------------------

// 单标签关闭记录栈的容量与有效期。有效期存在的意义：Chrome 侧只能靠 URL 匹配识别撤销，
// 太久以前的记录容易与"用户手动打开了同一个 URL"混淆。
const CLOSED_LOG_MAX = 50;
const CLOSED_LOG_TTL_MS = 5 * 60 * 1000;
// 关闭组栈的容量；单组超过成员上限时降级为「只记成员、不记结构」，
// 避免一次关掉整棵大树把 storage.session 的配额撑爆。
const CLOSED_GROUP_MAX = 5;
const GROUP_MAX_MEMBERS = 500;
// Firefox 每标签会话值的键名与写入防抖。
const TAB_REF_KEY = "nesoi:tree-ref";
const TAB_REF_DEBOUNCE_MS = 250;
// 单个标签恢复（sessions.restore / tabs.create）等待创建事件的超时。
const RESTORE_TAB_TIMEOUT_MS = 4000;
// 批量关闭的分批大小与间隔（与前端 helpers.removeTabsInBatches 同一口径）。
const REMOVE_BATCH_SIZE = 100;
const REMOVE_BATCH_GAP_MS = 150;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

// 关闭记录与关闭组都是**栈**：下标 0 是最新的一次。内存里维持一份，
// 每次变更整体写回 storage.session——记录量很小（日志 50 条 / 组 5 条），不值得做增量。
let closedTabLog = [];
let closedGroups = [];
let restorableGroupCount = 0;

// 记录载入只做一次；所有读写入口都先 await 它，避免"还没载入就把旧记录覆盖掉"。
let loadPromise = null;
// 临时诊断用：关闭记录栈是否已经从 storage.session 载入完成。
let closedLogLoaded = false;
// 写盘串行化：storage.session.set 是异步的，并发写会互相覆盖。
let writeChain = Promise.resolve();

// 正在被本插件批量关闭的标签：用于在关闭事件的记录里打上 groupId。
let pendingGroupClose = null;

// 正在由「撤销关闭」自己创建的标签 URL：这些标签的父标签由恢复流程统一套用，
// 不能让 onCreated 的默认规则先定下来（否则会与恢复流程互相覆盖）。
// 用计数而不是集合：同一组里可能有多个相同 URL 的标签（例如连续几个新标签页）。
const pendingCreatedUrls = new Map();
const PENDING_CREATED_URL_TTL_MS = 10000;

// 结构变化 → 刷新 Firefox 每标签会话值的防抖任务：windowId -> Set<tabId>。
const pendingTabRefTabs = new Map();
let tabRefTimer = null;

/**
 * 判断一个值是不是有效的标签 id。
 *
 * **必须显式排除 `null` / `undefined`**：`Number(null) === 0`，若用 `Number.isFinite(Number(value))` 判断，
 * 顶层标签（`parentId = null`）会被误判成"父标签 #0"，进而把 `null` 语义写成 `0`——
 * 关门组记录里就会出现假父标签 `#0`，下游只能靠"这个父标签不存在"侥幸兜住。
 */
function isFiniteId(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }
  return Number.isFinite(Number(value));
}

/**
 * Firefox 专有的每标签会话值 API（`sessions.setTabValue` / `getTabValue`），否则 null。
 *
 * 为什么优先 `browser.*` 并且**只按 Promise 调用**：实测在 Firefox 下
 * `chrome.sessions.setTabValue(tabId, key, value, callback)` 这类回调形式不生效——
 * 写入看似成功（回调被调用、无 lastError）、回读却永远是空，异常还会被 try/catch 吞掉，
 * 于是"精确识别撤销关闭"的权威判据永远不存在，认领只能静默退回默认规则。
 * `browser.sessions.*` 是标准的 Promise 形式，行为可预期；`chrome.*` 仅作为兜底（同样按 Promise 调用）。
 */
function sessionsRefApi() {
  if (
    typeof browser !== "undefined" &&
    browser &&
    browser.sessions &&
    typeof browser.sessions.setTabValue === "function" &&
    typeof browser.sessions.getTabValue === "function"
  ) {
    return browser.sessions;
  }
  if (
    typeof chrome !== "undefined" &&
    chrome.sessions &&
    typeof chrome.sessions.setTabValue === "function" &&
    typeof chrome.sessions.getTabValue === "function"
  ) {
    return chrome.sessions;
  }
  return null;
}

/** 本环境是否**存在**每标签会话值 API（是否**可用**还要看自检，见 tabRefsVerified）。 */
function supportsTabRefs() {
  return Boolean(sessionsRefApi());
}

// 会话值机制的可用性：null = 尚未自检，true = 自检通过，false = 自检失败（不再依赖它）。
let tabRefsVerified = null;
let tabRefsSelfCheck = null;
const TAB_REF_SELF_KEY = "nesoi:tree-ref-probe";

function logDebug(...args) {
  // 记录里含 URL 与标题（属于用户数据），因此只在明确需要排查时打开。
  if (typeof console !== "undefined" && logDebug.enabled) {
    console.log("[closed_groups]", ...args);
  }
}
logDebug.enabled = false;

// ---------------------------------------------------------------------------
// 临时诊断（定位"原生撤销关闭认领失败"的原因，排查结束即删）
//
// 只在调试打印开关打开时输出（与 [Nesoi树·*] 同一开关、同一日志缓冲），
// 因此正式使用与单元测试都不受影响。内容刻意**不含 URL 正文**：
// 只输出 tabId、布尔值、URL 的粗分类（空 / about:* / http(s) / 其它）。
// ---------------------------------------------------------------------------

/**
 * 写一条诊断日志；调试打印开关关闭时暂存下来，等开关就绪后补打。
 *
 * 为什么要暂存：后台（事件页/Service Worker）刚被唤醒时，调试配置还在异步载入，
 * 而"后台刚被回收"恰好是我们要排查的一种成因（关闭记录栈可能还没载入完）。
 * 直接丢弃的话，最关键的现场就没了。
 */
const diagBacklog = [];
function diag(message) {
  if (!isTreeDebugPrintEnabled()) {
    diagBacklog.push(`[撤销诊断] ${message}`);
    if (diagBacklog.length > 200) {
      diagBacklog.shift();
    }
    return;
  }
  while (diagBacklog.length > 0) {
    logFlow(diagBacklog.shift());
  }
  logFlow(`[撤销诊断] ${message}`);
}

/** URL 粗分类：既能区分"onCreated 没给 url"，又不泄露用户数据。 */
function classifyUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return "空";
  }
  if (url.startsWith("about:")) {
    return "about:*";
  }
  if (/^https?:/i.test(url)) {
    return "http(s)";
  }
  return "其它协议";
}

/** 把父标签渲染成诊断文本。 */
function describeParent(parentId) {
  return isFiniteId(parentId) ? `#${Number(parentId)}` : "顶层";
}

/** 读一次会话值并渲染成诊断文本（不含 URL）。 */
async function describeStoredRef(tabId) {
  const stored = await getTabValue(Number(tabId), TAB_REF_KEY);
  if (!stored || typeof stored !== "object") {
    return "无";
  }
  return describeParent(stored.parentId);
}

// ---------------------------------------------------------------------------
// 载入与持久化
// ---------------------------------------------------------------------------

function sanitizeLog(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((record) => record && isFiniteId(record.tabId)).slice(0, CLOSED_LOG_MAX);
}

function sanitizeGroups(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((group) => group && typeof group.groupId === "string" && Array.isArray(group.members))
    .slice(0, CLOSED_GROUP_MAX);
}

/** 从会话存储载入记录（幂等）。 */
export function ensureClosedGroupsLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const [log, groups] = await Promise.all([
        storageSessionGet(CLOSED_LOG_KEY),
        storageSessionGet(CLOSED_GROUPS_KEY),
      ]);
      closedTabLog = sanitizeLog(log);
      closedGroups = sanitizeGroups(groups);
      restorableGroupCount = closedGroups.length;
      closedLogLoaded = true;
    })();
  }
  return loadPromise;
}

/** 把当前内存状态写回会话存储（串行，避免并发覆盖）。 */
function persist() {
  restorableGroupCount = closedGroups.length;
  writeChain = writeChain
    .then(() =>
      storageSessionSet({
        [CLOSED_LOG_KEY]: closedTabLog,
        [CLOSED_GROUPS_KEY]: closedGroups,
      })
    )
    .catch(() => {});
  return writeChain;
}

/**
 * 初始化撤销关闭系统。
 * 必须在后台脚本顶层（而不是 onStartup）调用：storage.session 能跨 Service Worker 回收存活，
 * 但内存缓存每次 SW 冷启动都是空的，需要重新读回来。
 */
export function initializeClosedGroups() {
  // 同步注册钩子：tabs.onCreated / 落盘纠偏可能在载入完成前就到达。
  // - undoDetectProvider：新建标签完成同步落位后，由本模块在判定窗口内异步确认"是不是撤销恢复"；
  // - structureRefsHook：结构被静默纠偏改写后，把新的父写回每标签会话值。
  setUndoDetectProvider(scheduleUndoDetect);
  setStructureRefsHook(handleTabStructureChanged);
  // 会话值机制的写读自检：失败就永久放弃这条路径（不再"假装权威"）。
  void ensureTabRefsVerified();
  return ensureClosedGroupsLoaded();
}

// ---------------------------------------------------------------------------
// 记录关闭
// ---------------------------------------------------------------------------

/**
 * 记录一次标签关闭的现场。
 *
 * **现场必须在函数返回前同步抓完**（因此本函数虽然有异步的持久化，但抓取部分是同步的）：
 * 调用方在 `tabs.onRemoved` 里紧接着就会执行"关闭提升"改写树、并删除 recent_tabs 的标签缓存，
 * 只要中间插入一个 await，父标签与 url/标题就可能已经取不到了。
 *
 * @param {number} tabId
 * @param {{windowId: number, isWindowClosing?: boolean}} removeInfo
 */
export function handleClosedTabRecorded(tabId, removeInfo = {}) {
  // 整窗关闭不做记录：窗口都没了，撤销没有意义（与树快照的清理口径一致）。
  if (removeInfo.isWindowClosing) {
    return Promise.resolve();
  }
  const id = Number(tabId);
  const windowId = Number(removeInfo.windowId);
  if (!Number.isFinite(id) || !Number.isFinite(windowId)) {
    return Promise.resolve();
  }

  const info = getTabStructureInfo(id, windowId);
  const cached = getCachedTabInfo(id);
  // 树没进内存时（后台刚被回收，或本轮事件早于懒加载）拿不到结构现场。
  // 此时用全量标签缓存兜底出下标与前后邻居：原生撤销关闭才能把标签放回原位，
  // 否则记录里是 index = -1、邻居全空，恢复出来的位置只能听天由命。
  const fallback = info ? null : getCachedTabNeighbors(id);
  // 关闭的是父标签时，记下它的直属子标签：撤销恢复它时要把"仍停在提升结果位置"的子标签重挂回去
  // （否则 `A - B - C` 撤销后只会得到 `A / B-C`）。
  // 注意：**提升还没发生**（调用方紧接着才执行提升），因此这里只记 id，
  // 提升后的父在下面的 .then（微任务，提升已完成）里补。
  const childIds = info ? getChildTabIds(id, windowId) : [];
  const record = {
    tabId: id,
    windowId,
    parentId: info ? info.parentId : null,
    prevId: info ? info.prevId : (fallback ? fallback.prevId : null),
    nextId: info ? info.nextId : (fallback ? fallback.nextId : null),
    index: info && Number.isFinite(info.index) ? info.index : (fallback ? fallback.index : -1),
    pinned: cached ? Boolean(cached.pinned) : false,
    url: cached ? cached.url || "" : "",
    title: cached ? cached.title || "" : "",
    at: Date.now(),
    groupId: pendingGroupClose && pendingGroupClose.tabIds.has(id) ? pendingGroupClose.groupId : null,
    // 直属子标签在"promote intelligently"之后各自被挂到哪里（null = 被提升为顶层）。
    promotedChildren: childIds.map((childId) => ({ tabId: childId, parentId: null })),
  };
  // 临时诊断：关闭那一刻，记录里的父与 Firefox 会话值里的父是否一致。
  // 若"记录父=顶层、会话值父=#X"，说明会话值被后来的结构变化写脏了。
  if (isTreeDebugPrintEnabled() && supportsTabRefs()) {
    describeStoredRef(id).then((refParent) => {
      diag(
        `关闭 #${id}：记录父=${describeParent(record.parentId)}，URL=${classifyUrl(record.url)}，` +
          `记录下标=${record.index}，子标签数=${childIds.length}，会话值父=${refParent}`
      );
    });
  } else if (!supportsTabRefs()) {
    diag(
      `关闭 #${id}：记录父=${describeParent(record.parentId)}，URL=${classifyUrl(record.url)}，` +
        `记录下标=${record.index}，子标签数=${childIds.length}（本浏览器无每标签会话值）`
    );
  }
  return ensureClosedGroupsLoaded().then(() => {
    // 这个 .then 是微任务，调用方（tabs.onRemoved 的处理链）已经同步跑完"关闭提升"，
    // 因此此刻才能读到子标签被挂到了哪里。
    fillPromotedChildren(record, windowId);
    closedTabLog = [record, ...closedTabLog].slice(0, CLOSED_LOG_MAX);
    persist();
  });
}

/**
 * 补齐 `promotedChildren`：记录每个直属子标签在提升之后的父（`null` = 顶层）。
 * 已被一并关闭 / 不在树里的子标签直接剔除（撤销时也没有重挂的必要）。
 */
function fillPromotedChildren(record, windowId) {
  const entries = [];
  for (const item of record.promotedChildren || []) {
    const childId = Number(item && item.tabId);
    if (!Number.isFinite(childId)) {
      continue;
    }
    const current = getTabStructureInfo(childId, windowId);
    if (!current) {
      continue;
    }
    entries.push({ tabId: childId, parentId: current.parentId ?? null });
  }
  record.promotedChildren = entries;
}

/**
 * 结构变化后刷新 Firefox 的每标签会话值。
 *
 * @param {number} windowId
 * @param {number[]|null} tabIds 受影响的标签；传 null 表示"该窗口所有标签"（代价 O(n)，只在关闭父标签时用）。
 */
export function handleTabStructureChanged(windowId, tabIds = null) {
  // 自检已判定不可用时不再做无意义的防抖写入（应用户要求：不"假装权威"、不空转）。
  if (!tabRefsUsable()) {
    return;
  }
  const winId = Number(windowId);
  if (!Number.isFinite(winId)) {
    return;
  }
  const pending = pendingTabRefTabs.get(winId) || { all: false, ids: new Set() };
  if (tabIds === null) {
    pending.all = true;
  } else {
    for (const id of tabIds) {
      if (isFiniteId(id)) {
        pending.ids.add(Number(id));
      }
    }
  }
  pendingTabRefTabs.set(winId, pending);
  if (tabRefTimer) {
    clearTimeout(tabRefTimer);
  }
  tabRefTimer = setTimeout(flushTabRefs, TAB_REF_DEBOUNCE_MS);
}

/**
 * 把待刷新标签的父标签写进每标签会话值。
 *
 * 语义说明：这些值只在 Firefox 下存在。它的作用**不是**记录完整的现场（父/邻居/下标在关闭那一刻
 * 已经由 closedTabLog 记全），而是提供一个"这个新建标签确实是被撤销关闭恢复回来的"的**权威判据**：
 * Chrome 只能靠 URL 猜，Firefox 能精确区分"撤销关闭"与"用户手动打开了同一个 URL"，
 * 并顺带给出比关闭记录更新的父标签。写不进去（标签已关闭）会被静默忽略——
 * 恢复端拿不到值时退回默认规则，不会破坏任何现有结构。
 *
 * **必须先确保树已加载**：本函数从内存树读父标签，而它是在结构事件后防抖触发的；
 * 若此刻窗口的树还没进内存（后台刚被回收、或标签创建与树加载的 500ms 防抖撞在一起），
 * 旧实现会对每个标签静默 return，于是这些标签永远没有会话值——表现为
 * 「原生撤销关闭后标签回到顶层、而不是原父之下」。因此这里统一先 ensureTreeFor。
 */
async function flushTabRefs() {
  tabRefTimer = null;
  const tasks = [...pendingTabRefTabs.entries()];
  pendingTabRefTabs.clear();
  for (const [windowId, pending] of tasks) {
    // 两种情况都要先把树准备好：pending.all 需要遍历树里的标签，pending.ids 也需要
    // getTabStructureInfo 能查到父标签。树加载失败（窗口已不存在）时直接跳过。
    const tree = await ensureTreeFor(windowId);
    if (!tree) {
      continue;
    }
    const ids = (pending.all ? [...tree.parentById.keys()] : [...pending.ids]).filter(
      // 正在做撤销判定的标签**先不写**：判定要读 Firefox 从被关闭标签恢复过来的会话值，
      // 我们自己写的值会把它覆盖掉，判定就再也拿不到真正的依据（判定结束后见 finishUndoDetect）。
      (tabId) => !pendingUndoDetects.has(`${windowId}:${tabId}`)
    );
    await Promise.all(
      ids.map(async (tabId) => {
        const info = getTabStructureInfo(tabId, windowId);
        if (!info) {
          return;
        }
        await setTabValue(tabId, TAB_REF_KEY, { parentId: info.parentId, at: Date.now() });
      })
    );
  }
}

// ---------------------------------------------------------------------------
// 关闭组：记录
// ---------------------------------------------------------------------------

/**
 * 关闭一批标签并记为一个「关闭组」。
 *
 * 只有本插件发起的批量关闭才应该走这里：管理页/侧边栏的批量关闭、「关闭整棵子树」、保存后关闭。
 * 单标签关闭（行内 ×、中键、Ctrl+W）不要走这里，它只进 closedTabLog。
 *
 * @param {number} windowId 目标窗口
 * @param {number[]} tabIds 要关闭的标签（会被去重、过滤掉已不存在的）
 * @param {string} label 供 UI 提示的组名，例如「关闭的子树 · 3 个标签页」
 * @param {{subtreeOf?: number}} options subtreeOf 为标签 id 时改为关闭它的整棵子树
 * @returns {Promise<{ok: boolean, groupId?: string, removed?: number, skipped?: number, error?: string}>}
 */
export async function closeTabsAsGroup(windowId, tabIds, label, options = {}) {
  await ensureClosedGroupsLoaded();
  const requestedWindowId = Number(windowId);

  let ids = Array.isArray(tabIds) ? tabIds.map(Number).filter(Number.isFinite) : [];
  if (isFiniteId(options.subtreeOf)) {
    if (!Number.isFinite(requestedWindowId)) {
      return { ok: false, error: "窗口参数无效。" };
    }
    ids = await collectSubtreeTabIds(requestedWindowId, Number(options.subtreeOf));
  }
  ids = [...new Set(ids)];
  if (ids.length === 0) {
    return { ok: false, error: "没有可关闭的标签页。" };
  }

  // 以关闭前的实际状态为准构造成员表。
  // 成员可以来自**多个窗口**（管理页「全部窗口」与侧边栏固定标签区的多选都会跨窗口），
  // 因此每个成员各自记住自己的 windowId；组内排序按「窗口 + 物理下标」，
  // 同一窗口内天然满足"父在子之前"，恢复时按顺序重建即可满足不变量。
  const tabs = (await Promise.all(ids.map(getTabInfo))).filter(Boolean);
  if (tabs.length === 0) {
    return { ok: false, error: "没有可关闭的标签页。" };
  }
  tabs.sort((a, b) => (Number(a.windowId) - Number(b.windowId)) || (Number(a.index) - Number(b.index)));

  const structureKnown = tabs.length <= GROUP_MAX_MEMBERS;
  const positionById = new Map(tabs.map((tab, index) => [Number(tab.id), index]));
  const collapsedSets = new Map();
  for (const tab of tabs) {
    const winId = Number(tab.windowId);
    if (!collapsedSets.has(winId)) {
      collapsedSets.set(winId, await loadCollapsedSet(winId));
    }
  }

  const members = tabs.map((tab) => {
    const id = Number(tab.id);
    const winId = Number(tab.windowId);
    const cached = getCachedTabInfo(id);
    // 结构快照与标题都取自关闭前：关闭事件的顺序无法保证，因此这里一次性算好。
    const info = structureKnown ? getTabStructureInfo(id, winId) : null;
    const parentId = info ? info.parentId : null;
    const parentInGroup = structureKnown && parentId !== null && positionById.has(parentId);
    return {
      tabId: id,
      windowId: winId,
      url: cached ? cached.url || "" : tab.url || "",
      title: cached ? cached.title || "" : tab.title || "",
      index: Number(tab.index),
      // parentIndex：父也在这一组里时的组内下标（-1 表示父不在这组里）。
      parentIndex: parentInGroup ? positionById.get(parentId) : -1,
      // parentId：父不在这一组里时的绝对 tabId，用于"关掉几个子标签后仍挂回原父"。
      parentId: structureKnown && parentId !== null && !parentInGroup ? parentId : null,
      // 原物理前后邻居：恢复时用来把标签放回原位附近。
      // 只用"绝对下标"回落是不行的——这期间标签栏早就变了，那个下标可能指向毫不相干的位置。
      prevId: info ? info.prevId : null,
      nextId: info ? info.nextId : null,
      pinned: Boolean(tab.pinned),
      collapsed: collapsedSets.get(winId).has(id),
    };
  });

  // 组自身的 windowId 只用于"恢复时窗口都不在了"的兜底：优先用调用方指定的窗口，
  // 否则用成员最多的那个窗口。
  const memberCountByWindow = new Map();
  for (const member of members) {
    memberCountByWindow.set(member.windowId, (memberCountByWindow.get(member.windowId) || 0) + 1);
  }
  const primaryWindowId = Number.isFinite(requestedWindowId) && memberCountByWindow.has(requestedWindowId)
    ? requestedWindowId
    : [...memberCountByWindow.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const group = {
    groupId: `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    windowId: primaryWindowId,
    at: Date.now(),
    label: label || `关闭的 ${members.length} 个标签页`,
    structure: structureKnown,
    members,
  };
  closedGroups = [group, ...closedGroups].slice(0, CLOSED_GROUP_MAX);
  persist();

  pendingGroupClose = { groupId: group.groupId, tabIds: new Set(members.map((member) => member.tabId)) };
  let result;
  try {
    result = await removeTabsInBatches(members.map((member) => member.tabId));
  } finally {
    pendingGroupClose = null;
  }

  // 剔除"其实没被关掉"的成员（beforeunload 会取消关闭），否则撤销时会重复打开它们。
  const stillOpen = new Set(
    (await Promise.all(members.map((member) => getTabInfo(member.tabId))))
      .filter(Boolean)
      .map((tab) => Number(tab.id))
  );
  if (stillOpen.size > 0) {
    group.members = group.members.filter((member) => !stillOpen.has(member.tabId));
    if (group.members.length === 0) {
      closedGroups = closedGroups.filter((item) => item !== group);
    } else {
      rebuildParentIndexes(group);
    }
    persist();
  }

  logDebug("closeTabsAsGroup", group.groupId, result);
  return { ok: true, groupId: group.groupId, removed: result.removed, skipped: result.skipped };
}

/** 成员被剔除后重算组内父下标：父也被剔除时，该项退回"用绝对 parentId 或顶层"。 */
function rebuildParentIndexes(group) {
  const positionById = new Map(group.members.map((member, index) => [member.tabId, index]));
  for (const member of group.members) {
    if (member.parentIndex < 0) {
      continue;
    }
    const previousParent = group.members[member.parentIndex];
    if (previousParent && positionById.has(previousParent.tabId)) {
      member.parentIndex = positionById.get(previousParent.tabId);
    } else {
      member.parentIndex = -1;
      member.parentId = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 单标签撤销：延迟判定 + 套用
//
// 为什么要"延迟判定"而不是在 tabs.onCreated 的同步阶段认领：
// 识别依据（Firefox 每标签会话值、标签的真实 URL）在这一刻都拿不到——
// Firefox 撤销恢复出来的标签在 onCreated 时 url = "about:blank"、没有 pendingUrl，
// 而关闭记录里存的是真实 URL，同步做 URL 全等匹配必然失败；会话值读取本身也是异步的。
// 因此改成：tree.js 先做**同步的合法落位**（永不产生非法父），随后调用本模块的判定钩子，
// 在 UNDO_DETECT_WINDOW_MS 内轮询两条依据，命中就把父关系与物理位置纠正为关闭记录的现场。
// ---------------------------------------------------------------------------

/** 判定窗口：超过这个时间还没命中就保持同步落位的结果（普通新标签不会有额外延迟以外的行为差异）。 */
const UNDO_DETECT_WINDOW_MS = 500;
/** 轮询节奏（毫秒，累计），覆盖"会话值/真实 URL 稍后才就绪"的情况。 */
const UNDO_DETECT_PROBE_DELAYS = [0, 60, 150, 300, 460];

/** 正在判定的新建标签：`windowId:tabId` -> { tabId, windowId, startedAt }。 */
const pendingUndoDetects = new Map();

/**
 * 登记一次「这个新建标签是不是撤销恢复」的判定（由 tree.js 在同步落位之后调用）。
 *
 * 必须是同步返回、不能阻塞落位：真正的轮询在 runUndoDetect 里异步进行。
 */
export function scheduleUndoDetect(tab, windowId) {
  const tabId = Number(tab && tab.id);
  const winId = Number(windowId);
  if (!Number.isFinite(tabId) || !Number.isFinite(winId)) {
    return;
  }
  // 本插件自己正在恢复关闭组：这些标签的父子关系由恢复流程统一套用，
  // 既不能套用默认规则，也**不能**把它们误判成原生撤销去消费关闭记录。
  // 因此这里只消费登记项并结束（与旧实现在同步认领里"占住顶层"等价，但不再需要抢跑）。
  const createdUrl = normalizeUrl(tab.url || tab.pendingUrl || "");
  if (pendingCreatedUrls.size > 0) {
    prunePendingCreatedUrls();
    const pending = createdUrl ? pendingCreatedUrls.get(createdUrl) : null;
    if (pending && pending.count > 0) {
      pending.count -= 1;
      if (pending.count <= 0) {
        pendingCreatedUrls.delete(createdUrl);
      }
      diag(`判定跳过 #${tabId}：本插件正在恢复关闭组（这条标签的父由恢复流程套用）`);
      return;
    }
  }
  if (!shouldScheduleUndoDetect()) {
    return;
  }
  const key = `${winId}:${tabId}`;
  if (pendingUndoDetects.has(key)) {
    return;
  }
  pendingUndoDetects.set(key, { tabId, windowId: winId, startedAt: Date.now() });
  void runUndoDetect(key);
}

/**
 * 值不值得开一次判定：既没有会话值机制、也没有未过期的关闭记录时完全没必要。
 * 关闭记录还没从 storage.session 载入完时不能过早放弃（那正是"后台刚被回收"的场景）。
 */
function shouldScheduleUndoDetect() {
  if (tabRefsUsable()) {
    return true;
  }
  if (!closedLogLoaded) {
    return true;
  }
  const now = Date.now();
  return closedTabLog.some((record) => record && now - Number(record.at || 0) <= CLOSED_LOG_TTL_MS);
}

/**
 * 结束一次判定（成功/超时/标签消失都走这里）。
 *
 * 结束时补写一次会话值：判定期间我们**故意不写**这个标签的引用（见 flushTabRefs），
 * 否则自己刚写的值会把"Firefox 恢复过来的值"覆盖掉，判定就再也读不到真正的依据。
 */
function finishUndoDetect(key) {
  const state = pendingUndoDetects.get(key);
  pendingUndoDetects.delete(key);
  if (state) {
    handleTabStructureChanged(state.windowId, [state.tabId]);
  }
}

/**
 * 轮询判定：命中"会话值"或"真实 URL 匹配关闭记录"就套用撤销恢复。
 *
 * 命中依据的优先级：
 * 1. **Firefox 每标签会话值**（自检通过时）——它精确回答"这是不是撤销恢复"，
 *    因此即使关闭记录已经过期/被消费，也能用值里的父把层级救回来；
 * 2. **真实 URL 全等匹配 `closedTabLog`**（Chrome 的主路径、Firefox 会话值不可用时的兜底）——
 *    必须等 URL 就绪（onCreated 时是 about:blank），并用 TTL 限制误判。
 */
async function runUndoDetect(key) {
  const state = pendingUndoDetects.get(key);
  if (!state) {
    return;
  }
  const { tabId, windowId, startedAt } = state;
  const deadline = startedAt + UNDO_DETECT_WINDOW_MS;
  try {
    await ensureClosedGroupsLoaded();
    const refsUsable = await ensureTabRefsVerified();
    const stackText = closedTabLog.length > 0
      ? `关闭记录栈 ${closedTabLog.length} 条（最新 #${closedTabLog[0].tabId}，${Math.round((Date.now() - Number(closedTabLog[0].at || 0)) / 1000)}s 前）`
      : `关闭记录栈空（已载入=${closedLogLoaded}）`;
    diag(`判定开始 #${tabId}：会话值可用=${refsUsable}，${stackText}`);

    for (const waitMs of UNDO_DETECT_PROBE_DELAYS) {
      if (waitMs > 0) {
        await delay(waitMs);
      }
      if (Date.now() > deadline || !pendingUndoDetects.has(key)) {
        break;
      }
      const tab = await getTabInfo(tabId);
      if (!tab || Number(tab.windowId) !== windowId) {
        diag(`判定中止 #${tabId}：标签已不存在或已换窗口`);
        finishUndoDetect(key);
        return;
      }
      // ① 会话值（精确判据）
      if (refsUsable) {
        const stored = await getTabValue(tabId, TAB_REF_KEY);
        if (stored && typeof stored === "object" && isOwnRefWrite(stored, startedAt)) {
          // 本插件自己刚给这个新标签写下的引用（每 250ms 防抖刷新一次），
          // 它只能说明"我们给它定了什么父"，**不能**当作"Firefox 撤销恢复了它"的证据。
          diag(`判定继续 #${tabId}：读到的会话值是本插件创建之后写的 → 不算撤销证据`);
        } else if (stored && typeof stored === "object") {
          const record = takeRecordForTab(tab);
          diag(
            `判定命中 #${tabId}：依据=会话值（会话值父=${describeParent(stored.parentId)}，` +
              `关闭记录=${record ? `#${record.tabId}` : "无"}）`
          );
          await applyUndoRestore(tab, record, stored);
          finishUndoDetect(key);
          return;
        }
      }
      // ② 真实 URL（等它就绪）
      const url = normalizeUrl(tab.url || tab.pendingUrl || "");
      if (url && !isPlaceholderUrl(url)) {
        const record = takeRecordForTab(tab, url);
        if (record) {
          diag(`判定命中 #${tabId}：依据=URL 记录 #${record.tabId}（真实 URL 已就绪）`);
          await applyUndoRestore(tab, record, null);
          finishUndoDetect(key);
          return;
        }
        // URL 已确定且没有任何记录匹配，且页面已经加载完成 → 不必再等到判定窗口结束。
        if (tab.status === "complete") {
          diag(`判定结束 #${tabId}：真实 URL 不匹配任何关闭记录（status=complete）→ 保持同步落位`);
          finishUndoDetect(key);
          return;
        }
        diag(`判定继续 #${tabId}：真实 URL 就绪但不匹配记录（url=${classifyUrl(url)}）`);
      } else {
        diag(`判定继续 #${tabId}：URL 仍是占位地址（${classifyUrl(url)}），等待真实 URL / 会话值`);
      }
    }
    diag(`判定超时 #${tabId}：判定窗口内未命中 → 保持同步落位`);
    finishUndoDetect(key);
  } catch (error) {
    // 判定是尽力而为：任何异常都不能影响已经完成的落位。
    diag(`判定异常 #${tabId}：${String(error && error.message ? error.message : error)}`);
    finishUndoDetect(key);
  }
}

/** 占位地址（about:blank / 新标签页等）：不能拿它去和关闭记录做 URL 匹配。 */
function isPlaceholderUrl(url) {
  return /^(about:(blank|newtab|home|sessionrestore|welcome)|chrome:\/\/(newtab|new-tab-page))/i.test(
    normalizeUrl(url)
  );
}

/**
 * 这个会话值是不是**本插件在这次创建之后**自己写下的（而不是 Firefox 从被关闭标签那里恢复过来的）。
 *
 * 判据是写入时间：会话值里带 `at`（写入时刻），判定状态里带 `startedAt`（这个标签的创建时刻）。
 * 我们自己写的值必然 `at >= startedAt`；而 Firefox 撤销恢复带过来的值来自被关闭标签的一生，
 * 必然早于新标签的创建时刻。没有这道判断时，**每个**新标签在 250ms 后都会因为"自己写的引用"
 * 被误判成撤销恢复（日志里表现为"判定命中：依据=会话值"），并因此提前结束判定、
 * 把真正该走的 URL 兜底路径跳过。
 */
function isOwnRefWrite(stored, createdAt) {
  const at = Number(stored && stored.at);
  return Number.isFinite(at) && Number.isFinite(createdAt) && at >= createdAt;
}

/**
 * 从关闭记录栈里取出与这个标签对应的记录（取出即出栈：同一条记录不会被两次撤销复用）。
 *
 * 匹配口径：URL 全等 + 未过期。URL 缺省时用标签当前的真实 URL（调用方已确认它不是占位地址）。
 * @returns {object|null}
 */
function takeRecordForTab(tab, url = null) {
  const target = normalizeUrl(url || tab.url || tab.pendingUrl || "");
  if (!target || isPlaceholderUrl(target)) {
    return null;
  }
  const now = Date.now();
  const index = closedTabLog.findIndex(
    (record) =>
      record &&
      record.url &&
      normalizeUrl(record.url) === target &&
      now - Number(record.at || 0) <= CLOSED_LOG_TTL_MS
  );
  if (index < 0) {
    return null;
  }
  const [record] = closedTabLog.splice(index, 1);
  persist();
  return record;
}

/**
 * 套用一次撤销恢复：父关系 + 物理位置 + 重挂被提升的子标签。
 *
 * @param {object} tab 创建事件里的标签（含 id / windowId / pinned）
 * @param {object|null} record 关闭记录（可能为空：例如记录已过期，但会话值证明这是撤销恢复）
 * @param {object|null} stored 每标签会话值（Firefox；可能为空）
 */
async function applyUndoRestore(tab, record, stored) {
  const tabId = Number(tab.id);
  const windowId = Number(tab.windowId);
  if (!Number.isFinite(tabId) || !Number.isFinite(windowId)) {
    return false;
  }
  // 父标签：关闭记录是关闭那一刻同步抓取的现场，比防抖写入的会话值更新，因此**记录优先**；
  // 没有记录（已过期 / 已被消费）时才用会话值里的父把层级救回来。
  let parentId = record ? record.parentId : null;
  if (!record && stored && isFiniteId(stored.parentId)) {
    parentId = Number(stored.parentId);
  }
  await ensureTreeFor(windowId);
  let indexMap = await refreshTreeIndexes(windowId);
  applyRestoredParent(windowId, tabId, parentId, { childPinned: Boolean(tab.pinned), indexMap });
  if (record) {
    await moveRestoredTabToRecordedPosition(tabId, windowId, record);
    // 移动之后父标签必须在子标签之前，这一条只能在校验时才知道，因此再套用一次。
    indexMap = await refreshTreeIndexes(windowId);
    applyRestoredParent(windowId, tabId, parentId, { childPinned: Boolean(tab.pinned), indexMap });
    // 重挂子标签要求"父在物理上排在子之前"。关闭前的物理顺序不一定满足
    // （树的顺序与标签栏顺序本来就允许不一致），此时先把被恢复的父移到最早的子标签之前，
    // 否则重挂会全部跳过（用户看到的就是"撤销后 B-C 没变、A 单独挂在顶层"）。
    await alignRestoredParentBeforePromotedChildren(windowId, tabId, record);
    // 重挂"被提升出去、且仍停在提升结果位置"的直属子标签（A - B - C 完整回来）。
    indexMap = await refreshTreeIndexes(windowId);
    const result = readoptPromotedChildren(windowId, tabId, record.promotedChildren, { indexMap });
    if (result.readopted.length > 0) {
      diag(`重挂子标签 #${tabId}：${result.readopted.map((id) => `#${id}`).join("，")}`);
    }
    // 被改过父关系的标签要立刻重写会话值，避免过期值在下一次撤销时把错误父引回来。
    handleTabStructureChanged(windowId, [tabId, ...result.readopted]);
  }
  return true;
}

/**
 * 重挂子标签前，保证被恢复的父标签在物理上排在"最早的一个被提升子标签"之前。
 *
 * 为什么需要：撤销恢复沿用的是关闭记录里的**物理**邻居，而树的顺序与标签栏顺序本来就允许不一致
 * （用户可以把子标签拖到父标签前面）。若子标签物理上在父之前，重新挂回就会违反
 * "父 index 小于子 index"这条硬不变量，只能整批跳过——用户看到的是
 * "撤销后 B-C 没变，A 单独挂在顶层"，也就是"撤销没能还原子树"。
 * 撤销是用户显式操作，因此这里允许移动**被恢复的那一个标签**（只动一个，且是刚刚由这次撤销
 * 恢复出来的标签），把它挪到最早子标签之前；不做其它标签的搬运。
 */
async function alignRestoredParentBeforePromotedChildren(windowId, tabId, record) {
  const children = Array.isArray(record.promotedChildren) ? record.promotedChildren : [];
  if (children.length === 0) {
    return;
  }
  const childIndexes = [];
  for (const item of children) {
    const childId = Number(item && item.tabId);
    if (!Number.isFinite(childId)) {
      continue;
    }
    const tab = await getTabInfo(childId);
    if (tab && Number(tab.windowId) === Number(windowId) && Number.isFinite(Number(tab.index))) {
      childIndexes.push(Number(tab.index));
    }
  }
  if (childIndexes.length === 0) {
    return;
  }
  const earliestChildIndex = Math.min(...childIndexes);
  const self = await getTabInfo(tabId);
  const selfIndex = self && Number(self.windowId) === Number(windowId) ? Number(self.index) : NaN;
  if (!Number.isFinite(selfIndex) || selfIndex < earliestChildIndex) {
    return;
  }
  diag(
    `重挂位置修正 #${tabId}：它在 idx ${selfIndex}，最早子标签在 idx ${earliestChildIndex} → 先把父移到子标签之前`
  );
  await moveTabsInternallyTo(windowId, [tabId], earliestChildIndex);
}

/**
 * 把恢复出来的标签移回原物理位置。
 *
 * 优先用"原前后邻居"定位而不是记录里的绝对下标：标签栏在这期间可能已经变化，
 * 绝对下标会把它插到毫不相干的地方；邻居都还在时，插到原后继之前正好还原原位。
 * 两个邻居都不在了就保持浏览器给出的位置——这比按过期下标乱插更安全。
 */
async function moveRestoredTabToRecordedPosition(tabId, windowId, record) {
  const target = await resolveRecordedIndex(windowId, record);
  if (target === null) {
    return;
  }
  const current = await getTabInfo(tabId);
  if (current && Number(current.index) === target) {
    return;
  }
  await moveTabsInternallyTo(windowId, [tabId], target);
}

async function resolveRecordedIndex(windowId, record) {
  const next = await getTabInfo(record.nextId);
  if (next && Number(next.windowId) === windowId) {
    return Number(next.index);
  }
  const prev = await getTabInfo(record.prevId);
  if (prev && Number(prev.windowId) === windowId) {
    return Number(prev.index) + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 整组撤销
// ---------------------------------------------------------------------------

/** 供右键菜单判断「撤销关闭」是否可用。 */
export function hasRestorableGroup() {
  return restorableGroupCount > 0;
}

/**
 * 撤销最近一个关闭组：整组重新打开，并恢复父子层级、兄弟顺序与物理位置。
 *
 * @param {number|null} windowId 目标窗口；缺省时依次尝试记录里的原窗口、最后聚焦的窗口。
 * @returns {Promise<{ok: boolean, groupId?: string, windowId?: number, restored?: number, skipped?: number, error?: string}>}
 */
export async function restoreClosedGroup(windowId = null) {
  await ensureClosedGroupsLoaded();
  const group = closedGroups[0];
  if (!group) {
    return { ok: false, error: "没有可撤销的关闭记录。" };
  }

  const targetWindowId = await resolveTargetWindow(windowId, group.windowId);
  if (!Number.isFinite(targetWindowId)) {
    return { ok: false, error: "找不到可用于恢复的窗口。" };
  }

  // 按「窗口 + 原物理下标」升序恢复：同一窗口内父标签天然排在子标签之前，
  // 重建层级时就不会出现"先挂子后挂父"。
  const members = group.members.slice().sort(
    (a, b) => (Number(a.windowId) - Number(b.windowId)) || (Number(a.index) - Number(b.index))
  );
  const idByMember = new Map();
  const restoredIds = [];
  const windowIds = [];

  // 跨窗口多选关闭是允许的（管理页「全部窗口」与侧边栏固定标签区），
  // 因此按成员各自的窗口分别恢复；原窗口已被关闭的成员退到 targetWindowId。
  const windowExistence = new Map();
  const windowStillExists = async (id) => {
    const key = Number(id);
    if (!Number.isFinite(key)) {
      return false;
    }
    if (!windowExistence.has(key)) {
      windowExistence.set(key, Boolean(await getWindow(key)));
    }
    return windowExistence.get(key);
  };
  const byWindow = new Map();
  for (const member of members) {
    const recorded = Number(member.windowId);
    const effective = (await windowStillExists(recorded)) ? recorded : targetWindowId;
    if (!byWindow.has(effective)) {
      byWindow.set(effective, []);
    }
    byWindow.get(effective).push(member);
  }

  // 先出栈再重开：恢复过程中 MV3 的 Service Worker 随时可能被回收，
  // 若等到最后才出栈，用户再点一次「撤销关闭」就会把同一批标签重复打开一遍。
  // 一个都没打开（重开阶段直接失败）时再放回去，让用户可以重试。
  closedGroups = closedGroups.filter((item) => item !== group);
  persist();
  try {
    for (const [memberWindowId, windowMembers] of [...byWindow.entries()].sort((a, b) => a[0] - b[0])) {
      windowIds.push(memberWindowId);
      const reopened = await reopenMembers(windowMembers, memberWindowId, group);
      for (const [member, tabId] of reopened) {
        idByMember.set(member, tabId);
      }
      const reopenedIds = windowMembers.map((member) => idByMember.get(member)).filter(isFiniteId);
      restoredIds.push(...reopenedIds);

      // 等 onCreated 全部被树的创建流程登记，否则随后写入的父子关系会被它覆盖。
      await ensureTreeFor(memberWindowId);
      await waitUntilTabsTracked(memberWindowId, reopenedIds);

      // 先按实时下标重建一次：下面判断"父是否排在子之前"必须依据物理事实，
      // 不能依赖内存里那张只反映"事件到达时顺序"的表。
      // 注意：parentIndex 是**组内全局下标**，因此查找父时始终传完整的 members。
      let indexMap = await refreshTreeIndexes(memberWindowId);
      applyGroupStructure(members, windowMembers, idByMember, memberWindowId, indexMap);
      await placeGroupMembers(windowMembers, idByMember, memberWindowId);
      // 物理位置变化后重新校验一次不变量（父必须在子之前）。落位算法本身保证了这一点，
      // 这一步是防御性的：不变量优先于"尽量还原"，违反者降级为顶层。
      indexMap = await refreshTreeIndexes(memberWindowId);
      applyGroupStructure(members, windowMembers, idByMember, memberWindowId, indexMap);

      await restoreCollapsedState(windowMembers, idByMember, memberWindowId);
    }
  } catch (error) {
    if (restoredIds.length === 0) {
      closedGroups = [group, ...closedGroups].slice(0, CLOSED_GROUP_MAX);
      persist();
    }
    throw error;
  }

  // 一个都没打开：把关闭组放回去并如实报错，不要让用户"点了一次撤销却什么都没发生"。
  if (restoredIds.length === 0) {
    closedGroups = [group, ...closedGroups].slice(0, CLOSED_GROUP_MAX);
    persist();
    return { ok: false, error: "标签页未能重新打开，关闭记录已保留，可稍后重试。" };
  }

  await activateTab(idByMember.get(members[0]));

  const skipped = members.length - restoredIds.length;
  logDebug("restoreClosedGroup", group.groupId, { restored: restoredIds.length, skipped });
  return {
    ok: true,
    groupId: group.groupId,
    windowId: windowIds[0] || targetWindowId,
    windowIds,
    restored: restoredIds.length,
    skipped,
  };
}

/** 目标窗口：显式指定 > 记录里的原窗口 > 最后聚焦的窗口。 */
async function resolveTargetWindow(windowId, recordedWindowId) {
  const explicit = Number(windowId);
  if (Number.isFinite(explicit) && (await getWindow(explicit))) {
    return explicit;
  }
  const recorded = Number(recordedWindowId);
  if (Number.isFinite(recorded) && (await getWindow(recorded))) {
    return recorded;
  }
  const focused = await getLastFocusedWindow();
  return focused ? Number(focused.id) : NaN;
}

/**
 * 重新打开一组标签，返回「成员 → 新 tabId」的映射。
 *
 * 顺序策略：先让浏览器自己恢复它仍记得的会话（保住前进后退历史），剩下的按 URL 重新打开。
 * Chrome 的 sessions 只保留约 25 条最近关闭记录，因此稍大的组必然会走到"按 URL 重开"这一步——
 * 对本插件这种面向海量标签页的场景，按 URL 重开才是主力路径。
 *
 * 映射靠**串行 + 逐个等待创建事件**保证：并发恢复时同 URL 的多个标签无法区分谁是谁。
 */
async function reopenMembers(members, windowId, group) {
  const idByMember = new Map();

  const sessions = await getRecentlyClosedTabs();
  const usedSessions = new Set();
  for (const member of members) {
    if (!member.url) {
      continue;
    }
    const match = sessions.find(
      (session) => !usedSessions.has(session.sessionId) && session.url === member.url
    );
    if (!match) {
      continue;
    }
    usedSessions.add(match.sessionId);
    const restored = await restoreSessionAndWait(match.sessionId, member.url, windowId);
    if (restored) {
      idByMember.set(member, Number(restored.id));
    }
  }

  for (const member of members) {
    if (idByMember.has(member)) {
      continue;
    }
    // 登记住 URL：这个标签的父标签由恢复流程统一套用，onCreated 不要套用默认规则。
    // 登记项由 onCreated 消费（见 claimRestoreCandidate），不在这里删除——
    // 创建事件与 tabs.create 回调的先后顺序并不保证。
    markPendingCreatedUrl(member.url);
    const created = await createTab({ url: member.url || "about:blank", windowId, active: false });
    if (created) {
      idByMember.set(member, Number(created.id));
    }
  }

  logDebug("reopenMembers", group.groupId, idByMember.size);
  return idByMember;
}

/** 登记一个"由恢复流程创建"的 URL（计数，支持同 URL 多个成员）。 */
function markPendingCreatedUrl(url) {
  const key = normalizeUrl(url) || "about:blank";
  const pending = pendingCreatedUrls.get(key) || { count: 0, at: Date.now() };
  pending.count += 1;
  pending.at = Date.now();
  pendingCreatedUrls.set(key, pending);
  prunePendingCreatedUrls();
}

/** 丢弃长时间没被消费的登记项，避免"创建失败"留下的登记把后续手动打开误判成恢复。 */
function prunePendingCreatedUrls() {
  const now = Date.now();
  for (const [key, pending] of pendingCreatedUrls) {
    if (now - pending.at > PENDING_CREATED_URL_TTL_MS) {
      pendingCreatedUrls.delete(key);
    }
  }
}

/**
 * 按记录重建父子关系；父无处可寻时落顶层（不变量优先级高于"尽量还原"）。
 *
 * @param {Array} allMembers 组内**全部**成员（用于解析 parentIndex 这个组内全局下标）
 * @param {Array} windowMembers 本窗口的成员（只处理它们）
 */
function applyGroupStructure(allMembers, windowMembers, idByMember, windowId, indexMap) {
  windowMembers.forEach((member) => {
    const tabId = idByMember.get(member);
    if (!isFiniteId(tabId)) {
      return;
    }
    let parentId = null;
    if (member.parentIndex >= 0 && allMembers[member.parentIndex]) {
      const parentTabId = idByMember.get(allMembers[member.parentIndex]);
      parentId = isFiniteId(parentTabId) ? parentTabId : null;
    }
    if (parentId === null && isFiniteId(member.parentId)) {
      // 父标签不在这组里：它可能还开着（关掉几个子标签的情况），也可能已经关了。
      // 父在别的窗口时，applyRestoredParent 会因为"父不在本窗口的树里"而拒绝并落顶层。
      parentId = Number(member.parentId);
    }
    applyRestoredParent(windowId, Number(tabId), parentId, {
      childPinned: Boolean(member.pinned),
      indexMap,
    });
  });
}

/**
 * 把整组标签逐个放回原来的物理位置。
 *
 * 为什么不能"整组一起搬到 min(原下标)"：关闭的成员可能分散在多处（例如 P1 下有 X1、P2 下有 X2），
 * 把它们压成一段会挤走中间还活着的标签，甚至把某个成员的父标签顶到自己后面，
 * 反过来破坏"父必须在子之前"这条不变量。
 *
 * 因此按**锚点**逐个落位，锚点优先级：
 * 1. 父标签（组内父用恢复出来的实例，组外父用仍活着的原父）——同一父下的多个兄弟按原顺序依次接到前一个之后；
 * 2. 原物理后继（插到它前面）；
 * 3. 原物理前驱（插到它后面）；
 * 4. 都没有（前后邻居都不在组里且都已关闭）→ 保持浏览器给出的位置，不做危险的下标猜测。
 */
async function placeGroupMembers(members, idByMember, windowId) {
  // 父标签 -> 该父下最后一个已落位的成员，保证兄弟顺序稳定。
  const lastPlacedByParent = new Map();
  for (const member of members) {
    const tabId = Number(idByMember.get(member));
    if (!Number.isFinite(tabId)) {
      continue;
    }
    const parentId = resolveParentTabId(member, members, idByMember);
    let anchorId = null;
    let insertAfter = true;

    if (Number.isFinite(parentId) && (await isAliveInWindow(parentId, windowId))) {
      anchorId = lastPlacedByParent.has(parentId) ? lastPlacedByParent.get(parentId) : parentId;
    } else if (await isAliveInWindow(member.prevId, windowId)) {
      anchorId = Number(member.prevId);
    } else if (await isAliveInWindow(member.nextId, windowId)) {
      anchorId = Number(member.nextId);
      insertAfter = false;
    }

    if (Number.isFinite(parentId)) {
      lastPlacedByParent.set(parentId, tabId);
    }

    if (anchorId === null || anchorId === tabId) {
      continue;
    }
    const anchor = await getTabInfo(anchorId);
    if (!anchor || Number(anchor.windowId) !== Number(windowId)) {
      continue;
    }
    const targetIndex = insertAfter ? Number(anchor.index) + 1 : Number(anchor.index);
    const current = await getTabInfo(tabId);
    if (current && Number(current.index) === targetIndex) {
      continue;
    }
    await moveTabsInternallyTo(windowId, [tabId], targetIndex);
  }
}

/** 解析成员的父标签：优先组内恢复出来的实例，其次组外仍在的父标签。 */
function resolveParentTabId(member, members, idByMember) {
  if (member.parentIndex >= 0 && members[member.parentIndex]) {
    const parentTabId = Number(idByMember.get(members[member.parentIndex]));
    if (Number.isFinite(parentTabId)) {
      return parentTabId;
    }
  }
  return isFiniteId(member.parentId) ? Number(member.parentId) : NaN;
}

async function isAliveInWindow(tabId, windowId) {
  if (!isFiniteId(tabId)) {
    return false;
  }
  const tab = await getTabInfo(Number(tabId));
  return Boolean(tab) && Number(tab.windowId) === Number(windowId);
}

/** 恢复组内被折叠的子树（折叠状态在前端存 storage.session，与管理页/侧边栏共用一份）。 */
async function restoreCollapsedState(windowMembers, idByMember, windowId) {
  const collapsedMembers = windowMembers.filter((member) => member.collapsed && isFiniteId(idByMember.get(member)));
  if (collapsedMembers.length === 0) {
    return;
  }
  const current = (await storageSessionGet(TREE_COLLAPSED_KEY)) || {};
  const forWindow = { ...(current[windowId] || {}) };
  for (const member of collapsedMembers) {
    forWindow[String(idByMember.get(member))] = true;
  }
  await storageSessionSet({ [TREE_COLLAPSED_KEY]: { ...current, [windowId]: forWindow } });
}

async function loadCollapsedSet(windowId) {
  const raw = (await storageSessionGet(TREE_COLLAPSED_KEY)) || {};
  const forWindow = raw[windowId];
  return new Set(forWindow ? Object.keys(forWindow).map(Number) : []);
}

// ---------------------------------------------------------------------------
// 浏览器 API 小工具
// ---------------------------------------------------------------------------

function normalizeUrl(url) {
  return typeof url === "string" ? url.trim() : "";
}

function getTabInfo(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    chrome.tabs.get(id, (tab) => {
      resolve(chrome.runtime.lastError || !tab ? null : tab);
    });
  });
}

function getWindow(windowId) {
  const id = Number(windowId);
  if (!Number.isFinite(id)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    chrome.windows.get(id, (win) => {
      resolve(chrome.runtime.lastError || !win ? null : win);
    });
  });
}

function getLastFocusedWindow() {
  return new Promise((resolve) => {
    chrome.windows.getLastFocused({}, (win) => {
      resolve(chrome.runtime.lastError || !win ? null : win);
    });
  });
}

function createTab(createProperties) {
  return new Promise((resolve) => {
    chrome.tabs.create(createProperties, (tab) => {
      resolve(chrome.runtime.lastError || !tab ? null : tab);
    });
  });
}

function activateTab(tabId) {
  if (!isFiniteId(tabId)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    chrome.tabs.update(Number(tabId), { active: true }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function getRecentlyClosedTabs() {
  if (!chrome.sessions || typeof chrome.sessions.getRecentlyClosed !== "function") {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    chrome.sessions.getRecentlyClosed({ maxResults: chrome.sessions.MAX_SESSION_RESULTS || 25 }, (sessions) => {
      if (chrome.runtime.lastError || !Array.isArray(sessions)) {
        resolve([]);
        return;
      }
      resolve(
        sessions
          .filter((session) => session && session.tab && session.tab.sessionId)
          .map((session) => ({
            sessionId: session.tab.sessionId,
            url: session.tab.url || "",
            title: session.tab.title || "",
          }))
      );
    });
  });
}

/**
 * 用浏览器会话恢复一个标签，并等它真的出现在目标窗口里。
 *
 * sessions.restore 不接受 windowId，恢复出来的标签可能落在别的窗口（它按"当前窗口"落位），
 * 因此这里统一校正窗口，保证后续写父子关系时窗口是对的。
 */
async function restoreSessionAndWait(sessionId, url, windowId) {
  if (!chrome.sessions || typeof chrome.sessions.restore !== "function") {
    return null;
  }
  const created = await new Promise((resolve) => {
    const waitForCreated = waitForNextCreatedTab((tab) => {
      const candidateUrl = normalizeUrl(tab.url || tab.pendingUrl || "");
      return candidateUrl === normalizeUrl(url);
    });
    chrome.sessions.restore(sessionId, () => {
      if (chrome.runtime.lastError) {
        waitForCreated.cancel();
        resolve(null);
      }
    });
    waitForCreated.promise.then(resolve);
  });
  if (!created) {
    return null;
  }
  if (Number(created.windowId) !== Number(windowId)) {
    await moveTabsInternallyTo(windowId, [Number(created.id)], -1);
    return (await getTabInfo(created.id)) || created;
  }
  return created;
}

/** 等下一个满足条件的 tabs.onCreated，并返回它；超时返回 null。 */
function waitForNextCreatedTab(predicate, timeoutMs = RESTORE_TAB_TIMEOUT_MS) {
  let done = false;
  let timer = null;
  let resolvePromise = null;
  const listener = (tab) => {
    if (done || !predicate(tab)) {
      return;
    }
    finish(tab);
  };
  const finish = (value) => {
    if (done) {
      return;
    }
    done = true;
    chrome.tabs.onCreated.removeListener(listener);
    if (timer) {
      clearTimeout(timer);
    }
    if (resolvePromise) {
      resolvePromise(value);
    }
  };
  chrome.tabs.onCreated.addListener(listener);
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    timer = setTimeout(() => finish(null), timeoutMs);
  });
  return { promise, cancel: () => finish(null) };
}

/** 分批关闭标签；整批失败时逐个重试，避免个别标签（例如已被关闭）拖累其余。 */
async function removeTabsInBatches(ids) {
  let removed = 0;
  let skipped = 0;
  for (let offset = 0; offset < ids.length; offset += REMOVE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + REMOVE_BATCH_SIZE);
    await new Promise((resolve) => {
      chrome.tabs.remove(batch, () => {
        if (!chrome.runtime.lastError) {
          removed += batch.length;
          resolve();
          return;
        }
        Promise.all(
          batch.map(
            (tabId) =>
              new Promise((innerResolve) => {
                chrome.tabs.remove(tabId, () => {
                  if (chrome.runtime.lastError) {
                    skipped += 1;
                  } else {
                    removed += 1;
                  }
                  innerResolve();
                });
              })
          )
        ).then(resolve);
      });
    });
    if (offset + REMOVE_BATCH_SIZE < ids.length) {
      await delay(REMOVE_BATCH_GAP_MS);
    }
  }
  return { removed, skipped };
}

/**
 * 写一个每标签会话值（Promise 形式）。
 *
 * 不抛错、不 reject：这是一条"尽力而为"的辅助信息，写不进去只影响撤销识别的精确度，
 * 绝不能让结构事件链路因为一次存储失败而中断（调用方都在 tabs 事件的处理器里）。
 */
function setTabValue(tabId, key, value) {
  const api = sessionsRefApi();
  if (!api) {
    return Promise.resolve();
  }
  try {
    return Promise.resolve(api.setTabValue(Number(tabId), key, value)).catch(() => {});
  } catch (_error) {
    return Promise.resolve();
  }
}

/** 读一个每标签会话值（Promise 形式）；读不到一律返回 null。 */
function getTabValue(tabId, key) {
  const api = sessionsRefApi();
  if (!api) {
    return Promise.resolve(null);
  }
  try {
    return Promise.resolve(api.getTabValue(Number(tabId), key)).then(
      (value) => (value === undefined ? null : value),
      () => null
    );
  } catch (_error) {
    return Promise.resolve(null);
  }
}

/**
 * 每标签会话值机制的**写读自检**（每个后台生命周期只做一次）。
 *
 * 为什么必须有：这套 API 曾经"看起来能用、实际永远读不到"（回调形式不生效 + 异常被吞），
 * 而它一旦失效，撤销识别就会静默退回启发式，用户只能看到"层级恢复得时对时错"。
 * 自检把这件事变成一条明确的判定：写一个探针值再读回，读到才算可用；读不到就永久放弃该机制。
 *
 * 探针只写进插件自己的键（`nesoi:tree-ref-probe`），不会污染 `nesoi:tree-ref`；
 * 拿一个现存标签当载体，失败（比如没有标签）时按"不可用"处理。
 */
function ensureTabRefsVerified() {
  if (tabRefsSelfCheck) {
    return tabRefsSelfCheck;
  }
  tabRefsSelfCheck = (async () => {
    if (!supportsTabRefs()) {
      tabRefsVerified = false;
      return false;
    }
    const probeValue = { at: Date.now() };
    const candidates = await new Promise((resolve) => {
      try {
        chrome.tabs.query({}, (list) => resolve(Array.isArray(list) ? list : []));
      } catch (_error) {
        resolve([]);
      }
    });
    const probeable = candidates
      .map((tab) => Number(tab && tab.id))
      .filter((tabId) => Number.isFinite(tabId))
      .slice(0, 3);
    if (probeable.length === 0) {
      // 没有可探测的标签（典型：后台在窗口恢复之前启动）。这一刻测不出结论，
      // 因此**不锁定**判定结果，等下次需要时再自检一次。
      tabRefsSelfCheck = null;
      diag("会话值自检：暂无可探测的标签 → 稍后重试");
      return false;
    }
    for (const tabId of probeable) {
      await setTabValue(tabId, TAB_REF_SELF_KEY, probeValue);
      const readBack = await getTabValue(tabId, TAB_REF_SELF_KEY);
      if (readBack && typeof readBack === "object" && Number(readBack.at) === probeValue.at) {
        tabRefsVerified = true;
        diag("会话值自检：通过（可写入并读回每标签会话值）");
        return true;
      }
    }
    tabRefsVerified = false;
    diag("会话值自检：失败 → 本环境放弃每标签会话值，撤销识别退回 URL 启发式");
    return false;
  })();
  return tabRefsSelfCheck;
}

/** 会话值机制此刻是否可用：自检未完成时按"可试一次"处理，自检失败后一律 false。 */
function tabRefsUsable() {
  return supportsTabRefs() && tabRefsVerified !== false;
}

/** 关闭父标签后，它的子标签会被提升：这些子标签的持久引用需要重写。 */
export function handlePromotionAfterClose(removedTabId, windowId) {
  const children = getChildTabIds(removedTabId, windowId);
  if (children.length > 0) {
    handleTabStructureChanged(windowId, children);
  }
}
