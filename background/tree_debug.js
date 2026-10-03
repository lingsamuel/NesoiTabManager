// 树结构调试：开关、树状态格式化、变化原因日志。
//
// 为什么单独成模块：树的"变化原因"分散在两处——tree_core.js 是纯算法决策（提升规则、
// 不变量修正），tree.js 是事件链路（关闭/移动/重建/落盘）。而"要不要打印"是运行时开关，
// 由用户在设置页打开。把开关、格式化、日志缓冲集中在这里，算法与事件链路只调用
// logFlow()/logTree()/noteTreeChange() 这类薄接口，各自的职责保持清晰。
//
// 输出两条通道，缺一不可：
// 1. 后台控制台（about:debugging → 本扩展 → 检查 → 控制台）——实时、可展开；
// 2. storage.session 里的环形缓冲——后台被回收、控制台没开着也不会丢现场，
//    管理页「复制调试日志」把最近若干行取走，便于整段贴出来核对。
//
// 日志内容说明：只会打印标签 id / 下标 / 父子关系 / 变化原因；**不含 URL**。
// 标题只在"调试模式 + 打印树"双开时才附带（便于人工对照），属于用户数据，
// 因此默认关闭、调试完请立刻关掉。

import { TREE_DEBUG_KEY, TREE_DEBUG_LOG_KEY } from "./constants.js";
import { storageGet, storageSessionGet, storageSessionSet } from "./storage.js";
import { buildTreeRows } from "./tree_core.js";

// 环形缓冲最多保留多少条（一条可能是多行文本块）。
const MAX_LOG_ENTRIES = 800;
// 写 storage.session 的防抖：一次关闭会连续产生多条，合并成一次写。
const PERSIST_DEBOUNCE_MS = 400;

let config = { enabled: false, printTree: false };
let loaded = false;
// 标签标题提供者：由 background.js 注入（复用 recent_tabs 的标签缓存），
// 这样本模块不必依赖 chrome API 与其它业务模块。
let labelProvider = null;
let entries = [];
let persistTimer = null;
let persistChain = Promise.resolve();

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

/** 子开关：控制"树状态 + 变化原因"日志，输出量很大，只在需要复现时打开。 */
export function isTreeDebugPrintEnabled() {
  return config.enabled && config.printTree;
}

/** 注入"标签 id → 人类可读标题"的提供者；取不到时退回 `#id`。 */
export function setTreeDebugLabelProvider(provider) {
  labelProvider = typeof provider === "function" ? provider : null;
}

/** 套用一份配置（内存态），返回归一化后的结果。 */
export function applyTreeDebugConfig(raw) {
  config = normalizeConfig(raw);
  return getTreeDebugConfig();
}

/** 启动时从 storage.local 读回配置（幂等）。 */
export async function initializeTreeDebug() {
  if (loaded) {
    return getTreeDebugConfig();
  }
  loaded = true;
  applyTreeDebugConfig(await storageGet(TREE_DEBUG_KEY));
  return getTreeDebugConfig();
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
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [TREE_DEBUG_KEY]: value }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (error) {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// 日志输出
// ---------------------------------------------------------------------------

const PREFIX = {
  flow: "[Nesoi树·流程]",
  tree: "[Nesoi树·树状]",
  // 变化摘要单独一个前缀：几千标签的窗口里树快照有几千行，摘要必须能一眼看到、
  // 也必须在控制台里能按前缀过滤出来。
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
  const text = `${PREFIX[scope]} ${toText(parts)}`;
  if (typeof console !== "undefined" && typeof console.log === "function") {
    console.log(text);
  }
  entries.push(text);
  if (entries.length > MAX_LOG_ENTRIES) {
    entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  }
  schedulePersist();
}

/** 流程级日志（需要总开关）。 */
export function logFlow(...parts) {
  if (!config.enabled) {
    return;
  }
  emit("flow", parts);
}

/** 树状日志：整棵树与变化原因（需要总开关 + 子开关）。 */
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

/**
 * 单独打印"变化原因 + 前后差异"摘要块。
 *
 * 为什么必须单独打一份：几千标签的窗口里，关闭前后各是一份几千行的树快照，
 * 真正要看的那几行原因和差异会被彻底淹没。摘要在完整块之外**再打一次**，
 * 用独立前缀 `[Nesoi树·变化摘要]`，既方便一眼找到，也方便在控制台按前缀过滤。
 * 完整块（关闭前的树 / 变化原因 / 关闭后的树 / 前后差异）保持不变。
 */
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

function schedulePersist() {
  if (persistTimer) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = entries.slice();
    persistChain = persistChain
      .then(() => storageSessionSet({ [TREE_DEBUG_LOG_KEY]: snapshot }))
      .catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

/** 后台启动时把上次留下的日志读回来（storage.session 跨回收存活）。 */
export async function loadTreeDebugLog() {
  const stored = await storageSessionGet(TREE_DEBUG_LOG_KEY);
  if (Array.isArray(stored)) {
    entries = stored.filter((item) => typeof item === "string").slice(-MAX_LOG_ENTRIES);
  }
  return entries.length;
}

/** 供管理页「复制调试日志」取走全文。 */
export function getTreeDebugLogText() {
  return entries.join("\n");
}

/** 清空日志（内存 + storage.session）。 */
export function clearTreeDebugLog() {
  entries = [];
  schedulePersist();
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
    const label = labelProvider ? labelProvider(row.id) : "";
    return `${"  ".repeat(row.depth)}#${row.id} idx=${indexById.get(row.id)}${label ? ` ${label}` : ""}`;
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
  const labelOf = (id) => {
    const label = labelProvider ? labelProvider(id) : "";
    return label ? `#${id} ${label}` : `#${id}`;
  };
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
