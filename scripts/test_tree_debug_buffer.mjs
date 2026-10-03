import assert from "node:assert/strict";

let restore;
globalThis.chrome = {
  storage: {
    local: { get: (_key, callback) => callback({}) },
    session: { get: (_key, callback) => { restore = callback; }, set: (_value, callback) => callback() },
  },
  runtime: { getManifest: () => ({ version: "test" }) },
};
const debug = await import("../background/tree_debug.js");
debug.applyTreeDebugConfig({ enabled: true });
const loading = debug.loadTreeDebugLog();
debug.logFlow("during-restore");
restore({ treeDebugLog: ["old-record"] });
await loading;
assert.match(debug.getTreeDebugLogText(), /during-restore/, "恢复不能覆盖正在采集的新记录");
console.log("tree debug restore race: passed");

const { createTreeDebugBuffer, TREE_DEBUG_LIMITS } = await import("../background/tree_debug_buffer.js");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(options = {}) {
  const writes = [];
  const buffer = createTreeDebugBuffer({
    read: async () => undefined,
    write: async (value) => { writes.push(structuredClone(value)); },
    schedule: () => 1,
    cancel: () => {},
    sourceId: "test-source",
    version: "test-version",
    ...options,
  });
  return { buffer, writes };
}
{
  let release;
  let reads = 0;
  const { buffer } = fixture({ read: () => { reads++; return new Promise((resolve) => { release = resolve; }); } });
  const one = buffer.load();
  const two = buffer.load();
  buffer.record({ type: "new", windowId: 1 });
  release(["legacy"]);
  await Promise.all([one, two]);
  assert.equal(reads, 1);
  assert.match(await buffer.exportText(), /metadataMissing/);
  assert.match(buffer.text(), /new/);
  assert.match(buffer.text(), /metadataMissing/);
}
{
  let release;
  const { buffer, writes } = fixture({ read: () => new Promise((resolve) => { release = resolve; }) });
  const loading = buffer.load();
  const clearing = buffer.clear();
  buffer.record({ type: "after-clear", windowId: 1 });
  release(["must-not-return"]);
  await Promise.all([loading, clearing]);
  assert.doesNotMatch(await buffer.exportText(), /must-not-return/);
  assert.match(buffer.text(), /after-clear/);
  assert.ok(writes.length);
}
{
  let finish;
  const writes = [];
  const { buffer } = fixture({ write: async (value) => { writes.push(structuredClone(value)); if (writes.length === 1) await new Promise((resolve) => { finish = resolve; }); } });
  buffer.record({ type: "first" });
  const saving = buffer.flush();
  await tick();
  buffer.record({ type: "second" });
  assert.equal(buffer.status().dirty, true);
  finish();
  await saving;
  assert.match(JSON.stringify(writes.at(-1)), /second/);
  assert.equal(buffer.status().dirty, false);
}
{
  let calls = 0;
  const { buffer } = fixture({ write: async () => { calls++; throw new Error("QUOTA_BYTES exceeded"); } });
  for (let id = 0; id < 8; id++) buffer.record({ type: "quota", id });
  const output = await buffer.exportText();
  assert.equal(calls, 2, "配额仅重试一次");
  assert.ok(buffer.status().persistError);
  assert.equal(buffer.status().dirty, true);
  assert.ok(buffer.status().dropped > 0);
  assert.match(output, /quota/);
}
{
  const { buffer } = fixture({ read: async () => { throw new Error("read failed"); }, write: async () => { throw new Error("write failed"); } });
  buffer.record({ type: "in-memory" });
  const output = await buffer.exportText();
  assert.match(output, /read failed/);
  assert.match(output, /write failed/);
  assert.match(output, /in-memory/);
  assert.ok(buffer.status().gaps.length);
}
{
  const { buffer, writes } = fixture();
  for (let id = 0; id < 805; id++) buffer.record({ type: "ordinary", id });
  buffer.record({ type: "large", nodes: Array.from({ length: 30000 }, (_, id) => ({ id, parentId: id - 1 })), title: "private-title", url: "https://private.example" });
  await buffer.flush();
  const stored = writes.at(-1);
  assert.ok(stored.entries.length <= 800);
  assert.ok(Buffer.byteLength(JSON.stringify(stored.entries)) <= TREE_DEBUG_LIMITS.normalBytes);
  assert.ok(stored.entries.every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= TREE_DEBUG_LIMITS.recordBytes));
  assert.ok(buffer.status().truncated > 0);
  assert.ok(buffer.status().dropped >= 5);
  assert.doesNotMatch(buffer.text(), /private-title|private.example/);
}
{
  const { buffer, writes } = fixture();
  buffer.incident({ signature: "same", type: "order", windowId: 1, ids: [1, 2], evidence: { label: "first" }, status: "active" });
  buffer.incident({ signature: "same", type: "order", windowId: 1, ids: [1, 2], evidence: { label: "latest" }, status: "active" });
  assert.equal(buffer.status().incidentCount, 1);
  assert.match(buffer.text(), /first/);
  assert.match(buffer.text(), /latest/);
  buffer.incident({ signature: "same", type: "order", windowId: 1, ids: [1, 2], evidence: {}, status: "recovered" });
  assert.equal(buffer.status().activeCount, 0);
  for (let id = 0; id < 6; id++) buffer.incident({ signature: `new-${id}`, type: "order", ids: [id], evidence: { nodes: Array.from({ length: 12000 }, (_, index) => ({ id: index })) }, status: "active" });
  await buffer.flush();
  assert.equal(buffer.status().incidentCount, 4);
  assert.equal(writes.at(-1).incidents[0].signature, "same");
  assert.equal(writes.at(-1).incidents.at(-1).signature, "new-5");
  assert.ok(writes.at(-1).incidents.every((item) => Buffer.byteLength(JSON.stringify(item)) <= TREE_DEBUG_LIMITS.incidentBytes));
  assert.ok(Buffer.byteLength(JSON.stringify(writes.at(-1).incidents)) <= TREE_DEBUG_LIMITS.incidentsBytes);
}
console.log("tree debug buffer: all tests passed");
{
  const { buffer, writes } = fixture();
  const event = { signature: "cycle", type: "order", windowId: 1, ids: [1], status: "active" };
  buffer.incident({ ...event, evidence: { marker: "original-proof", nodes: Array.from({ length: 20000 }, (_, id) => ({ id })) } });
  buffer.incident({ ...event, evidence: { marker: "latest-proof", nodes: Array.from({ length: 20000 }, (_, id) => ({ id })) } });
  assert.match(buffer.text(), /original-proof/);
  assert.match(buffer.text(), /latest-proof/);
  buffer.incident({ ...event, status: "recovered", evidence: {} });
  buffer.incident({ ...event, evidence: {} });
  assert.equal(buffer.status().incidentCount, 2);
  await buffer.flush();
  assert.ok(writes.at(-1).incidents.every((item) => Buffer.byteLength(JSON.stringify(item)) <= TREE_DEBUG_LIMITS.incidentBytes));
}
{
  let release;
  let concurrent = 0;
  let maximum = 0;
  let calls = 0;
  const { buffer } = fixture({ write: async () => {
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    calls++;
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    else await tick();
    concurrent--;
  } });
  buffer.record({ type: "start" });
  const first = buffer.flush(false);
  await tick();
  const second = buffer.exportText();
  const third = buffer.exportText();
  buffer.record({ type: "end" });
  release();
  await Promise.all([first, second, third]);
  assert.equal(maximum, 1, "并发导出也必须串行保存");
}
{
  const failureDebug = await import(`../background/tree_debug.js?lastError=${Date.now()}`);
  chrome.storage.session.get = (_key, callback) => callback({});
  chrome.storage.session.set = (_value, callback) => {
    chrome.runtime.lastError = { message: "storage runtime failure" };
    callback();
    delete chrome.runtime.lastError;
  };
  failureDebug.applyTreeDebugConfig({ enabled: true });
  failureDebug.recordTreeDiagnostic({ type: "memory-survives" });
  assert.match(await failureDebug.exportTreeDebugLog(), /storage runtime failure/);
  assert.equal(failureDebug.getTreeDebugStatus().dirty, true);
  chrome.storage.session.set = () => { throw new Error("synchronous failure"); };
  assert.match(await failureDebug.exportTreeDebugLog(), /synchronous failure/);
  chrome.storage.session.set = (_value, callback) => callback();
  await failureDebug.exportTreeDebugLog();
  assert.equal(failureDebug.getTreeDebugStatus().persistError, null);
  assert.equal(failureDebug.getTreeDebugStatus().dirty, false);
  failureDebug.applyTreeDebugConfig({ enabled: false });
  failureDebug.recordTreeDiagnostic({ type: "disabled-event" });
  failureDebug.recordTreeIncident({ signature: "disabled-incident" });
  assert.doesNotMatch(failureDebug.getTreeDebugLogText(), /disabled-event|disabled-incident/);
}
console.log("tree debug integration and concurrent export: passed");
{
  const { buffer, writes } = fixture();
  buffer.record({ type: "https://private.example/type", sourceId: "https://private.example/source", correlationId: "https://private.example/correlation", capturedAt: "https://private.example/time", title: "secret", payload: { title: "secret", url: "https://private.example" } });
  assert.doesNotMatch(buffer.text(), /private.example|secret/);
  for (let id = 0; id < 200; id++) buffer.record({ type: "bytes", id, detail: "汉".repeat(3000) });
  await buffer.flush();
  const stored = writes.at(-1);
  assert.ok(Buffer.byteLength(JSON.stringify(stored.entries)) <= TREE_DEBUG_LIMITS.normalBytes);
  assert.ok(stored.entries.length < 200);
  assert.ok(buffer.status().dropped > 0);
}
console.log("tree debug privacy and UTF-8 budget: passed");
{
  const { buffer, writes } = fixture();
  const huge = "长".repeat(100000);
  buffer.record({ type: huge, sourceId: huge, correlationId: huge, capturedAt: huge });
  await buffer.flush();
  assert.ok(writes.at(-1).entries.length > 0, "单条巨大元数据应有界保留，不能把整条静默淘汰");
  assert.ok(writes.at(-1).entries.every((item) => Buffer.byteLength(JSON.stringify(item)) <= TREE_DEBUG_LIMITS.recordBytes));
}
console.log("tree debug oversized metadata: passed");
{
  debug.logFlow(new Map([["tabId", 42], ["parentId", 7]]));
  assert.match(debug.getTreeDebugLogText(), /tabId/);
  debug.setTreeDebugLabelProvider(() => "private-title");
  assert.doesNotMatch(debug.formatTreeState({ entries: [{ id: 1, index: 0, parentId: null }] }), /private-title/);
}
{
  let finish;
  const writes = [];
  const { buffer } = fixture({ write: async (value) => {
    writes.push(structuredClone(value));
    if (writes.length === 1) await new Promise((resolve) => { finish = resolve; });
  } });
  buffer.record({ type: "before-clear" });
  const saving = buffer.flush(false);
  await tick();
  const clearing = buffer.clear();
  finish();
  await Promise.all([saving, clearing]);
  assert.equal(writes.at(-1).entries.length, 0);
  assert.doesNotMatch(buffer.text(), /before-clear/);
}
console.log("tree debug compatibility and clear during save: passed");
{
  let finishConfig;
  let configReads = 0;
  chrome.storage.local.get = (_key, callback) => { configReads++; finishConfig = callback; };
  const configDebug = await import(`../background/tree_debug.js?config=${Date.now()}`);
  const first = configDebug.initializeTreeDebug();
  const second = configDebug.initializeTreeDebug();
  finishConfig({ treeDebugConfig: { enabled: true, printTree: true } });
  assert.deepEqual(await first, await second, "重复初始化必须等待同一配置读取");
  assert.equal(configReads, 1);
  const raceDebug = await import(`../background/tree_debug.js?configRace=${Date.now()}`);
  const initializing = raceDebug.initializeTreeDebug();
  raceDebug.handleTreeDebugConfigChanged({ enabled: true });
  finishConfig({ treeDebugConfig: { enabled: false } });
  await initializing;
  assert.equal(raceDebug.isTreeDebugEnabled(), true, "旧配置读取不能覆盖配置变更事件");
  chrome.storage.local.set = (_value, callback) => {
    chrome.runtime.lastError = { message: "config write failed" };
    callback();
    delete chrome.runtime.lastError;
  };
  await assert.rejects(raceDebug.saveTreeDebugConfig({ printTree: true }), /config write failed/);
  assert.equal(raceDebug.isTreeDebugPrintEnabled(), true, "保存失败仍保留当前实际采用的内存配置");
  raceDebug.recordTreeDiagnostic({ type: "received", sourceId: "frontend", receivedAt: "known-receive-time" });
  assert.match(raceDebug.getTreeDebugLogText(), /known-receive-time/);
}
console.log("tree debug config races and errors: passed");
{
  const { buffer, writes } = fixture();
  buffer.record({ type: "operation-start", windowId: 7, correlationId: "operation-7" });
  const longSignature = "s".repeat(2000);
  buffer.incident({ signature: `${longSignature}a`, windowId: 7, type: "order", evidence: { observation: { correlationId: "operation-7" } } });
  buffer.incident({ signature: `${longSignature}b`, windowId: 7, type: "order", evidence: {} });
  buffer.record({ type: "operation-end", windowId: 7, correlationId: "operation-7" });
  await buffer.flush();
  assert.equal(buffer.status().incidentCount, 2, "长签名共同前缀不能误合并");
  assert.match(JSON.stringify(writes.at(-1).incidents[0].relatedEvents), /operation-start/);
  assert.match(JSON.stringify(writes.at(-1).incidents[0].relatedEvents), /operation-end/);
  assert.equal(writes.at(-1).incidents[0].missingBeforeEvents, false);
  assert.equal(writes.at(-1).incidents[0].missingAfterEvents, false);
}
{
  const { buffer, writes } = fixture();
  buffer.record({ type: "nested-large", evidence: { nodes: [
    ...Array.from({ length: 10000 }, (_, id) => ({ id, context: true, detail: "x".repeat(30) })),
    { id: 10001, context: false, changes: ["parent"], marker: "must-retain-change" },
  ] } });
  await buffer.flush();
  const item = writes.at(-1).entries[0];
  assert.equal(item.originalNodeCount, 10001);
  assert.equal(item.evidence.nodes.length, 1);
  assert.equal(item.evidence.nodes[0].marker, "must-retain-change");
  assert.ok(item.truncated);
}
{
  const { buffer, writes } = fixture({ read: async () => ({ entries: [], incidents: [{ signature: "old", type: "order", windowId: 1, status: "active", firstEvidence: { huge: "x".repeat(2000000) }, latestEvidence: { huge: "x".repeat(2000000) } }] }) });
  await buffer.exportText();
  assert.ok(Buffer.byteLength(JSON.stringify(writes.at(-1).incidents[0])) <= TREE_DEBUG_LIMITS.incidentBytes);
  assert.ok(buffer.status().truncated > 0);
}
{
  const { buffer } = fixture();
  buffer.record({ type: "earlier", capturedAt: 1000 });
  buffer.record({ type: "later", capturedAt: "2026-01-01T00:00:00.000Z" });
  const header = JSON.parse(buffer.text().split("\n").slice(1).join("\n").split("\n--- 普通记录 ---")[0]);
  assert.deepEqual(header.timeRange, ["1970-01-01T00:00:01.000Z", "2026-01-01T00:00:00.000Z"]);
}
console.log("tree debug retained incident evidence and restoration limits: passed");
{
  const { buffer, writes } = fixture();
  buffer.record({ type: "client-event", truncation: { reason: "client-field-limit", omittedItems: 1872, dropped: 3, transportLost: 2 } });
  assert.ok(buffer.status().truncated > 0, "上游截断必须进入可见状态");
  assert.equal(buffer.status().dropped, 5, "排队与传输丢失必须进入累计状态");
  buffer.incident({ signature: "client-order", windowId: 3, type: "order-change", ids: [1, 2], status: "pending",
    sourceId: "client-1", seq: 41, capturedAt: 1000, receivedAt: 1100,
    truncation: { reason: "client-field-limit", omittedItems: 1872 }, evidence: { nodes: [{ id: 1 }], totalAfter: 2000 } });
  buffer.incident({ signature: "client-order", windowId: 3, type: "order-change", ids: [1, 2], status: "pending",
    sourceId: "client-1", seq: 42, capturedAt: 2000, receivedAt: 2100,
    truncation: { reason: "client-event-limit", transportLost: 4 }, evidence: { nodes: [{ id: 2 }] } });
  await buffer.flush();
  const item = writes.at(-1).incidents[0];
  assert.equal(item.truncated, true);
  assert.equal(item.firstEvidence.truncation.omittedItems, 1872);
  assert.equal(item.latestEvidence.truncation.transportLost, 4);
  assert.equal(item.firstEvidence.sourceId, "client-1");
  assert.equal(item.firstEvidence.seq, 41);
  assert.equal(item.firstEvidence.capturedAt, 1000);
  assert.equal(item.firstEvidence.receivedAt, 1100);
  assert.equal(item.latestEvidence.seq, 42);
  assert.equal(item.latestEvidence.capturedAt, 2000);
  assert.equal(item.latestEvidence.receivedAt, 2100);
  assert.equal(item.sourceId, "client-1");
  assert.equal(item.seq, 41);
  assert.equal(item.capturedAt, 1000);
  assert.equal(item.receivedAt, 1100);
  assert.equal(buffer.status().dropped, 9);
  buffer.incident({ signature: "unknown-identity", type: "order-change", status: "pending", identityUnavailable: true, evidence: {} });
  buffer.incident({ signature: "unknown-identity", type: "order-change", status: "pending", identityUnavailable: true, evidence: {} });
  await buffer.flush();
  const incomplete = writes.at(-1).incidents.slice(-2);
  assert.equal(incomplete.length, 2);
  assert.ok(incomplete.every((incident) => incident.identityUnavailable && incident.firstEvidence.identityUnavailable && incident.truncated));
}
console.log("tree debug upstream completeness and client origin: passed");
{
  const { buffer, writes } = fixture();
  buffer.incident({ signature: "large-client", type: "order-change", status: "pending", sourceId: "client-large", seq: 77, capturedAt: 100, receivedAt: 200,
    identityUnavailable: true, truncation: { reason: "client-event-limit", omittedItems: 15 },
    evidence: { nodes: Array.from({ length: 30000 }, (_, id) => ({ id, changes: ["parent"] })) } });
  await buffer.flush();
  const evidence = writes.at(-1).incidents[0].firstEvidence;
  assert.equal(evidence.receivedAt, 200, "本地二次截断仍应保留接收时刻");
  assert.equal(evidence.truncation.reason, "client-event-limit", "本地二次截断不能擦除上游边界");
  assert.equal(evidence.identityUnavailable, true);
}
console.log("tree debug nested truncation metadata: passed");
{
  const oldLines = [
    "[Nesoi树·树状] #7 idx=6 私人医疗检查结果",
    "[Nesoi树·树状] 关闭前\n  #8 idx=7 parentId=7 私人地址\n    #9 idx=8 私人账户",
    "无法识别的私人正文 https://private.example",
  ];
  const { buffer, writes } = fixture({ read: async () => oldLines });
  buffer.record({ type: "new-during-private-restore", windowId: 1 });
  const output = await buffer.exportText();
  assert.doesNotMatch(output, /私人|private.example|无法识别/);
  assert.match(output, /new-during-private-restore/);
  const legacy = writes.at(-1).entries.filter((entry) => entry.type === "legacy");
  assert.equal(legacy.length, oldLines.length, "每条旧记录应有对应的隐私受限占位，保留数量");
  assert.ok(legacy.every((entry) => entry.metadataMissing && entry.privacyRedacted && entry.historyLimited));
  assert.deepEqual(legacy[0].nodes, [{ id: 7, index: 6 }]);
  assert.deepEqual(legacy[1].nodes, [{ id: 8, index: 7, parentId: 7 }, { id: 9, index: 8 }]);
  assert.deepEqual(legacy[2].nodes, []);
  assert.equal(legacy[0].originalBytes, Buffer.byteLength(oldLines[0]));
  assert.equal(legacy[0].originalRecordCount, 1);
}
{
  const { buffer } = fixture({ read: async () => ({ entries: [{ type: "legacy", metadataMissing: true, text: "#12 idx=0 私人旧格式包装" }] }) });
  assert.doesNotMatch(await buffer.exportText(), /私人旧格式包装/);
}
console.log("tree debug legacy privacy: passed");
{
  const text = Array.from({ length: 10000 }, (_, id) => `#${id} idx=${id} 私人标题`).join("\n");
  const { buffer, writes } = fixture({ read: async () => [text] });
  const exported = await buffer.exportText();
  const legacy = writes.at(-1).entries[0];
  assert.equal(legacy.privacyRedacted, true);
  assert.equal(legacy.metadataMissing, true);
  assert.equal(legacy.historyLimited, true);
  assert.equal(legacy.originalBytes, Buffer.byteLength(text));
  assert.equal(legacy.originalRecordCount, 1);
  assert.doesNotMatch(exported, /私人标题/);
}
console.log("tree debug oversized legacy privacy: passed");
