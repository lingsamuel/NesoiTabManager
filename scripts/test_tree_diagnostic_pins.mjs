import assert from 'node:assert/strict';

const data = {};
globalThis.chrome = {
  runtime: { lastError: null, getManifest: () => ({ version: 'test' }) },
  storage: {
    local: { get: (key, cb) => cb({ [key]: data[key] }), set: (value, cb) => { Object.assign(data, value); cb?.(); } },
    session: { get: (_key, cb) => cb({}), set: (_value, cb) => cb?.() },
  },
};
const debug = await import('../background/tree_debug.js');
const runtime = await import('../background/tree_diagnostic_runtime.js');
debug.applyTreeDebugConfig({ enabled: true, printTree: false });
runtime.configureTreeDiagnostics({ captureState: () => null });
const tests = [];
const test = (name, run) => tests.push({ name, run });
const incidents = () => debug.getTreeDebugLogText().split('--- 异常记录包 ---')[1].trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const moved = (fromIndex, toIndex) => {
  const correlationId = runtime.recordBrowserTreeEvent('moved', 1, [4], { fromIndex, toIndex, internal: false });
  return runtime.beginTreeDiagnosticOperation('moved', 1, [4], { registered: false, correlationId });
};
const pin = (pinned, index) => runtime.recordBrowserPinEvent(4, { pinned }, { id: 4, windowId: 1, index, pinned });

for (const pinned of [true, false]) {
  for (const order of ['pin-first', 'move-first']) {
    test(`${pinned ? 'pin' : 'unpin'} ${order} 在冷后台不产生未知移动异常`, () => {
      const [from, to] = pinned ? [20, 2] : [0, 2];
      if (order === 'pin-first') pin(pinned, to);
      const token = moved(from, to);
      if (order === 'move-first') pin(pinned, to);
      runtime.endTreeDiagnosticOperation(token);
      assert.equal(debug.getTreeDebugStatus().activeCount, 0);
      assert.equal(incidents().length, 0);
      assert.ok(debug.getTreeDebugLogText().includes('browser-moved'), '原始移动证据保留');
    });
  }
}
test('移动时已经固定，迟到固定事件仍能解释匹配位置', () => {
  const token = moved(20, 2);
  runtime.observeMovedTab(1, 4, { id: 4, windowId: 1, index: 2, pinned: true });
  runtime.endTreeDiagnosticOperation(token);
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
  pin(true, 2);
  assert.equal(debug.getTreeDebugStatus().activeCount, 0);
  assert.equal(incidents()[0].status, 'recovered');
});
test('未关联固定的移动仍确认异常；以后在原地固定不能解释旧拖动', () => {
  const token = moved(20, 2);
  runtime.observeMovedTab(1, 4, { id: 4, windowId: 1, index: 2, pinned: false });
  runtime.endTreeDiagnosticOperation(token);
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
  pin(true, 2);
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
});
test('目标位置不同的固定事件不能解释未知移动', () => {
  runtime.endTreeDiagnosticOperation(moved(20, 2));
  pin(true, 1);
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
});
test('移动现场已知为普通标签，处理尚未结束时原地固定也不能解释旧拖动', () => {
  const token = moved(20, 2);
  runtime.observeMovedTab(1, 4, { id: 4, windowId: 1, index: 2, pinned: false });
  pin(true, 2);
  runtime.endTreeDiagnosticOperation(token);
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
});
test('无移动的固定标记遇到其他标签结构事件后不能解释后续拖动', () => {
  pin(true, 2);
  runtime.recordBrowserTreeEvent('created', 1, [9]);
  runtime.endTreeDiagnosticOperation(moved(3, 2));
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
});
test('一个固定事件不能消除同标签之前多次未知移动', () => {
  runtime.endTreeDiagnosticOperation(moved(20, 15));
  runtime.endTreeDiagnosticOperation(moved(15, 2));
  pin(true, 2);
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
});
test('固定位置移动方向不符不能解释；标记只被下一次移动消费', () => {
  pin(true, 2);
  runtime.endTreeDiagnosticOperation(moved(0, 2));
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
  runtime.endTreeDiagnosticOperation(moved(20, 2));
  assert.equal(debug.getTreeDebugStatus().activeCount, 1);
});
test('诊断关闭、窗口关闭和复位清理固定关联现场', async () => {
  for (const clear of [
    () => { debug.applyTreeDebugConfig({ enabled: false }); pin(true, 2); debug.applyTreeDebugConfig({ enabled: true }); },
    () => runtime.forgetTreeDiagnostics(1),
    () => runtime.resetTreeDiagnosticBaselines('test-clear'),
  ]) {
    pin(true, 2); clear();
    runtime.endTreeDiagnosticOperation(moved(20, 2));
    assert.equal(debug.getTreeDebugStatus().activeCount, 1);
    runtime.resetTreeDiagnosticBaselines('between-clear');
    await debug.clearTreeDebugLog();
  }
});

let failed = 0;
for (const { name, run } of tests) {
  await debug.clearTreeDebugLog(); runtime.resetTreeDiagnosticBaselines('test-case');
  try { await run(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`, error); }
}
process.exit(failed ? 1 : 0);
