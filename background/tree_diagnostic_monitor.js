import { compareTreeSnapshots } from './tree_diagnostics.js';

const EXPLAINABLE = new Set(['close', 'move', 'filter', 'collapse', 'expand', 'pin', 'attach', 'detach', 'transfer']);
const COMPLETE_PHASES = new Set(['complete', 'applied', 'after']);

function registeredOperation(context) {
  return context.registered === true && Boolean(context.correlationId) && COMPLETE_PHASES.has(context.phase) && EXPLAINABLE.has(context.type);
}

function operationContexts(context) {
  return [...(context.operations || []), context].filter(registeredOperation);
}

function snapshotCopy(snapshot) {
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry) => ({ ...entry })),
    ...(snapshot.parentById instanceof Map ? { parentById: new Map(snapshot.parentById) } : {}),
    ...(snapshot.childIdsById instanceof Map ? { childIdsById: new Map([...snapshot.childIdsById].map(([id, children]) => [id, [...children]])) } : {}),
  };
}

function snapshotParents(snapshot) {
  const parents = new Map(snapshot?.parentById || []);
  for (const entry of snapshot?.entries || []) parents.set(entry.id, entry.parentId ?? null);
  return parents;
}

function permittedParentChanges(evidence, context) {
  const allowed = new Set();
  const operations = operationContexts(context).map((operation) => ({
    type: operation.type,
    focus: new Set(operation.focusIds || []),
    expected: new Map((operation.expectedParents || []).map(({ childId, parentId }) => [childId, parentId])),
  }));
  // 前端可能跨过多次关闭：按实际登记顺序校验每一步的作用范围与精确目标父。
  // 不能只看最后一次赋值，否则缺失中间关闭证据也会被误当成已解释。
  for (const node of evidence.nodes) {
    if (!node.before || !node.after || !node.changes.includes('parent')) continue;
    let parentId = node.before.parentId;
    let explained = false;
    for (const operation of operations) {
      const inScope = operation.type === 'close' ? operation.focus.has(parentId) : operation.focus.has(node.id);
      if (inScope && operation.expected.has(node.id)) {
        parentId = operation.expected.get(node.id);
        explained = true;
      }
    }
    if (explained && parentId === node.after.parentId) allowed.add(node.id);
  }
  return allowed;
}

function unexplainedParents(evidence, context, previous, current) {
  const allowed = permittedParentChanges(evidence, context, previous);
  const parents = snapshotParents(current);
  const inherited = new Map();
  const hasExplainedAncestor = (id) => {
    const path = [];
    const seen = new Set();
    let cursor = id;
    let explained = false;
    while (cursor != null && !seen.has(cursor)) {
      if (allowed.has(cursor)) { explained = true; break; }
      if (inherited.has(cursor)) { explained = inherited.get(cursor); break; }
      path.push(cursor);
      seen.add(cursor);
      cursor = parents.get(cursor);
    }
    for (const visited of path) inherited.set(visited, explained);
    return explained;
  };
  return evidence.nodes.filter((node) => {
    if (!node.before || !node.after) return false;
    if (node.changes.includes('parent') && !allowed.has(node.id)) return true;
    return node.changes.includes('depth') && !hasExplainedAncestor(node.id);
  }).map((node) => node.id);
}

function explainedOrder(context, current) {
  // 关闭登记只能解释父赋值及共同存活项的 index 位移，永远不能解释存活身份换位。
  const operations = operationContexts(context).filter((operation) => operation.type !== 'close');
  const operation = operations.at(-1);
  if (!Array.isArray(operation?.expectedOrderIds)) return false;
  const expected = operation.expectedOrderIds;
  return expected.length === current.entries.length && current.entries.every((entry, index) => entry.id === expected[index]);
}

function safeObservation(context) {
  const observation = {
    type: context.type || 'observation',
    correlationId: context.correlationId || null,
    phase: context.phase || null,
    aligned: context.aligned === true,
    registered: context.registered === true,
  };
  for (const field of ['requestId', 'revision', 'sourceToken', 'previousSourceToken', 'queryEpoch', 'currentEpoch', 'epoch', 'fromRevision', 'toRevision', 'filterActive', 'filterMode', 'collapsedCount', 'visibleCount', 'completeCount', 'pinnedCount']) {
    if (typeof context[field] === 'string' || typeof context[field] === 'boolean' || Number.isFinite(context[field])) observation[field] = context[field];
  }
  if (Array.isArray(context.operations)) {
    observation.operations = context.operations.map((operation) => {
      const summary = {};
      for (const field of ['type', 'correlationId', 'phase', 'revision', 'fromRevision', 'toRevision']) {
        if (typeof operation[field] === 'string' || Number.isFinite(operation[field])) summary[field] = operation[field];
      }
      return summary;
    });
  }
  return observation;
}

function signatureFor(snapshot, type, ids) {
  return JSON.stringify([snapshot.windowId, snapshot.source, type, [...ids].sort((a, b) => a - b)]);
}

function groupIssues(issues) {
  const grouped = new Map();
  for (const issue of issues) {
    if (!grouped.has(issue.type)) grouped.set(issue.type, new Set());
    for (const id of issue.ids) grouped.get(issue.type).add(id);
  }
  return grouped;
}

function restoredOrder(active, current) {
  const currentIds = new Set(current.entries.map((entry) => entry.id));
  const expected = active.originalIds.filter((id) => currentIds.has(id));
  const originalIds = new Set(expected);
  const observed = current.entries.filter((entry) => originalIds.has(entry.id)).map((entry) => entry.id);
  return expected.every((id, index) => observed[index] === id);
}

function restoredParents(active, current, currentEvidence) {
  const entries = new Map(current.entries.map((entry) => [entry.id, entry]));
  const states = new Map(currentEvidence.nodes.map((node) => [node.id, node.after]));
  return active.ids.every((id) => {
    if (!entries.has(id)) return true;
    const expected = active.originalStates.get(id);
    const actual = states.get(id);
    return expected && actual && expected.parentId === actual.parentId && expected.depth === actual.depth;
  });
}

function setRecoveryBaseline(active, previous, evidence) {
  const ids = new Set(active.ids);
  active.previous = previous ? snapshotCopy(previous) : null;
  active.originalIds = (previous?.entries || []).map((entry) => entry.id).filter((id) => ids.has(id));
  active.originalStates = new Map(evidence.nodes.filter((node) => node.before).map((node) => [node.id, node.before]));
}

/**
 * 消费真实观测点的只读监测器；不设置定时器、不查询浏览器、不维护业务树。
 * aligned 仅在调用方确认异步观察可对齐时为 true；处理中疑点保留首次前态，后续观察确认或恢复。
 * preserveBaselineOnSourceChange 仅供同一前端生命周期使用：后台换实例不改变浏览器 tabId，
 * 可以继续比较存活身份，但不能跨实例比较 revision 或假定中间操作证据完整。
 * emit/incident 的失败与业务隔离；调用方继续负责记录容量与保存。
 */
export function createTreeDiagnosticMonitor({ emit = () => {}, incident = () => {}, preserveBaselineOnSourceChange = false } = {}) {
  const sources = new Map();
  const safeEmit = (record) => { try { emit(record); } catch { /* 日志失败不能改变标签操作。 */ } };
  const safeIncident = (record) => { try { incident(record); } catch { /* 存储失败不阻断观测。 */ } };
  const keyFor = (snapshot) => JSON.stringify([snapshot.windowId, snapshot.source]);
  const report = (active, snapshot, context, status, evidence) => {
    // 未对齐的暂态只进入普通日志与内存跟踪；正常关闭的短暂悬空不能占用异常预留包。
    // 已确认问题的后续处理中观察仍更新原包，首次确认同时带上真正的首次前态。
    if (status === 'active') active.confirmed = true;
    if (active.confirmed) {
      safeIncident({ signature: active.signature, windowId: snapshot.windowId, source: snapshot.source, type: active.type, ids: active.ids, status, evidence: { ...evidence, firstEvidence: active.firstEvidence, observation: safeObservation(context) } });
    }
    safeEmit({ type: 'tree-anomaly', windowId: snapshot.windowId, source: snapshot.source, correlationId: context.correlationId || null, classification: status === 'recovered' ? 'recovered' : status === 'pending' ? 'pending' : active.structural ? 'inconsistent' : 'suspect', signature: active.signature, observation: safeObservation(context), evidence });
  };

  const gap = ({ windowId, source, reason }) => {
    for (const [key, state] of sources) {
      if ((windowId == null || state.snapshot.windowId === windowId) && (source == null || state.snapshot.source === source)) sources.delete(key);
    }
    safeEmit({ type: 'monitor-gap', windowId: windowId ?? null, source: source ?? null, reason });
  };

  const observe = (snapshot, context = {}) => {
    context = { sourceToken: snapshot.sourceToken ?? snapshot.instanceToken ?? snapshot.instanceId, revision: snapshot.revision, ...context };
    const key = keyFor(snapshot);
    let state = sources.get(key);
    const token = snapshot.sourceToken ?? snapshot.instanceToken ?? snapshot.instanceId ?? null;
    if (state && token !== state.token) {
      if (preserveBaselineOnSourceChange) {
        safeEmit({ type: 'monitor-source-changed', windowId: snapshot.windowId, source: snapshot.source,
          previousSourceToken: state.token, sourceToken: token, baselinePreserved: true });
        // 切换可能先出现在处理中采样；直到下一次对齐观察才结束这段跨来源比较。
        if (!state.sourceTransition) state.sourceTransition = { previousSourceToken: state.token };
        state.token = token;
      } else {
        gap({ windowId: snapshot.windowId, source: snapshot.source, reason: 'source-instance-changed' });
        state = null;
      }
    }
    if (state?.sourceTransition) context = { ...context, ...state.sourceTransition };
    const previous = state?.snapshot || null;
    const evidence = compareTreeSnapshots(previous, snapshot, { focusIds: context.focusIds || [] });
    if (!state) {
      state = { snapshot: null, alignedSnapshot: null, token, active: new Map() };
      sources.set(key, state);
      safeEmit({ type: 'monitor-baseline', windowId: snapshot.windowId, source: snapshot.source, missingBefore: true, totalAfter: snapshot.entries.length });
    }
    // 查询结果和父映射会分批到达；处理中出现的新节点尚无可信父关系基线。
    // 即时证据照常保留，但非结构性确认只比较上次对齐观察中的共同存活身份。
    const comparisonPrevious = context.aligned === true ? state.alignedSnapshot : previous;
    const comparisonEvidence = context.aligned === true
      ? compareTreeSnapshots(comparisonPrevious, snapshot, { focusIds: context.focusIds || [] })
      : evidence;
    const changedParents = unexplainedParents(comparisonEvidence, context, comparisonPrevious, snapshot);
    const changedOrder = explainedOrder(context, snapshot) ? [] : comparisonEvidence.orderChanges.map((change) => change.id);
    const confirmedIds = new Map([
      ['parent-change', new Set(changedParents)],
      ['order-change', new Set(changedOrder)],
    ]);
    const issues = groupIssues(evidence.issues);
    const recovered = new Map();
    // 已发生的可疑换位不能因下一次快照相同而消失；恢复需要真实观察回到最初相对顺序。
    for (const [signature, active] of [...state.active]) {
      let activeEvidence = compareTreeSnapshots(active.previous, snapshot, { focusIds: active.ids });
      let remains;
      if (!active.structural && !active.confirmed && context.aligned === true) {
        const eligibleIds = active.ids.filter((id) => confirmedIds.get(active.type).has(id));
        remains = eligibleIds.length > 0;
        if (remains) {
          // 首次处理中证据保持原样；恢复判据则绑定真正的已对齐前态。
          active.ids = eligibleIds;
          active.signature = signatureFor(snapshot, active.type, active.ids);
          state.active.delete(signature);
          state.active.set(active.signature, active);
          setRecoveryBaseline(active, comparisonPrevious, comparisonEvidence);
          activeEvidence = comparisonEvidence;
        }
      } else if (active.structural) {
        const currentIds = issues.get(active.type);
        remains = Boolean(currentIds && active.ids.some((id) => currentIds.has(id)));
      } else if (active.type === 'order-change') {
        remains = !restoredOrder(active, snapshot) && !explainedOrder(context, snapshot);
      } else {
        const allowedNow = unexplainedParents(activeEvidence, context, active.previous, snapshot);
        const allExplained = operationContexts(context).length > 0 && active.ids.every((id) => !allowedNow.includes(id));
        remains = !allExplained && !restoredParents(active, snapshot, activeEvidence);
      }
      if (!remains && context.aligned === true) {
        report(active, snapshot, context, 'recovered', activeEvidence);
        state.active.delete(signature);
        if (!recovered.has(active.type)) recovered.set(active.type, new Set());
        for (const id of active.ids) recovered.get(active.type).add(id);
      } else if (remains) {
        report(active, snapshot, context, context.aligned === true ? 'active' : 'pending', activeEvidence);
      }
    }
    const candidates = [...issues].map(([type, ids]) => ({ type, ids: [...ids], structural: true }));
    if (changedParents.length) candidates.push({ type: 'parent-change', ids: changedParents, structural: false });
    if (changedOrder.length) candidates.push({ type: 'order-change', ids: changedOrder, structural: false });
    let unexplained = false;
    for (const candidate of candidates) {
      candidate.ids = candidate.ids.filter((id) => !recovered.get(candidate.type)?.has(id));
      if (!candidate.ids.length) continue;
      unexplained = true;
      const signature = signatureFor(snapshot, candidate.type, candidate.ids);
      if (state.active.has(signature)) continue;
      const candidateEvidence = candidate.structural ? evidence : comparisonEvidence;
      const candidatePrevious = candidate.structural ? previous : comparisonPrevious;
      const active = {
        ...candidate,
        signature,
        firstEvidence: { ...candidateEvidence, missingBefore: !candidatePrevious, observation: safeObservation(context) },
        confirmed: false,
      };
      setRecoveryBaseline(active, candidatePrevious, candidateEvidence);
      // 只读观察器也必须有容量边界，不能让长时间运行产生无限原始快照。
      // 超限保留缓冲层已经捕获的现场，并明确声明后续恢复跟踪不完整。
      if (state.active.size >= 32) {
        const oldest = state.active.keys().next().value;
        state.active.delete(oldest);
        safeEmit({ type: 'monitor-gap', windowId: snapshot.windowId, source: snapshot.source, reason: 'incident-tracking-limit', signature: oldest });
      }
      state.active.set(signature, active);
      report(active, snapshot, context, context.aligned === true ? 'active' : 'pending', { ...candidateEvidence, missingBefore: !candidatePrevious });
    }
    if (previous && (evidence.nodes.some((node) => node.changes.length) || evidence.shifts.length)) {
      safeEmit({ type: 'tree-observation', windowId: snapshot.windowId, source: snapshot.source, correlationId: context.correlationId || null, classification: unexplained ? (context.aligned === true ? 'suspect' : 'pending') : 'explained', observation: safeObservation(context), evidence });
    }
    state.snapshot = snapshotCopy(snapshot);
    if (context.aligned === true) {
      state.alignedSnapshot = state.snapshot;
      state.sourceTransition = null;
    }
    return evidence;
  };
  return { observe, gap, clear: () => sources.clear() };
}
