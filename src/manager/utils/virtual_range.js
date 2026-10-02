// 虚拟列表滚动几何的纯计算。
//
// 抽出来的原因：这段计算有两个必须成立的不变量，而它们在浏览器里出问题时的表现是
// "列表整片空白，滚动一下才恢复"，很难复现也很难定位：
//   1. 只要还有行、且不是真的滚到了内容之外，可见区间就**不能为空**；
//      startIndex 一旦越过 endIndex，渲染循环一次都不执行，界面就是空白。
//   2. 滚动位置必须被夹进 [0, 内容高度 - 视口高度]：
//      滚动位置与真实 DOM 不同步时（例如内容变长但浏览器仍按旧高度夹住了赋值），
//      未夹取的巨大值会让 startIndex 直接跳过整个列表。
//
// 另外两个函数服务于"视口高度变化后补偿滚动位置"（Firefox 侧边栏的多选条一出现就会压小列表视口）：
// 它们同样是纯几何计算，因此和可见区间放在一起、共用同一套夹取规则，也共用同一份单测。

/**
 * 把滚动位置夹进 [0, 内容高度 - 视口高度]。
 *
 * 这是本模块所有滚动计算的底座：任何"算出一个目标滚动位置"的地方都必须经过它，
 * 否则越界值会让 startIndex 直接跳过整个列表（表现为整片空白）。
 *
 * @param {number} scrollTop 期望的滚动位置（可以为越界值或负数）
 * @param {{itemCount: number, itemHeight: number, viewportHeight: number}} options
 * @returns {number} 夹取后的滚动位置
 */
export function clampScrollTop(scrollTop, options = {}) {
  const itemCount = Math.max(0, Math.floor(Number(options.itemCount) || 0));
  const itemHeight = Number(options.itemHeight) || 0;
  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  const contentHeight = itemCount * itemHeight;
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  return Math.max(0, Math.min(Number(scrollTop) || 0, maxScrollTop));
}

/**
 * @param {{itemCount: number, itemHeight: number, scrollTop: number,
 *          viewportHeight: number, overscan?: number}} options
 * @returns {{startIndex: number, endIndex: number, safeScrollTop: number}}
 *   safeScrollTop 是夹取后的滚动位置，调用方可据此判断"是否需要把真实滚动位置拉回来"。
 */
export function computeVisibleRange(options = {}) {
  const itemCount = Math.max(0, Math.floor(Number(options.itemCount) || 0));
  const itemHeight = Number(options.itemHeight) || 0;
  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  const overscan = Math.max(0, Math.floor(Number(options.overscan) || 0));
  const rawScrollTop = Number(options.scrollTop) || 0;

  if (itemCount === 0 || itemHeight <= 0) {
    return { startIndex: 0, endIndex: 0, safeScrollTop: 0 };
  }

  const safeScrollTop = clampScrollTop(rawScrollTop, { itemCount, itemHeight, viewportHeight });

  const startIndex = Math.max(0, Math.floor(safeScrollTop / itemHeight) - overscan);
  const endIndex = Math.ceil((safeScrollTop + viewportHeight) / itemHeight) + overscan;

  // 双保险：即使上面的夹取因为视口高度尚未测量（viewportHeight 为 0）而偏小，
  // 也要保证区间非空且不越界。
  return {
    startIndex: Math.min(startIndex, itemCount - 1),
    endIndex: Math.min(itemCount, Math.max(endIndex, startIndex + 1)),
    safeScrollTop,
  };
}

/**
 * 视口高度变化后（Firefox 侧边栏的多选条出现 / 消失）的"底边锚定"补偿。
 *
 * 场景：列表正好滚到底部时，多选条从列表手里拿走约 2–3 行的高度。浏览器只会把 maxScroll
 * 变大，不会自己移动 scrollTop，于是原来贴着视口下边缘的行直接落到视口之外——虚拟列表随之
 * 不再渲染它们，表现为"选中最底部的标签后，它们就不见了"。
 *
 * 做法：保持"变化前视口下边缘对应的内容坐标"不变，即新 scrollTop = 该坐标 − 新视口高度。
 * 效果是列表内容整体上移一个多选条的高度，底部内容始终留在视口下边缘。
 *
 * @param {{anchorBottom: number, itemCount: number, itemHeight: number, viewportHeight: number}} options
 *   anchorBottom = 变化前的 scrollTop + viewportHeight（视口下边缘的内容坐标）
 *   viewportHeight 必须是**变化后**实测的高度，否则补偿量恒为 0
 * @returns {number} 补偿后的滚动位置（已按新视口高度夹取）
 */
export function computeBottomAnchorScrollTop(options = {}) {
  const anchorBottom = Number(options.anchorBottom) || 0;
  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  return clampScrollTop(anchorBottom - viewportHeight, options);
}

/**
 * 计算"让一段行尽量完整可见"时的目标滚动位置。
 *
 * 多选条出现后选中区间可能整段落在视口之外（列表底部尤其明显），因此需要显式把选中的行滚回来。
 * 三个约束按优先级排列：
 *   1. **focusIndex 那一行必须完整可见**——它是用户刚点的行，不能被任何补偿顶出视口；
 *   2. 在满足 1 的前提下，让 [firstIndex, lastIndex] 与视口的**重叠尽可能大**：
 *      区间放得下 → 整段可见；区间长过视口 → 视口完全落在区间内部（重叠 = 视口高度，已是最大值）；
 *   3. 在不违反 1、2 的前提下尽量少动：从传入的 scrollTop 出发取最近的合法位置。
 *
 * 约束 1、2 各自对应一段"合法的视口上边缘区间"，取交集后按约束 3 选点；交集为空只可能出现在
 * 视口比一行还矮的退化情况，那时放弃约束 2、只保证 focus 行尽量露出。
 *
 * @param {{scrollTop: number, itemCount: number, itemHeight: number, viewportHeight: number,
 *          firstIndex: number, lastIndex: number, focusIndex: number}} options
 *   firstIndex/lastIndex 是选中区间在**当前渲染行序列**里的首尾下标（顺序无所谓，内部会排序）；
 *   focusIndex 通常就在区间内（被点行必然被选中），越界会被夹到合法行。
 * @returns {number} 目标滚动位置（已夹取）
 */
export function computeRevealScrollTop(options = {}) {
  const itemCount = Math.max(0, Math.floor(Number(options.itemCount) || 0));
  const itemHeight = Number(options.itemHeight) || 0;
  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  const geometry = { itemCount, itemHeight, viewportHeight };
  if (itemCount === 0 || itemHeight <= 0 || viewportHeight <= 0) {
    return clampScrollTop(options.scrollTop, geometry);
  }

  const toIndex = (value, fallback) => {
    const index = Math.floor(Number(value));
    if (!Number.isFinite(index)) {
      return fallback;
    }
    return Math.max(0, Math.min(index, itemCount - 1));
  };
  const first = toIndex(options.firstIndex, 0);
  const last = toIndex(options.lastIndex, first);
  const rangeFirst = Math.min(first, last);
  const rangeLast = Math.max(first, last);
  const focus = toIndex(options.focusIndex, rangeFirst);

  const rangeTop = rangeFirst * itemHeight;
  const rangeBottom = (rangeLast + 1) * itemHeight;
  // 约束 2：窗口与区间的重叠最大 → 视口上边缘落在下面这段区间里。
  // 区间放得下时是"窗口包住区间"（上边缘 ≤ rangeTop 且 ≥ rangeBottom − 视口），
  // 区间长过视口时是"窗口落在区间内部"（上边缘 ≥ rangeTop 且 ≤ rangeBottom − 视口），
  // 两种情况的端点正好互换，因此写成 min/max 就能同时覆盖。
  const overlapLow = Math.min(rangeTop, rangeBottom - viewportHeight);
  const overlapHigh = Math.max(rangeTop, rangeBottom - viewportHeight);
  // 约束 1：focus 行完整可见 → 视口上边缘落在 [focusBottom − 视口, focusTop]。
  const focusLow = focus * itemHeight + itemHeight - viewportHeight;
  const focusHigh = focus * itemHeight;

  let lowBound = Math.max(overlapLow, focusLow);
  let highBound = Math.min(overlapHigh, focusHigh);
  if (lowBound > highBound) {
    // 退化情况（视口比一行还矮）：两个约束没有交集，放弃"重叠最大"，只保证 focus 行尽量露出。
    lowBound = focusHigh;
    highBound = focusLow;
  }
  const base = clampScrollTop(options.scrollTop, geometry);
  return clampScrollTop(Math.max(lowBound, Math.min(base, highBound)), geometry);
}
