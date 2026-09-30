// 侧边栏「外部拖放」的纯逻辑：数据类型优先级、链接/搜索词判定、落点意图组装。
//
// 与 chrome API、Vue 都无关（只读取一个"类 DataTransfer"对象和几个基本值），
// 因此可以在 Node 里直接单测——拖放这类交互在真实浏览器里很难自动化，纯函数是唯一可靠的回归保护。
//
// 规则对齐 Tree Style Tab 的 `webextensions/common/retrieve-url.js`：
// 类型优先级、`uri-list` 注释行处理、裸域名补 `http://`、过滤 `javascript:`/`data:`。
//
// 安全提示：`parseDroppedItem` 必须在 drop 事件的同一个同步调用栈里执行，
// 事件结束后 `dataTransfer.getData()` 就取不到数据了（Firefox 与 Chrome 都会清空）。

// 取值优先级：拖动链接时数据里通常同时带 `text/uri-list` 与 `text/plain`，
// 必须先看 uri-list，否则链接会被当成普通文本丢给搜索引擎。
const DROP_DATA_TYPES = [
  "text/uri-list",
  "text/x-moz-url",
  "text/x-moz-text-internal",
  "text/plain",
];

// 带协议头的链接（`https://`、`file://`、`chrome://` …）。故意要求 `//`：
// 纯文本里出现的 `mailto:foo@bar` 更像一句话而不是链接，与 TST 的口径一致。
const URL_PATTERN = /^\w+:\/\/.+/;
// 裸域名：`example.com`、`example.com/path`、`sub.example.co.jp`。
const BARE_DOMAIN_PATTERN = /^([^.\s]+\.)+[^.\s]{2}/;
// 不允许的协议：拖放不能被用作脚本执行入口。
const UNSAFE_SCHEME_PATTERN = /^\s*(javascript|data):/i;

/**
 * 判断这次拖拽是否携带"外部内容"（链接或文本）而不是本插件内部的标签拖拽。
 *
 * 注意：内部标签拖拽也会写 `text/plain`（写的是标签 id），所以调用方**必须**同时判断
 * "当前没有内部拖拽进行中"（组件里的 draggingId 为空），不能只看这里。
 *
 * @param {DataTransfer|null} dataTransfer
 */
export function isExternalDropData(dataTransfer) {
  if (!dataTransfer || !dataTransfer.types) {
    return false;
  }
  const types = Array.from(dataTransfer.types);
  return DROP_DATA_TYPES.some((type) => types.indexOf(type) !== -1);
}

/** 拆分多行文本，去掉空行；`uri-list` 还要丢掉 `#` 注释行。 */
function splitEntries(raw, { dropComments = false } = {}) {
  const lines = String(raw).replace(/\r/g, "\n").split("\n");
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (dropComments && trimmed.charAt(0) === "#") {
      continue;
    }
    entries.push(trimmed);
  }
  return entries;
}

/**
 * 从 `text/x-moz-url` 里取 URL。
 * 这种类型是 "URL\n标题\nURL\n标题" 的成对数据，URL 全在偶数行。
 */
function firstMozUrlEntry(raw) {
  const lines = String(raw).replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 2) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

/** 单个类型的原始数据 → 第一个候选条目（可能是链接，也可能是搜索词）。 */
export function firstDropEntry(raw, type) {
  if (!raw) {
    return "";
  }
  if (type === "text/x-moz-url") {
    return firstMozUrlEntry(raw);
  }
  const entries = splitEntries(raw, { dropComments: type === "text/uri-list" });
  return entries.length > 0 ? entries[0] : "";
}

/**
 * 判定一条候选文本是链接还是搜索词。
 *
 * @param {string} text
 * @returns {{kind: "url"|"query", value: string}|null} 不安全的协议返回 null（忽略这次拖放）。
 */
export function classifyDroppedText(text) {
  const value = String(text || "").trim();
  if (!value) {
    return null;
  }
  if (UNSAFE_SCHEME_PATTERN.test(value)) {
    return null;
  }
  if (URL_PATTERN.test(value)) {
    return { kind: "url", value };
  }
  if (BARE_DOMAIN_PATTERN.test(value)) {
    // 用户拖的"example.com"应当当链接打开，而不是去搜索引擎搜这个词组。
    return { kind: "url", value: `http://${value}` };
  }
  return { kind: "query", value };
}

/**
 * 解析一次外部拖放。
 *
 * 使用场景：侧边栏树行、固定标签图标、列表下方空白处的 drop 事件。
 * 前置要求：在 drop 的同步调用栈里调用。
 *
 * @param {DataTransfer|null} dataTransfer
 * @returns {{kind: "url"|"query", value: string}|null}
 */
export function parseDroppedItem(dataTransfer) {
  if (!dataTransfer || typeof dataTransfer.getData !== "function") {
    return null;
  }
  for (const type of DROP_DATA_TYPES) {
    let raw = "";
    try {
      raw = dataTransfer.getData(type) || "";
    } catch (error) {
      raw = "";
    }
    if (!raw) {
      continue;
    }
    const entry = firstDropEntry(raw, type);
    if (!entry) {
      continue;
    }
    const item = classifyDroppedText(entry);
    // 命中的类型解析出来是"不安全协议"时直接放弃，不再回退到更低优先级：
    // 同一个拖拽的 text/plain 往往是同一段内容，回退只会把被拒的链接再按搜索词打开一次。
    return item;
  }
  return null;
}

/**
 * 树区域的落点 → 后台消息里的布局意图。
 *
 * 与管理页/侧边栏**内部拖拽改父子**共用同一套口径：
 * - `before`：插到目标行之前，成为目标行的兄弟（父 = 目标行的父）；
 * - `after`：插到目标行之后（含其整棵子树之后），成为目标行的兄弟；
 * - `child`（行中间）：外部拖放没有"成为子标签"的语义，改为**覆盖**目标标签。
 *
 * @param {number} targetTabId 目标行对应的标签 id
 * @param {number|null} targetParentId 目标行的父标签 id（顶层为 null）
 * @param {"before"|"after"|"child"} zone
 * @returns {{replaceTabId: number}|{parentId: number|null, beforeTabId?: number, afterTabId?: number}}
 */
export function buildTreeDropPayload(targetTabId, targetParentId, zone) {
  const tabId = Number(targetTabId);
  const parentId =
    targetParentId === null || targetParentId === undefined ? null : Number(targetParentId);
  if (zone === "child") {
    return { replaceTabId: tabId };
  }
  if (zone === "before") {
    return { parentId, beforeTabId: tabId };
  }
  return { parentId, afterTabId: tabId };
}

/** 列表下方空白处的落点：追加到最后一个可见行之后（没有行时建为顶层）。 */
export function buildAppendDropPayload(lastTabId, lastParentId) {
  if (lastTabId === null || lastTabId === undefined) {
    return { parentId: null };
  }
  const parentId =
    lastParentId === null || lastParentId === undefined ? null : Number(lastParentId);
  return { parentId, afterTabId: Number(lastTabId) };
}

/**
 * 固定标签区的横向分区。
 *
 * 与内部重排（左右各半）不同：外部拖放必须在中间留出"覆盖"区，
 * 所以前后插入只占两侧 1/4，中间 1/2 覆盖。
 *
 * @param {number} clientX 指针横坐标
 * @param {{left: number, width: number}} rect 图标的包围盒
 * @returns {"before"|"overwrite"|"after"}
 */
export function resolvePinnedDropPosition(clientX, rect) {
  if (!rect || !rect.width) {
    return "overwrite";
  }
  const ratio = (Number(clientX) - rect.left) / rect.width;
  if (ratio < 0.25) {
    return "before";
  }
  if (ratio > 0.75) {
    return "after";
  }
  return "overwrite";
}

/**
 * 固定标签区的落点 → 布局意图。
 *
 * 前置要求：`before`/`after` 只在**本窗口**的固定标签组上生效——
 * 在别的窗口的组里插入固定标签等价于"往那个窗口塞标签"，与固定标签区"跨窗口不重排"的既有规则相悖。
 *
 * @param {{tabId: number, windowId: number, isCurrentWindow: boolean}} target
 * @param {"before"|"overwrite"|"after"} position
 * @returns {{replaceTabId: number}|{windowId: number, pinned: true, beforeTabId?: number, afterTabId?: number}|null}
 */
export function buildPinnedDropPayload(target, position) {
  const tabId = Number(target && target.tabId);
  if (!Number.isFinite(tabId)) {
    return null;
  }
  if (position === "overwrite") {
    return { replaceTabId: tabId };
  }
  if (!target.isCurrentWindow) {
    return null;
  }
  const windowId = Number(target.windowId);
  if (!Number.isFinite(windowId)) {
    return null;
  }
  if (position === "before") {
    return { windowId, pinned: true, beforeTabId: tabId };
  }
  return { windowId, pinned: true, afterTabId: tabId };
}
