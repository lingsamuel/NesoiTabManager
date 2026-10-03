// 每个前端文档一份诊断客户端。全窗快照只留在本地 monitor，IPC 仅发送有界局部证据。
import { reactive } from "vue";
import { createTreeDiagnosticMonitor } from "../../../background/tree_diagnostic_monitor.js";
import { request } from "./request.js";
import { storageLocalGet } from "./storage.js";

const CONFIG_KEY = "treeDebugConfig";
const STATUS_KEY = "treeDiagnosticStatus";
const MAX_EVENT_BYTES = 24 * 1024;
const MAX_BATCH_BYTES = 96 * 1024;
const MAX_QUEUE_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).length;

/** 传输边界再次剔除正文；嵌套数组也设上限，避免异常数据耗尽队列。 */
function safeEvidence(value, limits, depth = 0) {
  if (depth > 10) { limits.depthLimited = true; return null; }
  if (typeof value === "string") {
    if (value.length > 200) limits.truncatedStrings = (limits.truncatedStrings || 0) + 1;
    return value.slice(0, 200);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    if (value.length > 128) limits.omittedItems = (limits.omittedItems || 0) + value.length - 128;
    return value.slice(0, 128).map((item) => safeEvidence(item, limits, depth + 1));
  }
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  const entries = Object.entries(value);
  if (entries.length > 128) limits.omittedFields = (limits.omittedFields || 0) + entries.length - 128;
  for (const [key, item] of entries.slice(0, 128)) {
    if (/^(title|url|text|favicon|favIconUrl|keyword|query)$/i.test(key)) continue;
    result[key] = safeEvidence(item, limits, depth + 1);
  }
  return result;
}

/** 大证据先缩减旁支上下文，仍保留异常身份、状态及最早局部前后态。 */
function fitEvent(kind, payload, originalBytes) {
  const entry = { kind, payload };
  if (bytes(entry) <= MAX_EVENT_BYTES) return entry;
  const evidence = payload.evidence || {};
  const local = {
    nodes: evidence.nodes || payload.nodes || [],
    shifts: evidence.shifts || [], issues: evidence.issues || [], orderChanges: evidence.orderChanges || [],
    observation: evidence.observation, missingBefore: evidence.missingBefore,
    totalBefore: evidence.totalBefore, totalAfter: evidence.totalAfter,
  };
  entry.payload = {
    type: payload.type || "client-evidence-truncated", windowId: payload.windowId,
    source: payload.source, sourceId: payload.sourceId, seq: payload.seq, capturedAt: payload.capturedAt,
    correlationId: payload.correlationId, signature: payload.signature, status: payload.status,
    ids: payload.ids?.slice(0, 16), evidence: local,
    truncation: { ...payload.truncation, reason: "client-event-limit", originalBytes },
  };
  for (const key of ["shifts", "issues", "orderChanges"]) local[key] = local[key].slice(0, 8);
  while (bytes(entry) > MAX_EVENT_BYTES && local.nodes.length > 1) {
    local.nodes = local.nodes.slice(0, Math.ceil(local.nodes.length / 2));
  }
  if (bytes(entry) > MAX_EVENT_BYTES) {
    local.nodes = local.nodes.map((node) => ({ id: node.id, changes: node.changes?.slice(0, 8),
      before: node.before && { parentId: node.before.parentId, index: node.before.index, depth: node.before.depth },
      after: node.after && { parentId: node.after.parentId, index: node.after.index, depth: node.after.depth } }));
    local.issues = local.issues.map((issue) => ({ type: issue.type, ids: issue.ids?.slice(0, 8) }));
    local.shifts = [];
    local.orderChanges = [];
    delete local.observation;
  }
  return entry;
}

function listenStorage(key, area, callback) {
  const changed = globalThis.chrome?.storage?.onChanged;
  if (!changed?.addListener) return () => {};
  const listener = (changes, changedArea) => {
    if (changedArea === area && changes[key]) callback(changes[key].newValue);
  };
  changed.addListener(listener);
  return () => changed.removeListener?.(listener);
}

/** 仅旁路观测；开关关闭会清空采样基线和待发送证据，不影响任何业务请求。 */
export function createTreeDiagnosticClient({
  send = request,
  readConfig = () => storageLocalGet(CONFIG_KEY),
  subscribeConfig = (callback) => listenStorage(CONFIG_KEY, "local", callback),
  subscribeStatus = (callback) => listenStorage(STATUS_KEY, "session", callback),
} = {}) {
  const sourceId = `ui-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const state = reactive({ enabled: false, detailed: false, generation: 0, status: {} });
  let seq = 0;
  let requestSeq = 0;
  let queue = [];
  let queuedBytes = 0;
  let scheduled = false;
  let inFlight = null;
  let disposed = false;
  let configEpoch = 0;
  let dropped = 0;
  let transportLost = 0;
  let reportLossOnDrain = false;
  let lossAttempted = false;
  let incidentSeq = 0;
  let cleanupRemoved = () => {};
  const incidentSignatures = new Map();
  const monitor = createTreeDiagnosticMonitor({
    // 客户端自身未重建时，保留后台休眠/重启前的已对齐树，用于发现重建引入的改父或换位。
    preserveBaselineOnSourceChange: true,
    emit: (event) => record(event),
    incident: (payload) => record(payload, "incident"),
  });

  function applyStatus(status) {
    if (status && typeof status === "object") {
      state.status = { ...status, ...(state.status.transportError ? { transportError: true } : {}) };
    }
  }

  async function refreshStatus() {
    if (!state.enabled || disposed) return;
    try {
      const result = await send("getTreeDebugStatus");
      if (state.enabled && !disposed && result?.ok) applyStatus(result.status);
    } catch { /* 诊断失败不得打断正常侧边栏操作。 */ }
  }

  function setConfig(config) {
    const enabled = Boolean(config?.enabled);
    state.detailed = Boolean(config?.printTree);
    if (enabled === state.enabled || disposed) return;
    state.enabled = enabled;
    state.generation += 1;
    monitor.clear();
    cleanupRemoved();
    cleanupRemoved = () => {};
    incidentSignatures.clear();
    queue = [];
    queuedBytes = 0;
    if (enabled) {
      // 同一文档能跨后台实例保留真实关闭依据；监听不查询标签，也不维持后台常驻。
      const event = globalThis.chrome?.tabs?.onRemoved;
      if (event?.addListener) {
        const listener = (tabId, info) => {
          if (!state.enabled || disposed) return;
          try { monitor.noteRemoved(tabId, info); } catch { /* 诊断不阻断标签事件。 */ }
        };
        event.addListener(listener);
        cleanupRemoved = () => event.removeListener?.(listener);
      }
      void refreshStatus();
    }
  }

  const cleanupConfig = subscribeConfig((config) => { configEpoch += 1; setConfig(config); });
  const cleanupStatus = subscribeStatus(applyStatus);
  const ready = Promise.resolve(readConfig()).then((config) => {
    // storage 读取期间的新开关通知优先，不能被旧读取结果覆盖。
    if (configEpoch === 0) setConfig(config);
  }).catch(() => {});

  function correlationId() {
    return state.enabled && !disposed ? `${sourceId}:${++requestSeq}` : null;
  }

  function record(payload, kind = "event") {
    if (!state.enabled || disposed) return;
    try {
      const originalBytes = bytes(payload);
      const limits = {};
      if (payload.classification === "explained" && !state.detailed) {
        const { evidence, ...summary } = payload;
        payload = { ...summary, detailOmitted: true };
      }
      let safe = safeEvidence(payload, limits);
      if (typeof payload.signature === "string") {
        // 原始签名可能含数千 id，直接截字符串会把不同异常合并；先做精确查找再赋短实例键。
        if (!incidentSignatures.has(payload.signature)) {
          if (incidentSignatures.size >= 256) incidentSignatures.delete(incidentSignatures.keys().next().value);
          incidentSignatures.set(payload.signature, `${sourceId}:incident:${++incidentSeq}`);
        }
        safe.signature = incidentSignatures.get(payload.signature);
      }
      if (Object.keys(limits).length) {
        safe.truncation = { reason: "client-field-limit", originalBytes, ...limits };
      }
      safe = { ...safe, sourceId, seq: ++seq, capturedAt: Date.now() };
      const entry = fitEvent(kind, safe, originalBytes);
      const size = bytes(entry);
      while (queue.length && queuedBytes + size > MAX_QUEUE_BYTES) {
        queuedBytes -= queue.shift().size;
        dropped += 1;
      }
      queue.push({ entry, size });
      queuedBytes += size;
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => { scheduled = false; void flush({ automatic: true }); });
      }
    } catch { /* 坏证据只影响诊断自身。 */ }
  }

  /** 同一文档最多一个发送请求；后台变慢时内存队列仍保持固定上限。 */
  function flush({ automatic = false } = {}) {
    if (inFlight) {
      // 复制可能赶上正在发送的最后一批；共享 worker 在结束前也有一次补报机会。
      if (!automatic && !lossAttempted) reportLossOnDrain = true;
      return inFlight;
    }
    if (!state.enabled || disposed || (queue.length === 0 && transportLost === 0)) return Promise.resolve();
    if (automatic && queue.length === 0) return Promise.resolve();
    lossAttempted = false;
    reportLossOnDrain = !automatic || transportLost > 0;
    inFlight = Promise.resolve().then(async () => {
      while (state.enabled && !disposed && (queue.length || (reportLossOnDrain && transportLost))) {
        const events = [];
        let batchBytes = 1024;
        const reportingLost = reportLossOnDrain && queue.length === 0 ? transportLost : 0;
        if (reportingLost) {
          // 每个 worker 至多尝试一次缺口报告。失败计数保留到下一次真实事件或显式导出，禁止自旋重试。
          reportLossOnDrain = false;
          lossAttempted = true;
          events.push({ kind: "event", payload: {
            type: "monitor-gap", source: "frontend-ipc", sourceId, seq: ++seq, capturedAt: Date.now(),
            reason: "transport-failed", transportLost: reportingLost,
          } });
        }
        while (queue.length && events.length < 64 && batchBytes + queue[0].size <= MAX_BATCH_BYTES) {
          const item = queue.shift();
          queuedBytes -= item.size;
          batchBytes += item.size;
          events.push(item.entry);
        }
        if (dropped) {
          events[0].payload.truncation = { ...events[0].payload.truncation, dropped };
          dropped = 0;
        }
        try {
          const response = await send("recordTreeDiagnostics", { events });
          if (response?.ok === false) throw new Error("diagnostic-transport-failed");
          // 只有后台真正接受报告后才清除计数；补报本身失败不算新的业务证据丢失。
          transportLost -= reportingLost;
        } catch {
          transportLost += events.length - (reportingLost ? 1 : 0);
          state.status = { ...state.status, transportError: true };
        }
      }
    }).finally(() => { inFlight = null; reportLossOnDrain = false; lossAttempted = false; });
    return inFlight;
  }

  function observe(snapshot, context = {}) {
    if (!state.enabled || disposed) return;
    try {
      monitor.observe({ ...snapshot, sourceId }, context);
    } catch { /* 采样永远不能改变正常树结构执行路径。 */ }
  }

  function gap(payload) {
    if (!state.enabled || disposed) return;
    try { monitor.gap(payload); } catch { /* 同上。 */ }
  }

  return {
    state, sourceId, ready, correlationId, record, observe, gap, flush, refreshStatus,
    dispose() {
      disposed = true;
      queue = [];
      queuedBytes = 0;
      monitor.clear();
      cleanupRemoved();
      cleanupConfig();
      cleanupStatus();
    },
  };
}

let singleton;
export function getTreeDiagnostics() {
  if (!singleton) singleton = createTreeDiagnosticClient();
  return singleton;
}

/** 两个界面的复制入口共用后台异步导出，两个界面使用同一份后台导出结果。 */
export async function copyTreeDiagnosticLog() {
  const response = await request("getTreeDebugLog");
  if (!response?.ok) throw new Error(response?.error || "诊断日志导出失败。");
  if (!response.text) throw new Error("还没有日志：请先开启诊断并复现一次。");
  await navigator.clipboard.writeText(response.text);
  return response.text.split("\n").length;
}
