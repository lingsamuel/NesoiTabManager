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

// 快照结构版本：v2 起每个 item 多一个 `i`（写入时的 tabId），快照顶层多一个 `sid`（会话令牌）。
// v1 快照没有这两个字段，读取时 `sid` 对不上、`i` 不是整数，自然退回纯 URL 对齐，无需迁移。
export const TREE_SNAPSHOT_VERSION = 2;
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
 *
 * 每个子节点都以 `parentById` 为准再校验一次：`childIdsById` 只是索引，任何"父映射里已经不是
 * 该父的子、索引里却还留着"的残留都不该被算进子树（否则"关闭整棵子树"/跨窗口迁移会牵走无关标签）。
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
        const childId = children[i];
        if (state.parentById.get(childId) !== current) {
          continue;
        }
        stack.push(childId);
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
 * 校验并规范化父子关系，返回被修正的关系数量。
 *
 * 需要成立的不变量（见 docs/ui/tree_style_tabs.md）：
 * - 父标签必须存在、同窗口、index 小于子标签；
 * - 固定标签一律顶层，且不能作为父；
 * - 无环。父 index 严格小于子 index 已足以排除环（下标严格递减的链不可能成环），
 *   所以这里不需要额外的环检测。
 *
 * 关键：**父不合法时不能直接落顶层**。父不在本窗口（已被关闭、或在树没进内存时被关闭、
 * 或被移到了别的窗口）是最常见的情形，此时父链信息往往还留在 state 里——直接落顶层会把
 * 整棵子树凭空抬到根上，这正是"关掉父标签后子标签全变成顶层"的成因。正确做法是按
 * promote intelligently 的口径沿父链向上，取最近的「存活、排在子标签之前、非固定」的祖先；
 * 整条链都没有存活祖先才落顶层（父标签必须真实存在是硬性不变量）。
 * 与快照对齐里的 findNearestAliveAncestor、关闭标签时的 applyRemovePromotion 同一语义。
 */
export function sanitizeTreeState(state, orderedTabIds, pinnedIds = null, onRepair = null) {
  const indexById = new Map();
  for (let i = 0; i < orderedTabIds.length; i += 1) {
    indexById.set(orderedTabIds[i], i);
  }
  // 「已不在本窗口的父」→ 最近的存活祖先。一次校验里会被大量复用：没有它时，
  // 一长串已关闭的父会让每个子标签都把父链重走一遍，退化成 O(n²)。
  const liveAncestorCache = new Map();
  // 每次改写都带上原因：调试模式下要能回答"这个标签为什么换了父"。
  const report = (tabId, from, to, reason) => {
    if (typeof onRepair === "function") {
      onRepair({ tabId, from: from == null ? null : from, to: to == null ? null : to, reason });
    }
  };
  let repaired = 0;
  for (let i = 0; i < orderedTabIds.length; i += 1) {
    const tabId = orderedTabIds[i];
    if (!state.parentById.has(tabId)) {
      // 窗口里真实存在、但内存树里没有条目的标签：补成顶层。
      //
      // 为什么必须补：代码各处一律用 `parentById.has(id)` 判断"这个标签在不在树里"
      // （新建标签挑父、撤销恢复的父校验、关闭提升都依赖它）。缺条目会让**真实存在的**
      // 标签被当成不存在——用户表现为"新标签不再挂到当前标签下"，而且只有重建/重载才恢复。
      // 缺条目的来源：标签的创建事件落在"树正在加载"的空档里被推迟，而随后的延迟对齐
      // 因为树已经装好而变成空操作，于是这个标签永远不会被写进父映射。
      report(tabId, null, null, "内存树缺少该标签的条目 → 补为顶层");
      state.parentById.set(tabId, null);
      repaired += 1;
      continue;
    }
    const parentId = state.parentById.get(tabId);
    if (parentId == null) {
      continue;
    }
    // 固定标签自己不能有父：留到第二趟再清——第一趟先让"沿父链向上"能用上它记录里的原父，
    // 否则把某个中间层标签固定住时，它的子标签会直接掉到顶层，而不是接回祖父。
    if (pinnedIds && pinnedIds.has(tabId)) {
      continue;
    }
    const parentIndex = indexById.has(parentId) ? indexById.get(parentId) : -1;
    const isPinnedParent = pinnedIds ? pinnedIds.has(parentId) : false;
    if (parentIndex >= 0 && parentIndex < i && !isPinnedParent) {
      continue;
    }
    // 逐级向上，直到找到一个「在子标签之前、且非固定」的存活祖先。
    // 结果的下标严格小于子标签，因此不可能成环，无需额外的环检测；guard 只防御外部损坏的状态。
    let resolved = nearestLiveAncestor(state, parentId, indexById, liveAncestorCache);
    let guard = 0;
    while (
      resolved != null &&
      guard <= state.parentById.size &&
      (indexById.get(resolved) >= i || (pinnedIds ? pinnedIds.has(resolved) : false))
    ) {
      const next = state.parentById.has(resolved) ? state.parentById.get(resolved) : null;
      resolved = next == null ? null : nearestLiveAncestor(state, next, indexById, liveAncestorCache);
      guard += 1;
    }
    const reason = parentIndex < 0
      ? "父标签已不在本窗口"
      : isPinnedParent
        ? "父标签是固定标签"
        : "父标签排在自己之后（物理顺序不合法）";
    state.parentById.set(tabId, resolved == null ? null : resolved);
    report(tabId, parentId, resolved, reason);
    repaired += 1;
  }
  // 第二趟：固定标签一律顶层（放在解析之后，理由见上）。
  if (pinnedIds) {
    for (let i = 0; i < orderedTabIds.length; i += 1) {
      const tabId = orderedTabIds[i];
      if (!pinnedIds.has(tabId)) {
        continue;
      }
      if (state.parentById.has(tabId) && state.parentById.get(tabId) != null) {
        report(tabId, state.parentById.get(tabId), null, "固定标签不能有父标签");
        state.parentById.set(tabId, null);
        repaired += 1;
      }
    }
  }
  state.childIdsById = buildChildIndex(state.parentById);
  return repaired;
}

/**
 * 沿 parentById 向上找最近的「在 orderedTabIds 里」的祖先，找不到返回 null。
 *
 * 与快照对齐里的 findNearestAliveAncestor 同一语义，区别只在"存活"的判据：
 * 那边由快照配对结果决定，这边由"是否在窗口当前标签序列里"决定。
 * 路径上的死节点会被记忆，避免重复走父链（长链关闭场景下是 O(n) 而非 O(n²)）。
 */
function nearestLiveAncestor(state, startId, indexById, cache) {
  if (startId == null) {
    return null;
  }
  const path = [];
  let cursor = startId;
  let resolved = null;
  let guard = 0;
  while (cursor != null && guard <= state.parentById.size) {
    if (indexById.has(cursor)) {
      resolved = cursor;
      break;
    }
    if (cache.has(cursor)) {
      resolved = cache.get(cursor);
      break;
    }
    path.push(cursor);
    cursor = state.parentById.has(cursor) ? state.parentById.get(cursor) : null;
    guard += 1;
  }
  for (const node of path) {
    cache.set(node, resolved);
  }
  return resolved;
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
 * 身份分两层，这也是本算法的核心取舍：
 * - **同一浏览器会话内**（Service Worker 被回收、但浏览器没重启）：`tabId` 稳定且不复用，
 *   快照里的 `i` + 顶层 `sid`（会话令牌）就是**权威身份**。此时先按 id 精确配对，
 *   URL 变了（地址栏搜索/导航/重定向）、标签被 discard 拿不到 URL、多个标签 URL 相同，
 *   都不再影响身份——"什么都没关，只是导航了一次，层级却丢了"正是只认 URL 造成的。
 * - **跨浏览器重启**：tabId 全部重新分配，`sid` 也对不上，只能退回「顺序 + URL」对齐
 *   （见下面的四步）。v1 旧快照没有 `i` / `sid`，同样走这条路。
 *
 * 为什么不用 TST 的 findStructureOffset：它用 indexOf 找起点再逐项比较，在大量重复 URL
 * （例如几百个 about:blank）下会退化成 O(n²)。
 *
 * URL 对齐分四步，目标是既容忍头部/中部成批增删，也容忍局部乱序：
 *   1. 偏移估计：用快照开头若干项在 URL 索引里定位，得到整体偏移量，
 *      解决"恢复时头部被插入了一批新标签"这类整体位移；
 *   2. 逐项局部配对：以「期望下标 = j + 偏移」为中心在很小的邻域内找同 URL 的未使用项，
 *      命中后就地修正偏移。邻域搜索保证一次错位（例如两个标签被互换）不会连带冲掉后面所有项
 *      ——这正是朴素的"单调游标贪心"会雪崩的地方。
 *   3. 邻域搜不到时，再用 URL 索引做一次跳距受限的前向搜索，兜住"中间被插入一大段新标签"。
 *   4. 父关系恢复：快照里记录的父标签可能已在插件不知情时被关闭（例如 MV3 的 SW 被回收后
 *      才收到 tabs.onRemoved，内存里没有树可改），此时沿快照的父链向上找最近的存活祖先，
 *      与关闭标签时的 promote intelligently 一致，避免整棵子树被凭空抬成顶层。
 *
 * @param {{activeTabId?: number|null, sessionToken?: string, onRepair?: Function}} options
 *   sessionToken 由后台从 `storage.session` 读出；只有它与快照里的 `sid` 一致时才信任 `i`。
 *   onRepair 是调试回调：不变量校验改写了哪个标签的父、原因是什么（见「调试」）。
 * @returns {{state: object, exact: boolean, matched: number, added: number, removed: number}}
 *   exact 为 true 表示快照与实际完全一一对应、未使用任何兜底推断，且快照里的 URL 仍然准确
 *   （URL 是跨重启唯一的配对依据，导航过就必须回写）——此时无需回写磁盘。
 */
export function alignSnapshotToTabs(orderedTabs, snapshot, options = {}) {
  const { activeTabId = null, sessionToken = "", onRepair = null } = options;
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

  // 会话令牌一致 ⇒ 快照里的 tabId 与当前标签是同一批身份，可以当权威依据。
  const trustTabIds = Boolean(sessionToken) && snapshot.sid === sessionToken;
  const indexByTabId = new Map();
  if (trustTabIds) {
    for (let i = 0; i < total; i += 1) {
      indexByTabId.set(Number(orderedTabs[i].id), i);
    }
  }
  // 快照里的 URL 是否仍然准确（任一被 id 命中的项 URL 对不上就置位）。
  let staleSnapshotContent = false;

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
    // 同一浏览器会话内：快照的 tabId 就是权威身份，直接命中，不参与 URL 猜测。
    // 命中后同样用「本次命中修正偏移」，让后面那些没有 id 的项（快照之后新建的标签、
    // 或旧版快照项）继续以"就近"为准则配对。
    if (trustTabIds && Number.isInteger(items[j].i)) {
      const idIndex = indexByTabId.get(items[j].i);
      if (idIndex !== undefined && !used[idIndex]) {
        used[idIndex] = 1;
        matchOfSnapshotIndex[j] = idIndex;
        matchedCount += 1;
        offset = idIndex - j;
        // URL 变了（导航/重定向/地址栏搜索）→ 快照里的 URL 已过期。
        // 它本身不影响本次结构，但**跨重启只能靠 URL 配对**，因此必须回写一次。
        if ((orderedTabs[idIndex].url || "") !== (items[j].u || "")) {
          staleSnapshotContent = true;
        }
        continue;
      }
    }

    const url = items[j].u || "";
    const expected = j + offset;
    // 该 URL 在实际序列里只出现一次时不存在"配错位置"的可能：邻域里命中的候选必然就是它本人。
    // 此时必须跳过"下一项确认"，否则紧跟在它后面的标签刚被关闭时确认会失败，
    // 这个唯一项就会被判成未配对（进而被当成"新增标签"，丢掉它在快照里的父子关系）。
    const urlPositions = url ? positionsByUrl.get(url) : undefined;
    const uniqueUrl = Boolean(urlPositions && urlPositions.length === 1);
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
      if (PROBE_OFFSETS[k] === 0 || uniqueUrl || confirmForwardMatch(items, j, index, orderedTabs, used, total)) {
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
      // 兜底：URL 证据整体失效时（标签已被卸载/冻结，见 hasUnknownIdentity），
      // 不能再把这一项判成"新增标签"——那会连带丢掉它在快照里的整条父子关系，
      // 表现为整棵子树被抬到顶层。对身份不可知的标签只按位置配对。
      // 要求候选本身就是这类标签，因此正常标签之间的 URL 匹配完全不受影响。
      for (let k = 0; k < PROBE_OFFSETS.length; k += 1) {
        const index = expected + PROBE_OFFSETS[k];
        if (index < 0 || index >= total || used[index]) {
          continue;
        }
        if (!hasUnknownIdentity(orderedTabs[index])) {
          continue;
        }
        found = index;
        break;
      }
    }

    if (found < 0) {
      // 快照里有、实际没有 → 该标签已被关闭，跳过。
      // 关键：它后面的快照项在实际序列里整体左移了一位，必须同步把偏移 -1，
      // 否则「以期望下标为中心就近优先」的探测会把同名 URL 的相邻项（连续多个
      // 新标签页 / about:blank）全部配到前一个槽位上，最后一项被挤成"新增标签"，
      // 于是真正的子标签反而变成顶层，父子关系整体断裂。
      offset -= 1;
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
  // 记忆「某个快照下标向上找到的最近存活祖先下标」，-2 = 未计算，-1 = 没有存活祖先。
  // 没有它时，父链很长且连续被关闭会让每个子标签重复走一遍父链，退化成 O(n²)。
  const nearestAliveCache = new Int32Array(items.length).fill(-2);
  const findNearestAliveAncestor = (startIndex) => {
    const path = [];
    let cursor = startIndex;
    let guard = 0;
    while (cursor >= 0 && cursor < items.length && guard <= items.length) {
      if (matchOfSnapshotIndex[cursor] >= 0) {
        break;
      }
      if (nearestAliveCache[cursor] !== -2) {
        cursor = nearestAliveCache[cursor];
        break;
      }
      path.push(cursor);
      cursor = Number.isInteger(items[cursor].p) ? items[cursor].p : SNAPSHOT_ROOT_PARENT;
      guard += 1;
    }
    const resolved = cursor >= 0 && cursor < items.length && matchOfSnapshotIndex[cursor] >= 0
      ? cursor
      : -1;
    for (const node of path) {
      nearestAliveCache[node] = resolved;
    }
    return resolved;
  };

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
        // 直接父标签在本次对齐里没配上（通常就是父标签已被关闭，而关闭发生在
        // 后台被回收、内存里没有这棵树的时候）。不能就此把它当顶层——那会把整棵
        // 子树凭空抬到根上；应沿快照的父链继续向上找最近的存活祖先，
        // 语义与关闭标签时的 promote intelligently（子树接到祖父）保持一致。
        usedFallback = true;
        const ancestorIndex = findNearestAliveAncestor(parentIndex);
        if (ancestorIndex >= 0) {
          const ancestorActualIndex = matchOfSnapshotIndex[ancestorIndex];
          if (ancestorActualIndex >= 0 && ancestorActualIndex < actualIndex) {
            parentId = orderedTabs[ancestorActualIndex].id;
          }
        }
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
  const repaired = sanitizeTreeState(
    state,
    orderedTabs.map((tab) => tab.id),
    pinnedIds,
    onRepair
  );
  const removed = items.length - matchedCount;
  return {
    state,
    // 结构与内容都仍然准确才叫 exact：URL 过期（导航过）时必须回写，否则下一次重启就配不上。
    exact:
      matchedCount === items.length &&
      added === 0 &&
      repaired === 0 &&
      !usedFallback &&
      !staleSnapshotContent,
    matched: matchedCount,
    added,
    removed,
    // 被不变量校验改写的父子关系数量（调试日志用：>0 说明这次重建动过结构）。
    repaired,
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
 * 判断一个"实际标签"的身份是不是**不可知**。
 *
 * 已卸载（discard / 冻结）的标签拿不到可靠的 URL：Firefox 曾完全取不到（Bug 1694699），
 * 现在也可能给出与快照不同的值（例如 about:blank）。这类标签无法用 URL 与快照配对，
 * 只能退化为按位置配对——这本来就是对齐算法的第一假设（偏移估计）。
 *
 * 使用场景：`alignSnapshotToTabs` 的 URL 匹配全部失败后的兜底。
 * 副作用：仅放宽"候选必须同 URL"这一条，不会让身份明确的标签被误配。
 */
function hasUnknownIdentity(tab) {
  return Boolean(tab && (tab.discarded || !(tab.url || "")));
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
 * 每项存 `u`(url) / `t`(title) / `p`(父在数组中的下标) / `i`(写入时的 tabId)：
 * - `u` 是**跨浏览器重启**唯一的配对依据，因此是主身份；
 * - `i` 只在**同一浏览器会话内**有效（tabId 稳定且不复用），配合快照顶层的 `sid`（会话令牌）
 *   在 SW 被回收后做精确配对——地址栏导航换了 URL 也不会让层级丢失。跨重启时 `sid` 对不上，
 *   读取端会完全忽略 `i`，因此 `i` 永远不会被误当成跨会话的身份。
 * - 标题只用于诊断，对齐算法不依赖它，所以体积超限时可以安全丢弃（`i` 不能丢）。
 *
 * @param {{includeTitles?: boolean, maxBytes?: number, now?: number, sessionToken?: string}} options
 *   sessionToken 为空（拿不到会话存储）时不写 `sid`，读取端也就不会启用 id 配对。
 * @returns {{payload: object|null, bytes: number, degraded: boolean}}
 */
export function encodeSnapshot(orderedTabs, state, options = {}) {
  const {
    includeTitles = true,
    maxBytes = 4 * 1024 * 1024,
    now = Date.now(),
    sessionToken = "",
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
      const item = { u: tab.url || "", p: parentIndex, i: Number(tab.id) };
      if (withTitles) {
        item.t = tab.title || "";
      }
      items[i] = item;
    }
    const payload = {
      v: TREE_SNAPSHOT_VERSION,
      at: now,
      n: orderedTabs.length,
      items,
    };
    if (sessionToken) {
      payload.sid = sessionToken;
    }
    return payload;
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
 * @param {null|((info: object) => void)} onDecision 调试回调：报告本次提升用的是哪条规则、
 *   以及每个子标签最终挂到了谁（见 docs/ui/tree_style_tabs.md 的「调试」）。
 * @returns {number} 被重新挂载的子标签数量
 */
export function applyRemovePromotion(state, removedId, onDecision = null) {
  const parentId = state.parentById.has(removedId) ? state.parentById.get(removedId) : null;
  // childIdsById 只是索引：以 parentById 为准过滤一次。索引里可能残留"其实已经不是它的子"的
  // 标签（任何绕过 setParent 的直接写都会造成），不过滤就会把它们当成子标签提升进树——
  // 表现为"关掉一个标签，几个毫不相干的标签突然被重排"。同一父下的兄弟数量统计也要用过滤后的口径。
  const rawChildren = state.childIdsById.has(removedId)
    ? state.childIdsById.get(removedId)
    : [];
  const children = rawChildren.filter(
    (childId) => state.parentById.has(childId) && state.parentById.get(childId) === removedId
  );
  // 关键：先统计"移除前"的兄弟数量，才能判断 T 是否为 P 的唯一子标签。
  const siblingCountBefore = parentId == null
    ? 0
    : (state.childIdsById.has(parentId)
      ? state.childIdsById.get(parentId).filter((id) => id !== removedId && state.parentById.get(id) === parentId).length
      : 0);
  const report = (rule, assignments) => {
    if (typeof onDecision === "function") {
      onDecision({
        removedId,
        parentId,
        children: children.slice(),
        siblingCountBefore,
        rule,
        assignments,
      });
    }
  };

  dropTab(state, removedId);

  if (children.length === 0) {
    report("no-children", []);
    return 0;
  }

  if (parentId != null && siblingCountBefore === 0) {
    for (const childId of children) {
      setParent(state, childId, parentId);
    }
    report("only-child-of-parent", children.map((childId) => ({ childId, parentId })));
    return children.length;
  }

  const [firstChild, ...rest] = children;
  setParent(state, firstChild, parentId);
  for (const childId of rest) {
    setParent(state, childId, firstChild);
  }
  report(parentId == null ? "closed-was-root" : "first-child-takes-place", [
    { childId: firstChild, parentId },
    ...rest.map((childId) => ({ childId, parentId: firstChild })),
  ]);
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
 * @returns {{parentId: number|null, invalid: boolean, unchanged: boolean, reason: string}}
 *   reason 是命中的规则名（调试用，便于回答"这个标签为什么换了父"）。
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
    return { parentId: null, invalid: false, unchanged: true, reason: "顶层标签保持顶层" };
  }

  let newParentId = oldParentId;
  let changed = false;
  let reason = "未命中任何规则（保持原父）";

  if (oldParentId != null && prevTabId != null && oldParentId === prevTabId) {
    // 紧跟在原父标签之后：维持原有挂载，不因位置的细微变化反复改树。
    newParentId = oldParentId;
    reason = "紧跟在原父之后，保持原父";
  } else if (prevTabId == null) {
    // 移到最前 → 顶层。
    newParentId = null;
    changed = oldParentId != null;
    reason = "移到最前 → 顶层";
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
    reason = newParentId == null ? "移到末尾且原父不在前一个标签的祖先链上 → 顶层" : "移到末尾，前一个标签的父仍在祖先链上 → 保持该父";
  } else if (prevParentId === nextParentId) {
    // 移入已有树中间：与两侧同级。
    newParentId = prevParentId;
    changed = newParentId !== oldParentId;
    reason = "两侧邻居同父 → 与它们同级";
  } else if (
    getDepth(state, prevTabId, depthCache) > getDepth(state, nextTabId, depthCache) &&
    nextParentId !== movedTabId
  ) {
    // 移到某棵已有树的末尾。位移很小多半是键盘/程序移动（保持同级），
    // 位移较大才是真正的拖拽（此时优先保留原父，否则采用后一个标签的父）。
    const delta = Math.abs(toIndex - fromIndex);
    newParentId = delta < 2 ? prevParentId : (oldParentId != null ? oldParentId : nextParentId);
    changed = newParentId !== oldParentId;
    reason = delta < 2 ? "移到某棵子树末尾（位移<2，按键盘/程序移动处理）→ 前一个标签的父" : "移到某棵子树末尾（拖拽）→ 优先保留原父";
  } else if (
    getDepth(state, prevTabId, depthCache) < getDepth(state, nextTabId, depthCache) &&
    nextParentId === prevTabId
  ) {
    // 移到已有树的首个子位置。
    newParentId = prevTabId;
    changed = newParentId !== oldParentId;
    reason = "移到某棵已有树的首个子位置 → 前一个标签";
  }

  // 环校验：新父不能是自己或自己的后代，否则视为无效移动（不修改树）。
  if (
    newParentId != null &&
    (newParentId === movedTabId || isDescendantOf(state, movedTabId, newParentId))
  ) {
    return { parentId: oldParentId, invalid: true, unchanged: false, reason: "新父是自己或自己的后代 → 无效移动，不改树" };
  }

  return { parentId: newParentId, invalid: false, unchanged: !changed, reason };
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
