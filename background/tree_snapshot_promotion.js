/** 正常关闭与快照消去缺失节点共用的规则；兄弟数量不包含被关闭节点自身。 */
export function getRemovePromotionRule(parentId, siblingCountBefore, childCount) {
  if (childCount === 0) return "no-children";
  if (parentId != null && siblingCountBefore === 0) return "only-child-of-parent";
  return parentId == null ? "closed-was-root" : "first-child-takes-place";
}

/**
 * 身份配对完成后消去快照里的缺失节点，返回存活节点的父快照下标（-1 为顶层）。
 * 快照没有关闭时间线，采用逆快照顺序作为批量缺失时的确定性规则；合法父总在子之前。
 * 连续缺失祖先只拼接存活根列表，等父归属确定后才写关系，避免长链反复搬运整片子树。
 * 每个根被赋父后就退出列表，扫描与拼接总计 O(n)，不递归，也不修改输入快照。
 */
export function restoreSnapshotParents(items, matchedIndexes) {
  const root = items.length;
  const originalParents = new Int32Array(root);
  const parents = new Int32Array(root).fill(-1);
  const childCounts = new Int32Array(root + 1);
  const heads = new Int32Array(root + 1).fill(-1);
  const tails = new Int32Array(root + 1).fill(-1);
  const sizes = new Int32Array(root + 1);
  const next = new Int32Array(root).fill(-1);
  for (let i = 0; i < root; i += 1) {
    const p = items[i].p;
    const parent = Number.isInteger(p) && p >= 0 && p < i ? p : root;
    originalParents[i] = parent;
    childCounts[parent] += 1;
  }

  for (let i = root - 1; i >= 0; i -= 1) {
    const parent = originalParents[i];
    let head = heads[i];
    let tail = tails[i];
    let size = sizes[i];
    if (matchedIndexes[i] >= 0) {
      for (let child = head; child !== -1; child = next[child]) parents[child] = i;
      head = tail = i;
      size = 1;
    } else {
      const rule = getRemovePromotionRule(parent === root ? null : parent, childCounts[parent] - 1, size);
      if (rule === "closed-was-root" || rule === "first-child-takes-place") {
        // 子树可能在物理序列中交错，列表拼接顺序不代表浏览器顺序。
        let first = head;
        for (let child = head; child !== -1; child = next[child]) {
          if (matchedIndexes[child] < matchedIndexes[first]) first = child;
        }
        for (let child = head; child !== -1; child = next[child]) {
          if (child !== first) parents[child] = first;
        }
        next[first] = -1;
        head = tail = first;
        size = 1;
      }
      childCounts[parent] += size - 1;
    }
    if (size === 0) continue;
    if (heads[parent] === -1) heads[parent] = head;
    else next[tails[parent]] = head;
    tails[parent] = tail;
    sizes[parent] += size;
  }
  return parents;
}
