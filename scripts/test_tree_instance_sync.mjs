import assert from 'node:assert/strict';

const storageListeners = [];
const pendingRequests = [];
const messages = [];
globalThis.chrome = {
  runtime: { sendMessage(message, callback) {
    messages.push(message);
    if (message.action === 'getTreeStructure') pendingRequests.push({ message, callback });
    else callback({ ok: true, status: {} });
  } },
  storage: {
    local: { get(key, callback) { callback({ [key]: { enabled: false } }); } },
    session: { get(_key, callback) { callback({}); }, set(_value, callback) { callback?.(); } },
    onChanged: { addListener(listener) { storageListeners.push(listener); }, removeListener() {} },
  },
};
const { useTree } = await import('../src/manager/composables/useTree.js');
const { getTreeDiagnostics } = await import('../src/manager/utils/tree_diagnostics.js');
const diagnostics = getTreeDiagnostics();
await diagnostics.ready;

function structure(token, revision, parents = {}) {
  return { revisionToken: token, revision, parents };
}
function notify(token, revisions) {
  for (const listener of storageListeners) {
    listener({ treeStructureRevision: { newValue: { token, revisions } } }, 'session');
  }
}
function startLoad(tree, windowIds) {
  const result = tree.loadForWindows(windowIds);
  const request = pendingRequests.shift();
  assert.ok(request, '必须执行真实结构请求');
  return { result, respond: request.callback };
}
async function load(tree, windowIds, structures) {
  const request = startLoad(tree, windowIds);
  request.respond({ ok: true, structures });
  return request.result;
}

// 重现通知先更新全局 token，却让旧实例 revision 8 拒绝新实例 revision 1。
const tree = useTree();
const notifications = [];
tree.onStructureChanged(ids => notifications.push(ids));
assert.equal(await load(tree, [1, 2], {
  1: structure('a', 8, { 11: 10 }), 2: structure('a', 9, { 21: 20 }),
}), true);
notify('b', { 1: 1, 2: 1 });
assert.deepEqual(notifications.at(-1), [], '实例切换通知触发全量刷新');
assert.equal(tree.diagnosticContextFor(1).sourceToken, 'a', '通知不能冒充窗口已经采用新实例');
assert.equal(await load(tree, [1], { 1: structure('b', 1, { 11: 12 }) }), true);
assert.deepEqual(tree.parentsFor(1), { 11: 12 }, '新实例较低版本必须采用');
assert.equal(tree.diagnosticContextFor(2).sourceToken, 'a', '各窗口独立保留实际采用实例');
assert.equal(await load(tree, [2], { 2: structure('b', 1, { 21: 22 }) }), true);
assert.deepEqual(tree.parentsFor(2), { 21: 22 }, '第二个窗口也必须接受新实例较低版本');
const notificationCount = notifications.length;
notify('a', { 1: 99 });
notify('b', { 1: 0, 2: 1 });
assert.equal(notifications.length, notificationCount, '迟到旧实例及同实例未前进通知不触发刷新');
assert.equal(await load(tree, [1], { 1: structure('a', 99, { 11: 10 }) }), false);
assert.equal(await load(tree, [1], { 1: structure('b', 0, { 11: 10 }) }), false);
assert.deepEqual(tree.parentsFor(1), { 11: 12 }, '旧实例及同实例旧版本都不得回退结构');

// 响应先到时同样要逐窗口接受，并阻止尚未返回的旧请求覆盖。
const responseFirst = useTree();
responseFirst.onStructureChanged(() => {});
await load(responseFirst, [1, 2], { 1: structure('c', 8), 2: structure('c', 8) });
const oldRequest = startLoad(responseFirst, [1]);
assert.equal(await load(responseFirst, [1, 2], {
  1: structure('d', 1, { 11: 12 }), 2: structure('d', 1, { 21: 22 }),
}), true);
oldRequest.respond({ ok: true, structures: { 1: structure('c', 10, { 11: 10 }) } });
assert.equal(await oldRequest.result, false);
notify('c', { 1: 10 });
notify('d', { 1: 1, 2: 1 });
assert.deepEqual(responseFirst.parentsFor(1), { 11: 12 });
assert.deepEqual(responseFirst.parentsFor(2), { 21: 22 });

// 旧请求发出时甚至还没有见过 token；实例边界也不能只依赖退役集合。
const firstLoad = useTree();
firstLoad.onStructureChanged(() => {});
const unknownOldRequest = startLoad(firstLoad, [1]);
notify('f', { 1: 1 });
unknownOldRequest.respond({ ok: true, structures: { 1: structure('e', 20, { 11: 10 }) } });
assert.equal(await unknownOldRequest.result, false, '切换前发出的未知旧实例响应也必须拒绝');
assert.equal(await load(firstLoad, [1], { 1: structure('f', 1, { 11: 12 }) }), true);
assert.deepEqual(firstLoad.parentsFor(1), { 11: 12 });

const noSubscriber = useTree();
await load(noSubscriber, [1], { 1: structure('g', 8) });
notify('h', { 1: 1 });
assert.equal(await load(noSubscriber, [1], { 1: structure('g', 9) }), false,
  '没有刷新订阅者时仍须记录实例切换，防止在途响应回退');
assert.equal(await load(noSubscriber, [1], { 1: structure('h', 1) }), true);

const wakingRequest = startLoad(noSubscriber, [1]);
notify('i', { 1: 1 });
wakingRequest.respond({ ok: true, structures: { 1: structure('i', 1, { 11: 15 }) } });
assert.equal(await wakingRequest.result, true, '旧请求唤醒新实例且先收到通知时，仍接受新实例响应');
assert.deepEqual(noSubscriber.parentsFor(1), { 11: 15 });

const failed = startLoad(tree, [1]);
failed.respond({ ok: false, error: '恢复失败' });
assert.equal(await failed.result, false);
assert.equal(await load(tree, [1], {}), false, '缺少所需窗口结构不能标记已对齐');
const incomplete = useTree();
assert.equal(await load(incomplete, [1, 2], { 1: structure('partial', 2, { 11: 13 }) }), false,
  '只采用部分所需窗口不能标记整个请求已对齐');
assert.deepEqual(incomplete.parentsFor(1), { 11: 13 }, '缺少其他窗口不妨碍采用已有窗口的正确结构');
assert.ok(messages.every(message => message.action === 'getTreeStructure'), '检测关闭时修复不增加诊断 IPC');
assert.ok(messages.every(message => !message.diagnosticRequestId));

// 开启检测后复用已有 response-discarded 事件解释实例边界丢弃。
for (const listener of storageListeners) listener({ treeDebugConfig: { newValue: { enabled: true } } }, 'local');
const monitored = useTree();
monitored.onStructureChanged(() => {});
await load(monitored, [1, 2], { 1: structure('monitored-a', 8), 2: structure('monitored-a', 8) });
notify('monitored-b', { 1: 1, 2: 1 });
assert.equal(await load(monitored, [1], { 1: structure('monitored-b', 1, { 11: 12 }) }), true);
assert.equal(await load(monitored, [2], { 2: structure('monitored-b', 1, { 21: 22 }) }), true);
assert.deepEqual(monitored.parentsFor(1), { 11: 12 });
assert.deepEqual(monitored.parentsFor(2), { 21: 22 });
assert.equal(await load(responseFirst, [1], { 1: structure('c', 12) }), false);
await diagnostics.flush();
assert.ok(messages.some(message => message.events?.some(event =>
  event.payload.type === 'response-discarded' && event.payload.reason === 'stale-instance')));
diagnostics.dispose();
console.log('✓ 真实 useTree 跨实例降版本、通知/响应时序、多窗口、旧响应拒绝与加载失败状态');
