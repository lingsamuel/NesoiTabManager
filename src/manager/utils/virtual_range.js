// 虚拟列表"当前应该渲染哪些行"的纯计算。
//
// 抽出来的原因：这段计算有两个必须成立的不变量，而它们在浏览器里出问题时的表现是
// "列表整片空白，滚动一下才恢复"，很难复现也很难定位：
//   1. 只要还有行、且不是真的滚到了内容之外，可见区间就**不能为空**；
//      startIndex 一旦越过 endIndex，渲染循环一次都不执行，界面就是空白。
//   2. 滚动位置必须被夹进 [0, 内容高度 - 视口高度]：
//      滚动位置与真实 DOM 不同步时（例如内容变长但浏览器仍按旧高度夹住了赋值），
//      未夹取的巨大值会让 startIndex 直接跳过整个列表。

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

  const contentHeight = itemCount * itemHeight;
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  const safeScrollTop = Math.max(0, Math.min(rawScrollTop, maxScrollTop));

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
