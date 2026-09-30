// 树状结构的纯逻辑实现。
//
// 本文件**不依赖任何 chrome API**，原因有二：
// 1. 建树、快照对齐、父子推断等都是纯计算，抽出来便于单独推理与测试；
// 2. scripts/bench_tree.mjs 需要直接引用同一份实现做 10K 级基准，避免"基准测的是另一套代码"。
//
// 内存表示（后台按窗口各持一份）：
//   parentById:  Map<tabId, parentId|null>   null 表示顶层标签
//   childIdsById: Map<tabId, tabId[]>        仅用于收集子树与判断"唯一子标签"，
//                                            数组顺序无意义——兄弟顺序由标签实际的 index 派生，
//                                            这样后台就不必为每次事件维护全局顺序，避免 O(n) 重排。
//
// 复杂度约定：所有导出函数必须为 O(n) 或 O(n log n)，禁止出现 indexOf 套循环式的 O(n²)。

export const TREE_SNAPSHOT_VERSION = 1;
// 顶层标签在快照中的父下标。
export const SNAPSHOT_ROOT_PARENT = -1;

/** 由 parentById 重建 childIdsById（数组顺序无意义）。 */
export function buildChildIndex(parentById) {
  const childIdsById = new Map();
  for (const [childId, parentId] of parentById) {
    if (parentId == null) {
      continue;
    }
    let children = childIdsById.get(parentId);
    if (!children) {
      children = [];
      childIdsById.set(parentId, children);
    }
    children.push(childId);
  }
  return childIdsById;
}

/** 把 parentById 包装为完整状态。 */
export function createTreeStateFromParents(parentById) {
  return {
    parentById,
    childIdsById: buildChildIndex(parentById),
  };
}

/**
 * 改变单个标签的父标签，同步维护 childIdsById。
 * 返回是否真的发生了变化。
 * 注意：调用方需自行保证 parentId 合法（存在、同窗口、非固定、不构成环）。
 */
export function setParent(state, childId, parentId) {
  const oldParentId = state.parentById.has(childId) ? state.parentById.get(childId) : null;
  if (oldParentId === parentId) {
    return false;
  }
  removeFromChildIndex(state, childId, oldParentId);
  if (parentId == null) {
    state.parentById.set(childId, null);
  } else {
    state.parentById.set(childId, parentId);
    let children = state.childIdsById.get(parentId);
    if (!children) {
      children = [];
      state.childIdsById.set(parentId, children);
    }
    children.push(childId);
  }
  return true;
}

/** 从某个父标签的子列表中摘除 childId；childIdsById 只是集合语义，因此用交换删除保持 O(1)。 */
function removeFromChildIndex(state, childId, parentId) {
  if (parentId == null) {
    return;
  }
  const children = state.childIdsById.get(parentId);
  if (!children) {
    return;
  }
  const index = children.indexOf(childId);
  if (index >= 0) {
    children.splice(index, 1);
  }
  if (children.length === 0) {
    state.childIdsById.delete(parentId);
  }
}

/** 彻底移除一个标签（以及它作为父节点的记录）。用于关闭标签。 */
export function dropTab(state, tabId) {
  const parentId = state.parentById.has(tabId) ? state.parentById.get(tabId) : null;
  removeFromChildIndex(state, tabId, parentId);
  state.parentById.delete(tabId);
  state.childIdsById.delete(tabId);
}

/**
 * 收集某标签及其全部后代（不含已不存在的标签）。
 * 使用显式栈而非递归：树的深度在极端情况下可达数万层，递归会爆栈。
 */
export function collectSubtreeIds(state, tabId) {
  const result = [];
  const visited = new Set();
  const stack = [tabId];
  while (stack.length > 0) {
    const current = stack.pop();
    // visited 既是去重，也是防御：即使外部状态被破坏成环，这里也不会死循环。
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    result.push(current);
    const children = state.childIdsById.get(current);
    if (children) {
      for (let i = 0; i < children.length; i += 1) {
        stack.push(children[i]);
      }
    }
  }
  return result;
}

/** 判断 maybeDescendantId 是否位于 ancestorId 的子树内（不含自身）。 */
export function isDescendantOf(state, ancestorId, maybeDescendantId) {
  let current = state.parentById.has(maybeDescendantId)
    ? state.parentById.get(maybeDescendantId)
    : null;
  let guard = 0;
  while (current != null && guard <= state.parentById.size) {
    if (current === ancestorId) {
      return true;
    }
    current = state.parentById.has(current) ? state.parentById.get(current) : null;
    guard += 1;
  }
  return false;
}

/**
 * 计算标签深度（顶层为 0）。
 * cache 由调用方在一次事件处理内复用，避免对同一批标签反复走父链。
 */
export function getDepth(state, tabId, cache = null) {
  if (cache && cache.has(tabId)) {
    return cache.get(tabId);
  }
  const chain = [];
  let current = tabId;
  let depth = 0;
  let guard = 0;
  while (guard <= state.parentById.size) {
    if (cache && cache.has(current)) {
      depth += cache.get(current);
      break;
    }
    chain.push(current);
    const parentId = state.parentById.has(current) ? state.parentById.get(current) : null;
    if (parentId == null) {
      break;
    }
    current = parentId;
    depth += 1;
    guard += 1;
  }
  if (cache) {
    let value = depth;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      cache.set(chain[i], value);
      const parentId = state.parentById.has(chain[i]) ? state.parentById.get(chain[i]) : null;
      if (parentId != null) {
        value -= 1;
      }
    }
  }
  return depth;
}

/**
 * 校验并规范化父子关系，返回是否发生过降级。
 *
 * 需要成立的不变量（见 docs/ui/tree_style_tabs.md）：
 * - 父标签必须存在、同窗口、index 小于子标签；
 * - 固定标签一律顶层，且不能作为父；
 * - 无环。父 index 严格小于子 index 已足以排除环（下标严格递减的链不可能成环），
 *   所以这里不需要额外的环检测。
 */
export function sanitizeTreeState(state, orderedTabIds, pinnedIds = null) {
  const indexById = new Map();
  for (let i = 0; i < orderedTabIds.length; i += 1) {
    indexById.set(orderedTabIds[i], i);
  }
  let demoted = 0;
  for (let i = 0; i < orderedTabIds.length; i += 1) {
    const tabId = orderedTabIds[i];
    const parentId = state.parentById.has(tabId) ? state.parentById.get(tabId) : null;
    if (parentId == null) {
      continue;
    }
    const parentIndex = indexById.has(parentId) ? indexById.get(parentId) : -1;
    const isPinnedChild = pinnedIds ? pinnedIds.has(tabId) : false;
    const isPinnedParent = pinnedIds ? pinnedIds.has(parentId) : false;
    if (parentIndex < 0 || parentIndex >= i || isPinnedChild || isPinnedParent) {
      state.parentById.set(tabId, null);
      demoted += 1;
    }
  }
  state.childIdsById = buildChildIndex(state.parentById);
  return demoted;
}

/**
 * 依据浏览器实际标签状态，用 openerTabId 构建一棵初始树。
 * 使用场景：窗口内没有任何可用快照时（首次使用、快照丢失）的冷启动。
 *
 * @param {Array} orderedTabs 按 index 升序的标签，至少含 id / openerTabId / pinned
 * @param {{activeTabId?: number}} options activeTabId 用于「新标签页命令」兜底：
 *        无 opener 的新标签挂到创建时刻的活动标签下（对应 TST 的 open as child 语义）。
 */
export function buildTreeFromTabs(orderedTabs, options = {}) {
  const { activeTabId = null } = options;
  const indexById = new Map();
  const pinnedIds = new Set();
  for (let i = 0; i < orderedTabs.length; i += 1) {
    indexById.set(orderedTabs[i].id, i);
    if (orderedTabs[i].pinned) {
      pinnedIds.add(orderedTabs[i].id);
    }
  }

  const parentById = new Map();
  for (let i = 0; i < orderedTabs.length; i += 1) {
    const tab = orderedTabs[i];
    parentById.set(tab.id, pickInitialParent(tab, i, indexById, pinnedIds, activeTabId));
  }

  const state = createTreeStateFromParents(parentById);
  sanitizeTreeState(state, orderedTabs.map((tab) => tab.id), pinnedIds);
  return state;
}

// 初始父标签的优先级：合法 opener → 创建时刻的活动标签 → 顶层。
// 「父必须排在子之前」是硬性要求：它既是渲染顺序（DFS）的前提，也是无环的保证。
function pickInitialParent(tab, index, indexById, pinnedIds, activeTabId) {
  if (tab.pinned) {
    return null;
  }
  const candidates = [tab.openerTabId, activeTabId];
  for (const candidate of candidates) {
    if (candidate == null || candidate === tab.id) {
      continue;
    }
    if (!indexById.has(candidate)) {
      continue;
    }
    if (pinnedIds.has(candidate)) {
      continue;
    }
    if (indexById.get(candidate) >= index) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * 把持久化快照对齐到当前实际标签序列（会话恢复）。
 *
 * 为什么不能用 tabId：Chrome 重启后标签 id 全部改变，只能靠「顺序 + URL」重新建立对应关系。
 * 为什么不用 TST 的 findStructureOffset：它用 indexOf 找起点再逐项比较，在大量重复 URL
 * （例如几百个 about:blank）下会退化成 O(n²)。
 *
 * 本实现分两步，目标是既容忍头部/中部成批增删，也容忍局部乱序：
 *   1. 偏移估计：用快照开头若干项在 URL 索引里定位，得到整体偏移量，
 *      解决"恢复时头部被插入了一批新标签"这类整体位移；
 *   2. 逐项局部配对：以「期望下标 = j + 偏移」为中心在很小的邻域内找同 URL 的未使用项，
 *      命中后就地修正偏移。邻域搜索保证一次错位（例如两个标签被互换）不会连带冲掉后面所有项
 *      ——这正是朴素的"单调游标贪心"会雪崩的地方。
 *   3. 邻域搜不到时，再用 URL 索引做一次跳距受限的前向搜索，兜住"中间被插入一大段新标签"。
 *
 * @returns {{state: object, exact: boolean, matched: number, added: number, removed: number}}
 *   exact 为 true 表示快照与实际完全一一对应且未使用任何兜底推断——此时无需回写磁盘。
 */
export function alignSnapshotToTabs(orderedTabs, snapshot, options = {}) {
  const { activeTabId = null } = options;
  const total = orderedTabs.length;
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];

  if (items.length === 0) {
    return {
      state: buildTreeFromTabs(orderedTabs, { activeTabId }),
      exact: false,
      matched: 0,
      added: total,
      removed: 0,
    };
  }

  // URL → 该 URL 在 orderedTabs 中的所有下标（自然升序），供前向搜索与偏移估计使用。
  const positionsByUrl = new Map();
  for (let i = 0; i < total; i += 1) {
    const url = orderedTabs[i].url || "";
    if (!url) {
      continue;
    }
    let positions = positionsByUrl.get(url);
    if (!positions) {
      positions = [];
      positionsByUrl.set(url, positions);
    }
    positions.push(i);
  }

  const used = new Uint8Array(total);
  const matchOfSnapshotIndex = new Int32Array(items.length).fill(-1);
  let matchedCount = 0;
  let offset = estimateInitialOffset(items, orderedTabs, positionsByUrl, total);
  const cursorByUrl = new Map();

  for (let j = 0; j < items.length; j += 1) {
    const url = items[j].u || "";
    const expected = j + offset;
    let found = -1;

    // 以期望下标为中心就近匹配：PROBE_OFFSETS 由近及远，优先选择"位置最合理"的同 URL 项。
    // 偏移不为 0 的候选必须通过"下一项也能就近接上"的确认，否则同名的重复 URL
    // （浏览器里大量存在的空白页、新标签页）会把配对引到错误的位置。
    for (let k = 0; k < PROBE_OFFSETS.length; k += 1) {
      const index = expected + PROBE_OFFSETS[k];
      if (index < 0 || index >= total || used[index]) {
        continue;
      }
      if (url && (orderedTabs[index].url || "") !== url) {
        continue;
      }
      if (PROBE_OFFSETS[k] === 0 || confirmForwardMatch(items, j, index, orderedTabs, used, total)) {
        found = index;
        break;
      }
    }

    // 邻域内没有合适项时，用 URL 索引向前找（跳距受限 + 下一项确认，避免误配到远处的同名 URL）。
    if (found < 0 && url) {
      const positions = positionsByUrl.get(url);
      if (positions) {
        const lowerBound = Math.max(0, Math.min(expected, total - 1));
        // 游标单调前进并跳过已占用项，保证同一 URL 的重复项不会被反复扫描（均摊 O(1)）。
        let cursor = cursorByUrl.has(url) ? cursorByUrl.get(url) : 0;
        while (
          cursor < positions.length &&
          (positions[cursor] < lowerBound || used[positions[cursor]])
        ) {
          cursor += 1;
        }
        if (
          cursor < positions.length &&
          positions[cursor] - lowerBound <= FORWARD_SEARCH_LIMIT
        ) {
          const candidate = positions[cursor];
          // 同名 URL 在窗口里可能大量重复（例如几百个空白页），单看一项不足以确认。
          // 这里要求"下一项也能在候选位置附近就近匹配"才采纳，显著降低误配。
          if (confirmForwardMatch(items, j, candidate, orderedTabs, used, total)) {
            found = candidate;
            cursor += 1;
          }
        }
        cursorByUrl.set(url, cursor);
      }
    }

    if (found < 0) {
      // 快照里有、实际没有 → 该标签已被关闭，跳过。
      continue;
    }
    used[found] = 1;
    matchOfSnapshotIndex[j] = found;
    matchedCount += 1;
    // 用本次命中修正偏移，使后续项继续以"就近"为准。
    offset = found - j;
  }

  // 依据快照里的父下标建立父子关系。父下标必须也已配对，且位置在子之前。
  const parentById = new Map();
  let usedFallback = false;
  for (let j = 0; j < items.length; j += 1) {
    const actualIndex = matchOfSnapshotIndex[j];
    if (actualIndex < 0) {
      continue;
    }
    const tab = orderedTabs[actualIndex];
    const parentIndex = Number.isInteger(items[j].p) ? items[j].p : SNAPSHOT_ROOT_PARENT;
    let parentId = null;
    if (parentIndex >= 0 && parentIndex < items.length) {
      const parentActualIndex = matchOfSnapshotIndex[parentIndex];
      if (parentActualIndex >= 0 && parentActualIndex < actualIndex) {
        parentId = orderedTabs[parentActualIndex].id;
      } else {
        usedFallback = true;
      }
    }
    parentById.set(tab.id, parentId);
  }

  // 新增标签（快照里没有）：用 openerTabId 兜底。
  const indexById = new Map();
  const pinnedIds = new Set();
  for (let i = 0; i < total; i += 1) {
    indexById.set(orderedTabs[i].id, i);
    if (orderedTabs[i].pinned) {
      pinnedIds.add(orderedTabs[i].id);
    }
  }
  let added = 0;
  for (let i = 0; i < total; i += 1) {
    if (used[i]) {
      continue;
    }
    added += 1;
    usedFallback = true;
    parentById.set(
      orderedTabs[i].id,
      pickInitialParent(orderedTabs[i], i, indexById, pinnedIds, null)
    );
  }

  const state = createTreeStateFromParents(parentById);
  const demoted = sanitizeTreeState(
    state,
    orderedTabs.map((tab) => tab.id),
    pinnedIds
  );
  const removed = items.length - matchedCount;
  return {
    state,
    exact: matchedCount === items.length && added === 0 && demoted === 0 && !usedFallback,
    matched: matchedCount,
    added,
    removed,
  };
}

// 就近匹配的探测步长：由近及远，先 0 再 ±1、±2……最大 ±16（足以覆盖连续的局部乱序与增删）。
const PROBE_OFFSETS = [0, -1, 1, -2, 2, -3, 3, -4, 4, -6, 6, -8, 8, -12, 12, -16, 16];
// 前向搜索的最大跳距：超过这个距离就认为不是同一个标签（避免同名 URL 被误配到很远的位置）。
const FORWARD_SEARCH_LIMIT = 256;
// 前向匹配的确认窗口：下一项应能在候选位置之后这么多个位置内就近匹配。
const FORWARD_CONFIRM_WINDOW = 4;
// 偏移估计时最多参考快照开头的多少项、最多扫描实际序列的前多少个位置。
const OFFSET_ESTIMATE_ITEMS = 24;
const OFFSET_SCAN_LIMIT = 8192;

/**
 * 确认一次"前向搜索"命中的候选位置是否可信。
 * 同名 URL 大量重复时，仅凭单项相等很容易配到错误的位置；这里要求后一项也能在候选位置附近
 * 就近匹配，用极小的代价把误配率压下来。快照最后一项没有后继，直接接受。
 */
function confirmForwardMatch(items, index, candidate, orderedTabs, used, total) {
  const nextItem = items[index + 1];
  if (!nextItem) {
    return true;
  }
  const nextUrl = nextItem.u || "";
  for (let step = 1; step <= FORWARD_CONFIRM_WINDOW; step += 1) {
    const nextIndex = candidate + step;
    if (nextIndex >= total) {
      break;
    }
    if (used[nextIndex]) {
      continue;
    }
    if (!nextUrl || (orderedTabs[nextIndex].url || "") === nextUrl) {
      return true;
    }
  }
  return false;
}

/**
 * 估计快照相对实际序列的整体偏移。
 *
 * 会话恢复时常见的情况是"顺序不变，但头部多/少了几个标签"（固定标签、初始标签页等），
 * 此时只靠局部邻域找不到第一个匹配项，必须先估出整体位移。
 *
 * 不能只看第一项：第一项本身可能正好被移动过，会得出一个荒谬的偏移并带偏整轮对齐。
 * 因此这里从开头若干项各自产生候选偏移，再用"后续项能对上多少"打分，取最优。
 */
function estimateInitialOffset(items, orderedTabs, positionsByUrl, total) {
  const scanLimit = Math.min(total, OFFSET_SCAN_LIMIT);
  const estimateCount = Math.min(items.length, OFFSET_ESTIMATE_ITEMS);
  const candidates = new Set([0]);

  for (let j = 0; j < estimateCount; j += 1) {
    const url = items[j].u || "";
    if (!url) {
      continue;
    }
    const positions = positionsByUrl.get(url);
    if (!positions) {
      continue;
    }
    // 只接受不早于快照位置太远的候选（负向偏差不超过 64），否则容易配到前面的同名 URL。
    const lowerBound = Math.max(0, j - 64);
    let lo = 0;
    let hi = positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (positions[mid] < lowerBound) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    // 向后多看两个候选：第一个候选可能只是碰巧同名的重复项。
    for (let probe = lo; probe < Math.min(positions.length, lo + 3); probe += 1) {
      if (positions[probe] >= scanLimit) {
        break;
      }
      candidates.add(positions[probe] - j);
    }
  }

  const scoreCount = Math.min(items.length, OFFSET_ESTIMATE_ITEMS * 2);
  let bestOffset = 0;
  let bestScore = -1;
  for (const candidate of candidates) {
    let score = 0;
    for (let j = 0; j < scoreCount; j += 1) {
      const index = j + candidate;
      if (index < 0 || index >= total) {
        continue;
      }
      const url = items[j].u || "";
      if (!url || (orderedTabs[index].url || "") === url) {
        score += 1;
      }
    }
    // 同分时优先选择偏移更小的方案，避免不必要的整体位移。
    if (score > bestScore || (score === bestScore && Math.abs(candidate) < Math.abs(bestOffset))) {
      bestScore = score;
      bestOffset = candidate;
    }
  }
  return bestOffset;
}

/**
 * 生成某窗口的持久化快照。
 *
 * 只存 url / title 与「父在数组中的下标」：Chrome 重启后 tabId 会变化，tabId 无法用于恢复；
 * 标题只用于对齐时的辅助判断（本算法实际只依赖 URL），所以体积超限时可以安全丢弃。
 *
 * @returns {{payload: object|null, bytes: number, degraded: boolean}}
 */
export function encodeSnapshot(orderedTabs, state, options = {}) {
  const {
    includeTitles = true,
    maxBytes = 4 * 1024 * 1024,
    now = Date.now(),
  } = options;

  const build = (withTitles) => {
    const indexById = new Map();
    for (let i = 0; i < orderedTabs.length; i += 1) {
      indexById.set(orderedTabs[i].id, i);
    }
    const items = new Array(orderedTabs.length);
    for (let i = 0; i < orderedTabs.length; i += 1) {
      const tab = orderedTabs[i];
      const parentId = state.parentById.has(tab.id) ? state.parentById.get(tab.id) : null;
      let parentIndex = SNAPSHOT_ROOT_PARENT;
      if (parentId != null && indexById.has(parentId)) {
        const candidate = indexById.get(parentId);
        // 父下标必须小于自身，否则快照本身就不合法，直接记为顶层。
        if (candidate < i) {
          parentIndex = candidate;
        }
      }
      const item = { u: tab.url || "", p: parentIndex };
      if (withTitles) {
        item.t = tab.title || "";
      }
      items[i] = item;
    }
    return {
      v: TREE_SNAPSHOT_VERSION,
      at: now,
      n: orderedTabs.length,
      items,
    };
  };

  let payload = build(includeTitles);
  let bytes = byteLength(JSON.stringify(payload));
  let degraded = false;
  if (bytes > maxBytes && includeTitles) {
    // 超限时降级：只保留 URL。对齐算法本身不依赖标题，因此不会破坏恢复能力。
    payload = build(false);
    bytes = byteLength(JSON.stringify(payload));
    degraded = true;
  }
  if (bytes > maxBytes) {
    return { payload: null, bytes, degraded };
  }
  return { payload, bytes, degraded };
}

function byteLength(text) {
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

/**
 * 关闭标签后修正树结构 —— TST 的 promote intelligently 语义。
 *
 * 规则（对应 TST 的 promoteAllChildrenWhenClosedParentIsLastChild，默认开启）：
 * - 被关闭标签 T 是顶层：C[0] 变顶层接替 T，C[1..] 挂到 C[0] 下；
 * - T 有父 P 且 T 是 P 的**唯一**子标签：C 全部挂到 P 下；
 * - 其余：C[0] 挂到 P 下接替 T，C[1..] 挂到 C[0] 下。
 * 之所以在"唯一子标签"时提升全部，是为了让整棵子树原地接替，避免凭空多出一层缩进。
 *
 * @returns {number} 被重新挂载的子标签数量
 */
export function applyRemovePromotion(state, removedId) {
  const parentId = state.parentById.has(removedId) ? state.parentById.get(removedId) : null;
  const children = state.childIdsById.has(removedId)
    ? state.childIdsById.get(removedId).slice()
    : [];
  // 关键：先统计"移除前"的兄弟数量，才能判断 T 是否为 P 的唯一子标签。
  const siblingCountBefore = parentId == null
    ? 0
    : (state.childIdsById.has(parentId)
      ? state.childIdsById.get(parentId).filter((id) => id !== removedId).length
      : 0);

  dropTab(state, removedId);

  if (children.length === 0) {
    return 0;
  }

  if (parentId != null && siblingCountBefore === 0) {
    for (const childId of children) {
      setParent(state, childId, parentId);
    }
    return children.length;
  }

  const [firstChild, ...rest] = children;
  setParent(state, firstChild, parentId);
  for (const childId of rest) {
    setParent(state, childId, firstChild);
  }
  return children.length;
}

/**
 * 用户在浏览器原生标签栏拖动标签后，依据新位置的邻居重新推断父标签。
 * 规则移植自 TST 的 background/tree.js#detectTabActionFromNewPosition()。
 *
 * 前置要求：
 * - 传入的 prevTabId / nextTabId 是**移动之后**紧邻该标签的前后标签（同窗口、非固定）；
 * - state 中已包含旧父信息（即该标签移动前的树，且尚未应用新位置）。
 *
 * @returns {{parentId: number|null, invalid: boolean, unchanged: boolean}}
 */
export function inferParentFromNewPosition(params) {
  const {
    toIndex,
    fromIndex,
    prevTabId = null,
    nextTabId = null,
    movedTabId,
    state,
    depthCache = null,
  } = params;

  const oldParentId = state.parentById.has(movedTabId) ? state.parentById.get(movedTabId) : null;

  // 顶层标签被放到「末尾或另一个顶层标签之前」时保持顶层，避免它被误挂到邻居下。
  const prevParentId = prevTabId == null
    ? null
    : (state.parentById.has(prevTabId) ? state.parentById.get(prevTabId) : null);
  const nextParentId = nextTabId == null
    ? null
    : (state.parentById.has(nextTabId) ? state.parentById.get(nextTabId) : null);

  if (oldParentId == null && (prevTabId == null || nextParentId == null)) {
    return { parentId: null, invalid: false, unchanged: true };
  }

  let newParentId = oldParentId;
  let changed = false;

  if (oldParentId != null && prevTabId != null && oldParentId === prevTabId) {
    // 紧跟在原父标签之后：维持原有挂载，不因位置的细微变化反复改树。
    newParentId = oldParentId;
  } else if (prevTabId == null) {
    // 移到最前 → 顶层。
    newParentId = null;
    changed = oldParentId != null;
  } else if (nextTabId == null) {
    // 移到最后：只有当前一个标签的父标签仍在自己的祖先链上时才保持挂载，否则脱离成顶层。
    newParentId = null;
    let ancestor = oldParentId;
    let guard = 0;
    while (ancestor != null && guard <= state.parentById.size) {
      if (ancestor === prevParentId) {
        newParentId = prevParentId;
        break;
      }
      ancestor = state.parentById.has(ancestor) ? state.parentById.get(ancestor) : null;
      guard += 1;
    }
    changed = newParentId !== oldParentId;
  } else if (prevParentId === nextParentId) {
    // 移入已有树中间：与两侧同级。
    newParentId = prevParentId;
    changed = newParentId !== oldParentId;
  } else if (
    getDepth(state, prevTabId, depthCache) > getDepth(state, nextTabId, depthCache) &&
    nextParentId !== movedTabId
  ) {
    // 移到某棵已有树的末尾。位移很小多半是键盘/程序移动（保持同级），
    // 位移较大才是真正的拖拽（此时优先保留原父，否则采用后一个标签的父）。
    const delta = Math.abs(toIndex - fromIndex);
    newParentId = delta < 2 ? prevParentId : (oldParentId != null ? oldParentId : nextParentId);
    changed = newParentId !== oldParentId;
  } else if (
    getDepth(state, prevTabId, depthCache) < getDepth(state, nextTabId, depthCache) &&
    nextParentId === prevTabId
  ) {
    // 移到已有树的首个子位置。
    newParentId = prevTabId;
    changed = newParentId !== oldParentId;
  }

  // 环校验：新父不能是自己或自己的后代，否则视为无效移动（不修改树）。
  if (
    newParentId != null &&
    (newParentId === movedTabId || isDescendantOf(state, movedTabId, newParentId))
  ) {
    return { parentId: oldParentId, invalid: true, unchanged: false };
  }

  return { parentId: newParentId, invalid: false, unchanged: !changed };
}

/**
 * 按 DFS 顺序扁平化一棵树，供虚拟列表渲染与基准测试共用。
 *
 * @param {number[]} orderedTabIds 窗口内（或当前渲染集合内）标签按 index 升序的 id 列表；
 *        兄弟顺序与顶层顺序都由它派生
 * @param {Map<number, number|null>} parentById 父映射；父不在 orderedTabIds 内的标签会向上
 *        就近提升到最近的可见祖先，避免出现"父行不显示、子行却缩进"的悬空行
 * @param {{collapsedIds?: Set<number>|null, forceExpand?: boolean}} options
 *        forceExpand 用于筛选场景：必须让匹配项可见，因此忽略折叠状态
 * @returns {Array<{id: number, depth: number, hasChildren: boolean, collapsed: boolean}>}
 */
export function flattenTree(orderedTabIds, parentById, options = {}) {
  const { collapsedIds = null, forceExpand = false } = options;
  const inWindow = new Set(orderedTabIds);
  // 提升结果按 tabId 记忆。不变量保证父一定排在子之前，因此按顺序一趟即可算完，
  // 整体 O(n)；若不做记忆，深层链会退化成 O(n·深度)。
  const resolvedParent = new Map();
  const childrenById = new Map();
  const roots = [];
  const limit = orderedTabIds.length;

  for (let i = 0; i < limit; i += 1) {
    const tabId = orderedTabIds[i];
    const rawParent = parentById.has(tabId) ? parentById.get(tabId) : null;
    const parentId = resolveVisibleParent(rawParent, inWindow, parentById, resolvedParent, limit);
    resolvedParent.set(tabId, parentId);
    if (parentId === null) {
      roots.push(tabId);
    } else {
      let children = childrenById.get(parentId);
      if (!children) {
        children = [];
        childrenById.set(parentId, children);
      }
      children.push(tabId);
    }
  }

  const rows = [];
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push({ id: roots[i], depth: 0 });
  }
  while (stack.length > 0) {
    const { id, depth } = stack.pop();
    const children = childrenById.get(id) || null;
    const hasChildren = Boolean(children && children.length > 0);
    const collapsed = Boolean(!forceExpand && collapsedIds && collapsedIds.has(id));
    rows.push({ id, depth, hasChildren, collapsed });
    if (hasChildren && !collapsed) {
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push({ id: children[i], depth: depth + 1 });
      }
    }
  }
  return rows;
}

/** 把一个"不在渲染集合内"的父标签沿父链向上提升到最近的可见祖先；路径上的节点都会被记忆。 */
function resolveVisibleParent(rawParent, inWindow, parentById, resolvedParent, limit) {
  let current = rawParent;
  const path = [];
  let guard = 0;
  while (current !== null && current !== undefined && !inWindow.has(current) && guard <= limit) {
    const cached = resolvedParent.get(current);
    if (cached !== undefined) {
      current = cached;
      break;
    }
    path.push(current);
    current = parentById.has(current) ? parentById.get(current) : null;
    guard += 1;
  }
  if (current !== null && current !== undefined && !inWindow.has(current)) {
    current = null;
  }
  const resolved = current === undefined ? null : current;
  for (const node of path) {
    resolvedParent.set(node, resolved);
  }
  return resolved;
}

/**
 * 计算树状视图下"应当渲染"的标签集合。
 *
 * 不传 isMatch 时全部保留；传入时保留匹配项本身，以及它们的**全部祖先**——
 * 只留匹配项会让树断成一片片孤立节点，祖先只作为路径存在（isMatch 对它们仍为 false）。
 *
 * 复杂度 O(n)：祖先链一旦被访问过就会进入 keep，后续匹配项走到这里立刻停下，
 * 因此不会出现"每个匹配项都把整条父链重走一遍"的退化。
 */
export function selectTreeIds(orderedTabIds, parentById, isMatch = null) {
  if (!isMatch) {
    return orderedTabIds.slice();
  }
  const keep = new Set();
  const limit = orderedTabIds.length + 1;
  for (let i = 0; i < orderedTabIds.length; i += 1) {
    const id = orderedTabIds[i];
    if (!isMatch(id)) {
      continue;
    }
    let cursor = id;
    let guard = 0;
    while (guard < limit) {
      if (keep.has(cursor)) {
        break;
      }
      keep.add(cursor);
      const parentId = parentById.has(cursor) ? parentById.get(cursor) : null;
      if (parentId === null || parentId === undefined) {
        break;
      }
      cursor = parentId;
      guard += 1;
    }
  }
  return orderedTabIds.filter((id) => keep.has(id));
}

/**
 * 树状视图的完整行模型：筛选（匹配项 + 全部祖先）→ DFS 扁平化 → 附带 matched 标记。
 * 管理页树状视图与 Firefox 侧边栏共用这一份实现，避免两处渲染逻辑各自演化。
 *
 * @param {Array<{id: number}>} orderedTabs 按 index 升序的标签（至少要有 id）
 * @param {Map<number, number|null>} parentById 父映射
 * @param {{collapsedIds?: Set<number>|null, forceExpand?: boolean, matchId?: ((id: number) => boolean)|null,
 *          pruneToMatches?: boolean}} options
 *   matchId 只负责"哪些行算匹配项"；pruneToMatches 决定"是否只保留匹配项及其祖先"。
 *   两者必须分开：跳转模式要保留完整树、只标记匹配项（否则会退化成过滤，匹配导航也会失效）。
 * @returns {Array<{id: number, depth: number, hasChildren: boolean, collapsed: boolean, matched: boolean}>}
 */
export function buildTreeRows(orderedTabs, parentById, options = {}) {
  const {
    collapsedIds = null,
    forceExpand = false,
    matchId = null,
    pruneToMatches = true,
  } = options;
  const total = orderedTabs.length;
  const orderedIds = new Array(total);
  for (let i = 0; i < total; i += 1) {
    orderedIds[i] = Number(orderedTabs[i].id);
  }
  const matchedIds = matchId ? new Set(orderedIds.filter((id) => matchId(id))) : null;
  // 只有"有匹配项"且"要求剪枝"时才裁掉非匹配行；否则保留完整树，仅靠 matched 标记做高亮。
  const visibleIds = matchedIds && pruneToMatches
    ? selectTreeIds(orderedIds, parentById, (id) => matchedIds.has(id))
    : orderedIds;
  const rows = flattenTree(visibleIds, parentById, { collapsedIds, forceExpand });
  if (!matchedIds) {
    return rows.map((row) => ({ ...row, matched: false }));
  }
  return rows.map((row) => ({ ...row, matched: matchedIds.has(row.id) }));
}

/**
 * 把父映射压缩为消息载荷：只传有父的标签，缺省即顶层。
 * 10K 标签下这样能省掉约一半的条目。
 */
export function toParentsPayload(state) {
  const parents = {};
  for (const [childId, parentId] of state.parentById) {
    if (parentId != null) {
      parents[childId] = parentId;
    }
  }
  return parents;
}

/**
 * 判断把 tabId 挂到 parentId 下是否合法（供管理页拖拽与消息校验复用）。
 * @returns {string} 空字符串表示合法，否则为中文错误原因
 */
export function validateNewParent(state, tabId, parentId, options = {}) {
  const { pinnedIds = null, windowTabIds = null } = options;
  if (parentId == null) {
    return "";
  }
  if (parentId === tabId) {
    return "不能把标签挂到自身之下。";
  }
  if (windowTabIds && !windowTabIds.has(parentId)) {
    return "父标签不在同一窗口。";
  }
  if (pinnedIds && (pinnedIds.has(parentId) || pinnedIds.has(tabId))) {
    return "固定标签不能参与父子关系。";
  }
  if (isDescendantOf(state, tabId, parentId)) {
    return "不能把标签挂到自己的子孙之下。";
  }
  return "";
}
