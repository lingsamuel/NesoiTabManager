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

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

await main();
