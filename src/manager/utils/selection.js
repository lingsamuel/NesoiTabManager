// 列表选择的「Shift 连续选择」共用逻辑。
//
// 管理页三个标签列表页（打开的窗口 / 近期标签页 / 冻结历史）与 Firefox 侧边栏的多选模式
// 用的是同一套语义，因此把"锚点维护 + 区间计算 + 剪枝"集中在这里：
// 它只依赖调用方传入的选中集合与"当前渲染顺序"，既不需要 Vue 也不需要 chrome API，可直接在 Node 里单测。
//
// 语义（与文档「连续选择（Shift 区间选择）」一致）：
// 1. 锚点 = 最近一次被**置为选中**的那一项；取消选中不改变锚点，但被取消的正好是锚点自己时清空；
// 2. Shift+点击 = 把锚点到终点（含两端）之间的**全部渲染项**置为选中——并集，不会取消任何已有选择；
// 3. 锚点不存在、已被取消、或不在当前渲染顺序里时，区间请求退化为普通点击（只切换被点项）。

/**
 * 计算区间选择覆盖的 key（含两端）。
 *
 * @param {Array<string|number>} orderedKeys 当前渲染顺序，必须与界面上的行顺序完全一致
 *   （树状模式下是 DFS 顺序；被折叠/被过滤隐藏的行不在其中，因此不会被圈进来）
 * @param {string|number|null|undefined} anchorKey 锚点；null/undefined 表示没有锚点
 * @param {string|number} targetKey 本次 Shift+点击的项
 * @returns {Array<string>|null} 区间内全部 key（字符串形式）；锚点或终点不在顺序里时返回 null
 */
function computeRangeKeys(orderedKeys, anchorKey, targetKey) {
  const keys = (Array.isArray(orderedKeys) ? orderedKeys : []).map((key) => String(key));
  if (anchorKey === null || anchorKey === undefined) {
    return null;
  }
  const anchorIndex = keys.indexOf(String(anchorKey));
  const targetIndex = keys.indexOf(String(targetKey));
  if (anchorIndex < 0 || targetIndex < 0) {
    return null;
  }
  return keys.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
}

/** 把 key 置为选中并返回新的锚点（"置为选中"是唯一会推进锚点的动作）。 */
function selectKey(selection, key) {
  const normalized = String(key);
  selection[normalized] = true;
  return normalized;
}

/** 取消选中；若取消的正是锚点本身则返回 null，否则锚点不变。 */
function deselectKey(selection, key, anchor) {
  const normalized = String(key);
  delete selection[normalized];
  return String(anchor) === normalized ? null : anchor;
}

/** 清空选中集合（锚点由调用方一并处理）。 */
function clearSelection(selection) {
  Object.keys(selection || {}).forEach((key) => {
    delete selection[key];
  });
}

/**
 * 处理一次普通点击：切换该项的选中态，并按规则推进/清空锚点。
 *
 * @returns {string|null} 新的锚点
 */
function toggleSelection(selection, key, anchor = null) {
  if (selection[String(key)]) {
    return deselectKey(selection, key, anchor);
  }
  return selectKey(selection, key);
}

/**
 * 处理一次点击（普通点击或 Shift 区间点击），统一入口。
 *
 * @param {object} selection 选中集合（通常是 Vue 的 reactive 对象，就地增删属性）
 * @param {{key: string|number, shiftKey?: boolean, orderedKeys?: Array, anchor?: string|null}} options
 * @returns {string|null} 新的锚点
 */
function applySelectionClick(selection, options = {}) {
  const { key, shiftKey = false, orderedKeys = [], anchor = null } = options;
  if (!shiftKey) {
    return toggleSelection(selection, key, anchor);
  }
  const covered = computeRangeKeys(orderedKeys, anchor, key);
  if (!covered) {
    // 锚点缺失/失效：退化为普通点击，避免"Shift 一下圈出一大段"的意外。
    return toggleSelection(selection, key, anchor);
  }
  covered.forEach((coveredKey) => {
    selection[coveredKey] = true;
  });
  // 终点成为新锚点：连续两次 Shift 会得到两段区间的并集。
  return String(key);
}

/**
 * 处理一次复选框/精确选择：checked 为 true 时置为选中，false 时精确取消。
 *
 * Shift 优先于 checked：复选框被 Shift+点击时浏览器可能把它改成"未勾选"
 * （原本勾着的项会变成 false），但 Shift 的语义是"选中整个区间、绝不取消"，
 * 因此这时忽略 checked，直接走区间选择。
 *
 * @returns {string|null} 新的锚点
 */
function setSelectionChecked(selection, key, checked, options = {}) {
  const { shiftKey = false, orderedKeys = [], anchor = null } = options;
  if (shiftKey) {
    return applySelectionClick(selection, { key, shiftKey: true, orderedKeys, anchor });
  }
  return checked ? selectKey(selection, key) : deselectKey(selection, key, anchor);
}

/**
 * 批量置为选中/取消（全选、全不选）。
 * 这两类动作不对应"某一行被选中"，因此调用方应把锚点清空。
 */
function setManySelected(selection, keys, checked) {
  (Array.isArray(keys) ? keys : []).forEach((key) => {
    const normalized = String(key);
    if (checked) {
      selection[normalized] = true;
    } else {
      delete selection[normalized];
    }
  });
}

/**
 * 剪掉已经不存在于当前数据里的选中项（标签被关闭/移出窗口后不留幽灵选中项）。
 *
 * @param {Iterable<string|number>} existingKeys 当前仍然存在的 key（数组或 Set 都可以）
 * @returns {string|null} 锚点：锚点项已被剪掉时返回 null，否则原样返回
 */
function pruneSelection(selection, existingKeys, anchor = null) {
  const source =
    existingKeys && typeof existingKeys[Symbol.iterator] === "function" ? [...existingKeys] : [];
  const existing = new Set(source.map((key) => String(key)));
  Object.keys(selection || {}).forEach((key) => {
    if (!existing.has(String(key))) {
      delete selection[key];
    }
  });
  if (anchor === null || anchor === undefined) {
    return null;
  }
  return existing.has(String(anchor)) ? String(anchor) : null;
}

export {
  applySelectionClick,
  clearSelection,
  computeRangeKeys,
  pruneSelection,
  setManySelected,
  setSelectionChecked,
  toggleSelection,
};
