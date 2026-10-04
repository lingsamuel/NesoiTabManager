import { buildChildIndex, flattenTree } from './tree_core.js';

// 诊断只使用已有纯函数创建临时索引，绝不调用清理、改父或关闭提升逻辑。
function inspectSnapshot(snapshot) {
  const entries = snapshot?.entries || [];
  const byId = new Map();
  const positions = new Map();
  const issues = [];
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      issues.push({ type: 'duplicate-id', ids: [entry.id] });
      continue;
    }
    positions.set(entry.id, byId.size);
    byId.set(entry.id, entry);
  }
  const parentById = new Map(snapshot?.parentById || []);
  for (const entry of byId.values()) {
    parentById.set(entry.id, entry.parentId ?? null);
  }
  const childIdsById = buildChildIndex(parentById);
  for (const [id, parentId] of parentById) {
    if (parentId != null && !parentById.has(parentId)) {
      issues.push({ type: 'missing-parent', ids: [id], parentId });
    }
  }
  // 每条父边最多走一次。局部路径位置用于精确提取环，完成集合避免长链反复回溯。
  const completed = new Set();
  for (const id of parentById.keys()) {
    const path = [];
    const visiting = new Map();
    let cursor = id;
    while (parentById.has(cursor) && !completed.has(cursor)) {
      if (visiting.has(cursor)) {
        issues.push({ type: 'cycle', ids: path.slice(visiting.get(cursor)) });
        break;
      }
      visiting.set(cursor, path.length);
      path.push(cursor);
      cursor = parentById.get(cursor);
    }
    for (const visited of path) {
      completed.add(visited);
    }
  }
  if (snapshot?.childIdsById instanceof Map) {
    checkChildIndex(snapshot.childIdsById, parentById, issues);
  }
  // flattenTree 自身不会修复父映射；环及其下游无法生成行，保留未知层级证据。
  const depths = new Map(flattenTree([...parentById.keys()], parentById).map((row) => [row.id, row.depth]));
  for (const id of byId.keys()) {
    if (!depths.has(id)) {
      issues.push({ type: 'unresolved-depth', ids: [id] });
    }
  }
  // 父映射的插入顺序可能早于本轮移动，兄弟邻居必须由本次来源序列决定。
  const siblingIds = new Set([...byId.keys(), ...parentById.keys()]);
  const siblings = buildChildIndex(new Map([...siblingIds].map((id) => [id, parentById.get(id) ?? '__root__'])));
  const neighborById = new Map();
  for (const ids of siblings.values()) {
    for (let index = 0; index < ids.length; index += 1) {
      neighborById.set(ids[index], [ids[index - 1], ids[index + 1]].filter((id) => id !== undefined));
    }
  }
  return { snapshot, entries, byId, positions, parentById, childIdsById, depths, neighborById, issues };
}

function checkChildIndex(childIndex, parents, issues) {
  const indexed = new Set();
  for (const [parentId, children] of childIndex) {
    const seen = new Set();
    for (const id of children) {
      if (seen.has(id)) {
        issues.push({ type: 'child-index-duplicate', ids: [id], parentId });
      }
      seen.add(id);
      if (!parents.has(id)) {
        issues.push({ type: 'child-index-extra', ids: [id], parentId });
      } else if (parents.get(id) !== parentId) {
        issues.push({ type: 'child-index-parent', ids: [id], parentId, expectedParentId: parents.get(id) });
      } else {
        indexed.add(id);
      }
    }
  }
  for (const [id, parentId] of parents) {
    if (parentId != null && !indexed.has(id)) {
      issues.push({ type: 'child-index-missing', ids: [id], parentId });
    }
  }
}

function collectContext(data, seeds) {
  const region = new Set();
  const descendants = new Set();
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop();
    if (descendants.has(id)) {
      continue;
    }
    descendants.add(id);
    region.add(id);
    for (const child of data.childIdsById.get(id) || []) {
      stack.push(child);
    }
  }
  const ancestors = new Set();
  for (const id of seeds) {
    for (const neighbor of data.neighborById.get(id) || []) {
      region.add(neighbor);
    }
    let cursor = id;
    while (cursor != null && !ancestors.has(cursor)) {
      ancestors.add(cursor);
      region.add(cursor);
      cursor = data.parentById.get(cursor);
    }
  }
  return region;
}

function safeState(data, id) {
  const entry = data.byId.get(id);
  if (!entry) {
    return null;
  }
  const parentId = entry.parentId ?? null;
  const observedDepth = Number.isFinite(entry.depth);
  return {
    parentId,
    parentExists: parentId == null ? null : data.parentById.has(parentId),
    index: Number.isFinite(entry.index) ? entry.index : null,
    indexSource: data.snapshot.indexSource || data.snapshot.source,
    depth: observedDepth ? entry.depth : (data.depths.get(id) ?? null),
    depthSource: observedDepth ? 'observed' : 'tree-row-model',
  };
}

function compareOrder(before, after, ignoredIds = new Set()) {
  const beforeIds = [...before.byId.keys()].filter((id) => after.byId.has(id) && !ignoredIds.has(id));
  const afterIds = [...after.byId.keys()].filter((id) => before.byId.has(id) && !ignoredIds.has(id));
  const beforePosition = new Map(beforeIds.map((id, index) => [id, index]));
  const changes = [];
  for (let index = 0; index < afterIds.length; index += 1) {
    const id = afterIds[index];
    const previousIndex = beforePosition.get(id);
    if (previousIndex === index) {
      continue;
    }
    const neighbors = (ids, position) => ({ position, previousId: ids[position - 1] ?? null, nextId: ids[position + 1] ?? null });
    changes.push({ id, before: neighbors(beforeIds, previousIndex), after: neighbors(afterIds, index) });
  }
  return changes;
}

/** 仅比较共同存活身份的相对顺序；已证实的单标签移动不能豁免其余标签的换位。 */
export function compareTreeOrder(before, after, ignoredIds = new Set()) {
  if (!before) return [];
  const data = snapshot => ({ byId: new Map((snapshot?.entries || []).map(entry => [entry.id, entry])) });
  return compareOrder(data(before), data(after), ignoredIds);
}

/**
 * 比较同窗口、同来源的连续观察；entries 的排列就是该来源顺序，不能改按 index 排序。
 * 全量检测在局部过滤之前完成，返回值只含身份/结构/变化标志，不包含标题或 URL。
 * 首次观察不产生新增差异，但仍检查结构约束。调用方负责序列化字节限额。
 */
export function compareTreeSnapshots(before, after, { focusIds = [] } = {}) {
  const previous = inspectSnapshot(before);
  const current = inspectSnapshot(after);
  const issues = current.issues;
  const issueIds = new Set(issues.flatMap((issue) => issue.ids));
  const orderChanges = before ? compareOrder(previous, current) : [];
  const orderIds = new Set(orderChanges.map((change) => change.id));
  const seeds = new Set([...focusIds, ...issueIds, ...orderIds]);
  const region = new Set([...collectContext(previous, seeds), ...collectContext(current, seeds)]);
  const ids = new Set([...previous.byId.keys(), ...current.byId.keys()]);
  const changed = [];
  const context = [];
  const shifts = [];
  let range = [];
  let omitted = 0;
  const flush = () => {
    if (range.length >= 2) {
      const first = range[0];
      const last = range.at(-1);
      shifts.push({ count: range.length, delta: first.after.index - first.before.index, firstId: first.id, lastId: last.id, before: { start: first.before.index, end: last.before.index }, after: { start: first.after.index, end: last.after.index } });
    } else if (range.length) {
      changed.push(range[0]);
    }
    range = [];
  };
  for (const id of ids) {
    const oldState = safeState(previous, id);
    const newState = safeState(current, id);
    const changes = [];
    if (before) {
      if (!oldState) {
        changes.push('added');
      } else if (!newState) {
        changes.push('removed');
      } else {
        if (oldState.parentId !== newState.parentId) changes.push('parent');
        if (oldState.depth !== newState.depth) changes.push('depth');
        if (oldState.index !== newState.index) changes.push('index');
        const oldEntry = previous.byId.get(id);
        const newEntry = current.byId.get(id);
        if (oldEntry.title !== newEntry.title || oldEntry.url !== newEntry.url || newEntry.contentChanged === true) changes.push('content');
        if (orderIds.has(id)) changes.push('order');
      }
    }
    if (issueIds.has(id)) changes.push('issue');
    const record = { id, before: oldState, after: newState, changes, context: changes.length === 0 };
    const shiftOnly = changes.length === 1 && changes[0] === 'index' && oldState.index != null && newState.index != null && !region.has(id);
    if (shiftOnly) {
      const last = range.at(-1);
      if (last && (newState.index - oldState.index !== last.after.index - last.before.index || previous.positions.get(id) !== previous.positions.get(last.id) + 1 || current.positions.get(id) !== current.positions.get(last.id) + 1 || oldState.index !== last.before.index + 1 || newState.index !== last.after.index + 1)) {
        flush();
      }
      range.push(record);
      continue;
    }
    flush();
    if (changes.length) changed.push(record);
    else if (region.has(id)) context.push(record);
    else omitted += 1;
  }
  flush();
  return { nodes: [...changed, ...context], shifts, omitted, totalBefore: previous.entries.length, totalAfter: current.entries.length, orderChanges, issues };
}
