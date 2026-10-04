import { collectSubtreeIds, flattenTree } from "./tree_core.js";

const sameOrder = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);

/** 仅记录关闭影响的后代块；用原物理锚点落位，用原 DFS 顺序排列块内节点。 */
export function planCloseOrder(state, orderedIds, removedId) {
  const descendants = new Set(collectSubtreeIds(state, removedId));
  descendants.delete(removedId);
  if (!descendants.size) return null;
  const rows = flattenTree(orderedIds, state.parentById).map(row => row.id);
  const movingIds = rows.filter(id => descendants.has(id));
  return makePlan(orderedIds, removedId, movingIds, rows.filter(id => id !== removedId));
}

function makePlan(beforeIds, removedId, movingIds, expectedRows = null) {
  const at = beforeIds.indexOf(removedId);
  if (at < 0 || !movingIds.length) return null;
  const moving = new Set(movingIds);
  const remaining = beforeIds.filter(id => id !== removedId && !moving.has(id));
  const index = beforeIds.slice(0, at).filter(id => !moving.has(id)).length;
  const targetIds = remaining.slice();
  targetIds.splice(index, 0, ...movingIds);
  return { removedId, movingIds, beforeIds, targetIds, expectedRows };
}

/** 父关系更新后才判断是否需要移动；连续布局和叶子关闭不触发浏览器移动。 */
export function needsCloseOrder(plan, parents) {
  if (!plan) return false;
  const actual = flattenTree(plan.beforeIds.filter(id => id !== plan.removedId), parents).map(row => row.id);
  return !sameOrder(actual, plan.expectedRows);
}

/**
 * 冷加载仅信任同会话且共同存活物理顺序未变的快照，绝不凭 URL 推测主动搬动标签。
 * 多个缺失祖先时，块内顺序服从既有恢复算法的最终父关系，避免子项被搬到新父之前。
 */
export function planSnapshotCloseOrder(tabs, snapshot, sessionToken, parents) {
  const items = snapshot?.items;
  if (!sessionToken || snapshot?.sid !== sessionToken || !Array.isArray(items)) return [];
  const beforeIds = items.map(item => item.i);
  if (beforeIds.some(id => !Number.isInteger(id)) || new Set(beforeIds).size !== beforeIds.length) return [];
  const liveIds = tabs.map(tab => Number(tab.id));
  const live = new Set(liveIds);
  if (!sameOrder(beforeIds.filter(id => live.has(id)), liveIds)) return [];
  const missing = new Set(beforeIds.filter(id => !live.has(id)));
  if (!missing.size) return [];
  const groupById = new Map();
  const groups = new Map();
  // 快照保证父下标在子项之前，一趟传播最外层缺失祖先即可，不逐节点回溯祖先链。
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!Number.isInteger(item.p) || item.p >= index || item.p < -1) return [];
    const inherited = item.p >= 0 ? groupById.get(items[item.p].i) : undefined;
    const group = inherited ?? (missing.has(item.i) ? item.i : undefined);
    if (group !== undefined) groupById.set(item.i, group);
  }
  for (const row of flattenTree(liveIds, parents)) {
    const group = groupById.get(row.id);
    if (group === undefined) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row.id);
  }
  const plans = [];
  const original = new Map(items.map(item => [item.i, item.p >= 0 ? items[item.p].i : null]));
  let virtual = beforeIds;
  for (const id of beforeIds) {
    if (!groups.has(id)) continue;
    const plan = makePlan(virtual, id, groups.get(id));
    if (plan) {
      const currentRows = flattenTree(virtual.filter(id => live.has(id)), parents).map(row => row.id);
      const targetRows = flattenTree(plan.targetIds.filter(id => live.has(id)), parents).map(row => row.id);
      if (sameOrder(currentRows, targetRows)) continue;
      plan.expectedParents = plan.movingIds.filter(id => original.get(id) !== parents.get(id))
        .map(childId => ({ childId, parentId: parents.get(childId) ?? null }));
      plans.push(plan);
      virtual = plan.targetIds;
    }
  }
  return plans;
}

/** 用仍存活的锚点而非旧数值下标定位；固定标签始终留在最前方。 */
export function closeOrderPlacement(plan, tabs) {
  const live = new Map(tabs.map(tab => [Number(tab.id), tab]));
  const movingIds = plan.movingIds.filter(id => live.has(id) && !live.get(id).pinned);
  const moving = new Set(movingIds);
  const remaining = tabs.filter(tab => !moving.has(Number(tab.id))).map(tab => Number(tab.id));
  let anchor = null;
  for (const id of plan.beforeIds) {
    if (id === plan.removedId) break;
    if (live.has(id) && !moving.has(id)) anchor = id;
  }
  const index = Math.max(tabs.filter(tab => tab.pinned).length, anchor === null ? 0 : remaining.indexOf(anchor) + 1);
  const targetIds = remaining.slice();
  targetIds.splice(index, 0, ...movingIds);
  return { movingIds, index, targetIds, needed: !sameOrder(tabs.map(tab => Number(tab.id)), targetIds) };
}

/**
 * 父关系仍由事件同步更新；这里只串行化异步物理定位。
 * 虚拟顺序仅在队列存续时存在，供连续关闭计算下一块的位置，不进入存储或界面。
 */
export function createCloseOrderScheduler({ query, move, begin, finish, sync, changed, settled = () => {} }) {
  const windows = new Map();
  function orderFor(windowId, physicalIds) {
    const order = windows.get(windowId)?.order;
    if (!order) return physicalIds;
    const live = new Set(physicalIds);
    const known = new Set(order);
    // 新创建项仍以实际物理邻居为锚点插入，不丢掉队列期间新增的身份。
    const merged = order.filter(id => live.has(id));
    for (let at = 0; at < physicalIds.length; at += 1) {
      const id = physicalIds[at];
      if (known.has(id)) continue;
      const previous = at > 0 ? merged.indexOf(physicalIds[at - 1]) : -1;
      merged.splice(previous + 1, 0, id);
    }
    return merged;
  }
  function enqueue(windowId, plan) {
    let state = windows.get(windowId);
    if (!state) {
      state = { jobs: [], order: plan.targetIds, cancelled: false, promise: null };
      windows.set(windowId, state);
      state.promise = Promise.resolve().then(() => drain(windowId, state));
    }
    state.order = plan.targetIds;
    state.jobs.push({ plan, token: begin(windowId, plan.movingIds, plan.expectedParents || []) });
  }
  async function place(windowId, state, plan, tabs) {
    // 每次重试必须确有成员消失，集合严格缩小；权限错误等真正失败不会无限重试。
    while (!state.cancelled) {
      const placement = closeOrderPlacement(plan, tabs);
      if (!placement.needed || !placement.movingIds.length) return placement.targetIds;
      try {
        await move(windowId, placement.movingIds, placement.index);
        return placement.targetIds;
      } catch (error) {
        const actual = await query(windowId);
        const live = new Set(actual.map(tab => Number(tab.id)));
        if (!placement.movingIds.some(id => !live.has(id))) throw error;
        tabs = actual;
      }
    }
    return [];
  }
  async function drain(windowId, state) {
    try {
      while (state.jobs.length && !state.cancelled) {
        const { plan, token } = state.jobs.shift();
        let failed = false;
        let targetIds;
        try {
          const tabs = await query(windowId);
          if (state.cancelled) {
            finish(token, { failed: true, reason: "window-closed" });
            break;
          }
          targetIds = await place(windowId, state, plan, tabs);
          const actual = await query(windowId);
          if (state.cancelled) {
            finish(token, { failed: true, reason: "window-closed" });
            break;
          }
          sync(windowId, actual);
          // 新关闭可让目标身份消失；其它变化不能被登记成已经实现的顺序。
          const live = new Set(actual.map(tab => Number(tab.id)));
          targetIds = targetIds.filter(id => live.has(id));
          const known = new Set(targetIds);
          const actualKnown = actual.map(tab => Number(tab.id)).filter(id => known.has(id));
          if (!sameOrder(targetIds, actualKnown)) throw new Error("关闭定位后的实际顺序与目标不一致");
          // 新增身份不属于本次移动的旧顺序约束；登记包含它们的真实完整结果供精确核对。
          targetIds = actual.map(tab => Number(tab.id));
        } catch (error) {
          failed = true;
          try { sync(windowId, await query(windowId)); } catch { /* 查询失败保留现有证据。 */ }
          // 后续计划基于本次成功后的虚拟位置，不能在失败后继续套用。
          for (const job of state.jobs.splice(0)) finish(job.token, { failed: true, reason: "close-order-predecessor-failed" });
          finish(token, { failed: true, reason: "close-order-failed", error: String(error?.message || error) });
        }
        if (state.cancelled) break;
        changed(windowId);
        if (!failed) finish(token, { expectedOrderIds: targetIds });
      }
    } finally {
      if (windows.get(windowId) === state) windows.delete(windowId);
      settled(windowId);
    }
  }
  return {
    orderFor, enqueue,
    async wait(windowId) { while (windows.has(windowId)) await windows.get(windowId).promise; },
    pending: windowId => windows.has(windowId),
    forget(windowId) {
      const state = windows.get(windowId);
      if (state) {
        state.cancelled = true;
        for (const job of state.jobs.splice(0)) finish(job.token, { failed: true, reason: "window-closed" });
        windows.delete(windowId);
      }
    },
  };
}
