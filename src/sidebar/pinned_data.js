// 固定标签区（pinned）的纯逻辑。
//
// 与 chrome API 无关，便于在 Node 里直接验证分组顺序与拖拽重排下标这两处最容易出错的规则；
// 组件只负责渲染与事件绑定。

/**
 * 把跨窗口查询到的固定标签整理成"按窗口分组"的显示模型。
 *
 * 排序规则：
 * 1. 本窗口的固定标签排最前（侧边栏的语境仍然是"本窗口"，其它窗口只做聚合补充）；
 * 2. 其余窗口按 chrome.windows.getAll() 返回的顺序排列——这也正是管理页「窗口 N」的编号口径；
 * 3. 组内按标签 index 升序。
 *
 * @param {Array<{id:number, windowId:number, index:number, pinned:boolean}>} pinnedTabs
 *        chrome.tabs.query({ pinned: true }) 的结果（跨所有窗口）
 * @param {{ currentWindowId?: number, windowOrder?: number[] }} options
 *        windowOrder：chrome.windows.getAll() 的窗口 id 顺序
 * @returns {Array<{ windowId: number, isCurrent: boolean, label: string, tabs: Array }>}
 */
export function groupPinnedTabs(pinnedTabs, options = {}) {
  const { currentWindowId = null, windowOrder = [] } = options;
  const currentId = currentWindowId === null ? null : Number(currentWindowId);
  const orderIndex = new Map();
  windowOrder.forEach((windowId, index) => {
    orderIndex.set(Number(windowId), index);
  });

  const groupsByWindow = new Map();
  for (const tab of Array.isArray(pinnedTabs) ? pinnedTabs : []) {
    if (!tab || !tab.pinned) {
      continue;
    }
    const windowId = Number(tab.windowId);
    if (!Number.isFinite(windowId)) {
      continue;
    }
    let group = groupsByWindow.get(windowId);
    if (!group) {
      group = { windowId, tabs: [] };
      groupsByWindow.set(windowId, group);
    }
    group.tabs.push(tab);
  }

  const groups = [...groupsByWindow.values()];
  for (const group of groups) {
    group.tabs.sort((left, right) => (left.index || 0) - (right.index || 0));
  }
  groups.sort((left, right) => {
    const leftCurrent = left.windowId === currentId;
    const rightCurrent = right.windowId === currentId;
    if (leftCurrent !== rightCurrent) {
      return leftCurrent ? -1 : 1;
    }
    const leftIndex = orderIndex.has(left.windowId) ? orderIndex.get(left.windowId) : Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.has(right.windowId) ? orderIndex.get(right.windowId) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.windowId - right.windowId;
  });

  return groups.map((group) => ({
    windowId: group.windowId,
    isCurrent: group.windowId === currentId,
    // 与设备页一致：窗口编号 = 它在 windows.getAll() 里的位次 + 1
    label: orderIndex.has(group.windowId) ? `窗口 ${orderIndex.get(group.windowId) + 1}` : "其它窗口",
    tabs: group.tabs,
  }));
}

/**
 * 计算固定标签在"本窗口固定标签范围内"的新下标。
 *
 * 为什么可以直接把这个位置当作 chrome.tabs.move 的 index：
 * 固定标签永远占据窗口标签栏最前面的若干位，因此"在固定标签中去掉自己后的插入位置"
 * 与"整个标签栏里的下标"是同一个值；chrome.tabs.move 的 index 也正是在"先移除该标签"
 * 的坐标系里生效的（与 handleWindowDrop 的口径一致）。
 *
 * @param {Array<{id:number, index:number}>} siblings 同窗口的固定标签（含被拖项，顺序不限）
 * @param {number} draggedId
 * @param {number} targetId
 * @param {"before"|"after"} position
 * @returns {number} 新的 index；位置没有变化或参数无效时返回 -1
 */
export function computePinnedReorderIndex(siblings, draggedId, targetId, position) {
  const list = (Array.isArray(siblings) ? siblings : [])
    .slice()
    .sort((left, right) => (left.index || 0) - (right.index || 0));
  const draggedPosition = list.findIndex((tab) => Number(tab.id) === Number(draggedId));
  if (draggedPosition < 0) {
    return -1;
  }
  const rest = list.filter((_tab, index) => index !== draggedPosition);
  const targetPosition = rest.findIndex((tab) => Number(tab.id) === Number(targetId));
  if (targetPosition < 0) {
    return -1;
  }
  const insertAt = position === "after" ? targetPosition + 1 : targetPosition;
  // 恰好落在原位置说明这次拖拽没有改变顺序，不必触发一次无意义的 tabs.move。
  if (insertAt === draggedPosition) {
    return -1;
  }
  return insertAt;
}

/** 固定标签行的 tooltip：本窗口只显示标题，其它窗口补上窗口标签。 */
export function pinnedTabTooltip(tab, group) {
  const title = (tab && (tab.title || tab.url)) || "未命名";
  if (group && !group.isCurrent && group.label) {
    return `${title}（${group.label}）`;
  }
  return title;
}
