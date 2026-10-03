// IPC 只接收扩展页面的有界诊断元数据；采集时刻与后台收到时刻分别保留。
const MAX_BATCH_BYTES = 96 * 1024;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_EVENTS = 64;
const encoder = new TextEncoder();
// 白名单同时防止页面内容意外进入日志。新增诊断字段必须显式审查。
const fields = new Set(`firstEvidence latestEvidence fromRevision toRevision truncatedStrings omittedItems depthLimited transportLost originalNodeCount omittedCategories removedFields originalLength incompleteFields
  success sameInstance parentCount changedCount observation operations revisionBefore depthSource position expectedParentId
  type source sourceId sourceToken instanceToken seq capturedAt receivedAt at windowId correlationId
  signature status ids evidence classification phase reason revision revisionToken knownRevision incomingRevision knownToken incomingToken
  requestId requestSequence queryEpoch currentEpoch epoch aligned registered focusIds expectedParentIds expectedOrderIds expectedParents
  token decision accepted applied rejected failed pending recovered firstAt lastAt count occurrences priorEvidence laterEvidence
  nodes shifts omitted totalBefore totalAfter orderChanges issues before after changes context id parentId parentExists index depth
  titleChanged urlChanged contentChanged added removed parentChanged depthChanged indexChanged orderChanged indexSource
  oldIndex newIndex delta fromIndex toIndex start end firstId lastId beforeStart beforeEnd afterStart afterEnd
  previousId nextId beforePreviousId beforeNextId afterPreviousId afterNextId childId actual expected parentIds childIds
  indexBefore indexAfter startId endId missing extra duplicate cycle members size total totalNodes detailedNodes
  omittedCount shiftedCount unchangedCount originalCount omittedNodes truncated truncation dropped details detailOmitted
  filterMode filterActive collapsedCount pinnedCount visibleCount completeCount hidden collectionChanged missingBefore missingAfter
  kind code messageKeys constraints observations baseline first latest result request response backend frontend
  parent beforeParent afterParent duplicates from to length scope operation boundary baselineMissing originalBytes
  restored gap gaps projection revisionByWindow revisions windowIds sourceSequence sourceInstance errorCode
  responseRevision responseToken localRevision localToken queryStartedAt queryCompletedAt requestCapturedAt
  alignedEpoch eventEpoch appliedRevision appliedToken stale displayState filter collapsed pinned
  cycleIds relatedIds missingParentId parentIdBefore parentIdAfter uncertain comparison recoveredAt explanation
  order relativeOrder ordinal beforeOrdinal afterOrdinal oldPrevious oldNext newPrevious newNext direction
  structuralChanged orderOnly signatureIds baselineAt currentAt incomplete byteLimit omittedFields missingEvidence
  previousSourceToken baselinePreserved
`.split(/\s+/).filter(Boolean));

function sanitize(value, depth = 0) {
  if (depth > 12) return { truncated: true, reason: 'ipc-depth-limit' };
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length <= 512 ? value : `${value.slice(0, 480)}…[截断]`;
  if (Array.isArray(value)) return value.slice(0, 256).map(item => sanitize(item, depth + 1));
  if (typeof value !== 'object') return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (fields.has(key)) result[key] = sanitize(item, depth + 1);
  }
  return result;
}

/** 返回接收统计；拒绝或超限也留明确间断，不将不完整批次伪装成完整现场。 */
export function createDiagnosticReceiver({ enabled, emit, incident, extensionRoot }) {
  return (events, sender = {}) => {
    if (!enabled() || typeof sender.url !== 'string' || !sender.url.startsWith(`${extensionRoot}ui/`)) {
      return { accepted: 0, rejected: Array.isArray(events) ? events.length : 0 };
    }
    let bytes;
    try { bytes = encoder.encode(JSON.stringify(events)).length; } catch (_) { bytes = Infinity; }
    if (!Array.isArray(events) || events.length > MAX_EVENTS || bytes > MAX_BATCH_BYTES) {
      emit({ type: 'monitor-gap', source: 'frontend-ipc', reason: 'batch-rejected', originalBytes: bytes, truncated: true });
      return { accepted: 0, rejected: Array.isArray(events) ? events.length : 1 };
    }
    let accepted = 0;
    for (const item of events) {
      if (!['event', 'incident'].includes(item?.kind) || !item.payload || typeof item.payload.type !== 'string' ||
          item.payload.type.length > 128 || encoder.encode(JSON.stringify(item)).length > MAX_EVENT_BYTES) continue;
      const payload = sanitize(item.payload);
      payload.receivedAt = Date.now();
      if (item.kind === 'incident') {
        if (typeof payload.signature !== 'string' || !['active', 'recovered', 'pending'].includes(payload.status)) continue;
        incident(payload);
      } else {
        emit(payload);
      }
      accepted += 1;
    }
    const rejected = events.length - accepted;
    if (rejected) emit({ type: 'monitor-gap', source: 'frontend-ipc', reason: 'records-rejected', dropped: rejected });
    return { accepted, rejected };
  };
}
