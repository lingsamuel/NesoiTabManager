/**
 * 从完整物理观察中核对固定边界变化，返回可解释自身移动的标签。
 * 状态缺失、固定区不连续或变化项不在边界时不作推断；不修改快照或业务树。
 */
export function explainedPinIds(before, after) {
  const allowed = new Set();
  if (!before) return allowed;
  const entries = after.entries || [];
  if (entries.some(entry => typeof entry.pinned !== 'boolean')) return allowed;
  const boundary = entries.findIndex(entry => !entry.pinned);
  const pinnedCount = boundary < 0 ? entries.length : boundary;
  if (entries.slice(pinnedCount).some(entry => entry.pinned)) return allowed;
  const previous = new Map(before.entries.map(entry => [entry.id, entry]));
  const pinned = new Set();
  const unpinned = new Set();
  for (const entry of entries) {
    const old = previous.get(entry.id);
    if (typeof old?.pinned !== 'boolean' || old.pinned === entry.pinned) continue;
    (entry.pinned ? pinned : unpinned).add(entry.id);
  }
  // 多次固定会把变化项放到固定区尾部，取消固定则放到普通区头部。
  // 只解释这两个边界块，不能把同一标签后来被移动到任意位置也归因于固定。
  const allowBoundary = (ids, start) => {
    if (!ids.size) return;
    const block = entries.slice(start, start + ids.size);
    if (block.length === ids.size && block.every(entry => ids.has(entry.id))) {
      for (const id of ids) allowed.add(id);
    }
  };
  allowBoundary(pinned, pinnedCount - pinned.size);
  allowBoundary(unpinned, pinnedCount);
  return allowed;
}

/** 原生固定事件的完成位置必须与同标签移动一致，方向也必须符合固定区边界变化。 */
export function matchesPinMove(pin, move) {
  if (!pin || !Number.isInteger(pin.index) || !Number.isInteger(move.fromIndex) ||
      pin.index !== move.toIndex) return false;
  return pin.pinned ? move.fromIndex >= move.toIndex : move.fromIndex <= move.toIndex;
}
