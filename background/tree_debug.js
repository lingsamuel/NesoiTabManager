// 树诊断统一入口：开关、兼容格式化与可靠会话缓冲。仅记录结构元数据。

import { TREE_DEBUG_KEY, TREE_DEBUG_LOG_KEY } from "./constants.js";
import { createTreeDebugBuffer, sanitizeTreeDiagnostic } from "./tree_debug_buffer.js";
import { buildTreeRows } from "./tree_core.js";

let config = { enabled: false, printTree: false };
let configPromise;
let configGeneration = 0;
const sourceId = `background-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

// 通用 storage 包装会吞掉错误；诊断必须单独读取 lastError 才能如实报告保存状态。
function checkedStorageOperation(area, method, value, key) {
  return new Promise((resolve, reject) => {
    try {
      if (!globalThis.chrome?.storage?.[area]) throw new Error(`${area} 存储不可用`);
      chrome.storage[area][method](value, (result) => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message || String(error)));
        else resolve(method === "get" ? result?.[key] : undefined);
      });
    } catch (error) { reject(error); }
  });
}
const buffer = createTreeDebugBuffer({
  read: () => checkedStorageOperation("session", "get", TREE_DEBUG_LOG_KEY, TREE_DEBUG_LOG_KEY),
  write: (value) => checkedStorageOperation("session", "set", { [TREE_DEBUG_LOG_KEY]: value }),
  sourceId,
  version: globalThis.chrome?.runtime?.getManifest?.()?.version || "unknown",
});
const statusListeners = new Set();
function notifyStatus() {
  for (const listener of statusListeners) {
    try { listener(getTreeDebugStatus()); } catch (_) { /* 提示失败不能影响正常业务。 */ }
  }
}
buffer.subscribe(notifyStatus);

function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const enabled = Boolean(source.enabled);
  return {
    enabled,
    // 子开关必须挂在总开关下：总开关关掉时子开关一律视为关闭。
    printTree: enabled && Boolean(source.printTree),
  };
}

/** 当前调试配置（只读副本）。 */
export function getTreeDebugConfig() {
  return { ...config };
}

/** 总开关：控制"流程级"日志（重建来源、落盘结果、后台启动等）。 */
export function isTreeDebugEnabled() {
  return config.enabled;
}

/** 子开关：控制局部结构与变化原因的详细证据。 */
export function isTreeDebugPrintEnabled() {
  return config.enabled && config.printTree;
}

/** 兼容旧的提供者注入接口；诊断已禁止输出标题。 */
export function setTreeDebugLabelProvider(provider) {
  // 保留旧调用接口，但不再采集标题或 URL。
  void provider;
}

/** 套用一份配置（内存态），返回归一化后的结果。 */
export function applyTreeDebugConfig(raw) {
  configGeneration++;
  config = normalizeConfig(raw);
  notifyStatus();
  return getTreeDebugConfig();
}

/** 启动时从 storage.local 读回配置（幂等）。 */
export function initializeTreeDebug() {
  if (!configPromise) {
    const loadingGeneration = configGeneration;
    configPromise = checkedStorageOperation("local", "get", TREE_DEBUG_KEY, TREE_DEBUG_KEY).then((stored) => {
      // 读取期间的用户配置已立即生效，晚到的历史值不能覆盖它。
      if (configGeneration === loadingGeneration) applyTreeDebugConfig(stored);
      return getTreeDebugConfig();
    });
  }
  return configPromise;
}

/** storage.onChanged 入口：用户在设置页改开关时立即生效，不必等后台重启。 */
export function handleTreeDebugConfigChanged(raw) {
  return applyTreeDebugConfig(raw);
}

/** 持久化配置（返回归一化后的配置）。 */
export async function saveTreeDebugConfig(patch) {
  applyTreeDebugConfig({ ...config, ...(patch || {}) });
  const value = getTreeDebugConfig();
  await persistConfig(value);
  return value;
}

function persistConfig(value) {
  return checkedStorageOperation("local", "set", { [TREE_DEBUG_KEY]: value });
}

// ---------------------------------------------------------------------------
// 日志输出
// ---------------------------------------------------------------------------

const PREFIX = {
  flow: "[Nesoi树·流程]",
  tree: "[Nesoi树·树状]",
  // 独立前缀保留旧日志调用的可识别性。
  summary: "[Nesoi树·变化摘要]",
};

function toText(parts) {
  return parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part instanceof Map) {
        return JSON.stringify(Object.fromEntries(part));
      }
      try {
        return JSON.stringify(part);
      } catch (error) {
        return String(part);
      }
    })
    .join(" ");
}

function emit(scope, parts) {
  // 兼容已有原因日志；新增结构事件优先通过 recordTreeDiagnostic 传结构化字段。
  const text = `${PREFIX[scope]} ${toText(parts.map((part) => sanitizeTreeDiagnostic(part)))}`;
  buffer.record({ type: scope, text });
}

/** 新诊断记录统一受总开关控制；前端保留采集顺序并另记后台接收时间。 */
export function recordTreeDiagnostic(event) {
  if (!config.enabled || !event || typeof event !== "object") return null;
  return buffer.record({ ...event, ...(event.sourceId && event.sourceId !== sourceId && event.receivedAt === undefined ? { receivedAt: new Date().toISOString() } : {}) });
}

/** 首次与最近现场独立保留；恢复后再现会创建新的异常包。 */
export function recordTreeIncident(event) {
  if (!config.enabled || !event || typeof event !== "object") return null;
  return buffer.incident(event);
}

/** 供 UI 获取小状态，不触发额外持久化。 */
export function getTreeDebugStatus() {
  return { enabled: config.enabled, ...buffer.status() };
}

/** 状态广播由调用方节流；监听不会单独写 storage。 */
export function subscribeTreeDebugStatus(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** 导出等待恢复并尝试保存；失败仍返回当前内存中的全部有界记录。 */
export function exportTreeDebugLog() {
  return buffer.exportText();
}

/** 流程级日志（需要总开关）。 */
export function logFlow(...parts) {
  if (!config.enabled) {
    return;
  }
  emit("flow", parts);
}

/** 兼容详细结构与原因日志（需要总开关 + 子开关）。 */
export function logTree(...parts) {
  if (!isTreeDebugPrintEnabled()) {
    return;
  }
  emit("tree", parts);
}

/** 打印一个多行文本块（树快照、变化原因汇总等）。 */
export function logTreeBlock(title, lines) {
  if (!isTreeDebugPrintEnabled()) {
    return;
  }
  const body = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  emit("tree", [`${title}\n${body}`]);
}

/** 兼容旧摘要入口；新观测通过结构化诊断入口记录局部前后证据。 */
export function logChangeSummary(title, reasonLines, diffLines) {
  if (!isTreeDebugPrintEnabled()) {
    return;
  }
  const reasons = Array.isArray(reasonLines) ? reasonLines : [];
  const diffs = Array.isArray(diffLines) ? diffLines : [];
  const body = [
    "--- 变化原因 ---",
    reasons.length > 0 ? reasons.map((item, index) => `${index + 1}. ${item}`).join("\n") : "（没有产生任何结构性变化）",
    "--- 前后差异 ---",
    diffs.length > 0 ? diffs.join("\n") : "（无差异）",
  ].join("\n");
  emit("summary", [`${title}\n${body}`]);
}

/** 恢复只启动一次，恢复期间的新日志与旧记录合并。 */
export function loadTreeDebugLog() {
  return buffer.load();
}

/** 兼容同步读取；用户导出应调用异步 exportTreeDebugLog。 */
export function getTreeDebugLogText() {
  return buffer.text();
}

/** 清空使用代次屏障，防止晚到的恢复/保存覆盖新状态。 */
export function clearTreeDebugLog() {
  return buffer.clear();
}

// ---------------------------------------------------------------------------
// 树状态格式化
// ---------------------------------------------------------------------------

/**
 * 把一个"树状态快照"格式化成缩进文本（DFS，与侧边栏/管理页的渲染口径一致）。
 *
 * @param {{entries: Array<{id:number, parentId:number|null, index:number}>}|null} state
 * @param {{maxRows?: number}} options maxRows 用于防御超大窗口（默认 4000 行）
 */
export function formatTreeState(state, options = {}) {
  if (!state || !Array.isArray(state.entries)) {
    return "（无内存树）";
  }
  const list = state.entries
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((entry) => ({ id: entry.id, index: entry.index }));
  const parentMap = new Map(
    state.entries.filter((entry) => entry.parentId !== null && entry.parentId !== undefined).map((entry) => [entry.id, entry.parentId])
  );
  const rows = buildTreeRows(list, parentMap, {});
  const indexById = new Map(list.map((tab) => [tab.id, tab.index]));
  const maxRows = Number.isFinite(options.maxRows) ? options.maxRows : 4000;
  const lines = rows.slice(0, maxRows).map((row) => {
    return `${"  ".repeat(row.depth)}#${row.id} idx=${indexById.get(row.id)}`;
  });
  if (rows.length > maxRows) {
    lines.push(`…（共 ${rows.length} 行，已截断）`);
  }
  return lines.length > 0 ? lines.join("\n") : "（空）";
}

/**
 * 对比两个树状态，列出"父关系变化 / 新增 / 消失 / 物理位置变化"。
 * 位置变化过多时（关闭标签会让后面全部左移）只给汇总，避免刷屏。
 */
export function diffTreeStates(before, after) {
  if (!before || !after) {
    return ["（无法对比：一侧没有内存树）"];
  }
  const labelOf = (id) => `#${id}`;
  const beforeParent = new Map(before.entries.map((entry) => [entry.id, entry.parentId ?? null]));
  const afterParent = new Map(after.entries.map((entry) => [entry.id, entry.parentId ?? null]));
  const beforeIndex = new Map(before.entries.map((entry) => [entry.id, entry.index]));
  const afterIndex = new Map(after.entries.map((entry) => [entry.id, entry.index]));
  const lines = [];
  const describe = (id) => (id === null || id === undefined ? "顶层" : labelOf(id));
  for (const [id, parentId] of afterParent) {
    if (!beforeParent.has(id)) {
      lines.push(`+ ${labelOf(id)} 进入树，父=${describe(parentId)}`);
      continue;
    }
    const oldParent = beforeParent.get(id);
    if ((oldParent ?? null) !== (parentId ?? null)) {
      lines.push(`父变化 ${labelOf(id)}：${describe(oldParent)} → ${describe(parentId)}`);
    }
  }
  for (const id of beforeParent.keys()) {
    if (!afterParent.has(id)) {
      lines.push(`- ${labelOf(id)} 已不在树里`);
    }
  }
  const movedIndexes = [];
  for (const [id, index] of afterIndex) {
    const old = beforeIndex.get(id);
    if (old !== undefined && old !== index) {
      movedIndexes.push(`${labelOf(id)} idx ${old}→${index}`);
    }
  }
  if (movedIndexes.length > 0) {
    lines.push(
      movedIndexes.length <= 12
        ? `位置变化：${movedIndexes.join("；")}`
        : `位置变化：共 ${movedIndexes.length} 个标签的物理 index 改变（关闭后整体左移属正常）`
    );
  }
  return lines.length > 0 ? lines : ["（无变化）"];
}
