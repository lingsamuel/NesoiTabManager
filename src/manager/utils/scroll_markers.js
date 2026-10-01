// 滚动条轨道标记的纯逻辑。
//
// 目标：让用户随时知道"当前活动标签在列表的什么位置"（这正是原生 Ctrl+F 的做法：
// 在滚动条轨道上按比例画出匹配位置，当前匹配单独高亮）。
// 与 chrome API 无关，便于在 Node 里验证"活动标签被折叠/被筛选隐藏时该标到哪一行"这类边界。

// 相邻刻度中心距离小于该值就合并：3px 高的刻度在这个距离上已经糊成一片。
export const MARKER_MERGE_THRESHOLD_PX = 6;

/**
 * 找到活动标签在行序列里的位置。
 *
 * 活动标签可能根本不在行序列里：它可能被折叠的祖先藏起来，或被筛选/隐藏已冻结过滤掉。
 * 这时退回到**它最近的可见祖先**行——至少能指出它所在的那一段，而不是干脆不显示标记。
 *
 * @param {number} activeTabId
 * @param {Array<{id: number}>} rows 当前渲染的行（DFS 顺序）
 * @param {Record<string, number>} parents 该窗口的父子映射（子 id -> 父 id）
 * @returns {{index: number, isAncestor: boolean}|null} isAncestor 为 true 表示标的是祖先行
 */
export function resolveActiveRow(activeTabId, rows, parents) {
  if (!Number.isFinite(Number(activeTabId)) || !Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const rowIndexById = new Map();
  rows.forEach((row, index) => {
    rowIndexById.set(Number(row.id), index);
  });
  return walkToVisibleAncestor(activeTabId, rowIndexById, parents, rows.length);
}

/**
 * 沿父链向上找第一个"确实出现在行序列里"的祖先。
 * 抽出来是因为管理页有多个窗口（每个窗口各有一条活动标签），
 * 批量解析时只需要建一次行号索引。
 */
function walkToVisibleAncestor(activeTabId, rowIndexById, parents, rowCount) {
  const direct = rowIndexById.get(Number(activeTabId));
  if (direct !== undefined) {
    return { index: direct, isAncestor: false };
  }
  const parentMap = parents && typeof parents === "object" ? parents : {};
  let cursor = parentMap[String(activeTabId)];
  let guard = 0;
  while (cursor !== undefined && cursor !== null && guard <= rowCount + 1) {
    const found = rowIndexById.get(Number(cursor));
    if (found !== undefined) {
      return { index: found, isAncestor: true };
    }
    cursor = parentMap[String(cursor)];
    guard += 1;
  }
  return null;
}

/**
 * 批量解析多个窗口的活动标签所在行（管理页每个窗口各画一条蓝色刻度）。
 *
 * @param {Array<{tabId: number, parents: Record<string, number>}>} entries
 * @param {Map<number, number>} rowIndexById 行号索引（由调用方对整份行数据建一次）
 * @returns {Array<{index: number, isAncestor: boolean}>} 只包含确实能定位到的那些
 */
export function resolveActiveRows(entries, rowIndexById) {
  if (!Array.isArray(entries) || !(rowIndexById instanceof Map) || rowIndexById.size === 0) {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry || !Number.isFinite(Number(entry.tabId))) {
      continue;
    }
    const found = walkToVisibleAncestor(entry.tabId, rowIndexById, entry.parents, rowIndexById.size);
    if (found) {
      result.push(found);
    }
  }
  return result;
}

/**
 * 把行序号的"比例位置"换算成轨道上的像素位置。
 * 取 (index + 0.5) / total 而不是 index / total：让刻度落在该行按比例对应的中心，而不是行首。
 */
export function toTrackTop(index, total, trackHeight) {
  if (!Number.isFinite(trackHeight) || trackHeight <= 0 || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(Number(index), total - 1));
  return ((clamped + 0.5) / total) * trackHeight;
}

/**
 * 汇总要在轨道上画的全部标记。
 *
 * @param {{rows: Array, activeRow: object|null, highlightMatches: boolean,
 *          currentMatchIndex: number, trackHeight: number}} options
 * @returns {Array<{key: string, index: number, kind: string, top: number}>}
 *   kind: active | active-ancestor | match | match-current
 */
export function buildTrackMarkers(options = {}) {
  const {
    rows = [],
    activeRow = null,
    activeRows = null,
    highlightMatches = false,
    currentMatchIndex = -1,
    trackHeight = 0,
    mergeThreshold = MARKER_MERGE_THRESHOLD_PX,
  } = options;
  const total = Array.isArray(rows) ? rows.length : 0;
  if (total === 0) {
    return [];
  }
  // 轨道高度还没测出来时比例无从谈起：此时若照常返回，所有刻度都会落在 0 并被合并成一条，
  // 看起来像"刻度全挤在一起"。宁可不画。
  if (!Number.isFinite(trackHeight) || trackHeight <= 0) {
    return [];
  }

  const markers = [];
  if (highlightMatches) {
    rows.forEach((row, index) => {
      if (!row || !row.matched) {
        return;
      }
      markers.push({
        key: `match-${row.id}`,
        index,
        kind: index === currentMatchIndex ? "match-current" : "match",
        top: toTrackTop(index, total, trackHeight),
      });
    });
  }

  // 管理页会传入多个窗口的活动行；侧边栏只传一个。
  const actives = Array.isArray(activeRows) && activeRows.length > 0
    ? activeRows
    : (activeRow ? [activeRow] : []);
  for (const active of actives) {
    if (!active || !Number.isFinite(active.index)) {
      continue;
    }
    markers.push({
      key: `active-${active.index}-${active.isAncestor ? "ancestor" : "self"}`,
      index: active.index,
      kind: active.isAncestor ? "active-ancestor" : "active",
      top: toTrackTop(active.index, total, trackHeight),
    });
  }

  return mergeOverlappingMarkers(markers, mergeThreshold);
}

/**
 * 距离过近的刻度合并成一个。
 *
 * 理由：轨道上几十个刻度糊在一起时，区分"具体是哪一个"既看不出来也没意义；
 * 合并成一条后，用户看到的是"这一带很密集"，点击时由簇内优先级决定跳转目标。
 * 采用"与相邻上一个成员的距离小于阈值就继续合并"的链式规则，
 * 因此一大片密集区域会合并成一条较长的段，而不是被切成很多小簇。
 */
function mergeOverlappingMarkers(markers, threshold) {
  if (markers.length <= 1) {
    return markers.map(annotateMarker);
  }
  const sorted = markers.slice().sort((a, b) => a.top - b.top || a.index - b.index);
  const clusters = [];
  let cluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = cluster[cluster.length - 1];
    if (sorted[i].top - previous.top < threshold) {
      cluster.push(sorted[i]);
    } else {
      clusters.push(cluster);
      cluster = [sorted[i]];
    }
  }
  clusters.push(cluster);
  return clusters.map(buildClusterMarker);
}

function annotateMarker(marker) {
  return { ...marker, count: 1, merged: false, matchIndex: marker.kind.startsWith("match") ? marker.index : null };
}

/**
 * 簇内点击目标：当前项 → 活动标签 → 簇内第一项。
 * 优先当前项是为了"点一下不会把当前跳转项点走"；其次是活动标签（它是用户最可能想找的位置）。
 */
function targetMember(members) {
  return (
    members.find((marker) => marker.kind === "match-current") ||
    members.find((marker) => marker.kind === "active" || marker.kind === "active-ancestor") ||
    members[0]
  );
}

function buildClusterMarker(members) {
  const target = targetMember(members);
  const targetIsMatch = target.kind === "match" || target.kind === "match-current";
  return {
    key: `cluster-${members.map((marker) => marker.key).join("|")}`,
    index: target.index,
    // 只有"点击目标本身就是匹配项"时才同步当前跳转项，
    // 否则会出现"滚到了活动标签、当前项却被改到别的行"这种自相矛盾的状态。
    matchIndex: targetIsMatch ? target.index : null,
    kind: clusterKind(members),
    // 用成员位置的平均值，让合并后的刻度落在这一簇的中间。
    top: members.reduce((sum, marker) => sum + marker.top, 0) / members.length,
    count: members.length,
    merged: members.length > 1,
  };
}

/**
 * 合并后显示成什么颜色：
 * - 簇里有当前匹配项 + 蓝色活动刻度 → 蓝色优先 + 高亮边框（active-current）；
 * - 只有当前匹配项 → 高亮（match-current）；
 * - 只有活动刻度 → 蓝色（活动标签被隐藏时用空心蓝 active-ancestor）；
 * - 其余 → 普通匹配色。
 */
function clusterKind(members) {
  const hasCurrent = members.some((marker) => marker.kind === "match-current");
  const hasActive = members.some((marker) => marker.kind === "active");
  const hasAncestorActive = members.some((marker) => marker.kind === "active-ancestor");
  if (hasCurrent && (hasActive || hasAncestorActive)) {
    return "active-current";
  }
  if (hasCurrent) {
    return "match-current";
  }
  if (hasActive) {
    return "active";
  }
  if (hasAncestorActive) {
    return "active-ancestor";
  }
  return "match";
}

// ---------------------------------------------------------------------------
// 跟随活动标签：判断"该不该把活动行滚到视口中间"
// ---------------------------------------------------------------------------

// 判断可见性时允许的像素容差。
// 行的上下边界是行高的整数倍，而滚动位置常常是小数（按行高居中后尤其如此），
// 不留容差的话"刚好贴边"的行会被判成不可见，于是每次切换标签都重复居中一次。
export const ROW_VISIBILITY_TOLERANCE_PX = 1;

/**
 * 把"行号 + 行高 + 滚动位置 + 视口高度"折算成两段像素区间：
 * 行自身的 [rowTop, rowBottom) 与视口（按容差放宽后的）[viewTop, viewBottom)。
 *
 * @returns {{rowTop: number, rowBottom: number, viewTop: number, viewBottom: number}|null}
 *   null 表示参数不足以判断：行号非法、行高未知、或视口高度还没测出来（组件刚挂载）。
 */
function resolveRowBounds(options = {}) {
  const index = Number(options.index);
  const itemHeight = Number(options.itemHeight);
  const scrollTop = Number(options.scrollTop);
  const viewportHeight = Number(options.viewportHeight);
  const rawTolerance = Number(options.tolerance);
  const tolerance = Number.isFinite(rawTolerance) ? Math.max(0, rawTolerance) : ROW_VISIBILITY_TOLERANCE_PX;
  if (!Number.isFinite(index) || index < 0) {
    return null;
  }
  if (!Number.isFinite(itemHeight) || itemHeight <= 0) {
    return null;
  }
  if (!Number.isFinite(scrollTop) || scrollTop < 0) {
    return null;
  }
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return null;
  }
  return {
    rowTop: index * itemHeight,
    rowBottom: (index + 1) * itemHeight,
    viewTop: scrollTop - tolerance,
    viewBottom: scrollTop + viewportHeight + tolerance,
  };
}

/**
 * 某一行是否**至少有一部分**落在视口里（即"在视野里"）。
 * 用于判断"用户是不是还停在旧活动标签附近"。
 */
export function isRowInView(options = {}) {
  const bounds = resolveRowBounds(options);
  if (!bounds) {
    return false;
  }
  return bounds.rowBottom > bounds.viewTop && bounds.rowTop < bounds.viewBottom;
}

/**
 * 某一行是否**完整**落在视口里（上下边界都可见）。
 * 用于判断"目标行已经看得见了、没有必要再动滚动位置"。
 */
export function isRowFullyVisible(options = {}) {
  const bounds = resolveRowBounds(options);
  if (!bounds) {
    return false;
  }
  return bounds.rowTop >= bounds.viewTop && bounds.rowBottom <= bounds.viewBottom;
}

/**
 * 活动标签变化（或列表刚重建）时，是否需要把新的活动行滚到视口中间。
 *
 * 两个条件同时成立才返回 true：
 * 1. 目标行还没有**完整**可见——已经看得见就不动，否则每次切换标签、点击侧边栏里
 *    紧邻的行都会让列表轻微抖动；
 * 2. 允许移动滚动位置，二者其一：
 *    - listRecreated：列表刚建立/重建（例如筛选把树清空后又恢复）。此时滚动位置必然是
 *      初始值 0，它不代表用户的任何意图，用活动标签的位置取代它正合适；
 *    - 旧活动行仍在视口内：说明列表本来就停在用户关心的位置上，他并没有滚去别处看，
 *      此时跟随新活动标签才是符合预期的。反之（旧活动行已滚出视野）一律不动，
 *      避免把用户正在浏览的位置拉走。
 *
 * @param {{activeIndex?: number, previousActiveIndex?: number, listRecreated?: boolean,
 *          itemHeight?: number, scrollTop?: number, viewportHeight?: number,
 *          tolerance?: number}} options
 *   activeIndex 是新活动标签在行序列里的行号；previousActiveIndex 是变化前那条活动行的行号
 *   （没有旧活动行时传 -1，例如页面刚打开、或旧活动标签是固定标签）。
 * @returns {boolean}
 */
export function shouldFollowActiveRow(options = {}) {
  const activeIndex = Number(options.activeIndex);
  if (!Number.isFinite(activeIndex) || activeIndex < 0) {
    return false;
  }
  const geometry = {
    itemHeight: options.itemHeight,
    scrollTop: options.scrollTop,
    viewportHeight: options.viewportHeight,
    tolerance: options.tolerance,
  };
  if (isRowFullyVisible({ index: activeIndex, ...geometry })) {
    return false;
  }
  if (options.listRecreated) {
    return true;
  }
  return isRowInView({ index: options.previousActiveIndex, ...geometry });
}

/**
 * 滚动时同步"当前跳转项"的规则。
 *
 * 规则：当前项已经不在可见范围内、且可见范围内还有匹配项时，把可见范围内**第一个**匹配项设为当前项；
 * 当前项仍然可见、或可见范围内没有匹配项时都不改动。
 * 当前项可见时不动，是为了避免在用户持续滚动时反复改写当前项。
 *
 * 只负责"该把哪一行设为当前项"，不涉及滚动：滚动同步绝不能反过来触发自动滚动，
 * 否则用户每滚一下都会被拉回去。
 *
 * @param {{matchRowIndexes: number[], currentMatchRowIndex: number,
 *          startIndex: number, endIndex: number}} options
 *   matchRowIndexes 必须按行号升序（由行序列顺序扫描得到）。
 * @returns {number|null} 需要设为当前项的行号；null 表示保持不变
 */
export function pickCurrentMatchFromVisibleRange(options = {}) {
  const {
    matchRowIndexes = [],
    currentMatchRowIndex = -1,
    startIndex = 0,
    endIndex = 0,
  } = options;
  if (!Array.isArray(matchRowIndexes) || matchRowIndexes.length === 0 || endIndex <= startIndex) {
    return null;
  }
  if (currentMatchRowIndex >= startIndex && currentMatchRowIndex < endIndex) {
    return null;
  }
  // 二分找第一个 >= startIndex 的匹配项：滚动事件很密集，避免每次从头线性扫描。
  let low = 0;
  let high = matchRowIndexes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matchRowIndexes[mid] < startIndex) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const candidate = matchRowIndexes[low];
  return candidate !== undefined && candidate < endIndex ? candidate : null;
}
