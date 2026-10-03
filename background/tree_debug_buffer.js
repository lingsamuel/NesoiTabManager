// 诊断只维护有界证据，不参与业务树；存储失败时内存仍是导出的权威来源。
export const TREE_DEBUG_LIMITS = Object.freeze({
  normalCount: 800, normalBytes: 1024 * 1024, recordBytes: 128 * 1024,
  incidentCount: 4, incidentsBytes: 1024 * 1024, incidentBytes: 256 * 1024,
});
const FORMAT_VERSION = 2;
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).length;
const errorText = (error) => String(error?.message || error).slice(0, 1000);

/** 防止调用方意外传入页面内容；内容比较只应传入布尔变化标志。 */
export function sanitizeTreeDiagnostic(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replace(/(?:https?|file|ftp):\/\/[^\s"<>]+/gi, "[地址已移除]");
  if (depth > 16 || typeof value !== "object" || seen.has(value)) return "[不可序列化或层级超限]";
  seen.add(value);
  const result = Array.isArray(value) ? value.map((item) => sanitizeTreeDiagnostic(item, depth + 1, seen)) : {};
  if (!Array.isArray(value)) {
    for (const [key, item] of Object.entries(value instanceof Map ? Object.fromEntries(value) : value)) {
      if (/^(?:url|title|label|favIconUrl|pendingUrl|pageContent|html)$/i.test(key)) continue;
      result[key] = sanitizeTreeDiagnostic(item, depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}

/**
 * 旧字符串可能把标题直接接在结构行后，无法通过 URL 过滤证明安全。
 * 只认明确的数值结构语法，其余正文全部舍弃，不猜测标题边界或恢复旧正文。
 */
function restoreLegacyRecord(text) {
  const nodes = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^[ \t]*(?:\[Nesoi树·树状\][ \t]*)?#(\d+)[ \t]+idx=(-?\d+)(?=[ \t]|$)(?:[ \t]+parent(?:Id)?=(null|-?\d+)(?=[ \t]|$))?/);
    if (!match) continue;
    const id = Number(match[1]);
    const index = Number(match[2]);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(index)) continue;
    const node = { id, index };
    if (match[3] === "null") node.parentId = null;
    else if (match[3] !== undefined && Number.isSafeInteger(Number(match[3]))) node.parentId = Number(match[3]);
    nodes.push(node);
  }
  return {
    type: "legacy", metadataMissing: true, privacyRedacted: true, historyLimited: true,
    originalBytes: encoder.encode(text).length, originalRecordCount: 1, nodes,
  };
}

function boundedRecord(input, limit, onTruncated) {
  const originalBytes = bytes(input);
  if (originalBytes <= limit) return input;
  const omittedCategories = [];
  let originalNodeCount = 0;
  function prioritize(value, path = "") {
    if (Array.isArray(value)) {
      if (/(?:nodes|entries|rows)$/.test(path)) originalNodeCount += value.length;
      const retained = value.filter((item) => !(item && typeof item === "object" && item.context === true));
      if (retained.length !== value.length) omittedCategories.push(`${path}:未变化上下文(${value.length - retained.length})`);
      return retained.map((item) => prioritize(item, path));
    }
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:context|unchanged|snapshot)$/i.test(key) && typeof item !== "boolean") {
        if (Array.isArray(item)) originalNodeCount += item.length;
        omittedCategories.push(path ? `${path}.${key}` : key);
      } else result[key] = prioritize(item, path ? `${path}.${key}` : key);
    }
    return result;
  }
  const value = prioritize(input);
  const truncation = { truncated: true, originalBytes, originalNodeCount, omittedCategories,
    ...(input.type === "legacy" ? { originalBytes: input.originalBytes, serializedBytesBeforeLimit: originalBytes } : {}),
  };
  if (bytes({ ...value, ...truncation }) <= limit) {
    onTruncated();
    return { ...value, ...truncation };
  }
  // 大详情只保留受限预览，不能把截断的 JSON 伪装为完整结构证据。
  const detail = JSON.stringify(value);
  const upstreamMetadata = {};
  for (const key of ["truncation", "evidenceTruncation"]) {
    if (input[key] === undefined) continue;
    const metadataBytes = bytes(input[key]);
    upstreamMetadata[key] = metadataBytes <= Math.min(4096, Math.floor(limit / 8)) ? input[key] : { truncated: true, reason: "截断元数据超限", originalBytes: metadataBytes };
  }
  const result = {
    type: input.type, windowId: input.windowId ?? null, sourceId: input.sourceId,
    seq: input.seq, capturedAt: input.capturedAt, correlationId: input.correlationId ?? null,
    ...(input.receivedAt !== undefined ? { receivedAt: input.receivedAt } : {}),
    ...(input.identityUnavailable ? { identityUnavailable: true } : {}),
    ...(input.type === "legacy" ? { metadataMissing: true, privacyRedacted: true, historyLimited: true, originalRecordCount: input.originalRecordCount } : {}),
    ...upstreamMetadata,
    ...truncation, omittedCategories: [...omittedCategories, "详情超限"],
    detailPreview: "",
  };
  let low = 0;
  let high = detail.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    result.detailPreview = detail.slice(0, middle);
    if (bytes(result) <= limit) low = middle;
    else high = middle - 1;
  }
  result.detailPreview = detail.slice(0, low);
  onTruncated();
  return result;
}

/**
 * 创建单实例会话缓冲。read/write 必须在同步异常或浏览器 lastError 时拒绝。
 * 恢复只执行一次；revision 与 generation 分别隔离保存中新日志和清空前读取。
 */
export function createTreeDebugBuffer({ read, write, sourceId, version = "unknown", now = () => new Date().toISOString(), schedule = setTimeout, cancel = clearTimeout }) {
  let entries = [];
  let incidents = [];
  let entryBytes = [];
  let normalBytes = 2;
  let dropped = 0;
  let truncated = 0;
  let gaps = [];
  let generation = 0;
  let revision = 0;
  let persistedRevision = 0;
  let seq = 0;
  let restorePromise;
  let saving;
  let timer = null;
  let persistError = null;
  let restoreError = null;
  let lastSavedAt = null;
  const listeners = new Set();
  const dirty = () => revision !== persistedRevision;
  const status = () => ({ incidentCount: incidents.length, activeCount: incidents.filter((item) => item.status !== "recovered").length, persistError, restoreError, truncated, dropped, dirty: dirty(), gaps: gaps.slice() });
  const notify = () => { for (const listener of listeners) { try { listener(status()); } catch (_) { /* 诊断订阅者不能阻断标签操作。 */ } } };
  const normalizeGap = (item) => ({ capturedAt: String(item.capturedAt || now()).slice(0, 100), sourceId: String(item.sourceId || sourceId).slice(0, 200), reason: String(item.reason || "未知监测间断").slice(0, 512) });
  const gap = (reason) => {
    gaps.push(normalizeGap({ capturedAt: now(), sourceId, reason }));
    if (gaps.length > 40) { gaps = gaps.slice(-40); truncated++; }
  };
  const countTruncation = () => { truncated++; };
  function resetEntries(items) {
    entries = items;
    entryBytes = items.map(bytes);
    normalBytes = 2 + entryBytes.reduce((total, size) => total + size, 0) + Math.max(0, items.length - 1);
  }
  function dropOldEntries(count) {
    const removedBytes = entryBytes.splice(0, count).reduce((total, size) => total + size, 0);
    const oldCount = entries.length;
    entries.splice(0, count);
    normalBytes -= removedBytes + Math.max(0, oldCount - 1) - Math.max(0, entries.length - 1);
    dropped += oldCount - entries.length;
  }
  function trimNormal(target = TREE_DEBUG_LIMITS.normalBytes) {
    // 字节数增量维护，不能每条事件重新序列化整个 1 MiB 环形缓冲。
    while (entries.length && (entries.length > TREE_DEBUG_LIMITS.normalCount || normalBytes > target)) dropOldEntries(1);
  }
  function trimIncidents() {
    while (incidents.length > TREE_DEBUG_LIMITS.incidentCount || bytes(incidents) > TREE_DEBUG_LIMITS.incidentsBytes) {
      if (incidents.length <= 1) break;
      incidents.splice(1, 1);
      dropped++;
    }
  }
  function queueSave() {
    if (timer !== null) return;
    timer = schedule(() => { timer = null; void flush(false); }, 400);
  }
  function changed() { revision++; queueSave(); notify(); }
  function stamp(raw) {
    const event = sanitizeTreeDiagnostic(raw);
    const originalMetadataLengths = {};
    for (const [key, limit] of Object.entries({ type: 200, sourceId: 200, capturedAt: 100, receivedAt: 100, correlationId: 512 })) {
      if (typeof event[key] === "string" && event[key].length > limit) {
        originalMetadataLengths[key] = event[key].length;
        event[key] = event[key].slice(0, limit);
      }
    }
    if (Object.keys(originalMetadataLengths).length) {
      countTruncation();
      Object.assign(event, { truncated: true, originalMetadataLengths, omittedCategories: ["超长元数据"] });
    }
    return {
      ...event,
      type: typeof event.type === "string" ? event.type : "diagnostic",
      windowId: Number.isInteger(event.windowId) ? event.windowId : null,
      sourceId: typeof event.sourceId === "string" ? event.sourceId : sourceId,
      seq: Number.isSafeInteger(event.seq) ? event.seq : ++seq,
      capturedAt: typeof event.capturedAt === "string" || typeof event.capturedAt === "number" ? event.capturedAt : now(),
      correlationId: event.correlationId ?? null,
    };
  }
  function accountUpstreamCompleteness(event) {
    let incomplete = false;
    let lost = 0;
    function visit(value) {
      if (!value || typeof value !== "object") return;
      if (value.truncated === true || value.identityUnavailable === true || value.incomplete === true ||
          (value.truncation && typeof value.truncation === "object" && Object.keys(value.truncation).length)) incomplete = true;
      for (const [key, item] of Object.entries(value)) {
        if (["dropped", "transportLost", "transportLoss"].includes(key) && Number.isSafeInteger(item) && item > 0) {
          lost += item;
          incomplete = true;
        }
        if (item && typeof item === "object") visit(item);
      }
    }
    visit(event);
    if (incomplete) countTruncation();
    dropped += lost;
    return incomplete;
  }
  function record(event) {
    const safeEvent = sanitizeTreeDiagnostic(event);
    const incomplete = accountUpstreamCompleteness(safeEvent);
    const item = boundedRecord(stamp({ ...safeEvent, ...(incomplete ? { truncated: true } : {}) }), TREE_DEBUG_LIMITS.recordBytes, countTruncation);
    const size = bytes(item);
    normalBytes += size + (entries.length ? 1 : 0);
    entries.push(item);
    entryBytes.push(size);
    trimNormal();
    if (/gap|interruption/.test(item.type)) gap(item.reason || item.type);
    for (const incident of incidents) {
      if (incident.status !== "recovered" && relatedTo(item, incident)) {
        incident.relatedEvents = [...incident.relatedEvents, boundedRecord(item, 2048, countTruncation)];
        if (incident.relatedEvents.length > 8) {
          incident.relatedEvents.splice(4, incident.relatedEvents.length - 8);
          incident.relatedEventsTruncated = true;
          countTruncation();
        }
        incident.missingAfterEvents = false;
      }
    }
    changed();
    return item;
  }
  function relatedTo(event, incident) {
    return event.windowId === incident.windowId && (!incident.correlationId || event.correlationId === incident.correlationId);
  }
  function normalizeIncident(raw) {
    const originalSignature = String(raw.signature || "incident");
    const signatureBytes = bytes(originalSignature);
    // 无法容纳身份时宁可不合并，也不能用截断前缀或有碰撞风险的摘要冒充精确身份。
    const identityUnavailable = Boolean(raw.identityUnavailable) || signatureBytes > 48 * 1024;
    const item = {
      signature: identityUnavailable ? `identity-unavailable:${sourceId}:${++seq}` : originalSignature,
      type: String(raw.type || "incident").slice(0, 200), windowId: Number.isInteger(raw.windowId) ? raw.windowId : null,
      ids: (Array.isArray(raw.ids) ? raw.ids : []).filter(Number.isInteger).slice(0, 256),
      sourceId: String(raw.sourceId || sourceId).slice(0, 200), seq: Number.isSafeInteger(raw.seq) ? raw.seq : ++seq,
      capturedAt: typeof raw.capturedAt === "number" ? raw.capturedAt : String(raw.capturedAt || now()).slice(0, 100),
      ...(raw.receivedAt !== undefined ? { receivedAt: typeof raw.receivedAt === "number" ? raw.receivedAt : String(raw.receivedAt).slice(0, 100) } : {}),
      firstSeen: typeof raw.firstSeen === "number" ? raw.firstSeen : String(raw.firstSeen || now()).slice(0, 100),
      lastSeen: typeof raw.lastSeen === "number" ? raw.lastSeen : String(raw.lastSeen || now()).slice(0, 100),
      count: Number(raw.count) || 1, status: ["active", "pending", "recovered"].includes(raw.status) ? raw.status : "active",
      correlationId: typeof raw.correlationId === "string" ? raw.correlationId.slice(0, 512) : null,
      relatedEvents: (Array.isArray(raw.relatedEvents) ? raw.relatedEvents : []).slice(-8).map((event) => boundedRecord(event, 2048, countTruncation)),
      relatedEventsTruncated: Boolean(raw.relatedEventsTruncated),
      missingBeforeEvents: raw.missingBeforeEvents !== false, missingAfterEvents: raw.missingAfterEvents !== false,
      identityUnavailable, originalSignatureBytes: signatureBytes,
      originalIdCount: Number.isSafeInteger(raw.originalIdCount) ? raw.originalIdCount : raw.ids?.length || 0,
    };
    // 为后续事件预留 16 KiB，详情预算扣除真实签名/节点身份开销。
    const detailLimit = Math.min(TREE_DEBUG_LIMITS.recordBytes - 8192, Math.floor((TREE_DEBUG_LIMITS.incidentBytes - bytes({ ...item, relatedEvents: [] }) - 18 * 1024) / 2));
    item.firstEvidence = boundedRecord(raw.firstEvidence || { missing: true }, detailLimit, countTruncation);
    item.latestEvidence = boundedRecord(raw.latestEvidence || { missing: true }, detailLimit, countTruncation);
    item.truncated = Boolean(raw.truncated || identityUnavailable || item.originalIdCount > item.ids.length || item.firstEvidence.truncated || item.latestEvidence.truncated || item.relatedEventsTruncated);
    if (identityUnavailable || item.originalIdCount > item.ids.length) countTruncation();
    return item;
  }
  function incident(raw) {
    const event = sanitizeTreeDiagnostic(raw);
    const signature = String(event.signature || `${event.windowId}:${event.type}:${(event.ids || []).join(",")}`);
    const existingIndex = incidents.findIndex((item) => !event.identityUnavailable && !item.identityUnavailable && item.signature === signature && item.windowId === (event.windowId ?? null) && item.status !== "recovered");
    const existing = incidents[existingIndex];
    if (!existing && event.status === "recovered") return null;
    const incomplete = accountUpstreamCompleteness(event);
    // 来源时间和序号来自实际采集方，不能在包装异常包时冒充后台刚采集的新证据。
    const origin = Object.fromEntries(["sourceId", "seq", "capturedAt", "receivedAt"].filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
    const evidence = stamp({
      ...(event.evidence || {}), type: event.type, windowId: event.windowId, ...origin,
      ...(event.truncation ? { truncation: event.truncation, ...(event.evidence?.truncation ? { evidenceTruncation: event.evidence.truncation } : {}) } : {}),
      ...(event.identityUnavailable ? { identityUnavailable: true } : {}),
      ...(incomplete ? { truncated: true } : {}),
    });
    const correlationId = event.correlationId || event.evidence?.observation?.correlationId || existing?.correlationId || null;
    const relatedEvents = existing?.relatedEvents || entries.filter((item) => relatedTo(item, { windowId: event.windowId ?? null, correlationId })).slice(-8);
    const item = normalizeIncident({
      ...(existing || { ...origin, firstSeen: evidence.capturedAt }), signature, type: event.type, windowId: event.windowId, ids: event.ids || [], correlationId,
      identityUnavailable: Boolean(event.identityUnavailable || existing?.identityUnavailable),
      firstEvidence: existing?.firstEvidence || evidence, latestEvidence: evidence,
      count: (existing?.count || 0) + 1, lastSeen: evidence.capturedAt, status: event.status,
      relatedEvents, missingBeforeEvents: existing?.missingBeforeEvents ?? relatedEvents.length === 0,
      missingAfterEvents: existing?.missingAfterEvents ?? true,
    });
    if (existing) incidents[existingIndex] = item;
    else incidents.push(item);
    trimIncidents();
    changed();
    return item;
  }
  function load() {
    if (restorePromise) return restorePromise;
    const readGeneration = generation;
    restorePromise = (async () => {
      try {
        const stored = await read();
        if (generation !== readGeneration) return entries.length;
        const previous = Array.isArray(stored) ? stored.filter((item) => typeof item === "string").map((text) => ({ type: "legacy", text })) : stored?.entries;
        if (Array.isArray(previous)) {
          const restored = previous.filter((item) => item && typeof item === "object").map((item) => {
            if (item.type === "legacy" && typeof item.text === "string") {
              item = restoreLegacyRecord(item.text);
              countTruncation();
            }
            return boundedRecord(sanitizeTreeDiagnostic(item), TREE_DEBUG_LIMITS.recordBytes, countTruncation);
          });
          resetEntries([...restored, ...entries]);
          if (!Array.isArray(stored)) {
            const savedIncidents = Array.isArray(stored.incidents) ? stored.incidents : [];
            // 旧实例未完成的异常不自动视为恢复，后续观测负责确认。
            incidents = [...savedIncidents.filter((item) => item && typeof item === "object").map((item) => normalizeIncident(sanitizeTreeDiagnostic(item))), ...incidents];
            dropped += Number(stored.dropped) || 0;
            truncated += Number(stored.truncated) || 0;
            gaps = [...(Array.isArray(stored.gaps) ? stored.gaps.filter((item) => item && typeof item === "object").map(normalizeGap) : []), ...gaps].slice(-40);
          }
          trimNormal();
          trimIncidents();
          gap("后台实例重新启动，旧实例结束至当前基线重建之间的观测不完整");
          changed();
        }
      } catch (error) {
        if (generation === readGeneration) {
          restoreError = errorText(error);
          gap("会话日志恢复失败，历史证据不可用");
          changed();
        }
      }
      notify();
      return entries.length;
    })();
    return restorePromise;
  }
  const snapshot = () => ({ formatVersion: FORMAT_VERSION, entries: structuredClone(entries), incidents: structuredClone(incidents), dropped, truncated, gaps: structuredClone(gaps) });
  async function saveOnce() {
    const savingRevision = revision;
    try {
      await write(snapshot());
      persistedRevision = savingRevision;
      persistError = null;
      lastSavedAt = now();
      return true;
    } catch (error) {
      persistError = errorText(error);
      if (/quota|QUOTA_BYTES/i.test(persistError)) {
        const removed = Math.ceil(entries.length / 2);
        dropOldEntries(removed);
        revision++;
        const retryRevision = revision;
        try {
          await write(snapshot());
          persistedRevision = retryRevision;
          persistError = null;
          lastSavedAt = now();
          return true;
        } catch (retryError) { persistError = errorText(retryError); }
      }
      return false;
    }
  }
  async function flush(drain = true) {
    await load();
    if (timer !== null) { cancel(timer); timer = null; }
    if (saving) {
      const succeeded = await saving;
      // 等待者重新竞争同一保存锁，避免多个导出在旧写完成后同时发起新写。
      if (!drain) return succeeded;
      return flush(true);
    }
    if (!dirty()) return true;
    saving = (async () => {
      let succeeded;
      do { succeeded = await saveOnce(); } while (succeeded && drain && dirty());
      return succeeded;
    })();
    const succeeded = await saving;
    saving = null;
    if (succeeded && dirty()) queueSave();
    notify();
    return succeeded;
  }
  function text() {
    const times = [...entries.map((item) => item.capturedAt), ...incidents.flatMap((item) => [item.firstSeen, item.lastSeen])].filter((value) => value !== undefined && value !== null).map((value) => typeof value === "number" ? value : Date.parse(value)).filter(Number.isFinite).sort((a, b) => a - b).map((value) => new Date(value).toISOString());
    const header = { extensionVersion: version, formatVersion: FORMAT_VERSION, timeRange: [times[0] || null, times.at(-1) || null], bufferBytes: { normal: normalBytes, incidents: bytes(incidents), metadata: bytes({ dropped, truncated, gaps }) }, ...status(), lastSavedAt, sessionStorageOnly: true, historyLimited: entries.some((item) => item.historyLimited), incidentSummary: incidents.map(({ signature, count, status, firstSeen, lastSeen, truncated }) => ({ signature, count, status, firstSeen, lastSeen, truncated })) };
    return [`Nesoi 树结构诊断日志\n${JSON.stringify(header, null, 2)}`, "--- 普通记录 ---", ...entries.map((item) => JSON.stringify(item)), "--- 异常记录包 ---", ...incidents.map((item) => JSON.stringify(item))].join("\n");
  }
  async function clear() {
    generation++;
    resetEntries([]); incidents = []; dropped = 0; truncated = 0; gaps = [];
    restoreError = null; persistError = null;
    changed();
    await flush();
  }
  return { load, record, incident, status, text, clear, flush, exportText: async () => { await load(); await flush(); return text(); }, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
}
