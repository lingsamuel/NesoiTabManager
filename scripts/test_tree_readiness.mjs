import assert from 'node:assert/strict';
import { encodeSnapshot, createTreeStateFromParents } from '../background/tree_core.js';

// 延迟真实后台所依赖的 API，而不是复制加载/继承实现。
let tabs = [];
let snapshot;
let storageRelease;
let reads = 0;
let queryError = false;
let storageError = false;
let writes = [];
const session = {};
const copy = value => structuredClone(value);
globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      set(value, cb) { writes.push(copy(value)); cb?.(); }, remove(_key, cb) { cb?.(); },
    },
    session: { get(key, cb) { cb({ [key]: session[key] }); }, set(value, cb) { Object.assign(session, value); cb?.(); } },
  },
  alarms: { create() {}, clear() {} },
  windows: { getAll(cb) { cb([{ id: 1 }]); } },
  tabs: {
    query(info, cb) {
      if (queryError) {
        chrome.runtime.lastError = { message: 'query failed' };
        cb(undefined);
        chrome.runtime.lastError = null;
        return;
      }
      cb(copy(tabs.filter(tab => (info.windowId == null || tab.windowId === info.windowId)
        && (info.index == null || tab.index === info.index) && (!info.active || tab.active))));
    },
    get(id, cb) { cb(copy(tabs.find(tab => tab.id === id))); },
    move(ids, info, cb) {
      const moving = ids.map(id => tabs.find(tab => tab.id === id)).filter(Boolean);
      for (const tab of moving) tab.windowId = info.windowId;
      const others = tabs.filter(tab => tab.windowId !== info.windowId && !ids.includes(tab.id));
      const target = tabs.filter(tab => tab.windowId === info.windowId && !ids.includes(tab.id));
      target.splice(info.index, 0, ...moving);
      tabs = [...others, ...target];
      reindex(); cb(copy(moving));
    },
  },
};

// 使用项目的真实键，测试不能因未命中快照而退化成另一种场景。
const { TREE_KEY_PREFIX, TREE_SESSION_TOKEN_KEY } = await import('../background/constants.js');
chrome.storage.local.get = (key, cb) => {
  if (!key.startsWith(TREE_KEY_PREFIX)) return cb({});
  reads += 1;
  const result = { [key]: copy(snapshot) };
  storageRelease = () => {
    if (storageError) chrome.runtime.lastError = { message: 'storage failed' };
    cb(result);
    chrome.runtime.lastError = null;
  };
};
session[TREE_SESSION_TOKEN_KEY] = 'ready-test';
const tick = () => new Promise(resolve => setImmediate(resolve));
function reindex() {
  const positions = new Map();
  for (const tab of tabs) {
    tab.index = positions.get(tab.windowId) || 0;
    positions.set(tab.windowId, tab.index + 1);
  }
}
function tab(id, parentId = null) { return { id, windowId: 1, index: 0, url: `https://example.invalid/${id}`, pinned: false, openerTabId: parentId ?? undefined }; }
let generation = 0;
async function setup(pairs) {
  tabs = pairs.map(([id]) => tab(id)); reindex();
  snapshot = encodeSnapshot(tabs, createTreeStateFromParents(new Map(pairs)), { sessionToken: 'ready-test' }).payload;
  reads = 0; storageRelease = null; queryError = false; storageError = false; writes = [];
  return import(`../background/tree.js?readiness=${++generation}`);
}
async function release() { await tick(); assert.ok(storageRelease, '恢复必须读取快照'); storageRelease(); await tick(); }
const cases = [];
function test(name, run) { cases.push({ name, run }); }

test('冷创建保留事件到达时的活动父，读请求等待完成，不重复增加下标', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  tree.handleTreeTabActivated({ windowId: 1, tabId: 2 });
  tabs.push(tab(3)); reindex();
  const created = tree.handleTreeTabCreated(copy(tabs[2]));
  tree.handleTreeTabActivated({ windowId: 1, tabId: 3 });
  let settled = false;
  const reading = tree.getTreeStructure([1]).then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false);
  await release(); await created;
  assert.equal((await reading).structures[1].parents[3], 2);
  assert.equal(reads, 1, '事件和读请求共享恢复');
  assert.equal(tree.getTabStructureInfo(3, 1).index, 2);
});

test('查询之后才创建的标签仍被登记，读响应不能漏掉它', async () => {
  const tree = await setup([[1, null]]);
  const reading = tree.getTreeStructure([1]); await tick();
  tabs.push(tab(2, 1)); reindex();
  const created = tree.handleTreeTabCreated(copy(tabs[1]));
  await release(); await created;
  assert.equal((await reading).structures[1].parents[2], 1);
  assert.equal(tree.getTabStructureInfo(2, 1).index, 1);
});

test('冷关闭主动等待并完成恢复，不依赖随后打开侧边栏', async () => {
  const tree = await setup([[1, null], [2, 1], [3, 2]]);
  tabs = tabs.filter(tab => tab.id !== 2); reindex();
  const removed = tree.handleTreeTabRemoved(2, { windowId: 1 });
  await release(); await removed;
  assert.equal(tree.getTabStructureInfo(3, 1)?.parentId, 1);
});

test('加载期间创建后立即关闭，不会被迟到创建复活', async () => {
  const tree = await setup([[1, null]]);
  const reading = tree.getTreeStructure([1]); await tick();
  tabs.push(tab(2, 1)); reindex();
  const created = tree.handleTreeTabCreated(copy(tabs[1]));
  tabs = tabs.filter(tab => tab.id !== 2); reindex();
  const removed = tree.handleTreeTabRemoved(2, { windowId: 1 });
  await release(); await Promise.all([created, removed, reading]);
  assert.equal(tree.getTabStructureInfo(2, 1), null);
});

test('恢复期间在父项下创建后关闭父项，新标签仍按关闭规则继承', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  const reading = tree.getTreeStructure([1]); await tick();
  tabs.push(tab(3, 2)); reindex();
  const created = tree.handleTreeTabCreated(copy(tabs[2]));
  tabs = tabs.filter(tab => tab.id !== 2); reindex();
  const removed = tree.handleTreeTabRemoved(2, { windowId: 1 });
  await release(); await Promise.all([created, removed]);
  assert.equal((await reading).structures[1].parents[3], 1);
});

test('恢复期间新建父子再关闭父项，存活子项仍继承祖父', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  const reading = tree.getTreeStructure([1]); await tick();
  tabs.push(tab(3, 2)); reindex();
  const parent = tree.handleTreeTabCreated(copy(tabs[2]));
  tabs.push(tab(4, 3)); reindex();
  const child = tree.handleTreeTabCreated(copy(tabs[3]));
  tabs = tabs.filter(tab => tab.id !== 3); reindex();
  const removed = tree.handleTreeTabRemoved(3, { windowId: 1 });
  await release(); await Promise.all([parent, child, removed]);
  assert.deepEqual((await reading).structures[1].parents, { 2: 1, 4: 2 });
  assert.equal(tree.getTabStructureInfo(3, 1), null);
});

test('冷移动等待恢复后按邻居推断父关系，不丢事件或重复移动下标', async () => {
  const tree = await setup([[1, null], [2, 1], [3, null]]);
  tabs = [tabs[0], tabs[2], tabs[1]]; reindex();
  const moving = tree.handleTreeTabMoved(3, { windowId: 1, fromIndex: 2, toIndex: 1 });
  await release(); await moving;
  assert.equal(tree.getTabStructureInfo(3, 1).parentId, 1);
  assert.equal(tree.getTabStructureInfo(2, 1).index, 2);
});

test('冷跨窗口移动等待源树恢复后保留整棵子树', async () => {
  const tree = await setup([[1, null], [2, 1], [3, 2]]);
  tabs[1].windowId = 2; tabs[1].index = 0; tabs[2].index = 1;
  const detached = tree.handleTreeTabDetached(2, { oldWindowId: 1, oldPosition: 1 });
  await release(); await detached;
  // 目标树使用即时存储回调；源树已恢复并采集迁移记录。
  const get = chrome.storage.local.get;
  chrome.storage.local.get = (_key, cb) => cb({});
  try {
    await tree.handleTreeTabAttached(2, { newWindowId: 2, newPosition: 0 });
    assert.equal(tabs.find(tab => tab.id === 3).windowId, 2);
    assert.equal(tree.getTabStructureInfo(3, 2).parentId, 2);
  } finally { chrome.storage.local.get = get; }
});

test('快速跨窗口来回不形成事件队列自等待', async () => {
  const tree = await setup([[1, null], [2, 1], [3, 2]]);
  const originalGet = chrome.storage.local.get;
  const callbacks = [];
  chrome.storage.local.get = (key, cb) => {
    callbacks.push(() => cb({ [key]: key === `${TREE_KEY_PREFIX}1` ? copy(snapshot) : undefined }));
  };
  try {
    tabs[1].windowId = 2; reindex();
    const firstDetach = tree.handleTreeTabDetached(2, { oldWindowId: 1, oldPosition: 1 });
    const firstAttach = tree.handleTreeTabAttached(2, { newWindowId: 2, newPosition: 0 });
    tabs[1].windowId = 1; reindex();
    const secondDetach = tree.handleTreeTabDetached(2, { oldWindowId: 2, oldPosition: 0 });
    const secondAttach = tree.handleTreeTabAttached(2, { newWindowId: 1, newPosition: 1 });
    await tick(); callbacks.forEach(fn => fn());
    await Promise.race([
      Promise.all([firstDetach, firstAttach, secondDetach, secondAttach]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('跨窗口恢复队列死锁')), 500)),
    ]);
    assert.equal(tree.getTabStructureInfo(3, 1)?.parentId, 2);
    assert.equal(tabs.find(tab => tab.id === 3).windowId, 1);
  } finally { chrome.storage.local.get = originalGet; }
});

test('冷批量关闭与热关闭的继承及物理位置一致', async () => {
  const pairs = [[1,null],[2,1],[3,null],[4,2],[5,2],[6,2],[7,4]];
  async function close(warm) {
    const tree = await setup(pairs);
    if (warm) { const reading = tree.getTreeStructure([1]); await release(); await reading; }
    const operations = [];
    for (const id of [4, 1, 2]) {
      tabs = tabs.filter(tab => tab.id !== id); reindex();
      operations.push(tree.handleTreeTabRemoved(id, { windowId: 1 }));
    }
    if (!warm) await release();
    await Promise.all(operations);
    const result = (await tree.getTreeStructure([1])).structures[1];
    return { parents: result.parents, ids: tabs.map(tab => tab.id) };
  }
  const warm = await close(true);
  assert.deepEqual(warm, { parents: { 5: 7, 6: 7 }, ids: [7, 5, 6, 3] });
  assert.deepEqual(await close(false), warm);
});

test('窗口在恢复期间关闭，加载结果不能复活缓存', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  const reading = tree.getTreeStructure([1]); reading.catch(() => {}); await tick();
  tabs = [];
  tree.handleTreeWindowRemoved(1);
  await release(); await reading.catch(() => {});
  assert.equal(tree.captureTreeDebugState(1), null);
});

test('浏览器查询失败不能作为空树成功返回，之后可以重试', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  queryError = true;
  const reading = tree.getTreeStructure([1]);
  const rejected = assert.rejects(reading, /query failed|加载|恢复/);
  rejected.catch(() => {});
  await release(); await rejected;
  queryError = false;
  const retry = tree.getTreeStructure([1]); await release();
  assert.equal((await retry).structures[1].parents[2], 1);
});

test('快照读取失败不降级为空快照，读请求失败后可重新恢复', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  storageError = true;
  const reading = tree.getTreeStructure([1]);
  const rejected = assert.rejects(reading, /storage failed|加载|恢复/); rejected.catch(() => {});
  await release(); await rejected;
  storageError = false;
  const retry = tree.getTreeStructure([1]); await release();
  assert.equal((await retry).structures[1].parents[2], 1);
});

test('撤销辅助入口在冷窗口刷新下标前也等待恢复', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  let settled = false;
  const refreshing = tree.refreshTreeIndexes(1).then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false);
  await release();
  assert.equal((await refreshing).get(2), 1);
  assert.equal(tree.getTabStructureInfo(2, 1).parentId, 1);
});

test('落盘查询失败保留脏窗口，后续调度仍能写入正确结构', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  const reading = tree.getTreeStructure([1]); await release(); await reading;
  tabs.push(tab(3, 2)); reindex();
  await tree.handleTreeTabCreated(copy(tabs[2]));
  queryError = true;
  tree.handleTreeSuspend(); await tick(); await tick();
  assert.equal(writes.some(value => value[`${TREE_KEY_PREFIX}1`]), false);
  queryError = false;
  tree.handleTreeSuspend(); await tick(); await tick();
  assert.equal(writes.some(value => value[`${TREE_KEY_PREFIX}1`]), true);
  assert.equal(tree.getTabStructureInfo(3, 1).parentId, 2);
});

test('浏览器启动恢复期间读请求等待稳定期，完成后共享一次加载', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  const realSetTimeout = globalThis.setTimeout;
  let finish;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 10000) { finish = fn; return 0; }
    if (ms === 60000) return 0;
    return realSetTimeout(fn, ms, ...args);
  };
  try { tree.initializeTreeSystem({ forceStartup: true }); }
  finally { globalThis.setTimeout = realSetTimeout; }
  let settled = false;
  const reading = tree.getTreeStructure([1]).then(result => { settled = true; return result; });
  await tick(); assert.equal(settled, false); assert.equal(reads, 0);
  finish(); await release();
  assert.equal((await reading).structures[1].parents[2], 1);
  assert.equal(reads, 1);
});

test('事件风暴进入静默期时已有缓存，后续创建仍等待并完整登记', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  const realSetTimeout = globalThis.setTimeout;
  let finish;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 10000) { finish = fn; return 0; }
    if (ms === 60000) return 0;
    return realSetTimeout(fn, ms, ...args);
  };
  try {
    tabs.push(tab(3, 2)); reindex();
    const first = tree.handleTreeTabCreated(copy(tabs.at(-1)));
    await release(); await first;
    for (let id = 4; id <= 21; id += 1) {
      tabs.push(tab(id, 2)); reindex();
      await tree.handleTreeTabCreated(copy(tabs.at(-1)));
    }
    tabs.push(tab(22, 2)); reindex();
    let settled = false;
    const last = tree.handleTreeTabCreated(copy(tabs.at(-1))).then(() => { settled = true; });
    await tick(); assert.ok(finish); assert.equal(settled, false);
    finish(); await last;
    assert.equal(tree.getTabStructureInfo(22, 1)?.parentId, 2);
    assert.equal(reads, 1, '已有缓存不需要再次读取旧快照');
  } finally { globalThis.setTimeout = realSetTimeout; }
});

test('等待启动稳定期时关闭窗口，不再发起恢复或复活缓存', async () => {
  const tree = await setup([[1, null], [2, 1]]);
  const realSetTimeout = globalThis.setTimeout;
  let finish;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 10000) { finish = fn; return 0; }
    if (ms === 60000) return 0;
    return realSetTimeout(fn, ms, ...args);
  };
  try { tree.initializeTreeSystem({ forceStartup: true }); }
  finally { globalThis.setTimeout = realSetTimeout; }
  const reading = tree.getTreeStructure([1]); reading.catch(() => {});
  await tick();
  tabs = [];
  tree.handleTreeWindowRemoved(1);
  finish(); await tick();
  // 失败版本仍会发起快照读取；放行它，避免测试挂起。
  if (storageRelease) storageRelease();
  await reading.catch(() => {});
  assert.equal(reads, 0);
  assert.equal(tree.captureTreeDebugState(1), null);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`✓ ${name}`); }
  catch (error) { failures += 1; console.error(`✗ ${name}`, error); }
}
process.exit(failures ? 1 : 0);
