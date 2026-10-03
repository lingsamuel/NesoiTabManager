import assert from 'node:assert/strict';
const storageListeners = [];
const businessMessages = [];
const removedListeners = new Set();
let treeResponse = { ok: true, structures: {} };
globalThis.chrome = {
  tabs: { onRemoved: { addListener: fn => removedListeners.add(fn), removeListener: fn => removedListeners.delete(fn) } },
  runtime: { sendMessage(message, callback) {
    businessMessages.push(message);
    callback(message.action === 'getTreeStructure' ? treeResponse : { ok: true, status: {} });
  } },
  storage: {
    local: { get(key, callback) { callback({ [key]: { enabled: true } }); } },
    session: { get(_key, callback) { callback({}); }, set(_value, callback) { callback?.(); } },
    onChanged: { addListener(listener) { storageListeners.push(listener); }, removeListener() {} },
  },
};
const { createTreeDiagnosticClient, getTreeDiagnostics } = await import('../src/manager/utils/tree_diagnostics.js');

const sent = [];
let configListener;
let resolveConfig;
const client = createTreeDiagnosticClient({
  send: async (action, payload = {}) => { sent.push({ action, ...payload }); return { ok: true }; },
  readConfig: () => new Promise((resolve) => { resolveConfig = resolve; }),
  subscribeConfig: (listener) => { configListener = listener; return () => {}; },
  subscribeStatus: () => () => {},
});
resolveConfig({ enabled: false });
await client.ready;
client.record({ type: 'disabled' });
client.observe({ windowId: 1, source: 'rows', entries: [{ id: 1 }] });
await client.flush();
assert.equal(sent.length, 0, '关闭时没有诊断 IPC');
assert.equal(client.correlationId(), null);
configListener({ enabled: true });
assert.equal(removedListeners.size, 1, '启用诊断后监听前端实际关闭事件');
const correlationId = client.correlationId();
assert.ok(correlationId);
client.record({ type: 'request', correlationId, title: '私密标题', nested: { url: 'https://private.invalid' } });
await client.flush();
const events = sent.filter((entry) => entry.action === 'recordTreeDiagnostics').flatMap((entry) => entry.events);
assert.ok(events.length);
assert.equal(JSON.stringify(events).includes('私密'), false);
assert.equal(JSON.stringify(events).includes('private.invalid'), false);
assert.equal(events[0].payload.sourceId, client.sourceId);
assert.ok(events[0].payload.seq > 0);
assert.ok(events[0].payload.capturedAt > 0);
for (let i = 0; i < 400; i += 1) client.record({ type: 'large', values: Array.from({ length: 4000 }, (_, id) => ({ id, reason: 'x'.repeat(300) })) });
await client.flush();
for (const batch of sent.filter((entry) => entry.action === 'recordTreeDiagnostics')) {
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 128 * 1024, '诊断消息不得超出 128 KiB');
}
assert.ok(sent.some((batch) => JSON.stringify(batch).includes('truncation')), '局部记录截断必须明确标记');
client.observe({ windowId: 1, source: 'rows', sourceToken: 'old-background',
  entries: [{ id: 1, index: 0 }, { id: 2, index: 1, parentId: 1 }, { id: 3, index: 2, parentId: 1 }] }, { aligned: true });
client.observe({ windowId: 1, source: 'rows', sourceToken: 'new-background',
  entries: [{ id: 2, index: 0 }, { id: 3, index: 1 }] }, { aligned: true });
await client.flush();
assert.ok(sent.some((batch) => batch.events?.some((event) => event.kind === 'incident' && event.payload.type === 'parent-change')),
  '真实前端客户端在后台实例切换后必须发送局部改父异常');
const removalSnapshot = (pairs, token) => ({ windowId: 22, source: 'rows', sourceToken: token,
  parentById: new Map(pairs), physicalOrderIds: pairs.map(([id]) => id),
  entries: pairs.map(([id,parentId],index) => ({id,parentId,index})) });
client.observe(removalSnapshot([[10,null],[11,10],[12,11],[13,11],[14,10]], 'a'), {aligned:true});
for (const listener of removedListeners) listener(11, {windowId:22});
client.observe(removalSnapshot([[10,null],[12,10],[13,12],[14,10]], 'b'), {aligned:true});
await client.flush();
assert.ok(!sent.some(batch => batch.events?.some(event => event.kind === 'incident' && event.payload.windowId === 22)),
  '真实前端收到关闭事件后，应解释跨后台正常继承');
configListener({ enabled: false });
assert.equal(removedListeners.size, 0, '关闭诊断立即移除监听');
const previous = sent.length;
client.record({ type: 'disabled again' });
await client.flush();
assert.equal(sent.length, previous);
client.dispose();
console.log('✓ 前端诊断启停、隐私字段清理、序列与队列上限');

const { useTree } = await import('../src/manager/composables/useTree.js');
const tree = useTree();
const shared = getTreeDiagnostics();
await shared.ready;
treeResponse = { ok: true, structures: { 1: { revision: 2, revisionToken: 'instance-a', parents: { 2: 1 } } } };
await tree.loadForWindows([1]);
assert.deepEqual(tree.parentsFor(1), { 2: 1 });
treeResponse = { ok: true, structures: { 1: { revision: 1, revisionToken: 'instance-a', parents: { 2: 3 } } } };
await tree.loadForWindows([1]);
assert.deepEqual(tree.parentsFor(1), { 2: 1 }, '诊断不得改变旧版本响应的丢弃逻辑');
await shared.flush();
const requests = businessMessages.filter((entry) => entry.action === 'getTreeStructure');
assert.ok(requests.every((entry) => entry.diagnosticRequestId));
assert.notEqual(requests[0].diagnosticRequestId, requests[1].diagnosticRequestId);
const requestEvents = businessMessages.filter((entry) => entry.action === 'recordTreeDiagnostics').flatMap((entry) => entry.events);
const discarded = requestEvents.find((entry) => entry.payload.type === 'response-discarded');
assert.equal(discarded.payload.correlationId, requests[1].diagnosticRequestId);
assert.equal(discarded.payload.incomingRevision, 1);
assert.equal(discarded.payload.knownRevision, 2);
assert.equal(tree.diagnosticContextFor(1).correlationId, requests[0].diagnosticRequestId);
treeResponse = { ok: true, structures: { 1: { revision: 2, revisionToken: 'instance-a', parents: { 2: 3 } } } };
await tree.loadForWindows([1]);
await shared.flush();
assert.ok(businessMessages.some((entry) => entry.events?.some((event) => event.kind === 'incident' && event.payload.type === 'same-version-parent-mismatch')));
await tree.loadForWindows([1]);
await shared.flush();
assert.ok(businessMessages.some((entry) => entry.events?.some((event) => event.payload.type === 'same-version-parent-mismatch' && event.payload.status === 'recovered')));
const mismatchesBeforeNotification = businessMessages.flatMap((entry) => entry.events || []).filter((event) => event.kind === 'incident').length;
tree.onStructureChanged(() => {});
for (const listener of storageListeners) listener({ treeStructureRevision: { newValue: { token: 'instance-b', revisions: { 1: 2 } } } }, 'session');
treeResponse = { ok: true, structures: { 1: { revision: 2, revisionToken: 'instance-b', parents: {} } } };
await tree.loadForWindows([1]);
await shared.flush();
assert.equal(businessMessages.flatMap((entry) => entry.events || []).filter((event) => event.kind === 'incident').length,
  mismatchesBeforeNotification, '实例切换通知先到时不得把旧实例已应用树误作同版本树');
for (const listener of storageListeners) listener({ treeStructureRevision: { newValue: { token: 'instance-b', revisions: { 1: 3 } } } }, 'session');
treeResponse = { ok: true, structures: { 1: { revision: 3, revisionToken: 'instance-b', parents: { 3: 2 },
  diagnosticContext: { revision: 3, pending: false, operations: [{ type: 'close', correlationId: 'close-1', registered: true,
    phase: 'complete', revisionBefore: 2, revision: 3, focusIds: [1], expectedParents: [{ childId: 3, parentId: 2 }] }] } } } };
await tree.loadForWindows([1]);
await shared.flush();
assert.equal(tree.diagnosticContextFor(1).operations[0].correlationId, 'close-1');
assert.equal(businessMessages.flatMap((entry) => entry.events || []).filter((event) => event.kind === 'incident').length,
  mismatchesBeforeNotification, '通知之后正常新版本父提升不误报同版本差异');
// 中间态可以更新业务树，但不能吞掉诊断已对齐的前态。
const pendingTree = useTree();
const pendingEvents = () => businessMessages.flatMap((entry) => entry.events || []).filter((event) => event.payload.windowId === 8);
const observePendingResponse = async (parents, pending, revision = 2, token = 'pending-instance') => {
  treeResponse = { ok: true, structures: { 8: { revision, revisionToken: token, parents,
    diagnosticContext: { revision, pending, operations: [] } } } };
  await pendingTree.loadForWindows([8]);
  await shared.flush();
};
const reusedParentMap = { 2: 1 };
await observePendingResponse(reusedParentMap, false);
reusedParentMap[2] = 3;
await observePendingResponse(reusedParentMap, true);
assert.deepEqual(pendingTree.parentsFor(8), { 2: 3 }, '处理中响应仍按原业务规则应用');
assert.equal(pendingEvents().filter((event) => event.kind === 'incident').length, 0, '处理中不能提前确认异常');
await observePendingResponse({ 2: 3 }, false);
const pendingConfirmed = pendingEvents().find((event) => event.kind === 'incident' && event.payload.status === 'active');
assert.ok(pendingConfirmed, '后续真实对齐观测必须相对处理中之前的父映射确认异常');
assert.equal(pendingConfirmed.payload.evidence.nodes[0].before, 1, '保留真正已对齐的最早父关系');
await observePendingResponse({ 2: 3 }, false);
assert.ok(pendingEvents().some((event) => event.payload.status === 'recovered' && event.payload.signature === pendingConfirmed.payload.signature));
await observePendingResponse({ 2: 4 }, true);
await observePendingResponse({ 2: 3 }, false);
assert.equal(pendingEvents().filter((event) => event.payload.status === 'active').length, 1, '中间态恢复不新增确认异常');
await observePendingResponse({ 2: 5 }, true, 3);
await observePendingResponse({ 2: 5 }, false, 3);
assert.equal(pendingEvents().filter((event) => event.payload.status === 'active').length, 1, '版本变化建立新基线不跨版本比较');
assert.ok(pendingEvents().some((event) => event.payload.type === 'monitor-gap' && event.payload.reason === 'response-version-changed'));
await observePendingResponse({ 2: 6 }, false, 3, 'another-instance');
assert.equal(pendingEvents().filter((event) => event.payload.status === 'active').length, 1, '实例变化建立新基线');
assert.ok(pendingEvents().some((event) => event.payload.type === 'monitor-gap' && event.payload.reason === 'source-instance-changed'));
for (const listener of storageListeners) listener({ treeDebugConfig: { newValue: { enabled: false } } }, 'local');
const disabledStart = businessMessages.length;
await tree.loadForWindows([1]);
await shared.flush();
assert.deepEqual(businessMessages.slice(disabledStart).map((entry) => entry.action), ['getTreeStructure']);
assert.equal(businessMessages.at(-1).diagnosticRequestId, undefined);
shared.dispose();
console.log('✓ 真实 useTree 请求关联、旧响应丢弃、同版本差异与关闭零诊断 IPC');

const { createDiagnosticReceiver } = await import('../background/tree_diagnostic_receiver.js');
const received = [];
const receiver = createDiagnosticReceiver({ enabled: () => true,
  emit: (event) => received.push(event), incident: (event) => received.push(event), extensionRoot: 'extension://test/' });
for (const batch of sent.filter((entry) => entry.action === 'recordTreeDiagnostics')) {
  assert.ok(batch.events.length <= 64);
  const result = receiver(batch.events, { url: 'extension://test/ui/sidebar.html' });
  assert.equal(result.rejected, 0, '真实后台 receiver 接受客户端有界批次');
}
const sourceChanged = received.find((event) => event.type === 'monitor-source-changed');
assert.equal(sourceChanged?.previousSourceToken, 'old-background', '来源切换的旧后台标识通过真实 IPC 保留');
assert.equal(sourceChanged?.baselinePreserved, true, '明确区分保留前态的切换与观测间隙');
const crossSourceIncident = received.find((event) => event.type === 'parent-change' && event.status === 'active');
assert.equal(crossSourceIncident?.evidence?.firstEvidence?.observation?.previousSourceToken, 'old-background',
  '异常包首次证据也必须保留跨后台比较的来源边界');
const boundedBatches = [];
const pendingSends = [];
const bounded = createTreeDiagnosticClient({
  readConfig: async () => ({ enabled: true }), subscribeConfig: () => () => {}, subscribeStatus: () => () => {},
  send(action, payload) {
    if (action !== 'recordTreeDiagnostics') return Promise.resolve({ ok: true });
    boundedBatches.push(payload);
    return new Promise((resolve) => pendingSends.push(resolve));
  },
});
await bounded.ready;
for (let id = 0; id < 70; id += 1) bounded.record({ type: 'small', id });
const firstFlush = bounded.flush();
const otherFlush = bounded.flush();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(boundedBatches.length, 1, '并发 flush 共用唯一发送 worker');
pendingSends.shift()({ ok: true });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(boundedBatches.length, 2);
pendingSends.shift()({ ok: true });
await Promise.all([firstFlush, otherFlush]);
bounded.record({ type: 'small-truncation', ids: Array.from({ length: 129 }, (_, id) => id),
  titleChanged: true, urlChanged: true, queryEpoch: 3, context: { phase: 'pending' } });
const truncationFlush = bounded.flush();
await new Promise((resolve) => setTimeout(resolve, 0));
const limited = boundedBatches.at(-1).events[0].payload;
assert.equal(limited.truncation.omittedItems, 1);
assert.equal(limited.titleChanged, true);
assert.equal(limited.urlChanged, true);
assert.equal(limited.queryEpoch, 3);
assert.equal(limited.context.phase, 'pending');
pendingSends.shift()({ ok: true });
await truncationFlush;
bounded.record({ type: 'large-incident', signature: 'exact-signature', status: 'pending', ids: [1],
  evidence: { nodes: Array.from({ length: 128 }, (_, id) => ({ id, before: { parentId: 1 }, after: { parentId: 2 },
    relatedIds: Array.from({ length: 128 }, (_, index) => index + 100000) })) } }, 'incident');
const incidentFlush = bounded.flush();
await new Promise((resolve) => setTimeout(resolve, 0));
const incidentEvent = boundedBatches.at(-1).events[0];
assert.equal(incidentEvent.kind, 'incident');
assert.equal(incidentEvent.payload.status, 'pending');
assert.ok(incidentEvent.payload.signature);
assert.ok(incidentEvent.payload.evidence.nodes.length);
assert.ok(Buffer.byteLength(JSON.stringify(incidentEvent)) <= 24 * 1024);
assert.equal(receiver([incidentEvent], { url: 'extension://test/ui/sidebar.html' }).accepted, 1);
pendingSends.shift()({ ok: true });
await incidentFlush;
bounded.dispose();
console.log('✓ 真实 IPC 接收、并发单发送、短数组截断标记与大异常局部证据保留');

// 最后一批失败后没有新事件，复制前的显式 flush 仍须把缺口告知后台。
const lossBatches = [];
let rejectDiagnosticSend = true;
const lossy = createTreeDiagnosticClient({
  readConfig: async () => ({ enabled: true }), subscribeConfig: () => () => {}, subscribeStatus: () => () => {},
  async send(action, payload) {
    if (action !== 'recordTreeDiagnostics') return { ok: true };
    lossBatches.push(payload);
    if (rejectDiagnosticSend) throw new Error('模拟后台不可达');
    receiver(payload.events, { url: 'extension://test/ui/sidebar.html' });
    return { ok: true };
  },
});
await lossy.ready;
lossy.record({ type: 'last-event-before-export' });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(lossBatches.length, 1, '自动发送失败后不得微任务紧密重试');
assert.equal(lossy.state.status.transportError, true);
await lossy.flush();
assert.equal(lossBatches.length, 2, '无新事件的显式 flush 必须尝试一次缺口报告');
assert.equal(lossBatches[1].events[0].payload.type, 'monitor-gap');
assert.equal(lossBatches[1].events[0].payload.transportLost, 1);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(lossBatches.length, 2, '缺口报告失败也不能无限重试');
rejectDiagnosticSend = false;
await Promise.all([lossy.flush(), lossy.flush()]);
assert.equal(lossBatches.length, 3, '并发显式 flush 共用一次缺口报告');
assert.equal(lossBatches[2].events[0].payload.transportLost, 1, '报告失败后保留尚未成功汇报的原始缺失数');
assert.ok(received.some((event) => event.type === 'monitor-gap' && event.transportLost === 1), '后台导出能够看到最后一批丢失的证据');
await lossy.flush();
assert.equal(lossBatches.length, 3, '成功上报后不重复报缺口');
rejectDiagnosticSend = true;
lossy.record({ type: 'export-joins-final-inflight' });
await lossy.flush();
assert.equal(lossBatches.length, 5, '显式导出赶上最终批次时，同一 worker 也只尝试一次缺口补报');
assert.equal(lossBatches.at(-1).events[0].payload.transportLost, 1);
rejectDiagnosticSend = false;
await lossy.flush();
assert.equal(lossBatches.at(-1).events[0].payload.transportLost, 1);
lossy.dispose();
console.log('✓ 最后批次失败后的显式缺口补报、失败保留与并发单次发送');
