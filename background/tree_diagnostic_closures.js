import { applyRemovePromotion, createTreeStateFromParents, flattenTree } from "./tree_core.js";

/** 完整父映射优先，显示行只覆盖自身；隐藏节点不能被推断为已关闭。 */
export function diagnosticParents(snapshot) {
  const parents = new Map(snapshot?.parentById || []);
  for (const entry of snapshot?.entries || []) parents.set(entry.id, entry.parentId ?? null);
  return parents;
}

/** 按当前显示身份复用树投影，隐藏祖先不计入显示缩进。 */
export function diagnosticDepths(snapshot, parents = diagnosticParents(snapshot)) {
  return new Map(flattenTree(snapshot.entries.map(entry => entry.id), parents).map(row => [row.id, row.depth]));
}

/**
 * 用实际 onRemoved 和关闭前已对齐快照计算预期分配；只改独立副本，绝不改观察值。
 * 没有完整物理顺序、前态损坏、或缺失节点缺少关闭依据时不推断，避免用猜测掩盖异常。
 */
export function observedCloseOperations(previous, current, removals) {
  if (!previous || !removals.length || !(previous.parentById instanceof Map) ||
      !(current.parentById instanceof Map) || !Array.isArray(previous.physicalOrderIds)) return [];
  const before = diagnosticParents(previous);
  const after = diagnosticParents(current);
  // 新增节点可能改变“唯一子项”分支；缺少新增时序时不能从旧前态推断。
  if ([...after.keys()].some(id => !before.has(id))) return [];
  const positions = new Map(previous.physicalOrderIds.map((id, index) => [id, index]));
  if (positions.size !== before.size || positions.size !== previous.physicalOrderIds.length) return [];
  for (const [id, parentId] of before) {
    if (!positions.has(id) || (parentId != null &&
        (!positions.has(parentId) || positions.get(parentId) >= positions.get(id)))) return [];
  }
  const missing = new Set([...before.keys()].filter(id => !after.has(id)));
  if (!missing.size) return [];
  const observed = new Set(removals.map(event => event.tabId));
  if ([...missing].some(id => !observed.has(id))) return [];

  const state = createTreeStateFromParents(before);
  const operations = [];
  for (const event of removals) {
    if (!missing.delete(event.tabId)) continue;
    state.childIdsById.get(event.tabId)?.sort((a, b) => positions.get(a) - positions.get(b));
    applyRemovePromotion(state, event.tabId, decision => {
      operations.push({ type: "close", registered: true, phase: "complete",
        correlationId: event.correlationId, focusIds: [event.tabId],
        expectedParents: decision.assignments, explanation: "observed-removal" });
    });
  }
  // 层级按当前来源的可见身份投影，隐藏祖先不能强行计入显示深度。
  const expectedDepths = diagnosticDepths(current, state.parentById);
  for (const operation of operations) operation.expectedDepths = expectedDepths;
  return operations;
}
