// 后台树集成层的回归测试。
//
// 本插件没有浏览器自动化环境，而 tree.js 的全部风险都在"与 chrome.tabs 事件交互"这一层，
// 因此这里用一套最小可用的 chrome API 模拟来真实验证事件链路：建树、创建挂载、关闭提升、
// 原生拖动重推断、管理页拖拽、跨窗口子树迁移、落盘与重启恢复。
//
// 运行：npm run test:tree

// ---------------------------------------------------------------------------
// chrome API 模拟
// ---------------------------------------------------------------------------

const listeners = {
  created: [],
  removed: [],
  moved: [],
  detached: [],
  attached: [],
  activated: [],
};

let tabs = [];
let windows = [];
let nextTabId = 1000;
const storageData = { local: {}, session: {} };
const alarmsCreated = [];
const createdTabOptions = [];

function makeEvent(bucket) {
  return { addListener: (fn) => bucket.push(fn) };
}

function reindex() {
  // 数组顺序本身就是物理顺序，这里只按窗口顺序重新编号，绝不能按旧 index 再排序
  // （否则会把移动后的顺序还原回去，模拟器就失真了）。
  const counters = new Map();
  for (const tab of tabs) {
    const next = counters.get(tab.windowId) || 0;
    tab.index = next;
    counters.set(tab.windowId, next + 1);
  }
}

// storage.local.get 的模拟延迟（毫秒）。默认 0 = 同步回调，保持既有场景的时序不变；
// 需要制造"对齐正在飞行、事件插进 await 空档"的竞态时临时调大（见场景 12）。
let mockStorageDelayMs = 0;

function storageArea(area) {
  return {
    get(key, callback) {
      const result = {};
      if (typeof key === "string") {
        if (key in storageData[area]) {
          result[key] = clone(storageData[area][key]);
        }
      } else if (Array.isArray(key)) {
        for (const item of key) {
          if (item in storageData[area]) {
            result[item] = clone(storageData[area][item]);
          }
        }
      } else if (key === null || key === undefined) {
        for (const [k, v] of Object.entries(storageData[area])) {
          result[k] = clone(v);
        }
      }
      if (mockStorageDelayMs > 0) {
        setTimeout(() => callback(result), mockStorageDelayMs);
        return;
      }
      callback(result);
    },
    set(obj, callback) {
      for (const [k, v] of Object.entries(obj)) {
        storageData[area][k] = clone(v);
      }
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        delete storageData[area][key];
      }
      if (callback) {
        callback();
      }
    },
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function moveTabsMock(tabIds, info, callback) {
  const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number);
  const windowId = Number(info.windowId);
  // 只在目标窗口的局部顺序里搬运，避免把其它窗口的标签也算进下标。
  const inWindow = tabs.filter((tab) => tab.windowId === windowId);
  const moving = ids
    .map((id) => inWindow.find((tab) => tab.id === id))
    .filter(Boolean);
  if (moving.length === 0) {
    globalThis.chrome.runtime.lastError = { message: "No tab with given id" };
    callback && callback([]);
    globalThis.chrome.runtime.lastError = null;
    return;
  }
  const rest = inWindow.filter((tab) => !ids.includes(tab.id));
  let index = Number.isFinite(info.index) && info.index >= 0 ? info.index : rest.length;
  index = Math.max(0, Math.min(index, rest.length));
  rest.splice(index, 0, ...moving);
  const others = tabs.filter((tab) => tab.windowId !== windowId);
  tabs = [...others, ...rest];
  reindex();
  if (callback) {
    callback(moving.slice());
  }
}

function setupChromeMock() {
  const runtime = { lastError: null };
  globalThis.chrome = {
    runtime,
    storage: { local: storageArea("local"), session: storageArea("session") },
    alarms: {
      create: (name, info) => alarmsCreated.push({ name, info }),
      clear: () => {},
    },
    windows: {
      getAll: (callback) => callback(windows.map((win) => ({ id: win.id }))),
    },
    tabs: {
      onCreated: makeEvent(listeners.created),
      onRemoved: makeEvent(listeners.removed),
      onMoved: makeEvent(listeners.moved),
      onDetached: makeEvent(listeners.detached),
      onAttached: makeEvent(listeners.attached),
      onActivated: makeEvent(listeners.activated),
      query: (info, callback) => {
        let result = tabs.slice();
        if (Number.isFinite(info.windowId)) {
          result = result.filter((tab) => tab.windowId === info.windowId);
        }
        if (Number.isFinite(info.index)) {
          result = result.filter((tab) => tab.index === info.index);
        }
        if (info.active) {
          result = result.filter((tab) => tab.active);
        }
        callback(result.sort((a, b) => a.index - b.index));
      },
      get: (id, callback) => {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) {
          runtime.lastError = { message: "No tab with given id" };
          callback(undefined);
          runtime.lastError = null;
          return;
        }
        callback({ ...tab });
      },
      create: (options, callback) => {
        createdTabOptions.push(clone(options));
        const tab = addTab({
          windowId: Number(options.windowId),
          index: Number.isFinite(options.index) ? Number(options.index) : null,
          active: Boolean(options.active),
          url: options.url || "about:newtab",
          title: "新标签页",
        });
        const snapshotTab = { ...tab };
        if (callback) {
          callback(snapshotTab);
        }
        // 真实浏览器在创建之后才异步派发 onCreated，这里保持同样的时序。
        emitAsync(listeners.created, snapshotTab);
        return snapshotTab;
      },
      move: (tabIds, info, callback) => moveTabsMock(tabIds, info, callback),
      remove: (ids, callback) => {
        const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
        tabs = tabs.filter((tab) => !list.includes(tab.id));
        reindex();
        callback && callback();
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 事件派发辅助
// ---------------------------------------------------------------------------

function emit(bucket, ...args) {
  for (const fn of bucket) {
    fn(...args);
  }
}

function emitAsync(bucket, ...args) {
  return new Promise((resolve) => {
    setTimeout(() => {
      emit(bucket, ...args);
      resolve();
    }, 0);
  });
}

function addTab({ windowId = 1, pinned = false, url = "", title = "", openerTabId = null, index = null } = {}) {
  const id = nextTabId;
  nextTabId += 1;
  const tab = { id, windowId, pinned, url, title, openerTabId, index: 0, active: false };
  const others = tabs.filter((item) => item.windowId !== windowId);
  const inWindow = tabs.filter((item) => item.windowId === windowId);
  const at = index === null ? inWindow.length : index;
  inWindow.splice(at, 0, tab);
  inWindow.forEach((item, i) => {
    item.index = i;
  });
  tabs = [...others, ...inWindow];
  reindex();
  return tab;
}

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function assertEqual(actual, expected, label) {
  checks += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`✗ ${label}：期望 ${expected}，实际 ${actual}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  checks += 1;
  if (a !== b) {
    failures += 1;
    console.error(`✗ ${label}：期望 ${b}，实际 ${a}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 测试场景
// ---------------------------------------------------------------------------

async function main() {
  setupChromeMock();
  const tree = await import("../background/tree.js");

  windows = [{ id: 1 }, { id: 2 }];
  tree.initializeTreeSystem();

  // --- 场景 1：冷启动用 openerTabId 建树 ---
  console.log("场景 1：冷启动按 openerTabId 建树");
  const a = addTab({ url: "https://a.example.com/", title: "A" });
  const b = addTab({ url: "https://b.example.com/", openerTabId: a.id, title: "B" });
  const c = addTab({ url: "https://c.example.com/", openerTabId: b.id, title: "C" });
  const d = addTab({ url: "https://d.example.com/", openerTabId: a.id, title: "D" });
  const pinned = addTab({ url: "https://p.example.com/", pinned: true, title: "P" });
  let snapshot = await tree.getTreeStructure([1]);
  assertEqual(snapshot.structures[1].parents[b.id], a.id, "B 的父是 A");
  assertEqual(snapshot.structures[1].parents[c.id], b.id, "C 的父是 B");
  assertEqual(snapshot.structures[1].parents[d.id], a.id, "D 的父是 A");
  assertEqual(snapshot.structures[1].parents[pinned.id], undefined, "固定标签是顶层");

  // --- 场景 2：新标签挂到 opener 下 ---
  console.log("场景 2：新建标签挂到 opener 下");
  const e = addTab({ url: "https://e.example.com/", openerTabId: c.id, title: "E" });
  await tree.handleTreeTabCreated(e);
  snapshot = await tree.getTreeStructure([1]);
  assertEqual(snapshot.structures[1].parents[e.id], c.id, "E 的父是 C");

  // --- 场景 3：无 opener 时挂到当前活动标签 ---
  console.log("场景 3：无 opener 的新标签挂到活动标签");
  tree.handleTreeTabActivated({ windowId: 1, tabId: d.id });
  const f = addTab({ url: "https://f.example.com/", title: "F" });
  await tree.handleTreeTabCreated(f);
  snapshot = await tree.getTreeStructure([1]);
  assertEqual(snapshot.structures[1].parents[f.id], d.id, "F 的父是活动标签 D");

  // --- 场景 3b：底部 New Tab 创建的标签必须是顶层，而不是挂在活动标签下 ---
  console.log("场景 3b：底部 New Tab（createRootTab）创建的是顶层标签");
  // 对照：场景 3 里直接 chrome.tabs.create 的 F 挂到了活动标签 D 之下
  assertEqual(snapshot.structures[1].parents[f.id], d.id, "对照：普通新建仍挂在活动标签下");
  const windowOneCount = tabs.filter((tab) => tab.windowId === 1).length;
  const rootCreated = await tree.createRootTab({ windowId: 1 });
  await tick(20);
  const rootTab = tabs.find((tab) => tab.id === rootCreated.tabId);
  assertEqual(Boolean(rootTab), true, "标签已创建");
  assertEqual(createdTabOptions[createdTabOptions.length - 1].index, windowOneCount, "显式指定 index = 原标签数（追加到窗口末尾）");
  snapshot = await tree.getTreeStructure([1]);
  assertEqual(snapshot.structures[1].parents[rootCreated.tabId], undefined, "新标签是顶层，未挂到活动标签 D 之下");

  // --- 场景 4：关闭父标签的 promote intelligently ---
  console.log("场景 4：关闭父标签（D 是 A 的非唯一子标签 → 提升第一个子标签 F 到祖父 A 之下）");
  tabs = tabs.filter((tab) => tab.id !== d.id);
  reindex();
  tree.handleTreeTabRemoved(d.id, { windowId: 1, isWindowClosing: false });
  snapshot = await tree.getTreeStructure([1]);
  assertEqual(snapshot.structures[1].parents[f.id], a.id, "F 被提升到祖父 A 之下");

  console.log("场景 4b：关闭父标签（A 有多个子标签 → 提升第一个）");
  // 此刻 A 的子标签为 B、F
  tabs = tabs.filter((tab) => tab.id !== a.id);
  reindex();
  tree.handleTreeTabRemoved(a.id, { windowId: 1, isWindowClosing: false });
  snapshot = await tree.getTreeStructure([1]);
  assertEqual(snapshot.structures[1].parents[b.id], undefined, "第一个子标签 B 接替为顶层");
  assertEqual(snapshot.structures[1].parents[f.id], b.id, "其余子标签挂到 B 之下");

  console.log("场景 4c：关闭唯一子标签（Y 是 X 的唯一子标签 → 提升全部子标签）");
  const x = addTab({ windowId: 3, url: "https://x.example.com/", title: "X" });
  const y = addTab({ windowId: 3, url: "https://y.example.com/", openerTabId: x.id, title: "Y" });
  const z = addTab({ windowId: 3, url: "https://z.example.com/", openerTabId: y.id, title: "Z" });
  const w = addTab({ windowId: 3, url: "https://w.example.com/", openerTabId: y.id, title: "W" });
  await tree.getTreeStructure([3]);
  tabs = tabs.filter((tab) => tab.id !== y.id);
  reindex();
  tree.handleTreeTabRemoved(y.id, { windowId: 3, isWindowClosing: false });
  snapshot = await tree.getTreeStructure([3]);
  assertEqual(snapshot.structures[3].parents[z.id], x.id, "Z 被提升到祖父 X 之下");
  assertEqual(snapshot.structures[3].parents[w.id], x.id, "W 被提升到祖父 X 之下");

  // --- 场景 5：原生拖动按新位置重新推断 ---
  console.log("场景 5：原生拖动把标签移出原树");
  // 当前树：B(根) ← C ← E；B ← F
  // 把 E 拖到窗口最前（index 0）→ 应变为顶层
  const eIndex = tabs.find((tab) => tab.id === e.id).index;
  const others5 = tabs.filter((tab) => tab.id !== e.id);
  others5.unshift(tabs.find((tab) => tab.id === e.id));
  tabs = others5;
  reindex();
  await tree.handleTreeTabMoved(e.id, { windowId: 1, fromIndex: eIndex, toIndex: 0 });
  snapshot = await tree.getTreeStructure([1]);
  assertEqual(snapshot.structures[1].parents[e.id], undefined, "移到最前的 E 成为顶层");

  // --- 场景 6：管理页拖拽改父子 + 物理移动 ---
  console.log("场景 6：管理页把 E 拖到 C 上（成为子标签）");
  const result = await tree.moveTabTree({ tabId: e.id, parentId: c.id, afterTabId: c.id });
  assertEqual(result.ok === undefined ? true : result.ok, true, "moveTabTree 返回成功");
  snapshot = await tree.getTreeStructure([1]);
  assertEqual(snapshot.structures[1].parents[e.id], c.id, "E 的父变回 C");
  const orderIds = tabs.filter((tab) => tab.windowId === 1).sort((x, y) => x.index - y.index).map((tab) => tab.id);
  assertEqual(orderIds.indexOf(e.id), orderIds.indexOf(c.id) + 1, "E 被物理移动到 C 之后");

  // --- 场景 7：拒绝非法拖拽 ---
  console.log("场景 7：拒绝把父标签拖到自己的子孙之下");
  let rejected = false;
  try {
    await tree.moveTabTree({ tabId: b.id, parentId: e.id, afterTabId: e.id });
  } catch (error) {
    rejected = /子孙/.test(String(error.message));
  }
  assertEqual(rejected, true, "拖到自己的子孙下被拒绝");

  console.log("场景 7b：拒绝把固定标签挂到别的标签下");
  rejected = false;
  try {
    await tree.moveTabTree({ tabId: pinned.id, parentId: b.id });
  } catch (error) {
    rejected = /固定标签/.test(String(error.message));
  }
  assertEqual(rejected, true, "固定标签参与父子被拒绝");

  // --- 场景 8：跨窗口迁移整棵子树 ---
  console.log("场景 8：把 B（带子树）拖到窗口 2");
  const subtree = [b.id, c.id, e.id, f.id];
  // 模拟 Chrome 的 onDetached → onAttached 顺序
  for (const id of [b.id, ...subtree.filter((x) => x !== b.id)]) {
    const tab = tabs.find((item) => item.id === id);
    if (tab) {
      tab.windowId = 2;
    }
  }
  reindex();
  tree.handleTreeTabDetached(b.id, { oldWindowId: 1, oldPosition: 0 });
  await tree.handleTreeTabAttached(b.id, { newWindowId: 2, newPosition: 0 });
  const win2 = await tree.getTreeStructure([2]);
  assertEqual(win2.structures[2].parents[c.id], b.id, "跨窗口后 C 仍挂在 B 下");
  assertEqual(win2.structures[2].parents[e.id], c.id, "跨窗口后 E 仍挂在 C 下");
  assertEqual(win2.structures[2].parents[f.id], b.id, "跨窗口后 F 仍挂在 B 下");
  const win2Order = tabs
    .filter((tab) => tab.windowId === 2)
    .sort((left, right) => left.index - right.index)
    .map((tab) => tab.id);
  assertEqual(
    win2Order.indexOf(e.id) > win2Order.indexOf(c.id),
    true,
    "迁移后子标签仍排在父标签之后（物理顺序未被打乱）"
  );

  // --- 场景 9：落盘与重启恢复 ---
  console.log("场景 9：落盘与重启恢复");
  await tree.handleTreeSuspend();
  await tick(10);
  const keys = Object.keys(storageData.local).filter((key) => key.startsWith("treeStructure:"));
  assertEqual(keys.length >= 2, true, "两个窗口都写出了快照");
  const win1Snapshot = storageData.local["treeStructure:1"];
  assertEqual(Array.isArray(win1Snapshot && win1Snapshot.items), true, "快照结构合法");

  // 模拟浏览器重启：标签 id 全部变化、顺序不变，用快照恢复父子关系
  const rebuilt = [];
  let baseId = 50000;
  for (const key of keys) {
    const windowId = Number(key.split(":")[1]);
    const saved = storageData.local[key];
    for (const item of saved.items) {
      baseId += 1;
      rebuilt.push({
        id: baseId,
        windowId,
        pinned: false,
        url: item.u,
        title: item.t || "",
        openerTabId: null,
        index: rebuilt.filter((tab) => tab.windowId === windowId).length,
        active: false,
      });
    }
  }
  tabs = rebuilt;
  windows = [{ id: 1 }, { id: 2 }];
  const freshTree = await import(`../background/tree.js?restart=${Date.now()}`);
  freshTree.initializeTreeSystem();
  const restored = await freshTree.getTreeStructure([2]);
  const restoredWin2 = restored.structures[2].parents;
  // 按 URL 反查重建后的 id：迁移后的物理顺序由实现决定，断言应针对"关系"而不是顺序。
  const urlById = new Map(rebuilt.map((tab) => [tab.id, tab.url]));
  const idByUrl = new Map(rebuilt.map((tab) => [tab.url, tab.id]));
  const parentUrlOf = (url) => urlById.get(restoredWin2[idByUrl.get(url)]);
  assertEqual(parentUrlOf("https://c.example.com/"), "https://b.example.com/", "重启后 C 仍挂在 B 下");
  assertEqual(parentUrlOf("https://e.example.com/"), "https://c.example.com/", "重启后 E 仍挂在 C 下");
  assertEqual(parentUrlOf("https://f.example.com/"), "https://b.example.com/", "重启后 F 仍挂在 B 下");
  assertEqual(parentUrlOf("https://b.example.com/"), undefined, "重启后 B 仍是顶层");

  // --- 场景 10：后台被回收时父标签被关闭，之后只能靠快照重建 ---
  // 触发条件：MV3 的 SW 空闲被回收后，tabs.onRemoved 到达时 trees 里没有该窗口的树，
  // handleTreeTabRemoved 会直接返回（不做提升）；用户随后打开管理页/侧边栏才首次对齐，
  // 此时快照里仍有已被关闭的父标签。回归点：子标签必须"就近提升"到祖父，而不是被抬成顶层。
  console.log("场景 10：后台被回收后父标签被关闭（快照重建路径）");
  const seedOrphanSnapshot = (windowId, items) => {
    storageData.local[`treeStructure:${windowId}`] = {
      v: 1,
      at: Date.now(),
      n: items.length,
      items,
    };
  };

  // 10a：CDE 与被关闭的 B 的 URL 各不相同（唯一 URL 能靠位置修正配对）
  windows.push({ id: 5 });
  seedOrphanSnapshot(5, [
    { u: "https://a.example.com/", t: "A", p: -1 },
    { u: "https://b.example.com/", t: "B", p: 0 },
    { u: "https://c.example.com/", t: "C", p: 1 },
    { u: "https://d.example.com/", t: "D", p: 1 },
    { u: "https://e.example.com/", t: "E", p: 1 },
  ]);
  const a10 = addTab({ windowId: 5, url: "https://a.example.com/", title: "A" });
  const c10 = addTab({ windowId: 5, url: "https://c.example.com/", title: "C" });
  const d10 = addTab({ windowId: 5, url: "https://d.example.com/", title: "D" });
  const e10 = addTab({ windowId: 5, url: "https://e.example.com/", title: "E" });
  let rebuilt10 = await tree.getTreeStructure([5]);
  assertEqual(rebuilt10.structures[5].parents[c10.id], a10.id, "10a：C 就近提升到祖父 A 之下");
  assertEqual(rebuilt10.structures[5].parents[d10.id], a10.id, "10a：D 就近提升到祖父 A 之下");
  assertEqual(rebuilt10.structures[5].parents[e10.id], a10.id, "10a：E 就近提升到祖父 A 之下");

  // 10b：CDE 都是新标签页（URL 完全相同）——同名 URL 最容易让配对整体错位，
  // 错位后真正的子标签会被当成"新增标签"或父下标落空，最终全部变顶层。
  windows.push({ id: 6 });
  seedOrphanSnapshot(6, [
    { u: "https://f.example.com/", t: "F", p: -1 },
    { u: "https://g.example.com/", t: "G", p: 0 },
    { u: "chrome://newtab/", t: "H", p: 1 },
    { u: "chrome://newtab/", t: "I", p: 1 },
    { u: "chrome://newtab/", t: "J", p: 1 },
  ]);
  const f10 = addTab({ windowId: 6, url: "https://f.example.com/", title: "F" });
  const h10 = addTab({ windowId: 6, url: "chrome://newtab/", title: "H" });
  const i10 = addTab({ windowId: 6, url: "chrome://newtab/", title: "I" });
  const j10 = addTab({ windowId: 6, url: "chrome://newtab/", title: "J" });
  rebuilt10 = await tree.getTreeStructure([6]);
  assertEqual(rebuilt10.structures[6].parents[h10.id], f10.id, "10b：新标签页 H 就近提升到祖父 F 之下");
  assertEqual(rebuilt10.structures[6].parents[i10.id], f10.id, "10b：新标签页 I 就近提升到祖父 F 之下");
  assertEqual(rebuilt10.structures[6].parents[j10.id], f10.id, "10b：新标签页 J 就近提升到祖父 F 之下");

  // 10c：整条祖先链都已关闭 → 只能落顶层（不变量要求父标签必须真实存在）
  windows.push({ id: 7 });
  seedOrphanSnapshot(7, [
    { u: "https://m.example.com/", t: "M", p: -1 },
    { u: "https://n.example.com/", t: "N", p: 0 },
    { u: "https://o.example.com/", t: "O", p: 1 },
  ]);
  const o10 = addTab({ windowId: 7, url: "https://o.example.com/", title: "O" });
  rebuilt10 = await tree.getTreeStructure([7]);
  assertEqual(rebuilt10.structures[7].parents[o10.id], undefined, "10c：祖先全部关闭时 O 落回顶层");

  // --- 场景 11：子标签已被卸载（discard / 冻结），URL 拿不到 ---
  // 已卸载标签的 URL 不可靠（Firefox 曾经完全取不到，现在也可能给出 about:blank），
  // 若因此把它们判成"新增标签"，父子关系会整条丢失、整棵子树被抬成顶层。
  // 回归点：这类"身份不可知"的标签必须按位置与快照配对，保住父子链。
  console.log("场景 11：子标签已卸载导致 URL 不可用（身份不可知 → 按位置配对）");
  const parentsOf = (snapshot, windowId) => snapshot.structures[windowId].parents;
  // 沿父链上溯到顶层，用来断言"仍挂在原来的祖先之下"而不是看具体是第几层
  const rootOf = (parents, tabId) => {
    let cursor = tabId;
    let guard = 0;
    while (parents[cursor] !== undefined && guard < 32) {
      cursor = parents[cursor];
      guard += 1;
    }
    return cursor;
  };

  for (const [windowId, unavailableUrl] of [[8, ""], [9, "about:blank"]]) {
    windows.push({ id: windowId });
    seedOrphanSnapshot(windowId, [
      { u: "https://p.example.com/", t: "P", p: -1 },
      { u: "https://q.example.com/", t: "Q", p: 0 },
      { u: "about:newtab", t: "R", p: 1 },
      { u: "about:newtab", t: "S", p: 1 },
      { u: "about:newtab", t: "T", p: 1 },
    ]);
    const p11 = addTab({ windowId, url: "https://p.example.com/", title: "P" });
    // 被关闭的 Q 的 id 已不可知：这里用一个窗口内不存在的 id 模拟"opener 已被关闭"
    const r11 = addTab({ windowId, url: unavailableUrl, title: "R", openerTabId: 999999 });
    const s11 = addTab({ windowId, url: unavailableUrl, title: "S", openerTabId: 999999 });
    const t11 = addTab({ windowId, url: unavailableUrl, title: "T", openerTabId: 999999 });
    for (const tab of [r11, s11, t11]) {
      tab.discarded = true;
    }
    rebuilt10 = await tree.getTreeStructure([windowId]);
    const parents = parentsOf(rebuilt10, windowId);
    const label = unavailableUrl === "" ? "url 为空" : "url 变成 about:blank";
    assertEqual(parents[r11.id] !== undefined, true, `11（${label}）：R 没有被抬成顶层`);
    assertEqual(parents[s11.id] !== undefined, true, `11（${label}）：S 没有被抬成顶层`);
    assertEqual(parents[t11.id] !== undefined, true, `11（${label}）：T 没有被抬成顶层`);
    assertEqual(rootOf(parents, r11.id), p11.id, `11（${label}）：R 的祖先链仍回到 P`);
    assertEqual(rootOf(parents, s11.id), p11.id, `11（${label}）：S 的祖先链仍回到 P`);
    assertEqual(rootOf(parents, t11.id), p11.id, `11（${label}）：T 的祖先链仍回到 P`);
  }

  // --- 场景 12：关闭事件恰好落在"树正在对齐"的空档里 ---
  // 触发条件：树不在内存里（后台被回收），用户的操作先触发了 loadTree。
  // loadTree 是「先 queryWindowTabs 拿到标签列表、再 await storageGet 等快照」，
  // 若关闭恰好落在这两步之间，装好的树里就会留下一个"幽灵父标签"（B 已关闭却仍挂在树上）。
  // 之后任何一次落盘都会跑不变量校验，旧实现会把 B 的子标签全部抬成顶层并把损坏写进快照。
  // 回归点：关闭必须延后补做提升，且落盘后的快照里子标签仍然挂在祖父之下。
  console.log("场景 12：树加载中到达的关闭（幽灵父标签）");
  windows.push({ id: 10 });
  seedOrphanSnapshot(10, [
    { u: "https://a12.example.com/", t: "A", p: -1 },
    { u: "https://b12.example.com/", t: "B", p: 0 },
    { u: "https://c12.example.com/", t: "C", p: 1 },
    { u: "https://d12.example.com/", t: "D", p: 1 },
    { u: "https://e12.example.com/", t: "E", p: 1 },
  ]);
  const a12 = addTab({ windowId: 10, url: "https://a12.example.com/", title: "A" });
  const b12 = addTab({ windowId: 10, url: "https://b12.example.com/", title: "B" });
  const c12 = addTab({ windowId: 10, url: "https://c12.example.com/", title: "C" });
  const d12 = addTab({ windowId: 10, url: "https://d12.example.com/", title: "D" });
  const e12 = addTab({ windowId: 10, url: "https://e12.example.com/", title: "E" });
  mockStorageDelayMs = 30;
  const loading12 = tree.getTreeStructure([10]);
  await tick(10); // queryWindowTabs 已经返回（列表含 B），树还没装进内存
  tabs = tabs.filter((tab) => tab.id !== b12.id);
  reindex();
  tree.handleTreeTabRemoved(b12.id, { windowId: 10, isWindowClosing: false });
  await loading12;
  mockStorageDelayMs = 0;
  const parents12 = parentsOf(await tree.getTreeStructure([10]), 10);
  assertEqual(parents12[c12.id], a12.id, "12：C 被提升到祖父 A 之下");
  assertEqual(parents12[d12.id], a12.id, "12：D 被提升到祖父 A 之下");
  assertEqual(parents12[e12.id], a12.id, "12：E 被提升到祖父 A 之下");
  assertEqual(parents12[b12.id], undefined, "12：已关闭的 B 不再是任何标签的父");
  // 真实使用中的暴露时机：下一次结构变化把窗口置脏，落盘时才会跑不变量校验。
  // 旧实现此时才把 C/D/E 抬成顶层，并把 p = -1 写进快照（结构永久损坏）。
  const f12 = addTab({ windowId: 10, url: "https://f12.example.com/", title: "F" });
  await tree.handleTreeTabCreated(f12);
  await tree.handleTreeSuspend();
  await tick(20);
  const saved12 = storageData.local["treeStructure:10"];
  const indexOfUrl12 = (url) => saved12.items.findIndex((item) => item.u === url);
  const a12Index = indexOfUrl12("https://a12.example.com/");
  assertEqual(indexOfUrl12("https://b12.example.com/"), -1, "12：快照里不再有已关闭的 B");
  assertEqual(saved12.items[indexOfUrl12("https://c12.example.com/")].p, a12Index, "12：快照里 C 的父下标是 A");
  assertEqual(saved12.items[indexOfUrl12("https://d12.example.com/")].p, a12Index, "12：快照里 D 的父下标是 A");
  assertEqual(saved12.items[indexOfUrl12("https://e12.example.com/")].p, a12Index, "12：快照里 E 的父下标是 A");

  // --- 场景 13：不变量校验（sanitizeTreeState）的就近改挂语义 ---
  // 这是内存树与磁盘快照之间最后一道纠偏，必须与"关闭标签"的 promote intelligently 同口径：
  // 关系不合法时先沿父链向上改挂，整条链都没有存活祖先才落顶层。
  console.log("场景 13：不变量校验的就近改挂语义");
  const core = await import("../background/tree_core.js");
  // 13a：父已不在窗口里 → 子标签接回祖父（这正是"幽灵父标签"落地时的情形）
  const ghost = core.createTreeStateFromParents(
    new Map([[1, null], [4, 1], [5, 4], [6, 4], [2, null], [3, null]])
  );
  core.sanitizeTreeState(ghost, [1, 5, 6, 2, 3], null);
  assertEqual(ghost.parentById.get(5), 1, "13a：父已关闭时子标签接回祖父");
  assertEqual(ghost.parentById.get(6), 1, "13a：父已关闭时第二个子标签也接回祖父");
  // 13b：父链上连续多个节点都已关闭 → 一直接到最近的存活祖先
  const deep = core.createTreeStateFromParents(new Map([[1, null], [7, 1], [8, 7], [9, 8]]));
  core.sanitizeTreeState(deep, [1, 9], null);
  assertEqual(deep.parentById.get(9), 1, "13b：连续多个已关闭的父 → 接到最近的存活祖先");
  // 13c：整条父链都没有存活祖先 → 顶层（父标签必须真实存在）
  const orphan = core.createTreeStateFromParents(new Map([[4, null], [5, 4]]));
  core.sanitizeTreeState(orphan, [5], null);
  assertEqual(orphan.parentById.get(5), null, "13c：整条父链都没有存活祖先 → 顶层");
  // 13d：固定标签一律顶层；固定标签不能作为父，子标签要跳过它继续向上
  const pinnedState = core.createTreeStateFromParents(new Map([[1, null], [2, 1], [3, 2]]));
  core.sanitizeTreeState(pinnedState, [1, 2, 3], new Set([2]));
  assertEqual(pinnedState.parentById.get(2), null, "13d：固定标签自己一律顶层");
  assertEqual(pinnedState.parentById.get(3), 1, "13d：父是固定标签时跳过它，接到它的父");
  // 13e：父排在子之后 → 关系非法；这里父已没有更上层的存活祖先 → 顶层
  const behind = core.createTreeStateFromParents(new Map([[1, null], [2, null], [3, 2]]));
  core.sanitizeTreeState(behind, [1, 3, 2], null);
  assertEqual(behind.parentById.get(3), null, "13e：父排在子之后且无更高祖先 → 顶层");

  // --- 场景 14：同一浏览器会话内标签导航换了 URL，层级必须保留 ---
  // 触发条件：后台被回收后，用户在某个子标签的地址栏里搜索/跳转（URL 变了），
  // 这次导航本身触发了首次对齐。旧实现只认 URL：该标签的 URL 对不上快照 →
  // 被判成"已关闭"+有一个"新增标签"，于是它自己被抬成顶层，父子关系整条丢失。
  // 回归点：同一会话内 tabId 是权威身份（快照 sid 与会话令牌一致），导航不影响层级。
  console.log("场景 14：导航换 URL 后后台被回收（会话内 tabId 可信 → 层级保留）");
  windows.push({ id: 11 });
  const a14 = addTab({ windowId: 11, url: "https://a14.example.com/", title: "A" });
  await tree.getTreeStructure([11]); // 先把树加载起来（此时窗口里只有 A）
  // B/C/D 都没有 opener：它们的父关系只存在于本插件的树里（"新标签挂到活动标签下"规则），
  // 这正是"重载时只能靠快照认身份"的场景——旧实现会把它们判成新增标签并抬成顶层。
  tree.handleTreeTabActivated({ windowId: 11, tabId: a14.id });
  const b14 = addTab({ windowId: 11, url: "https://b14.example.com/", title: "B" });
  await tree.handleTreeTabCreated(b14);
  tree.handleTreeTabActivated({ windowId: 11, tabId: b14.id });
  const c14 = addTab({ windowId: 11, url: "https://c14.example.com/", title: "C" });
  await tree.handleTreeTabCreated(c14);
  const d14 = addTab({ windowId: 11, url: "https://d14.example.com/", title: "D" });
  await tree.handleTreeTabCreated(d14);
  await tree.handleTreeSuspend();
  await tick(20);
  // 地址栏 paste and go：B 的 URL 变成搜索页
  tabs.find((tab) => tab.id === b14.id).url = "https://search14.example.com/?q=hello";
  // 后台被回收：新模块实例（内存树为空），但 storage.session 的会话令牌与 tabId 都还在
  const tree14 = await import(`../background/tree.js?reclaim=${Date.now()}`);
  tree14.initializeTreeSystem();
  const parents14 = parentsOf(await tree14.getTreeStructure([11]), 11);
  assertEqual(parents14[b14.id], a14.id, "14：导航后 B 仍挂在 A 下");
  assertEqual(parents14[c14.id], b14.id, "14：导航后 C 仍挂在 B 下");
  assertEqual(parents14[d14.id], b14.id, "14：导航后 D 仍挂在 B 下");
  // URL 变了 ⇒ 快照内容已过期，必须回写（URL 是跨重启唯一的配对依据）
  await tree14.handleTreeSuspend();
  await tick(20);
  const saved14 = storageData.local["treeStructure:11"];
  const b14Item = saved14.items.find((item) => item.i === b14.id);
  assertEqual(b14Item.u, "https://search14.example.com/?q=hello", "14：快照回写了导航后的 URL");

  // --- 场景 15：跨浏览器重启时快照里的 tabId 不可信（会话令牌失效）→ 忽略 id，仍按 URL 配对 ---
  console.log("场景 15：跨浏览器重启时忽略快照里的 tabId");
  const live15 = [
    { id: 400, url: "https://a15.example.com/", pinned: false },
    { id: 401, url: "https://search15.example.com/?q=hello", pinned: false },
    { id: 402, url: "https://c15.example.com/", pinned: false },
  ];
  // 快照：A 顶层、B 挂 A、C 挂 B；B 的 URL 是导航前的旧值（跨重启后只能靠 URL 认它）
  const snap15 = {
    v: 2,
    at: Date.now(),
    n: 3,
    sid: "session-before-restart",
    items: [
      { u: "https://a15.example.com/", p: -1, i: 400 },
      { u: "https://b15.example.com/", p: 0, i: 401 },
      { u: "https://c15.example.com/", p: 1, i: 402 },
    ],
  };
  // 令牌一致（同一会话）：按 id 命中，B 的 URL 变了也照样挂回 A
  const trusted15 = core.alignSnapshotToTabs(live15, snap15, { sessionToken: "session-before-restart" });
  assertEqual(trusted15.state.parentById.get(401), 400, "15：令牌一致时 B 按 tabId 挂回 A");
  assertEqual(trusted15.state.parentById.get(402), 401, "15：令牌一致时 C 按 tabId 挂回 B");
  // 令牌不一致（浏览器已重启，tabId 可能复用）：必须完全忽略 i，退回 URL 对齐
  const untrusted15 = core.alignSnapshotToTabs(live15, snap15, { sessionToken: "session-after-restart" });
  assertEqual(untrusted15.state.parentById.get(401), null, "15：令牌不一致时 B 的旧 URL 对不上 → 顶层");
  assertEqual(untrusted15.state.parentById.get(402), 400, "15：令牌不一致时 C 就近提升到祖父 A");

  // --- 场景 16：子索引残留（childIdsById 与 parentById 不同步）不得牵动无关标签 ---
  // 任何绕过 setParent 的直接写都会让"父映射里已经顶层、子索引里还留着"的标签出现。
  // 关闭那个父时，旧实现会把这个其实早已顶层的标签当成子标签提升进树
  // ——表现为"关掉一个标签，几个毫不相干的标签突然被重排"。
  console.log("场景 16：子索引残留不得被当成子标签");
  const leakState = core.createTreeStateFromParents(new Map([[1, null], [2, 1], [3, 2]]));
  // 1=A（顶层）、2=B（挂 A）、3=C（挂 B）；把 C 改成顶层但不修子索引，模拟残留
  leakState.parentById.set(3, null);
  assertDeepEqual(core.collectSubtreeIds(leakState, 2), [2], "16：子索引残留不进子树");
  core.applyRemovePromotion(leakState, 2);
  assertEqual(leakState.parentById.get(3), null, "16：关闭 B 不会把顶层 C 提升到 A 下");

  // --- 场景 17：调试模式（打印树结构与变化原因）---
  // 用户要能凭日志回答"这个标签为什么换了父"，因此这里断言一次关闭的完整现场：
  // 关闭前的树、每条变化的原因（含用到的规则）、关闭后的树、前后差异。
  console.log("场景 17：调试模式打印关闭前后的树与变化原因");
  const debug = await import("../background/tree_debug.js");
  const a17 = addTab({ windowId: 21, url: "https://a17.example.com/", title: "A17" });
  const b17 = addTab({ windowId: 21, url: "https://b17.example.com/", title: "B17", openerTabId: a17.id });
  const c17 = addTab({ windowId: 21, url: "https://c17.example.com/", title: "C17", openerTabId: b17.id });
  await tree.handleTreeTabCreated(a17);
  await tree.handleTreeTabCreated(b17);
  await tree.handleTreeTabCreated(c17);
  await tick(10);
  // 关键：必须先把窗口 21 的树加载进内存，否则关闭事件会被判成"内存里没有树"（那也是一种要打印的情况）。
  await tree.getTreeStructure([21]);
  debug.clearTreeDebugLog();
  debug.applyTreeDebugConfig({ enabled: true, printTree: true });
  tree.beginTreeCloseDebug(b17.id, { windowId: 21 });
  tabs = tabs.filter((tab) => tab.id !== b17.id);
  reindex();
  tree.handleTreeTabRemoved(b17.id, { windowId: 21, isWindowClosing: false });
  tree.endTreeCloseDebug();
  const debugText = debug.getTreeDebugLogText();
  assertEqual(debugText.includes("关闭前的树"), true, "17：日志含关闭前的树");
  assertEqual(debugText.includes("变化原因"), true, "17：日志含变化原因段落");
  assertEqual(debugText.includes("提升 #"), true, "17：日志说明了提升的是哪个标签");
  assertEqual(debugText.includes("规则："), true, "17：日志说明了命中的提升规则");
  assertEqual(debugText.includes("关闭后的树"), true, "17：日志含关闭后的树");
  assertEqual(debugText.includes(`#${c17.id}`), true, "17：日志里能看到被提升的子标签");
  // 摘要必须**单独**再打一份（独立前缀），否则几千标签的窗口里原因会被树快照淹没。
  assertEqual(debugText.includes("[Nesoi树·变化摘要]"), true, "17：变化摘要单独成块（独立前缀）");
  const summaryIndex = debugText.lastIndexOf("[Nesoi树·变化摘要]");
  const summaryText = debugText.slice(summaryIndex);
  assertEqual(summaryText.includes("提升 #"), true, "17：摘要块里含变化原因");
  assertEqual(summaryText.includes("父变化"), true, "17：摘要块里含前后差异");
  assertEqual(summaryText.includes("关闭前的树"), false, "17：摘要块不含整棵树（便于一眼看到）");
  assertEqual((summaryText.match(/\n1\. /g) || []).length, 1, "17：摘要里的原因编号不重复");
  const after17 = await tree.getTreeStructure([21]);
  assertEqual(after17.structures[21].parents[c17.id], a17.id, "17：前提——唯一子标签被提升到祖父");

  // 关掉调试后不得再产生日志（默认全关，避免影响正常使用）
  debug.clearTreeDebugLog();
  debug.applyTreeDebugConfig({ enabled: false, printTree: false });
  tree.beginTreeCloseDebug(b17.id, { windowId: 21 });
  tree.handleTreeTabRemoved(a17.id, { windowId: 21, isWindowClosing: false });
  tree.endTreeCloseDebug();
  assertEqual(debug.getTreeDebugLogText(), "", "17：调试关闭后不产生任何日志");

  // --- 场景 18：不变量校验要补齐"窗口里有、内存树里没有条目"的标签 ---
  // 用户现象：新标签不再自动挂到当前激活标签下，过一会或 Reload 才恢复。
  // 成因：该标签的创建事件落在"树正在加载"的空档被丢弃，父映射里永远没有它；
  // 而代码各处都用 parentById.has(id) 判断"在不在树里"，于是真实存在的活动标签被当成不存在。
  console.log("场景 18：不变量校验补齐缺失条目的标签");
  const { sanitizeTreeState } = await import("../background/tree_core.js");
  const sparseState = {
    parentById: new Map([[1, null]]),
    childIdsById: new Map(),
  };
  const repairedCount = sanitizeTreeState(sparseState, [1, 2, 3], new Set());
  assertEqual(sparseState.parentById.has(2), true, "18：缺失条目的标签被补进父映射");
  assertEqual(sparseState.parentById.get(2), null, "18：补进来的标签是顶层");
  assertEqual(sparseState.parentById.get(3), null, "18：所有缺失条目都被补齐");
  assertEqual(repairedCount >= 2, true, "18：补齐被计入不变量修正（会触发通知与会话值重写）");

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

await main();
