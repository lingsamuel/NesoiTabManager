import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// 缺失实现时仍以断言失败，明确红灯来自待实现的诊断能力。
const diagnostics = await import('../background/tree_diagnostics.js').catch(() => ({}));
const monitorModule = await import('../background/tree_diagnostic_monitor.js').catch(() => ({}));
assert.equal(typeof diagnostics.compareTreeSnapshots, 'function', '应提供只读快照比较器');
assert.equal(typeof monitorModule.createTreeDiagnosticMonitor, 'function', '应提供诊断监测器');
const { compareTreeSnapshots } = diagnostics;
const { createTreeDiagnosticMonitor } = monitorModule;
const snapshot = (entries, extra = {}) => ({ windowId: 1, source: 'physical', entries: entries.map((entry, index) => ({ parentId: null, index, ...entry })), ...extra });
const node = (result, id) => result.nodes.find((entry) => entry.id === id);
const tests = [];
const test = (name, run) => tests.push({ name, run });

test('首次基线检查损坏结构，但不报告整窗新增', () => {
  const result = compareTreeSnapshots(null, snapshot([{ id: 1, parentId: 999 }]));
  assert.ok(result.issues.some((issue) => issue.type === 'missing-parent'));
  assert.equal(node(result, 1).after.parentId, 999);
  assert.equal(node(result, 1).after.parentExists, false);
  assert.ok(!node(result, 1).changes.includes('added'));
});

test('2000 标签关闭：统一位移压缩、保持原始层级与前后子树上下文', () => {
  const entries = Array.from({ length: 2000 }, (_, id) => ({ id, index: id, parentId: id < 8 && id > 0 ? id - 1 : null, title: '私密标题', url: 'https://private.invalid' }));
  const before = snapshot(entries);
  const after = snapshot(entries.filter((entry) => entry.id !== 3).map((entry, index) => ({ ...entry, index, parentId: entry.parentId === 3 ? 2 : entry.parentId })));
  const start = performance.now();
  const result = compareTreeSnapshots(before, after, { focusIds: [3] });
  const ms = performance.now() - start;
  assert.ok(result.nodes.length < 20);
  assert.ok(result.shifts.reduce((count, shift) => count + shift.count, 0) > 1900);
  assert.equal(result.orderChanges.length, 0);
  assert.equal(node(result, 7).before.depth, 7);
  assert.equal(node(result, 7).after.depth, 6);
  assert.ok(node(result, 0));
  const text = JSON.stringify(result);
  assert.ok(!text.includes('私密标题') && !text.includes('private.invalid'));
  assert.ok(Buffer.byteLength(text) < 15000);
  console.log(`2000 标签样本：${Buffer.byteLength(text)} bytes，${ms.toFixed(2)} ms`);
});

test('操作范围外双换位被完整检测，包含双方前后邻居', () => {
  const before = snapshot(Array.from({ length: 2000 }, (_, id) => ({ id })));
  const ids = before.entries.map(({ id }) => id);
  [ids[1200], ids[1201]] = [ids[1201], ids[1200]];
  [ids[1800], ids[1801]] = [ids[1801], ids[1800]];
  const result = compareTreeSnapshots(before, snapshot(ids.map((id) => ({ id }))), { focusIds: [2] });
  assert.deepEqual(new Set(result.orderChanges.map((change) => change.id)), new Set([1200, 1201, 1800, 1801]));
  assert.equal(result.orderChanges.find((change) => change.id === 1200).before.nextId, 1201);
  assert.equal(result.orderChanges.find((change) => change.id === 1200).after.previousId, 1201);
});

test('新增删除不改变共同存活项顺序；不同位置的 index 位移不合并', () => {
  const before = snapshot([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  const after = snapshot([{ id: 9 }, { id: 1 }, { id: 3 }, { id: 4, index: 5 }]);
  const result = compareTreeSnapshots(before, after);
  assert.equal(result.orderChanges.length, 0);
  assert.ok(node(result, 1).changes.includes('index'));
  assert.ok(node(result, 4).changes.includes('index'));
});

test('范围外改父、层级、内容优先输出，日志不含正文', () => {
  const before = snapshot([{ id: 1 }, { id: 2 }, { id: 3, title: '旧' }, { id: 4, depth: 0 }]);
  const after = snapshot([{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, title: '新' }, { id: 4, depth: 2 }]);
  const result = compareTreeSnapshots(before, after, { focusIds: [1] });
  assert.ok(node(result, 2).changes.includes('parent'));
  assert.ok(node(result, 3).changes.includes('content'));
  assert.ok(node(result, 4).changes.includes('depth'));
  assert.equal(node(result, 4).after.depth, 2);
  assert.equal(node(result, 4).after.depthSource, 'observed');
  assert.ok(result.nodes.findIndex((entry) => entry.id === 4) < result.nodes.findIndex((entry) => entry.id === 1));
  assert.ok(!JSON.stringify(result).includes('"title"'));
});

test('损坏子索引不影响子树范围，缺漏/多余/归属错均保留', () => {
  const before = snapshot([{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4 }], { childIdsById: new Map([[1, [4, 999]], [2, [3, 3]]]) });
  const result = compareTreeSnapshots(before, before, { focusIds: [1] });
  assert.ok(node(result, 3));
  for (const type of ['child-index-missing', 'child-index-extra', 'child-index-parent', 'child-index-duplicate']) {
    assert.ok(result.issues.some((issue) => issue.type === type), type);
  }
});

test('环与重复在首次观测检测，不改写原始快照', () => {
  const entries = [{ id: 1, parentId: 2 }, { id: 2, parentId: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }];
  const input = snapshot(entries);
  const original = JSON.stringify(input);
  const result = compareTreeSnapshots(null, input);
  assert.ok(result.issues.some((issue) => issue.type === 'cycle'));
  assert.ok(result.issues.some((issue) => issue.type === 'duplicate-id'));
  assert.equal(node(result, 3).after.depth, null);
  assert.equal(JSON.stringify(input), original);
});

test('深链采用迭代线性算法，不递归爆栈', () => {
  const input = snapshot(Array.from({ length: 20000 }, (_, id) => ({ id, parentId: id ? id - 1 : null })));
  const result = compareTreeSnapshots(input, input, { focusIds: [19999, 19998] });
  assert.equal(node(result, 19999).after.depth, 19999);
  assert.equal(result.issues.length, 0);
});

test('可见行依据完整父映射区分隐藏与悬空，保留观察层级', () => {
  const input = snapshot([{ id: 2, parentId: 1, depth: 0 }], { source: 'visible', parentById: new Map([[1, null], [2, 1]]) });
  const result = compareTreeSnapshots(null, input, { focusIds: [2] });
  assert.equal(result.issues.length, 0);
  assert.equal(node(result, 2).after.parentExists, true);
  assert.equal(node(result, 2).after.depth, 0);
});

function harness() {
  const records = [];
  const incidents = [];
  const monitor = createTreeDiagnosticMonitor({ emit: (record) => records.push(record), incident: (record) => incidents.push(record) });
  return { monitor, records, incidents };
}

test('不同来源各自建基线，不直接比较物理与 DFS', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 2 }, { id: 1 }], { source: 'rows' }), { aligned: true });
  assert.equal(incidents.length, 0);
});

test('来源未知 onMoved 仍可疑；双换位恢复保留真实前后观察', () => {
  const { monitor, records, incidents } = harness();
  const original = snapshot([{ id: 1 }, { id: 2 }, { id: 3 }]);
  const changed = snapshot([{ id: 2 }, { id: 1 }, { id: 3 }]);
  monitor.observe(original, { aligned: true });
  monitor.observe(changed, { type: 'onMoved', focusIds: [1], aligned: true });
  assert.equal(incidents.at(-1).status, 'active');
  assert.ok(records.some((record) => record.classification === 'suspect'));
  monitor.observe(changed, { type: 'observation', aligned: true });
  assert.notEqual(incidents.at(-1).status, 'recovered');
  monitor.observe(original, { type: 'observation', aligned: true });
  assert.ok(incidents.some((entry) => entry.status === 'recovered'));
  assert.ok(incidents[0].evidence.nodes.some((entry) => entry.before && entry.after));
});

test('未对齐问题先 pending，后续真实一致观察确认及恢复', () => {
  const { monitor, incidents, records } = harness();
  const invalid = snapshot([{ id: 1, parentId: 999 }]);
  monitor.observe(invalid, { aligned: false });
  assert.equal(incidents.length, 0);
  assert.ok(!records.some((record) => record.classification === 'inconsistent'));
  monitor.observe(invalid, { aligned: true });
  assert.equal(incidents.at(-1).status, 'active');
  assert.equal(incidents.at(-1).signature, incidents[0].signature);
  monitor.observe(snapshot([{ id: 1 }]), { aligned: false });
  assert.notEqual(incidents.at(-1).status, 'recovered');
  monitor.observe(snapshot([{ id: 1 }]), { aligned: true });
  assert.ok(incidents.some((entry) => entry.status === 'recovered'));
});

test('关闭登记只解释真实子树内变化，不能掩盖其它分支改父', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 1 }, { id: 3, parentId: 1 }, { id: 4, parentId: 1 }]), { type: 'close', registered: true, correlationId: 'close-2', expectedParents: [{ childId: 3, parentId: 1 }], phase: 'complete', focusIds: [2], aligned: true });
  assert.ok(incidents.some((entry) => entry.ids.includes(4)));
  assert.ok(incidents.every((entry) => !entry.ids.includes(3)));
});

test('有登记但不同阶段或无关联 ID 的变化不能算已解释', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 1 }, { id: 3, parentId: 1 }]), { type: 'close', registered: true, phase: 'before', focusIds: [2], aligned: true });
  assert.ok(incidents.length > 0);
});

test('显式移动和显示状态的登记只解释匹配的精确相对顺序', () => {
  const { monitor, incidents, records } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }, { id: 3 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 2 }, { id: 1 }, { id: 3 }]), { type: 'move', registered: true, correlationId: 'move-1', phase: 'complete', focusIds: [1], expectedOrderIds: [2, 1, 3], aligned: true });
  assert.equal(incidents.length, 0);
  assert.ok(records.some((entry) => entry.classification === 'explained'));
});

test('实例切换与显式 gap 不比较跨边界快照', () => {
  const { monitor, records, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }], { sourceToken: 'a' }), { aligned: true });
  monitor.observe(snapshot([{ id: 2 }, { id: 1 }], { sourceToken: 'b' }), { aligned: true });
  assert.equal(incidents.length, 0);
  assert.ok(records.some((record) => record.type === 'monitor-gap'));
  monitor.gap({ windowId: 1, source: 'physical', reason: 'hidden' });
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }], { sourceToken: 'b' }), { aligned: true });
  assert.equal(incidents.length, 0);
  monitor.clear();
});

test('处理中未知改父在完成时无新差异仍确认，解除必须核对最新目标父', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 1 }, { id: 3, parentId: 1 }, { id: 4 }]), { type: 'close', aligned: false });
  assert.equal(incidents.length, 0);
  monitor.observe(snapshot([{ id: 1 }, { id: 3, parentId: 4 }, { id: 4 }]), { type: 'close', registered: true, correlationId: 'close-2', expectedParents: [{ childId: 3, parentId: 1 }], phase: 'complete', focusIds: [2], aligned: true });
  assert.equal(incidents.at(-1).status, 'active');
  assert.equal(incidents.at(-1).evidence.nodes.find((entry) => entry.id === 3).after.parentId, 4);
});

test('持续父变化异常保存最新局部证据，不以无差异确认恢复', () => {
  const { monitor, incidents } = harness();
  const before = snapshot([{ id: 1 }, { id: 2 }]);
  const after = snapshot([{ id: 1 }, { id: 2, parentId: 1 }]);
  monitor.observe(before, { aligned: true });
  monitor.observe(after, { aligned: false });
  monitor.observe(after, { aligned: true });
  assert.equal(incidents.at(-1).status, 'active');
  assert.ok(incidents.at(-1).evidence.nodes.some((entry) => entry.id === 2));
  monitor.observe(before, { aligned: false });
  monitor.observe(before, { aligned: true });
  assert.equal(incidents.at(-1).status, 'recovered');
  assert.ok(incidents.at(-1).evidence.nodes.some((entry) => entry.id === 2 && entry.after.parentId === null));
});

test('相邻兄弟按观测顺序取值，不能依赖父映射插入顺序', () => {
  const input = snapshot([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], { parentById: new Map([[1, null], [5, null], [3, null], [4, null], [2, null]]) });
  const result = compareTreeSnapshots(input, input, { focusIds: [3] });
  assert.deepEqual(new Set(result.nodes.map((entry) => entry.id)), new Set([2, 3, 4]));
});

test('换位问题按涉及身份恢复，不被后来无关分支换位拖住', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 2 }, { id: 1 }, { id: 3 }, { id: 4 }]), { aligned: true });
  const originalSignature = incidents.at(-1).signature;
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }, { id: 4 }, { id: 3 }]), { aligned: true });
  assert.ok(incidents.some((entry) => entry.signature === originalSignature && entry.status === 'recovered'));
  assert.ok(incidents.some((entry) => entry.status === 'active' && entry.ids.includes(3)));
});

test('前端批次关闭按时间顺序核对多次父赋值链', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4, parentId: 3 }, { id: 5, parentId: 4 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 1 }, { id: 4, parentId: 1 }, { id: 5, parentId: 4 }]), { aligned: true, operations: [
    { type: 'close', registered: true, correlationId: 'close-3', phase: 'complete', focusIds: [3], expectedParents: [{ childId: 4, parentId: 2 }] },
    { type: 'close', registered: true, correlationId: 'close-2', phase: 'complete', focusIds: [2], expectedParents: [{ childId: 4, parentId: 1 }] },
  ] });
  assert.equal(incidents.length, 0);
});

test('跨批次登记父赋值链断裂或关闭掩盖换位均保持可疑', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4, parentId: 3 }, { id: 5 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 5 }, { id: 1 }, { id: 4, parentId: 1 }]), { aligned: true, operations: [
    { type: 'close', registered: true, correlationId: 'close-2', phase: 'complete', focusIds: [2], expectedParents: [{ childId: 4, parentId: 1 }], expectedOrderIds: [5, 1, 4] },
  ] });
  assert.ok(incidents.some((entry) => entry.type === 'parent-change'));
  assert.ok(incidents.some((entry) => entry.type === 'order-change'));
});

test('时序证据保留请求/实例/版本与事件代次，但不透传任意页面字段', () => {
  const { monitor, incidents, records } = harness();
  monitor.observe(snapshot([{ id: 1, parentId: 999 }], { sourceToken: 'instance-a', revision: 7 }), {
    filterActive: true, filterMode: 'jump', collapsedCount: 3,
    requestId: 'request-1', queryEpoch: 4, currentEpoch: 5, epoch: 5, aligned: false, title: '隐私内容',
    operations: [{ type: 'close', correlationId: 'close-2', revision: 6, fromRevision: 5, toRevision: 6 }],
  });
  const observation = records.find((entry) => entry.classification === 'pending').observation;
  assert.equal(observation.requestId, 'request-1');
  assert.equal(observation.filterActive, true);
  assert.equal(observation.filterMode, 'jump');
  assert.equal(observation.collapsedCount, 3);
  assert.equal(observation.sourceToken, 'instance-a');
  assert.equal(observation.revision, 7);
  assert.equal(observation.queryEpoch, 4);
  assert.equal(observation.currentEpoch, 5);
  assert.equal(observation.epoch, 5);
  assert.equal(observation.operations[0].fromRevision, 5);
  assert.ok(!JSON.stringify(incidents).includes('隐私内容'));
});

test('正常关闭处理中短暂悬空只保留普通证据，完成后不创建异常包', () => {
  const { monitor, incidents, records } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 1 }, { id: 3, parentId: 2 }]), { type: 'rows', aligned: false });
  assert.equal(incidents.length, 0);
  assert.ok(records.some((entry) => entry.classification === 'pending'));
  monitor.observe(snapshot([{ id: 1 }, { id: 3, parentId: 1 }]), { aligned: true, operations: [
    { type: 'close', registered: true, correlationId: 'close-2', phase: 'complete', focusIds: [2], expectedParents: [{ childId: 3, parentId: 1 }] },
  ] });
  assert.equal(incidents.length, 0);
  assert.ok(records.some((entry) => entry.classification === 'recovered'));
});

test('处理中疑点在对齐后仍存在才建包，保存首次前态与最新确认现场', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1 }]), { requestId: 'first-pending', aligned: false });
  assert.equal(incidents.length, 0);
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1, index: 4 }]), { requestId: 'confirmation', aligned: true });
  assert.equal(incidents.length, 1);
  const evidence = incidents[0].evidence;
  const first = evidence.firstEvidence.nodes.find((entry) => entry.id === 2);
  assert.equal(first.before.parentId, null);
  assert.equal(first.after.parentId, 1);
  assert.equal(first.after.index, 1);
  assert.equal(evidence.firstEvidence.observation.requestId, 'first-pending');
  assert.equal(evidence.observation.requestId, 'confirmation');
  assert.equal(evidence.nodes.find((entry) => entry.id === 2).after.index, 4);
  monitor.observe(snapshot([{ id: 1 }, { id: 2, parentId: 1, index: 5 }]), { aligned: false });
  assert.equal(incidents.at(-1).status, 'pending');
  assert.equal(incidents.at(-1).evidence.firstEvidence.nodes.find((entry) => entry.id === 2).before.parentId, null);
});

test('新标签处理中先按根节点出现，首次对齐挂父不应创建改父异常', () => {
  const { monitor, incidents, records } = harness();
  monitor.observe(snapshot([{ id: 101 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 101 }, { id: 102 }, { id: 103 }]), { aligned: false });
  monitor.observe(snapshot([{ id: 101 }, { id: 102, parentId: 101 }, { id: 103, parentId: 102 }]), { aligned: false });
  assert.equal(incidents.length, 0);
  assert.ok(records.some((entry) => entry.classification === 'pending'));
  monitor.observe(snapshot([{ id: 101 }, { id: 102, parentId: 101 }, { id: 103, parentId: 102 }]), { aligned: true });
  assert.equal(incidents.length, 0);
  assert.ok(records.some((entry) => entry.classification === 'recovered'));
});

test('新增标签的挂父直接随对齐结果到达，也不比较处理中根节点猜测', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 101 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 101 }, { id: 102 }, { id: 103 }]), { aligned: false });
  monitor.observe(snapshot([{ id: 101 }, { id: 102, parentId: 101 }, { id: 103, parentId: 102 }]), { aligned: true });
  assert.equal(incidents.length, 0);
});

test('尚无任何对齐基线时的处理中改父和换位，仅结束观察不确认异常', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }, { id: 3 }]), { aligned: false });
  monitor.observe(snapshot([{ id: 2 }, { id: 1 }, { id: 3, parentId: 1 }]), { aligned: false });
  monitor.observe(snapshot([{ id: 2 }, { id: 1 }, { id: 3, parentId: 1 }]), { aligned: true });
  assert.equal(incidents.length, 0);
});

test('处理中真实存活标签换位仍需确认，并保留首次换位现场', () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([{ id: 1 }, { id: 2 }]), { aligned: true });
  monitor.observe(snapshot([{ id: 2 }, { id: 1 }, { id: 3 }]), { aligned: false, requestId: 'first-swap' });
  monitor.observe(snapshot([{ id: 2 }, { id: 1 }, { id: 3, parentId: 1 }]), { aligned: true });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].type, 'order-change');
  assert.deepEqual(new Set(incidents[0].ids), new Set([1, 2]));
  assert.equal(incidents[0].evidence.firstEvidence.observation.requestId, 'first-swap');
  assert.equal(incidents[0].evidence.firstEvidence.orderChanges.find((entry) => entry.id === 1).before.nextId, 2);
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n${error.stack}`);
  }
}
assert.equal(failed, 0, `${failed} 项诊断测试失败`);
