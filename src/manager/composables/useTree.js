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
import { getTreeDiagnostics } from "../utils/tree_diagnostics.js";
import {
  HAS_SESSION_STORAGE,
  storageLocalGet,
  storageLocalSet,
  storageSessionGet,
  storageSessionSet,
} from "../utils/storage.js";

const MODE_STORAGE_KEY = "treeViewMode";
const COLLAPSED_STORAGE_KEY = "treeCollapsed";
// 后台写入的树结构版本号（storage.session）：`{ [windowId]: revision }`。
const REVISION_STORAGE_KEY = "treeStructureRevision";
const MODE_TREE = "tree";
const MODE_FLAT = "flat";
// 折叠切换的写入防抖：连点折叠时只在停下来后写一次。
const COLLAPSED_SAVE_DEBOUNCE_MS = 500;

function useTree() {
  const diagnostics = getTreeDiagnostics();
  const diagnosticRequestByWindow = new Map();
  const diagnosticOperationByWindow = new Map();
  const diagnosticAppliedByWindow = new Map();
  const diagnosticMismatches = new Map();
  let diagnosticGeneration = diagnostics.state.generation;
  const mode = ref(true);
  // windowId -> { [childId]: parentId }，只包含"有父标签"的条目，缺省即顶层。
  const parentsByWindow = reactive({});
  // windowId -> 已应用的结构版本号。后台每次结构变化都会自增该值（并推送变更通知），
  // 这里记下来用于丢弃"慢请求先发后到"的旧结果——否则界面可能被旧结构覆盖，
  // 出现"后台已经改了、界面还显示旧层级"。
  const revisionByWindow = reactive({});
  // 版本号令牌：后台实例重启后版本号会从头开始，此时不能与本地已知值比较（见下面的 loadForWindows）。
  let knownRevisionToken = "";
  // 通知只说明后台来源变化；窗口版本号必须与真正采用该结构时的来源配对。
  const appliedTokenByWindow = new Map();
  const retiredRevisionTokens = new Set();
  // windowId -> { [tabId]: true }，折叠的子树根。
  const collapsedByWindow = reactive({});
  const status = reactive({ message: "", type: "" });

  let collapsedSaveTimer = null;
  // 订阅"后台结构变了"的回调（管理页 / 侧边栏各自的刷新队列）。
  const structureListeners = new Set();

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
   *
   * 同一个监听器还负责**结构变更通知**（`treeStructureRevision`）：后台每次改结构（含落盘前的
   * 静默纠偏——它不产生任何 tabs 事件）都会自增该键，前端据此重拉父子映射。
   * 这是"界面看到的必须等于后台真实结构"的兜底通道：只靠 tabs 事件会出现
   * "后台已经纠偏、界面还显示旧层级，必须 Reload 扩展才对齐"。
   */
  function watchSessionChanges() {
    if (!HAS_SESSION_STORAGE || typeof chrome.storage.onChanged === "undefined") {
      return;
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session") {
        return;
      }
      if (changes[REVISION_STORAGE_KEY]) {
        const incoming = changes[REVISION_STORAGE_KEY].newValue;
        notifyStructureChanged(incoming);
      }
      if (!changes[COLLAPSED_STORAGE_KEY]) {
        return;
      }
      const incoming = changes[COLLAPSED_STORAGE_KEY].newValue;
      if (collapsedSignature(incoming) === collapsedSignature(serializeCollapsed())) {
        return;
      }
      applyCollapsed(incoming);
    });
  }

  /**
   * 通知订阅者"后台结构变了"。
   *
   * @param {object} raw `{ token, revisions: { [windowId]: revision } }`
   *   `token` 是后台实例的版本号令牌：与本地已知值不同时说明后台重启过（版本号不可比较），
   *   此时按"变化未知"通知一次全量刷新。
   */
  function notifyStructureChanged(raw) {
    const payload = raw && typeof raw === "object" ? raw : {};
    const incomingToken = String(payload.token || "");
    if (retiredRevisionTokens.has(incomingToken)) return;
    const sameInstance = incomingToken !== "" && incomingToken === knownRevisionToken;
    const revisions = payload.revisions && typeof payload.revisions === "object" ? payload.revisions : null;
    if (!revisions) {
      return;
    }
    const windowIds = [];
    for (const [windowId, revision] of Object.entries(revisions)) {
      const id = Number(windowId);
      const value = Number(revision);
      if (!Number.isFinite(id) || !Number.isFinite(value)) {
        continue;
      }
      // 同一实例内只通知"版本号确实前进了"的窗口，避免重复写入造成多余刷新。
      if (sameInstance && appliedTokenByWindow.get(windowId) === incomingToken &&
          value <= Number(revisionByWindow[windowId] || 0)) {
        continue;
      }
      windowIds.push(id);
    }
    // 后台重启过：版本号不可比较，按"变化未知"处理（空列表 = 让订阅方做一次全量刷新）。
    const changed = sameInstance ? windowIds : [];
    rememberRevisionToken(incomingToken);
    if (sameInstance && changed.length === 0) {
      return;
    }
    for (const listener of [...structureListeners]) {
      try {
        listener(changed);
      } catch (error) {
        console.warn(
          "树结构变更回调失败：",
          String(error && error.message ? error.message : error)
        );
      }
    }
  }

  /** 只记录实例边界，不挪用任何窗口的已采用版本；旧实例不能再次成为当前来源。 */
  function rememberRevisionToken(token) {
    if (!token || token === knownRevisionToken) return;
    if (knownRevisionToken) retiredRevisionTokens.add(knownRevisionToken);
    knownRevisionToken = token;
  }

  /**
   * 订阅"后台树结构发生变化"。
   * @param {(windowIds: number[]) => void} listener
   * @returns {() => void} 取消订阅
   */
  function onStructureChanged(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    structureListeners.add(listener);
    return () => structureListeners.delete(listener);
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
   *
   * 结果自带 `revision`（该窗口内存树的版本号）：比本地已知值更旧的结果直接丢弃，
   * 避免并发的两次拉取里"慢的那次后到"把新结构覆盖回旧结构。
   */
  async function loadForWindows(windowIds) {
    const payload = Array.isArray(windowIds) && windowIds.length > 0 ? { windowIds } : {};
    const requestedToken = knownRevisionToken;
    const correlationId = diagnostics.correlationId();
    if (diagnosticGeneration !== diagnostics.state.generation) {
      diagnosticAppliedByWindow.clear();
      diagnosticMismatches.clear();
      diagnosticOperationByWindow.clear();
      diagnosticRequestByWindow.clear();
      diagnosticGeneration = diagnostics.state.generation;
    }
    if (correlationId) {
      payload.diagnosticRequestId = correlationId;
      diagnostics.record({ type: "request", source: "frontend-structure", correlationId,
        windowIds: payload.windowIds || [], knownToken: knownRevisionToken });
    }
    const response = await request("getTreeStructure", payload);
    if (correlationId) diagnostics.record({ type: "response-received", source: "frontend-structure", correlationId,
      success: Boolean(response?.ok) });
    if (!response || !response.ok) {
      setStatus((response && response.error) || "树状结构加载失败。", "error");
      return false;
    }
    const appliedWindows = new Set();
    let discarded = false;
    for (const [windowId, data] of Object.entries(response.structures || {})) {
      const incomingRevision = Number(data && data.revision);
      const incomingToken = String((data && data.revisionToken) || "");
      // 全局可能已收到新实例通知，但这个窗口仍持有旧实例结构，不能跨实例比较版本。
      const sameInstance = incomingToken !== "" && incomingToken === appliedTokenByWindow.get(windowId);
      const knownRevision = Number(revisionByWindow[windowId] || 0);
      const diagnosticContext = correlationId ? {
        source: "frontend-structure", windowId: Number(windowId), correlationId,
        incomingRevision, incomingToken, knownRevision, knownToken: knownRevisionToken, sameInstance,
      } : null;
      // 请求跨过实例边界后，只允许当前已确认来源的结果，避免首次加载的未知旧响应回退。
      const staleInstance = retiredRevisionTokens.has(incomingToken) ||
        (requestedToken !== knownRevisionToken && incomingToken !== knownRevisionToken);
      if (staleInstance || (sameInstance && Number.isFinite(incomingRevision) && incomingRevision < knownRevision)) {
        if (diagnosticContext) diagnostics.record({ ...diagnosticContext,
          type: "response-discarded", phase: "discarded", reason: staleInstance ? "stale-instance" : "stale-revision" });
        discarded = true;
        continue;
      }
      const lastApplied = diagnosticAppliedByWindow.get(String(windowId));
      const compatibleBaseline = lastApplied?.token === incomingToken && lastApplied.revision === incomingRevision;
      if (diagnosticContext && lastApplied && !compatibleBaseline) {
        // 版本不同时无法判断同版本前后态，保留观测间隙而非跨实例/版本拼接异常。
        diagnostics.gap({ windowId: Number(windowId), source: "frontend-structure",
          reason: lastApplied.token === incomingToken ? "response-version-changed" : "source-instance-changed" });
        diagnosticAppliedByWindow.delete(String(windowId));
        diagnosticMismatches.delete(String(windowId));
      }
      if (diagnosticContext && compatibleBaseline) {
        // 处理中仍可按业务规则应用响应；诊断比较独立副本，避免该应用覆盖最早已对齐证据。
        const before = lastApplied.parents;
        const after = (data && data.parents) || {};
        const changed = [];
        let changedCount = 0;
        for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (before[id] === after[id]) continue;
          changedCount += 1;
          if (changed.length < 16) changed.push({ id: Number(id), before: before[id] ?? null, after: after[id] ?? null });
        }
        if (changedCount && data?.diagnosticContext?.pending) {
          diagnostics.record({ ...diagnosticContext, type: "parent-mismatch-observation", phase: "pending",
            evidence: { nodes: changed, changedCount, omitted: changedCount - changed.length } });
        } else if (changedCount) {
          const signature = `${diagnostics.sourceId}:${windowId}:${incomingToken}:${incomingRevision}:parent-mismatch`;
          diagnosticMismatches.set(String(windowId), signature);
          diagnostics.record({
            ...diagnosticContext, type: "same-version-parent-mismatch", status: "active", signature,
            evidence: { nodes: changed, changedCount, omitted: changedCount - changed.length },
          }, "incident");
        } else if (diagnosticMismatches.has(String(windowId)) && !data?.diagnosticContext?.pending) {
          diagnostics.record({ ...diagnosticContext, type: "same-version-parent-mismatch", status: "recovered",
            signature: diagnosticMismatches.get(String(windowId)), evidence: { changedCount: 0 } }, "incident");
          diagnosticMismatches.delete(String(windowId));
        }
      }
      if (diagnosticContext) diagnostics.record({ ...diagnosticContext, type: "response-accepted" });
      parentsByWindow[windowId] = (data && data.parents) || {};
      if (Number.isFinite(incomingRevision)) {
        revisionByWindow[windowId] = incomingRevision;
      }
      rememberRevisionToken(incomingToken);
      appliedTokenByWindow.set(windowId, incomingToken);
      appliedWindows.add(windowId);
      if (diagnosticContext) {
        if (!data?.diagnosticContext?.pending) {
          diagnosticAppliedByWindow.set(String(windowId), {
            token: incomingToken, revision: incomingRevision, parents: { ...((data && data.parents) || {}) },
          });
        }
        diagnosticRequestByWindow.set(String(windowId), correlationId);
        const operation = data?.diagnosticContext;
        // 只保留当前响应版本的解释链；树本身的版本接受规则完全不依赖这些旁路数据。
        if (operation?.revision === incomingRevision && Array.isArray(operation.operations)) {
          diagnosticOperationByWindow.set(String(windowId), { ...operation, sourceToken: incomingToken });
        } else {
          diagnosticOperationByWindow.delete(String(windowId));
        }
        diagnostics.record({ ...diagnosticContext, type: "response-applied", phase: "applied",
          parentCount: Object.keys(parentsByWindow[windowId]).length });
      }
    }
    // HTTP/IPC 成功不代表界面已经采用所需结构，缺失或丢弃都不能宣告已对齐。
    if (discarded || payload.windowIds?.some(windowId => !appliedWindows.has(String(windowId)))) {
      setStatus("树状结构尚未同步，请稍后重试。", "error");
      return false;
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

  // 组装阶段就挂上远端变更监听：管理页与侧边栏谁先改动，另一边都能跟上；
  // 同一个监听器也承担"后台结构变更 → 前端重拉"的通知通道。
  watchSessionChanges();

  return {
    mode,
    status,
    loadPreferences,
    loadCollapsed,
    setMode,
    loadForWindows,
    onStructureChanged,
    parentsFor,
    // 行模型的旁路采样用它串起来源；不能用此值决定是否接受业务响应。
    diagnosticContextFor(windowId) {
      const requestId = diagnosticRequestByWindow.get(String(windowId)) || null;
      const operation = diagnosticOperationByWindow.get(String(windowId));
      const revision = Number(revisionByWindow[windowId] || 0);
      const sourceToken = appliedTokenByWindow.get(String(windowId)) || "";
      const validOperation = operation?.sourceToken === sourceToken && operation.revision === revision;
      return { ...(validOperation ? operation : {}),
        correlationId: requestId, requestId,
        sourceToken, revision };
    },
    isCollapsed,
    collapsedSetFor,
    toggleCollapse,
    pruneCollapsed,
  };
}

export { useTree };
