// 后台诊断的观测边界。所有采样均由已有事件驱动，不查询标签、不修改业务树。
import { createTreeDiagnosticMonitor } from './tree_diagnostic_monitor.js';
import {
  isTreeDebugEnabled, isTreeDebugPrintEnabled, recordTreeDiagnostic, recordTreeIncident,
} from './tree_debug.js';

let captureState = null;
let metadataProvider = null;
let readRevision = () => null;
const completedOperations = new Map();
let enabled = false;
let sequence = 0;
const instanceId = `background-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const epochs = new Map();
const operations = new Map();
const unregisteredMoves = new Map();
const physicalBaselines = new Map();
const monitor = createTreeDiagnosticMonitor({
  emit: event => {
    // 普通差异在详细开关下输出；异常证据始终交给独立预留区。
    if (event.classification === 'explained' && !isTreeDebugPrintEnabled()) {
      const { evidence, ...summary } = event;
      recordTreeDiagnostic({ ...summary, detailOmitted: true });
    } else {
      recordTreeDiagnostic(event);
    }
  },
  incident: recordTreeIncident,
});

/** 只注入读取接口；业务树仍由 tree.js 独占维护。 */
export function configureTreeDiagnostics(options = {}) {
  if (options.captureState) captureState = options.captureState;
  if (options.metadataProvider) metadataProvider = options.metadataProvider;
  if (options.readRevision) readRevision = options.readRevision;
}

/** 内容仅留在临时快照做精确比较，不进入日志字段。 */
export function getTreeDiagnosticContent(id) {
  if (!isTreeDebugEnabled() || !metadataProvider) return {};
  try {
    const tab = metadataProvider(id);
    return tab ? { title: tab.title, url: tab.url } : {};
  } catch (_) {
    return {};
  }
}

function ready() {
  const current = isTreeDebugEnabled();
  if (current !== enabled) {
    monitor.clear();
    operations.clear();
    completedOperations.clear();
    unregisteredMoves.clear();
    physicalBaselines.clear();
    epochs.clear();
    enabled = current;
    if (current) recordTreeDiagnostic({ type: 'monitor-gap', reason: 'enabled-or-background-restarted', source: 'backend' });
  }
  return current;
}

/** 配置切换时立即释放基线，避免关闭再开启后跨越未监测区间。 */
export function resetTreeDiagnosticBaselines(reason = 'configuration-changed') {
  monitor.clear();
  operations.clear();
  completedOperations.clear();
  unregisteredMoves.clear();
  physicalBaselines.clear();
  epochs.clear();
  enabled = isTreeDebugEnabled();
  if (enabled) recordTreeDiagnostic({ type: 'monitor-gap', source: 'backend', reason });
}

export function treeDiagnosticEpoch(windowId) {
  return epochs.get(Number(windowId)) || 0;
}

/** 先记原始事件，再让业务处理，包括内部移动的提前返回分支。 */
export function recordBrowserTreeEvent(type, windowId, ids = [], details = {}) {
  if (!ready()) return null;
  const id = Number(windowId);
  epochs.set(id, treeDiagnosticEpoch(id) + 1);
  const correlationId = `${instanceId}:${++sequence}`;
  recordTreeDiagnostic({ type: `browser-${type}`, windowId: id, correlationId, ids, epoch: treeDiagnosticEpoch(id), ...details });
  if (type === 'moved' && !details.internal) {
    const key = `${id}:${ids[0]}`;
    const previous = unregisteredMoves.get(key);
    const tracking = previous || {
      signature: `${instanceId}:${id}:unregistered-move:${ids.join(',')}:${sequence}`,
      windowId: id, type: 'unregistered-browser-move', ids,
      originalIndex: details.fromIndex,
      originalOrder: physicalBaselines.get(id) || null,
    };
    if (!previous && unregisteredMoves.size >= 128) {
      unregisteredMoves.delete(unregisteredMoves.keys().next().value);
      recordTreeDiagnostic({ type: 'monitor-gap', windowId: id, reason: 'raw-move-tracking-limit' });
    }
    unregisteredMoves.set(key, tracking);
    const { originalOrder, ...identity } = tracking;
    recordTreeIncident({ ...identity, status: 'active', evidence: {
      missingBefore: !originalOrder,
      correlationId, fromIndex: details.fromIndex, toIndex: details.toIndex,
      reason: '已观察到来源未知的移动；尚不能确认用户意图', classification: 'suspect',
    } });
  }
  return correlationId;
}

/** 捕获同一来源的连续观测。异步操作尚未结束时仅记处理中证据。 */
export function observeTreeDiagnostics(windowId, context = {}) {
  if (!ready() || !captureState) return;
  try {
    const snapshot = captureState(windowId);
    if (!snapshot) {
      monitor.gap({ windowId: Number(windowId), source: 'backend-cache', reason: 'tree-unavailable' });
      return;
    }
    const active = operations.get(Number(windowId));
    monitor.observe(snapshot, {
      type: 'observation', phase: 'complete', ...context,
      aligned: context.aligned !== false && !(active?.size),
    });
  } catch (_) {
    recordTreeDiagnostic({ type: 'monitor-gap', windowId, reason: 'snapshot-observation-failed' });
  }
}

/** 起止关联跨 await 保持不变；并发操作只标记无法对齐，不借延时宣称稳定。 */
export function beginTreeDiagnosticOperation(type, windowId, focusIds = [], details = {}) {
  if (!ready()) return null;
  const id = Number(windowId);
  const correlationId = details.correlationId || `${instanceId}:${++sequence}`;
  const token = { type, windowId: id, focusIds, registered: true, revisionBefore: readRevision(id), ...details, correlationId };
  observeTreeDiagnostics(id, { ...token, phase: 'before' });
  if (!operations.has(id)) operations.set(id, new Set());
  operations.get(id).add(token);
  recordTreeDiagnostic({ type: `${type}-begin`, windowId: id, correlationId, focusIds });
  return token;
}

export function endTreeDiagnosticOperation(token, details = {}) {
  if (!token || !ready()) return;
  operations.get(token.windowId)?.delete(token);
  recordTreeDiagnostic({ type: `${token.type}-end`, windowId: token.windowId, correlationId: token.correlationId, ...details });
  const completed = { ...token, ...details, phase: 'complete', aligned: !details.failed, revision: readRevision(token.windowId) };
  if (completed.registered && !details.failed && ['close', 'move'].includes(token.type)) {
    const history = completedOperations.get(token.windowId) || [];
    const { reasons, ...context } = completed;
    history.push(context);
    completedOperations.set(token.windowId, history.slice(-32));
  }
  observeTreeDiagnostics(token.windowId, completed);
}

/** 复用实际发生的全窗 query 结果；绝不为诊断追加查询。 */
export function observeTreePhysicalTabs(windowId, tabs, queryEpoch) {
  if (!ready()) return;
  const currentEpoch = treeDiagnosticEpoch(windowId);
  const aligned = queryEpoch === currentEpoch && !(operations.get(Number(windowId))?.size);
  if (aligned) {
    const positions = new Map(tabs.map(tab => [Number(tab.id), tab.index]));
    for (const [key, tracking] of unregisteredMoves) {
      if (tracking.windowId !== Number(windowId)) continue;
      const index = positions.get(tracking.ids[0]);
      // 插删会改变数值下标；只有共同存活身份的相对次序恢复才可结束疑点。
      const { originalOrder, ...identity } = tracking;
      const originalIds = new Set(originalOrder || []);
      const expected = originalOrder?.filter(id => positions.has(id));
      const actual = tabs.filter(tab => originalIds.has(Number(tab.id))).map(tab => Number(tab.id));
      const recovered = index === undefined || Boolean(expected && expected.every((id, offset) => actual[offset] === id));
      recordTreeIncident({ ...identity, status: recovered ? 'recovered' : 'active', evidence: {
        type: 'raw-move-observed-result', queryEpoch, currentEpoch, index: index ?? null,
        missingBefore: !originalOrder, commonCount: expected?.length ?? 0,
        reason: recovered ? 'observed-relative-order-restored-or-tab-left' : 'relative-order-unrestored-or-baseline-missing',
      } });
      if (recovered) unregisteredMoves.delete(key);
    }
    physicalBaselines.set(Number(windowId), tabs.map(tab => Number(tab.id)));
  }
  try {
    monitor.observe({
      windowId, source: 'browser-physical', sourceId: instanceId, sourceToken: instanceId,
      entries: tabs.map(tab => ({ id: Number(tab.id), parentId: null, index: tab.index, title: tab.title, url: tab.url })),
    }, { type: 'query', phase: 'complete', queryEpoch, currentEpoch,
      operations: completedOperations.get(Number(windowId)) || [],
      aligned });
  } catch (_) {
    recordTreeDiagnostic({ type: 'monitor-gap', windowId, source: 'browser-physical', reason: 'query-observation-failed' });
  }
}

export function forgetTreeDiagnostics(windowId) {
  if (!ready()) return;
  monitor.gap({ windowId, reason: 'window-closed' });
  operations.delete(Number(windowId));
  completedOperations.delete(Number(windowId));
  physicalBaselines.delete(Number(windowId));
  for (const [key, item] of unregisteredMoves) {
    if (item.windowId === Number(windowId)) unregisteredMoves.delete(key);
  }
  epochs.delete(Number(windowId));
}

/** 响应仅携带最近已完成操作的元数据；前端按自身基线版本筛选作用区间。 */
export function getTreeDiagnosticOperations(windowId) {
  if (!ready()) return null;
  return { operations: (completedOperations.get(Number(windowId)) || []).map(item => ({ ...item })),
    pending: Boolean(operations.get(Number(windowId))?.size), revision: readRevision(Number(windowId)) };
}
