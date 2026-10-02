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
  HAS_SESSION_STORAGE,
  TREE_COLLAPSED_KEY,
  TREE_REPAIR_KEY,
} from "./constants.js";
import { getCachedTabInfo } from "./recent_tabs.js";
import { storageSessionGet, storageSessionSet } from "./storage.js";
import {
  applyRestoredParent,
  collectSubtreeTabIds,
  ensureTreeFor,
  getChildTabIds,
  getTabStructureInfo,
  getTrackedParentId,
  getTreeSessionStartedAt,
  moveTabsInternallyTo,
  refreshTreeIndexes,
  setRestoreCandidateProvider,
  setStructureRepairProvider,
  waitUntilTabsTracked,
} from "./tree.js";
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
// 层级自动修复：每次并发读取多少个标签的会话值，以及单窗口单会话最多检查多少个标签。
// 修复是"尽力而为的一次性救援"，因此用批量并发压低后台开销，并用上限防御 10K 级窗口。
const REPAIR_BATCH_SIZE = 24;
const REPAIR_MAX_TABS = 4000;

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

// 层级自动修复：本次 SW 生命周期内已经排过队的窗口（内存去重，避免并发重复扫描）。
const repairQueuedWindows = new Set();
// storage.session 里"本浏览器会话已扫描过的窗口"表的内存副本。
let repairDoneMap = null;

function isFiniteId(value) {
  return Number.isFinite(Number(value));
}

/** Firefox 才有每标签的会话值；Chrome 的 sessions API 不提供这两个方法。 */
function supportsTabRefs() {
  return Boolean(
    chrome.sessions &&
      typeof chrome.sessions.setTabValue === "function" &&
      typeof chrome.sessions.getTabValue === "function"
  );
}

function logDebug(...args) {
  // 记录里含 URL 与标题（属于用户数据），因此只在明确需要排查时打开。
  if (typeof console !== "undefined" && logDebug.enabled) {
    console.log("[closed_groups]", ...args);
  }
}
logDebug.enabled = false;

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
  // 同步注册判定钩子：tabs.onCreated 可能在载入完成前就到达。
  setRestoreCandidateProvider(claimRestoreCandidate);
  // 树每次从快照重建后，都可能需要一次"历史损坏救援"（见 repairTreeFromTabRefs）。
  setStructureRepairProvider(repairTreeFromTabRefs);
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
  const record = {
    tabId: id,
    windowId,
    parentId: info ? info.parentId : null,
    prevId: info ? info.prevId : null,
    nextId: info ? info.nextId : null,
    index: info && Number.isFinite(info.index) ? info.index : -1,
    pinned: cached ? Boolean(cached.pinned) : false,
    url: cached ? cached.url || "" : "",
    title: cached ? cached.title || "" : "",
    at: Date.now(),
    groupId: pendingGroupClose && pendingGroupClose.tabIds.has(id) ? pendingGroupClose.groupId : null,
  };
  return ensureClosedGroupsLoaded().then(() => {
    closedTabLog = [record, ...closedTabLog].slice(0, CLOSED_LOG_MAX);
    persist();
  });
}

/**
 * 结构变化后刷新 Firefox 的每标签会话值。
 *
 * @param {number} windowId
 * @param {number[]|null} tabIds 受影响的标签；传 null 表示"该窗口所有标签"（代价 O(n)，只在关闭父标签时用）。
 */
export function handleTabStructureChanged(windowId, tabIds = null) {
  if (!supportsTabRefs()) {
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
    const ids = pending.all ? [...tree.parentById.keys()] : [...pending.ids];
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
// 层级自动修复（用每标签会话值救援历史版本写坏的结构）
// ---------------------------------------------------------------------------

/** 读取"本浏览器会话已扫描过的窗口"表（storage.session；重启后自动清空，于是会再扫一次）。 */
async function loadRepairDoneMap() {
  if (!repairDoneMap) {
    const stored = await storageSessionGet(TREE_REPAIR_KEY);
    repairDoneMap = stored && typeof stored === "object" ? { ...stored } : {};
  }
  return repairDoneMap;
}

/**
 * 用 Firefox 每标签会话值，把"历史版本写坏成顶层"的标签挂回原父。
 *
 * 背景：旧版本在"父标签已被关闭、树却不在内存里"等情况下会把整棵子树写成顶层（`p = -1`），
 * 那份快照里的原父信息已经丢了，靠快照自己无法还原。而 Firefox 的 `sessions.setTabValue`
 * 是按 tabId 存的父引用，能跨 Service Worker 回收、也随标签一起恢复，因此是唯一可用的救援来源。
 *
 * 安全边界（任意一条不满足就跳过）：
 * - 只在 Firefox（有每标签会话值）且能写 `storage.session` 时执行；
 * - 只处理**当前是顶层**的非固定标签（已经有父的说明结构完好，不去动它）；
 * - 会话值必须写于**本浏览器会话内**（早于会话起点的值来自上一次会话，那里的 tabId 可能已被复用）；
 * - 最终仍由 `applyRestoredParent` 走不变量校验：父必须存活、同窗口、非固定、排在自己之前、不成环。
 *
 * 开销与频次：按窗口记在 `storage.session`，**每个浏览器会话最多扫一次**；批量并发读取，
 * 单窗口上限 `REPAIR_MAX_TABS`。整段是后台尽力而为，任何异常都只记日志、不影响正常结构。
 *
 * @param {number} windowId 刚重建完树的窗口
 * @param {chrome.tabs.Tab[]} tabs 该窗口的标签列表（与树同时刻查询得到）
 * @param {boolean} hadSnapshot 是否是从磁盘快照重建的（全新窗口没有可修复的内容）
 */
async function repairTreeFromTabRefs(windowId, tabs, hadSnapshot) {
  if (!hadSnapshot || !supportsTabRefs() || !HAS_SESSION_STORAGE) {
    return;
  }
  const winId = Number(windowId);
  if (!Number.isFinite(winId) || !Array.isArray(tabs) || tabs.length === 0) {
    return;
  }
  if (repairQueuedWindows.has(winId)) {
    return;
  }
  repairQueuedWindows.add(winId);
  try {
    const done = await loadRepairDoneMap();
    if (done[winId]) {
      return;
    }
    const sessionStartedAt = await getTreeSessionStartedAt();
    const indexMap = new Map(tabs.map((tab) => [Number(tab.id), Number(tab.index)]));
    const candidates = [];
    for (const tab of tabs) {
      const id = Number(tab.id);
      if (!Number.isFinite(id) || tab.pinned) {
        continue;
      }
      // 只修顶层标签；用 O(1) 的 getTrackedParentId，避免"遍历整窗标签"退化成 O(n²)。
      if (getTrackedParentId(winId, id) !== null) {
        continue;
      }
      candidates.push(id);
      if (candidates.length >= REPAIR_MAX_TABS) {
        break;
      }
    }
    let repaired = 0;
    for (let offset = 0; offset < candidates.length; offset += REPAIR_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + REPAIR_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (tabId) => {
          const stored = await getTabValue(tabId, TAB_REF_KEY);
          if (!stored || typeof stored !== "object") {
            return false;
          }
          const parentId = Number(stored.parentId);
          if (!Number.isFinite(parentId)) {
            return false;
          }
          // 上一次浏览器会话留下的值不可信：那里的 tabId 与本会话无关（可能已被复用）。
          if (Number(stored.at) < sessionStartedAt) {
            return false;
          }
          if (!applyRestoredParent(winId, tabId, parentId, { childPinned: false, indexMap })) {
            return false;
          }
          // applyRestoredParent 在校验失败时会降级为顶层，因此以"真的挂上了"为准来计数。
          return getTrackedParentId(winId, tabId) != null;
        })
      );
      repaired += results.filter(Boolean).length;
    }
    // 标记本会话已扫过：无论是否修好都不再重复扫（避免每次树重建都做一轮 O(n) IPC）。
    done[winId] = Date.now();
    repairDoneMap = done;
    await storageSessionSet({ [TREE_REPAIR_KEY]: done });
    if (repaired > 0) {
      logDebug("repairTreeFromTabRefs", { windowId: winId, candidates: candidates.length, repaired });
    }
  } catch (error) {
    // 尽力而为：修复失败只影响"能不能救回历史损坏"，不影响任何正常结构。
  } finally {
    repairQueuedWindows.delete(winId);
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
// 单标签撤销：认领 + 套用
// ---------------------------------------------------------------------------

/**
 * 判断一个新建标签是不是「撤销关闭」产生的（同步，必须在 tabs.onCreated 的同步阶段调用）。
 *
 * 返回值语义见 tree.js 的 setRestoreCandidateProvider：
 * - 返回 null：不是撤销恢复，走默认的 opener / 活动标签规则；
 * - 返回 { record, apply }：由 apply() 决定是否已处理。
 */
function claimRestoreCandidate(tab) {
  if (!tab || !isFiniteId(tab.id)) {
    return null;
  }
  const url = normalizeUrl(tab.url || tab.pendingUrl || "");
  if (!url) {
    return null;
  }

  // 本插件自己正在恢复关闭组：这些标签的父子关系由恢复流程统一套用，
  // 这里只负责"占住顶层"，避免默认规则插手后又与恢复结果互相覆盖。
  if (pendingCreatedUrls.size > 0) {
    prunePendingCreatedUrls();
    const pending = pendingCreatedUrls.get(url);
    if (pending && pending.count > 0) {
      pending.count -= 1;
      if (pending.count <= 0) {
        pendingCreatedUrls.delete(url);
      }
      return { record: null, apply: () => Promise.resolve(true) };
    }
  }

  const now = Date.now();  const index = closedTabLog.findIndex(
    (record) =>
      record &&
      record.url &&
      normalizeUrl(record.url) === url &&
      now - Number(record.at || 0) <= CLOSED_LOG_TTL_MS
  );
  if (index < 0) {
    return null;
  }

  // 认领即出栈：同一条记录不会被两次"重新打开"复用；判定失败（Firefox 读不到会话值）时再放回去。
  const [record] = closedTabLog.splice(index, 1);
  persist();
  return {
    record,
    apply: async () => {
      const handled = await applyClaimedRestore(tab, record);
      if (!handled) {
        // 判定失败：放回原位，让后续的"重新打开"仍有机会用它。
        closedTabLog.splice(Math.min(index, closedTabLog.length), 0, record);
        persist();
      }
      return handled;
    },
  };
}

/**
 * 套用单标签撤销恢复：挂回原父节点与原物理位置。
 *
 * Firefox 下每标签会话值是**权威信息**：读不到就说明这次创建并不是撤销关闭
 * （例如用户手动打开了同一个 URL），此时返回 false 让调用方退回默认规则。
 *
 * @returns {Promise<boolean>} true 表示已按记录处理完父子关系
 */
async function applyClaimedRestore(tab, record) {
  const tabId = Number(tab.id);
  const windowId = Number(tab.windowId);
  if (!Number.isFinite(tabId) || !Number.isFinite(windowId) || !record) {
    return false;
  }

  if (supportsTabRefs()) {
    const stored = await getTabValue(tabId, TAB_REF_KEY);
    if (!stored || typeof stored !== "object") {
      return false;
    }
    // 会话值里的父标签比"URL 匹配出来的旧记录"更新（关闭之后又被挂到别处之类的操作会更新它）。
    // 前后邻居仍以关闭记录为准：那里记录的是关闭那一刻的真实邻居，比防抖写入的会话值更准。
    if (isFiniteId(stored.parentId)) {
      record.parentId = Number(stored.parentId);
    }
  }

  await ensureTreeFor(windowId);
  let indexMap = await refreshTreeIndexes(windowId);
  applyRestoredParent(windowId, tabId, record.parentId, { childPinned: Boolean(tab.pinned), indexMap });
  await moveRestoredTabToRecordedPosition(tabId, windowId, record);
  // 移动之后父标签必须在子标签之前，这一条只能在校验时才知道，因此再套用一次。
  indexMap = await refreshTreeIndexes(windowId);
  applyRestoredParent(windowId, tabId, record.parentId, { childPinned: Boolean(tab.pinned), indexMap });
  return true;
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

      // 先按实时下标重建一次：`indexById` 是"删除不重编号"的近似表，
      // 而下面判断"父是否排在子之前"必须依据物理事实。
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

function setTabValue(tabId, key, value) {
  return new Promise((resolve) => {
    try {
      chrome.sessions.setTabValue(tabId, key, value, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (error) {
      resolve();
    }
  });
}

function getTabValue(tabId, key) {
  return new Promise((resolve) => {
    try {
      chrome.sessions.getTabValue(tabId, key, (value) => {
        resolve(chrome.runtime.lastError ? null : value);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

/** 关闭父标签后，它的子标签会被提升：这些子标签的持久引用需要重写。 */
export function handlePromotionAfterClose(removedTabId, windowId) {
  const children = getChildTabIds(removedTabId, windowId);
  if (children.length > 0) {
    handleTabStructureChanged(windowId, children);
  }
}
