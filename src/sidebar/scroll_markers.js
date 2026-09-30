// 滚动条轨道标记的纯逻辑。
//
// 目标：让用户随时知道"当前活动标签在列表的什么位置"（这正是原生 Ctrl+F 的做法：
// 在滚动条轨道上按比例画出匹配位置，当前匹配单独高亮）。
// 与 chrome API 无关，便于在 Node 里验证"活动标签被折叠/被筛选隐藏时该标到哪一行"这类边界。

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

  const direct = rowIndexById.get(Number(activeTabId));
  if (direct !== undefined) {
    return { index: direct, isAncestor: false };
  }

  // 沿父链向上找第一个"确实出现在行序列里"的祖先。
  const parentMap = parents && typeof parents === "object" ? parents : {};
  let cursor = parentMap[String(activeTabId)];
  let guard = 0;
  while (cursor !== undefined && cursor !== null && guard <= rows.length + 1) {
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
    highlightMatches = false,
    currentMatchIndex = -1,
    trackHeight = 0,
  } = options;
  const total = Array.isArray(rows) ? rows.length : 0;
  if (total === 0) {
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

  if (activeRow && Number.isFinite(activeRow.index)) {
    markers.push({
      key: `active-${activeRow.index}-${activeRow.isAncestor ? "ancestor" : "self"}`,
      index: activeRow.index,
      kind: activeRow.isAncestor ? "active-ancestor" : "active",
      top: toTrackTop(activeRow.index, total, trackHeight),
    });
  }

  return markers;
}
