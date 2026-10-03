import assert from 'node:assert/strict';
const data = { local: {}, session: {} };
const area = (name) => ({
  get: (key, cb) => cb({ [key]: data[name][key] }),
  set: (value, cb) => { Object.assign(data[name], value); cb?.(); },
  remove: (_keys, cb) => cb?.(),
});
let tabs = [
  { id: 1, windowId: 1, index: 0, title: 'PRIVATE-A', url: 'https://private-a/' },
  { id: 2, windowId: 1, index: 1, openerTabId: 1, title: 'PRIVATE-D', url: 'https://private-d/' },
  { id: 3, windowId: 1, index: 2, openerTabId: 2, title: 'PRIVATE-E', url: 'https://private-e/' },
];
globalThis.chrome = {
  runtime: { lastError: null, getManifest: () => ({ version: 'test' }) },
  storage: { local: area('local'), session: area('session') },
  tabs: { query: (query, cb) => cb(tabs.filter(t => (query.windowId == null || t.windowId === query.windowId) && (query.index == null || t.index === query.index))) },
  alarms: { create() {}, clear() {} },
  windows: { getAll: cb => cb([{ id: 1 }]) },
};
const tree = await import('../background/tree.js');
const debug = await import('../background/tree_debug.js');
await tree.getTreeStructure([1]);
const snapshot = tree.captureTreeDebugState(1);
assert(snapshot.childIdsById instanceof Map, '快照保留原始子索引供只读核对');
assert.equal(snapshot.source, 'backend-cache', '缓存下标来源必须明确');
debug.applyTreeDebugConfig({ enabled: true, printTree: false });
const token = tree.beginTreeCloseDebug(2, { windowId: 1 });
assert(token, '只开总开关仍应监测关闭');
tabs = tabs.filter(t => t.id !== 2).map((t, index) => ({ ...t, index }));
tree.handleTreeTabRemoved(2, { windowId: 1 });
tree.endTreeCloseDebug(token);
let text = debug.getTreeDebugLogText();
assert.match(text, /close/);
assert.match(text, /promotion/);
assert(!text.includes('PRIVATE-') && !text.includes('https://private'), '日志不得包含正文');
assert.equal((await tree.getTreeStructure([1])).structures[1].parents[3], 1, '监测不改关闭语义');
await tree.refreshTreeIndexes(1);
// 原始移动即使在防抖期间换回，仍各自记录；诊断不推测用户意图。
await tree.handleTreeTabMoved(3, { windowId: 1, fromIndex: 1, toIndex: 0 });
await tree.handleTreeTabMoved(3, { windowId: 1, fromIndex: 0, toIndex: 1 });
text = debug.getTreeDebugLogText();
assert.equal((text.split("--- 异常记录包 ---")[0].match(/"type":"browser-moved"/g) || []).length, 2);
await tree.refreshTreeIndexes(1);
const packages = debug.getTreeDebugLogText().split('--- 异常记录包 ---')[1].trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.equal(packages.find(item => item.type === 'unregistered-browser-move')?.status, 'recovered', '实际查询确认换回后结束原始移动疑点');
// 数值 index 回到原处并不等于共同存活标签恢复相对顺序。
const runtime = await import('../background/tree_diagnostic_runtime.js');
const deferredToken = runtime.beginTreeDiagnosticOperation('close', 9, [], { correlationId: undefined });
assert.equal(typeof deferredToken.correlationId, 'string', '缺少原始事件关联时仍生成新的关联ID');
runtime.endTreeDiagnosticOperation(deferredToken);
await debug.clearTreeDebugLog();
runtime.resetTreeDiagnosticBaselines('test-relative-recovery');
runtime.observeTreePhysicalTabs(9, [{ id: 91, index: 0 }, { id: 92, index: 1 }, { id: 93, index: 2 }], 0);
runtime.recordBrowserTreeEvent('moved', 9, [92], { fromIndex: 1, toIndex: 2 });
runtime.recordBrowserTreeEvent('removed', 9, [91]);
runtime.observeTreePhysicalTabs(9, [{ id: 93, index: 0 }, { id: 92, index: 1 }], runtime.treeDiagnosticEpoch(9));
const shiftedPackages = debug.getTreeDebugLogText().split('--- 异常记录包 ---')[1].trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.equal(shiftedPackages.find(item => item.type === 'unregistered-browser-move')?.status, 'active', '删前方节点不能将数值下标相同误认成换位恢复');
console.log('后台诊断集成：关闭总开关、原始移动、相对恢复、隐私、语义保持通过');
process.exit(0);
