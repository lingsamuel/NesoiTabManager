// 撤销关闭（关闭记录 + 整组恢复）的回归测试。
//
// 与 test_tree.mjs 同样的思路：本插件没有浏览器自动化环境，而这条链路的风险全部在
// "与 chrome.tabs / chrome.sessions 的交互顺序"上，因此用一套最小可用的 chrome API 模拟
// 真实验证事件链路（按 background.js 的接线顺序注册监听，标签的创建/关闭一律走事件）。
//
// 覆盖点：
//   - 关闭整棵子树 → 撤销 → 层级 / 兄弟顺序 / 物理位置一致；
//   - 多选跨父关闭 → 各自回到原父（含"父不在关闭组内"的情况）；
//   - 浏览器原生「重新打开已关闭的标签页」→ 单标签回到原父与原位置（Chrome 的 URL 匹配路径）；
//   - Firefox 的每标签会话值：有值=精确恢复，无值（用户手动打开同一 URL）=退回默认规则且记录放回；
//   - 原父已关闭时降级为顶层；关闭组容量淘汰；关闭记录有效期。
//
// 运行：node scripts/test_closed_groups.mjs

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
let windows = [{ id: 1 }, { id: 2 }];
let nextTabId = 1000;
let nextSessionId = 1;
const storageData = { local: {}, session: {} };
const alarmsCreated = [];
// tabId -> { [key]: value }，模拟 Firefox 的每标签会话值。
const tabValues = new Map();
// 后台写入 storage.session 的树结构版本号快照（前端据此重拉父子映射）。
// 每次写入都会记一份，用于断言"结构变化（含落盘前静默纠偏）都会通知前端"。
const revisionSnapshots = [];
// 模拟浏览器的「最近关闭」列表：元素为 { sessionId, url, title }。
let recentlyClosed = [];

function makeEvent(bucket) {
  return {
    addListener: (fn) => bucket.push(fn),
    removeListener: (fn) => {
      const index = bucket.indexOf(fn);
      if (index >= 0) {
        bucket.splice(index, 1);
      }
    },
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 重排物理顺序与 index：数组顺序就是物理顺序。 */
function reindex() {
  const counters = new Map();
  for (const tab of tabs) {
    const next = counters.get(tab.windowId) || 0;
    tab.index = next;
    counters.set(tab.windowId, next + 1);
  }
}

function addTab({
  windowId = 1,
  pinned = false,
  url = "",
  title = "",
  openerTabId = null,
  index = null,
  status = "complete",
} = {}) {
  const id = nextTabId;
  nextTabId += 1;
  const tab = { id, windowId, pinned, url, title, openerTabId, index: 0, active: false, status };
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
      } else {
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
      // 树结构版本号是"后台 → 前端"的结构变更通知通道，单独记一份便于断言。
      if (area === "session" && obj.treeStructureRevision) {
        revisionSnapshots.push(clone(obj.treeStructureRevision));
      }
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) {
        delete storageData[area][key];
      }
      if (callback) {
        callback();
      }
    },
  };
}

function moveTabsMock(tabIds, info, callback) {
  const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number);
  const windowId = Number(info.windowId);
  const moving = ids.map((id) => tabs.find((tab) => tab.id === id)).filter(Boolean);
  if (moving.length === 0) {
    globalThis.chrome.runtime.lastError = { message: "No tab with given id" };
    callback && callback([]);
    globalThis.chrome.runtime.lastError = null;
    return;
  }
  const movingIds = new Set(moving.map((tab) => tab.id));
  const rest = tabs.filter((tab) => !movingIds.has(tab.id));
  for (const tab of moving) {
    tab.windowId = windowId;
  }
  const restInWindow = rest.filter((tab) => tab.windowId === windowId);
  const others = rest.filter((tab) => tab.windowId !== windowId);
  let index = Number.isFinite(info.index) && info.index >= 0 ? info.index : restInWindow.length;
  index = Math.max(0, Math.min(index, restInWindow.length));
  restInWindow.splice(index, 0, ...moving);
  tabs = [...others, ...restInWindow];
  reindex();
  callback && callback(moving.slice());
}

function setupChromeMock() {
  const runtime = { lastError: null };
  // Firefox 的每标签会话值：**只提供 Promise 形式**。
  // 真实 Firefox 上 `chrome.sessions.setTabValue(id, key, value, callback)` 这类回调形式不生效
  // （写入看似成功、回读永远为空），曾经因此让"精确识别撤销关闭"整条链路静默失效。
  // 因此测试替身必须严格：传回调直接抛错，否则这类问题永远测不出来。
  const setTabValue = (tabId, key, value, callback) => {
    if (typeof callback === "function") {
      throw new TypeError("sessions.setTabValue 不接受回调：请使用 Promise 形式");
    }
    const entry = tabValues.get(Number(tabId)) || {};
    entry[key] = clone(value);
    tabValues.set(Number(tabId), entry);
    return Promise.resolve();
  };
  const getTabValue = (tabId, key, callback) => {
    if (typeof callback === "function") {
      throw new TypeError("sessions.getTabValue 不接受回调：请使用 Promise 形式");
    }
    const entry = tabValues.get(Number(tabId)) || {};
    return Promise.resolve(entry[key] === undefined ? null : clone(entry[key]));
  };
  globalThis.chrome = {
    runtime,
    storage: { local: storageArea("local"), session: storageArea("session") },
    alarms: {
      create: (name, info) => alarmsCreated.push({ name, info }),
      clear: () => {},
      get: (_name, callback) => callback && callback(null),
    },
    windows: {
      getAll: (callback) => callback(windows.map((win) => ({ id: win.id }))),
      get: (id, callback) => {
        const win = windows.find((item) => item.id === Number(id));
        if (!win) {
          runtime.lastError = { message: "No window with given id" };
          callback(undefined);
          runtime.lastError = null;
          return;
        }
        callback({ id: win.id });
      },
      getLastFocused: (_info, callback) => callback({ id: windows[0].id }),
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
        const tab = tabs.find((item) => item.id === Number(id));
        if (!tab) {
          runtime.lastError = { message: "No tab with given id" };
          callback(undefined);
          runtime.lastError = null;
          return;
        }
        callback({ ...tab });
      },
      create: (options, callback) => {
        const tab = addTab({
          windowId: Number(options.windowId) || windows[0].id,
          index: Number.isFinite(options.index) ? Number(options.index) : null,
          active: Boolean(options.active),
          url: options.url || "about:newtab",
          title: options.url || "新标签页",
        });
        const snapshot = { ...tab };
        callback && callback(snapshot);
        // 真实浏览器在创建之后才异步派发 onCreated，这里保持同样的时序。
        emitAsync(listeners.created, snapshot);
        return snapshot;
      },
      move: (tabIds, info, callback) => moveTabsMock(tabIds, info, callback),
      update: (id, changes, callback) => {
        const tab = tabs.find((item) => item.id === Number(id));
        if (!tab) {
          runtime.lastError = { message: "No tab with given id" };
          callback && callback(undefined);
          runtime.lastError = null;
          return;
        }
        if (changes.active) {
          for (const item of tabs) {
            if (item.windowId === tab.windowId) {
              item.active = false;
            }
          }
          tab.active = true;
        }
        callback && callback({ ...tab });
      },
      remove: (ids, callback) => {
        const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
        const removed = tabs.filter((tab) => list.includes(tab.id));
        tabs = tabs.filter((tab) => !list.includes(tab.id));
        reindex();
        // 真实浏览器先派发 onRemoved（后台在这里抓取关闭现场），再结束回调。
        for (const tab of removed) {
          emit(listeners.removed, tab.id, { windowId: tab.windowId, isWindowClosing: false });
        }
        callback && callback();
      },
    },
    sessions: {
      MAX_SESSION_RESULTS: 25,
      setTabValue,
      getTabValue,
      getRecentlyClosed: (_filter, callback) =>
        callback(recentlyClosed.map((item) => ({ tab: { ...item } }))),
      restore: (sessionId, callback) => {
        const session = recentlyClosed.find((item) => item.sessionId === sessionId);
        if (!session) {
          runtime.lastError = { message: "Invalid session id" };
          callback && callback();
          runtime.lastError = null;
          return;
        }
        recentlyClosed = recentlyClosed.filter((item) => item.sessionId !== sessionId);
        const tab = addTab({ windowId: windows[0].id, url: session.url, title: session.title });
        const snapshot = { ...tab };
        callback && callback(snapshot);
        emitAsync(listeners.created, snapshot);
      },
    },
  };
  return { setTabValue, getTabValue };
}

// ---------------------------------------------------------------------------
// 事件派发辅助
// ---------------------------------------------------------------------------

function emit(bucket, ...args) {
  for (const fn of bucket.slice()) {
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

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等某窗口里某标签的父关系变成期望值（`undefined` = 顶层）。
 *
 * 撤销判定是**异步**的（要在判定窗口内等 Firefox 会话值 / 真实 URL 就绪），
 * 因此断言必须等它收敛，而不是"创建后固定睡 20ms"。
 */
async function waitForParent(windowId, tabId, expected, timeoutMs = 900) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const structure = await tree.getTreeStructure([windowId]);
    if (parentsOf(structure, windowId)[tabId] === expected) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await tick(10);
  }
}

/** 等某窗口里某标签的物理下标变成期望值。 */
async function waitForIndex(tabId, expected, timeoutMs = 900) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = tabById(tabId);
    if (tab && tab.index === expected) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await tick(10);
  }
}

/** 像浏览器那样新建一个标签：先进列表，再异步派发 onCreated。 */
async function openTab(options) {
  const tab = addTab(options);
  await emitAsync(listeners.created, { ...tab });
  await tick(15);
  return tab;
}

/** 像浏览器那样关闭标签：走 chrome.tabs.remove，由事件触发后台记录。 */
async function closeTabs(ids) {
  await new Promise((resolve) => chrome.tabs.remove(ids, resolve));
  await tick(15);
}

/**
 * 直接改物理顺序，**不派发 onMoved**。
 *
 * 用途：模拟"插件不知情时标签栏已经变了"（后台被回收、事件被丢掉），
 * 此时内存树里可能残留一个物理上已经排到子标签之后的父——正好用来验证落盘前的静默纠偏。
 */
function moveTabPhysicallyRaw(tabId, targetIndex) {
  const tab = tabs.find((item) => item.id === Number(tabId));
  if (!tab) {
    return;
  }
  const inWindow = tabs.filter((item) => item.windowId === tab.windowId && item.id !== tab.id);
  const others = tabs.filter((item) => item !== tab && item.windowId !== tab.windowId);
  const at = Math.max(0, Math.min(Number(targetIndex), inWindow.length));
  inWindow.splice(at, 0, tab);
  inWindow.forEach((item, i) => {
    item.index = i;
  });
  tabs = [...others, ...inWindow];
  reindex();
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

function assertTrue(value, label) {
  assertEqual(Boolean(value), true, label);
}

// ---------------------------------------------------------------------------
// 测试场景
// ---------------------------------------------------------------------------

let tree = null;
let closed = null;
let recent = null;
let sessionMock = null;

function parentsOf(structure, windowId) {
  return structure.structures[windowId].parents;
}

function tabById(id) {
  return tabs.find((tab) => tab.id === Number(id)) || null;
}

function tabByUrl(url) {
  return tabs.find((tab) => tab.url === url) || null;
}

async function main() {
  setupChromeMock();
  tree = await import("../background/tree.js");
  recent = await import("../background/recent_tabs.js");
  closed = await import("../background/closed_groups.js");

  // 冷启动"事件风暴"启发式会在导入后的 5 秒内把连续的结构事件判定为会话恢复，
  // 从而跳过树维护——测试全程在 1 秒内跑完，会误触发它。这里把时钟推后，
  // 让测试等价于"浏览器已经跑了一段时间"的真实场景。
  const realClock = Date.now;
  Date.now = () => realClock() + 10 * 60 * 1000;

  tree.initializeTreeSystem();
  closed.initializeClosedGroups();

  // 按 background.js 的真实接线顺序注册监听：顺序不能改，
  // 撤销关闭必须在树执行"关闭提升"之前抓取现场。
  chrome.tabs.onCreated.addListener((tab) => {
    recent.handleRecentTabCreated(tab);
    tree.handleTreeTabCreated(tab);
    closed.handleTabStructureChanged(tab.windowId, [tab.id]);
  });
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    closed.handleClosedTabRecorded(tabId, removeInfo);
    closed.handlePromotionAfterClose(tabId, removeInfo.windowId);
    recent.handleRecentTabRemoved(tabId);
    tree.handleTreeTabRemoved(tabId, removeInfo);
  });

  // 先把窗口 1 的树加载出来：真实的浏览器里用户已经操作过，树的懒加载早就完成。
  await tree.getTreeStructure([1]);

  // --- 场景 1：关闭整棵子树 → 撤销 → 层级与物理位置一致 ---
  console.log("场景 1：关闭整棵子树后整组撤销");
  const a = await openTab({ url: "https://a.example/", title: "A" });
  const b = await openTab({ url: "https://b.example/", openerTabId: a.id, title: "B" });
  const c = await openTab({ url: "https://c.example/", openerTabId: b.id, title: "C" });
  const d = await openTab({ url: "https://d.example/", title: "D" });
  let structure = await tree.getTreeStructure([1]);
  assertEqual(parentsOf(structure, 1)[b.id], a.id, "前置：B 挂在 A 之下");
  assertEqual(parentsOf(structure, 1)[c.id], b.id, "前置：C 挂在 B 之下");

  const bIndex = b.index;
  const closeResult = await closed.closeTabsAsGroup(1, [], "关闭的子树", { subtreeOf: b.id });
  assertEqual(closeResult.ok, true, "整棵子树关闭成功");
  assertEqual(closeResult.removed, 2, "关掉了 B 与 C 两个标签");
  assertEqual(Boolean(tabById(b.id)), false, "B 已关闭");
  assertEqual(closed.hasRestorableGroup(), true, "存在可撤销的关闭组");
  await tick(20);
  assertTrue(
    Array.isArray(storageData.session.closedGroups) && storageData.session.closedGroups.length === 1,
    "关闭组已落到 storage.session"
  );
  const group = storageData.session.closedGroups[0];
  assertEqual(group.members.length, 2, "关闭组记录了 2 个成员");
  assertEqual(group.members[1].parentIndex, 0, "C 记录到组内父下标（B 在组内第 0 位）");
  assertEqual(group.members[0].parentId, a.id, "B 记录到组外父标签 A");

  const restoreResult = await closed.restoreClosedGroup(1);
  await tick(30);
  assertEqual(restoreResult.ok, true, "整组撤销成功");
  assertEqual(restoreResult.restored, 2, "恢复了 2 个标签");
  structure = await tree.getTreeStructure([1]);
  const restoredB = tabByUrl("https://b.example/");
  const restoredC = tabByUrl("https://c.example/");
  assertTrue(Boolean(restoredB) && Boolean(restoredC), "B 与 C 都重新打开");
  assertEqual(parentsOf(structure, 1)[restoredB.id], a.id, "恢复后 B 仍挂在 A 之下");
  assertEqual(parentsOf(structure, 1)[restoredC.id], restoredB.id, "恢复后 C 仍挂在 B 之下");
  assertEqual(restoredB.index + 1, restoredC.index, "恢复后 B、C 物理相邻且顺序不变");
  assertEqual(restoredB.index, bIndex, "恢复后 B 回到原物理位置");
  assertEqual(closed.hasRestorableGroup(), false, "撤销后该组出栈");
  assertEqual((storageData.session.closedGroups || []).length, 0, "storage.session 里也不再保留该组");

  // --- 场景 2：多选跨父关闭 → 各自回到原父 ---
  console.log("场景 2：多选跨父批量关闭后整组撤销");
  const p1 = await openTab({ url: "https://p1.example/", title: "P1" });
  const x1 = await openTab({ url: "https://x1.example/", openerTabId: p1.id, title: "X1" });
  const p2 = await openTab({ url: "https://p2.example/", title: "P2" });
  const x2 = await openTab({ url: "https://x2.example/", openerTabId: p2.id, title: "X2" });
  structure = await tree.getTreeStructure([1]);
  assertEqual(parentsOf(structure, 1)[x1.id], p1.id, "前置：X1 挂在 P1 之下");
  assertEqual(parentsOf(structure, 1)[x2.id], p2.id, "前置：X2 挂在 P2 之下");

  const multiClose = await closed.closeTabsAsGroup(1, [x1.id, x2.id], "关闭所选");
  assertEqual(multiClose.ok, true, "批量关闭成功");
  const multiRestore = await closed.restoreClosedGroup(1);
  await tick(30);
  assertEqual(multiRestore.ok, true, "整组撤销成功");
  structure = await tree.getTreeStructure([1]);
  assertEqual(
    parentsOf(structure, 1)[tabByUrl("https://x1.example/").id],
    p1.id,
    "X1 回到原父 P1 之下（父不在关闭组内）"
  );
  assertEqual(
    parentsOf(structure, 1)[tabByUrl("https://x2.example/").id],
    p2.id,
    "X2 回到原父 P2 之下（父不在关闭组内）"
  );

  // --- 场景 3：浏览器原生「重新打开已关闭的标签页」（Chrome 的 URL 匹配路径） ---
  console.log("场景 3：原生重新打开单标签（Chrome 路径）");
  const chromeSessions = setupChromeMockKeepListeners();
  const root = await openTab({ url: "https://root.example/", title: "Root" });
  const leaf = await openTab({ url: "https://leaf.example/", openerTabId: root.id, title: "Leaf" });
  const leafIndex = leaf.index;
  await closeTabs([leaf.id]);
  assertTrue(
    (storageData.session.closedTabLog || []).length >= 1,
    "单标签关闭写入 closedTabLog"
  );

  // Ctrl+Shift+T：新 tabId、相同 URL，且 Chrome 下没有每标签会话值。
  const reopened = await openTab({ url: "https://leaf.example/", title: "Leaf" });
  assertTrue(await waitForParent(1, reopened.id, root.id), "原生撤销后回到原父 Root 之下");
  assertTrue(await waitForIndex(reopened.id, leafIndex), "原生撤销后回到原物理位置");

  // --- 场景 3b：onCreated 只给 about:blank，真实 URL 稍后才到（Firefox 的真实时序）---
  // 关键回归：旧实现拿 onCreated 的 url 做全等匹配，而撤销恢复出来的标签这一刻是 about:blank，
  // 于是判定必然失败、只能退回默认规则（用户看到的就是"撤销后层级不对"）。
  console.log("场景 3b：onCreated 只有 about:blank，真实 URL 稍后才到");
  const root3b = await openTab({ url: "https://blank-root.example/", title: "BRoot" });
  const leaf3b = await openTab({ url: "https://blank-leaf.example/", openerTabId: root3b.id, title: "BLeaf" });
  const leaf3bIndex = leaf3b.index;
  await closeTabs([leaf3b.id]);
  // 模拟 Ctrl+Shift+T：先以 about:blank 出现，真实 URL 之后才提交。
  const blankReopen = addTab({ url: "about:blank", status: "loading", title: "" });
  await emitAsync(listeners.created, { ...blankReopen });
  await tick(80);
  // 判定窗口内还不该把 about:blank 当成"匹配失败"：它必须继续等真实 URL。
  const blankTab = tabById(blankReopen.id);
  blankTab.url = "https://blank-leaf.example/";
  blankTab.title = "BLeaf";
  blankTab.status = "complete";
  assertTrue(await waitForParent(1, blankReopen.id, root3b.id), "真实 URL 就绪后仍能按记录还原父");
  assertTrue(await waitForIndex(blankReopen.id, leaf3bIndex), "真实 URL 就绪后仍能还原物理位置");

  // --- 场景 4：Firefox 的每标签会话值 ---
  console.log("场景 4：Firefox 每标签会话值——有值精确恢复");
  // 恢复每标签会话值，模拟切回 Firefox。
  chrome.sessions.setTabValue = chromeSessions.setTabValue;
  chrome.sessions.getTabValue = chromeSessions.getTabValue;
  const froot = await openTab({ url: "https://froot.example/", title: "FRoot" });
  const fleaf = await openTab({ url: "https://fleaf.example/", openerTabId: froot.id, title: "FLeaf" });
  // 等防抖（250ms）把父标签写进会话值。
  await tick(350);
  const fleafValue = tabValues.get(Number(fleaf.id));
  assertEqual(
    fleafValue && fleafValue["nesoi:tree-ref"] && fleafValue["nesoi:tree-ref"].parentId,
    froot.id,
    "会话值里写下了父标签"
  );

  await closeTabs([fleaf.id]);
  // 4a：浏览器恢复了会话值（真·撤销关闭）→ 精确挂回原父。
  const firefoxReopen = addTab({ url: "https://fleaf.example/", title: "FLeaf" });
  // `at` 必须早于新标签的创建时刻：Firefox 恢复的是"被关闭标签一生中写下的值"。
  // 若 at 落在创建之后，插件会（正确地）把它当成本插件自己刚写的引用而拒绝采信。
  tabValues.set(Number(firefoxReopen.id), {
    "nesoi:tree-ref": { parentId: froot.id, at: Date.now() - 5000 },
  });
  await emitAsync(listeners.created, { ...firefoxReopen });
  assertTrue(await waitForParent(1, firefoxReopen.id, froot.id), "Firefox：有会话值时精确挂回原父");

  // 4b：会话值**稍后**才就绪（真实 Firefox 上会晚一点出现）→ 短轮询后照样精确识别。
  // 关键回归：旧实现只读一次，读不到就把记录放回并退回默认规则。
  const slowReopen = addTab({ url: "about:blank", status: "loading", title: "" });
  await emitAsync(listeners.created, { ...slowReopen });
  await tick(80);
  tabValues.set(Number(slowReopen.id), {
    "nesoi:tree-ref": { parentId: froot.id, at: Date.now() - 5000 },
  });
  assertTrue(await waitForParent(1, slowReopen.id, froot.id), "Firefox：会话值延迟就绪也能精确识别");

  // 4c：用户手动打开了同一个 URL（没有会话值）→ 会话值不可用时退回 URL 启发式，
  // 因此会被当成撤销恢复（**已知上限**：与 Chrome 侧同一口径；Firefox 会话值可用时不会误判）。
  const anchor = await openTab({ url: "https://anchor.example/", title: "Anchor" });
  tree.handleTreeTabActivated({ windowId: 1, tabId: anchor.id });
  const secondLeaf = await openTab({ url: "https://fleaf.example/", openerTabId: froot.id, title: "FLeaf" });
  await tick(350);
  await closeTabs([secondLeaf.id]);
  const manual = await openTab({ url: "https://fleaf.example/", title: "FLeaf" });
  assertTrue(await waitForParent(1, manual.id, froot.id), "Firefox：无会话值时按 URL 启发式恢复原父（与 Chrome 同口径）");
  assertEqual(
    (storageData.session.closedTabLog || []).some((record) => record.url === "https://fleaf.example/"),
    false,
    "URL 命中后关闭记录被消费出栈"
  );

  // --- 场景 5：原父已关闭 → 降级为顶层 ---
  console.log("场景 5：原父已不存在时降级为顶层");
  // 切回 Chrome 路径（没有每标签会话值）：判定完全依赖关闭记录，
  // 这样才能验证"记录里的父标签已经不存在"时的降级行为。
  delete chrome.sessions.setTabValue;
  delete chrome.sessions.getTabValue;
  const goneRoot = await openTab({ url: "https://gone-root.example/", title: "GoneRoot" });
  const goneChild = await openTab({
    url: "https://gone-child.example/",
    openerTabId: goneRoot.id,
    title: "GoneChild",
  });
  await closeTabs([goneChild.id]);
  await closeTabs([goneRoot.id]);
  const orphan = await openTab({ url: "https://gone-child.example/", title: "GoneChild" });
  await tick(20);
  structure = await tree.getTreeStructure([1]);
  assertEqual(parentsOf(structure, 1)[orphan.id], undefined, "原父不存在时降级为顶层且不报错");

  // --- 场景 6：关闭组容量淘汰 ---
  console.log("场景 6：关闭组容量");
  for (let i = 0; i < 7; i += 1) {
    const victim = await openTab({ url: `https://victim-${i}.example/`, title: `V${i}` });
    await closed.closeTabsAsGroup(1, [victim.id], `第 ${i} 组`);
    await tick(10);
  }
  await tick(30);
  assertEqual((storageData.session.closedGroups || []).length, 5, "关闭组栈只保留最近 5 组");
  assertEqual(storageData.session.closedGroups[0].label, "第 6 组", "最新的一组在栈顶");
  assertEqual(
    storageData.session.closedGroups.some((item) => item.label === "第 0 组"),
    false,
    "最旧的一组已被淘汰"
  );

  // --- 场景 7：关闭记录有效期 ---
  console.log("场景 7：关闭记录有效期");
  // 让被关闭的标签确实有一个"原父"，否则无法区分"记录过期未生效"与"本来就没有父"。
  const expiredRoot = await openTab({ url: "https://expired-root.example/", title: "ERoot" });
  const expired = await openTab({
    url: "https://expired.example/",
    openerTabId: expiredRoot.id,
    title: "Expired",
  });
  await closeTabs([expired.id]);
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 60 * 1000;
  const expiredReopen = await openTab({ url: "https://expired.example/", title: "Expired" });
  await tick(20);
  Date.now = realNow;
  structure = await tree.getTreeStructure([1]);
  assertEqual(
    parentsOf(structure, 1)[expiredReopen.id] === expiredRoot.id,
    false,
    "超过有效期的关闭记录不再被认领（没有挂回原父）"
  );
  assertEqual(
    parentsOf(structure, 1)[expiredReopen.id],
    anchor.id,
    "过期记录被忽略后走默认规则（挂到当前活动标签下）"
  );

  // --- 场景 8：浏览器仍记得的会话优先走 sessions.restore ---
  console.log("场景 8：优先用浏览器会话恢复（保住前进后退历史）");
  const s1 = await openTab({ url: "https://session-a.example/", title: "SA" });
  const s2 = await openTab({ url: "https://session-b.example/", title: "SB" });
  await closed.closeTabsAsGroup(1, [s1.id, s2.id], "会话组");
  // 让浏览器"记得"其中一个标签（模拟它仍在最近关闭列表里）。
  recentlyClosed = [{ sessionId: nextSessionId, url: "https://session-a.example/", title: "SA" }];
  nextSessionId += 1;
  const sessionRestore = await closed.restoreClosedGroup(1);
  await tick(40);
  assertEqual(sessionRestore.ok, true, "整组撤销成功");
  assertEqual(sessionRestore.restored, 2, "两个标签都回来了");
  assertTrue(
    Boolean(tabByUrl("https://session-a.example/")) && Boolean(tabByUrl("https://session-b.example/")),
    "走会话恢复的与按 URL 重开的标签都在窗口里"
  );
  assertEqual(recentlyClosed.length, 0, "被用掉的会话记录已从最近关闭列表消费掉");

  // --- 场景 9：跨窗口多选关闭 → 各自回到自己的窗口与原父 ---
  console.log("场景 9：跨窗口批量关闭后整组撤销");
  await tree.getTreeStructure([2]);
  const w1root = await openTab({ url: "https://w1-root.example/", title: "W1R", windowId: 1 });
  const w1child = await openTab({
    url: "https://w1-child.example/",
    title: "W1C",
    windowId: 1,
    openerTabId: w1root.id,
  });
  const w2root = await openTab({ url: "https://w2-root.example/", title: "W2R", windowId: 2 });
  const w2child = await openTab({
    url: "https://w2-child.example/",
    title: "W2C",
    windowId: 2,
    openerTabId: w2root.id,
  });
  structure = await tree.getTreeStructure([1, 2]);
  assertEqual(parentsOf(structure, 1)[w1child.id], w1root.id, "前置：窗口 1 的子标签挂在 W1R 之下");
  assertEqual(parentsOf(structure, 2)[w2child.id], w2root.id, "前置：窗口 2 的子标签挂在 W2R 之下");

  const crossClose = await closed.closeTabsAsGroup(1, [w1child.id, w2child.id], "跨窗口关闭");
  assertEqual(crossClose.ok, true, "跨窗口批量关闭成功");
  const crossRestore = await closed.restoreClosedGroup(1);
  await tick(40);
  assertEqual(crossRestore.ok, true, "跨窗口整组撤销成功");
  assertEqual(crossRestore.restored, 2, "两个窗口的标签都回来了");
  structure = await tree.getTreeStructure([1, 2]);
  const restoredW1Child = tabByUrl("https://w1-child.example/");
  const restoredW2Child = tabByUrl("https://w2-child.example/");
  assertEqual(restoredW1Child.windowId, 1, "窗口 1 的成员回到窗口 1");
  assertEqual(restoredW2Child.windowId, 2, "窗口 2 的成员回到窗口 2");
  assertEqual(parentsOf(structure, 1)[restoredW1Child.id], w1root.id, "窗口 1 的成员回到原父");
  assertEqual(parentsOf(structure, 2)[restoredW2Child.id], w2root.id, "窗口 2 的成员回到原父");

  // --- 场景 10：重开阶段整体失败 → 关闭组保留，可重试 ---
  console.log("场景 10：重开失败时保留关闭组");
  const failA = await openTab({ url: "https://fail-a.example/", title: "FA" });
  const failB = await openTab({ url: "https://fail-b.example/", title: "FB" });
  await closed.closeTabsAsGroup(1, [failA.id, failB.id], "失败组");
  assertEqual(closed.hasRestorableGroup(), true, "关闭后存在可撤销的组");
  const realCreate = chrome.tabs.create;
  chrome.tabs.create = (options, callback) => {
    chrome.runtime.lastError = { message: "模拟创建失败" };
    callback && callback(undefined);
    chrome.runtime.lastError = null;
  };
  const failedRestore = await closed.restoreClosedGroup(1);
  chrome.tabs.create = realCreate;
  assertEqual(failedRestore.ok, false, "一个都没打开时如实返回失败");
  await tick(20);
  assertEqual(closed.hasRestorableGroup(), true, "关闭组被放回，仍可重试");
  const retryRestore = await closed.restoreClosedGroup(1);
  await tick(40);
  assertEqual(retryRestore.ok, true, "重试后恢复成功");
  assertEqual(retryRestore.restored, 2, "两个标签都回来了");

  // --- 场景 11：树尚未加载时创建的标签，也必须写下每标签会话值 ---
  // 触发条件：后台刚被回收。标签创建的树加载防抖是 500ms，而会话值刷新防抖是 250ms，
  // 旧实现在这个空档里从内存树读不到父标签 → 静默不写。
  // 后果：该标签永远没有会话值，之后用原生 Ctrl+Shift+T 恢复它时判不出原父，只能落顶层。
  console.log("场景 11：树尚未加载时也要补写每标签会话值");
  chrome.sessions.setTabValue = chromeSessions.setTabValue;
  chrome.sessions.getTabValue = chromeSessions.getTabValue;
  windows.push({ id: 3 });
  const w3root = addTab({ windowId: 3, url: "https://w3-root.example/", title: "W3R" });
  const w3leaf = addTab({
    windowId: 3,
    url: "https://w3-leaf.example/",
    openerTabId: w3root.id,
    title: "W3L",
  });
  await emitAsync(listeners.created, { ...w3leaf }); // 走真实接线：树处理 + handleTabStructureChanged
  await tick(400); // 等 250ms 的会话值防抖；树此时只能靠 ensureTreeFor 按需加载
  const w3Value = tabValues.get(Number(w3leaf.id));
  assertEqual(
    w3Value && w3Value["nesoi:tree-ref"] ? w3Value["nesoi:tree-ref"].parentId : null,
    w3root.id,
    "11：树未加载时创建的标签也写下了父引用"
  );

  // --- 场景 12：撤销认领把"已经在树里的标签"直接改顶层时，不能留下子索引残留 ---
  // 触发条件：新建标签的 URL 与刚关闭的标签相同（插件会走"撤销认领"把它先按顶层登记），
  // 而对齐恰好已经把它挂到 opener 之下。旧实现直接写父映射，等于把它的 id 留在 opener 的
  // childIdsById 里；之后 opener 被关闭时，这个其实早已顶层的标签会被当成它的子标签提升进树
  // ——正是"关闭一个标签，几个毫不相干的标签突然被重排"。
  console.log("场景 12：撤销认领不得留下子索引残留");
  // 用 Chrome 路径（没有每标签会话值）：认领只按 URL 匹配，命中后套用关闭记录里的父（这里是 null），
  // 因此"登记为顶层"这一步不会被随后套用的父关系掩盖，能干净地暴露子索引残留。
  delete chrome.sessions.setTabValue;
  delete chrome.sessions.getTabValue;
  windows.push({ id: 8 });
  const claimUrl = "https://claim-target.example/";
  const claimRecordSeed = await openTab({ windowId: 8, url: claimUrl, title: "CR" });
  await closeTabs([claimRecordSeed.id]); // 留下一条同 URL 的关闭记录，供后面认领
  const p8 = addTab({ windowId: 8, url: "https://p8.example/", title: "P8" });
  const b8 = addTab({ windowId: 8, url: "https://b8.example/", openerTabId: p8.id, title: "B8" });
  // X 由 B 打开（opener=B8）、URL 与刚关闭的记录相同；先加进列表，再让树对齐把它挂到 B8 下
  const x8 = addTab({ windowId: 8, url: claimUrl, openerTabId: b8.id, title: "X8" });
  let parents8 = parentsOf(await tree.getTreeStructure([8]), 8);
  assertEqual(parents8[x8.id], b8.id, "前置：X 由对齐按 opener 临时挂到 B8 下");
  // 创建事件随后到达：URL 命中关闭记录 → 走撤销认领路径（先按顶层登记）
  await emitAsync(listeners.created, { ...x8 });
  await tick(20);
  parents8 = parentsOf(await tree.getTreeStructure([8]), 8);
  assertEqual(parents8[x8.id], undefined, "12：认领后 X 是顶层（没有被套用默认规则）");
  // 关闭 B8：不得把 X 提升到 P8 之下
  await closeTabs([b8.id]);
  await tick(20);
  parents8 = parentsOf(await tree.getTreeStructure([8]), 8);
  assertEqual(parents8[x8.id], undefined, "12：关闭 B8 不会把顶层的 X 提升进树");

  // --- 场景 13：树没进内存时关闭标签，关闭记录仍要带上原位置 ---
  // 触发条件：后台刚被回收（或本轮事件早于懒加载），tabs.onRemoved 到达时拿不到结构现场。
  // 旧实现此时写下 index = -1、前后邻居全空，原生「撤销关闭」就再也无法把标签放回原位。
  console.log("场景 13：树未加载时关闭，记录仍需保留下标与前后邻居");
  windows.push({ id: 9 });
  const n9a = addTab({ windowId: 9, url: "https://n9-a.example/", title: "N9A" });
  const n9b = addTab({ windowId: 9, url: "https://n9-b.example/", title: "N9B" });
  const n9c = addTab({ windowId: 9, url: "https://n9-c.example/", title: "N9C" });
  const n9d = addTab({ windowId: 9, url: "https://n9-d.example/", title: "N9D" });
  // 只喂标签缓存（不触发树的懒加载），模拟"后台有全量缓存、但这棵树的现场不在内存里"
  for (const tab of [n9a, n9b, n9c, n9d]) {
    recent.handleRecentTabCreated(tab);
  }
  await closeTabs([n9c.id]);
  const record9 = (storageData.session.closedTabLog || [])[0];
  assertEqual(record9 && record9.index, 2, "13：记录里保留了原物理下标");
  assertEqual(record9 && record9.prevId, n9b.id, "13：记录里保留了原前驱");
  assertEqual(record9 && record9.nextId, n9d.id, "13：记录里保留了原后继");
  // 原生撤销（Chrome 路径：按 URL 认领）→ 应回到原物理位置（N9B 与 N9D 之间）
  const n9restored = await openTab({ windowId: 9, url: "https://n9-c.example/", title: "N9C" });
  await tick(30);
  const order9 = tabs
    .filter((tab) => tab.windowId === 9)
    .sort((left, right) => left.index - right.index)
    .map((tab) => tab.id);
  assertEqual(order9.indexOf(n9restored.id), 2, "13：撤销后回到原来的第 3 位");

  // --- 场景 14：关闭父标签后撤销，必须把被提升出去的直属子标签重挂回去（A - B - C）---
  // 用户现象：A - B - C，关闭 A（B 被提升为顶层、X 挂到 B 下）后 Ctrl+Shift+T，
  // 旧实现只恢复 A 一个标签 → 得到 `A / B-C`，而不是 `A - B - C`。
  console.log("场景 14：撤销父标签时重挂被提升的直属子标签");
  windows.push({ id: 14 });
  await tree.getTreeStructure([14]);
  const a14 = await openTab({ windowId: 14, url: "https://a14.example/", title: "A14" });
  const b14 = await openTab({ windowId: 14, url: "https://b14.example/", openerTabId: a14.id, title: "B14" });
  const c14 = await openTab({ windowId: 14, url: "https://c14.example/", openerTabId: b14.id, title: "C14" });
  const x14 = await openTab({ windowId: 14, url: "https://x14.example/", openerTabId: a14.id, title: "X14" });
  let parents14 = parentsOf(await tree.getTreeStructure([14]), 14);
  assertEqual(parents14[b14.id], a14.id, "14 前置：B 挂在 A 下");
  assertEqual(parents14[c14.id], b14.id, "14 前置：C 挂在 B 下");
  assertEqual(parents14[x14.id], a14.id, "14 前置：X 挂在 A 下");

  await closeTabs([a14.id]); // 原生关闭：只进 closedTabLog
  parents14 = parentsOf(await tree.getTreeStructure([14]), 14);
  assertEqual(parents14[b14.id], undefined, "14 前置：A 被关闭后第一个子标签 B 提升为顶层");
  assertEqual(parents14[x14.id], b14.id, "14 前置：其余子标签挂到第一个子标签 B 下");
  const record14 = (storageData.session.closedTabLog || []).find((record) => record.tabId === a14.id);
  assertEqual(
    Array.isArray(record14 && record14.promotedChildren) ? record14.promotedChildren.length : 0,
    2,
    "14：关闭记录里记下了 2 个被提升的直属子标签"
  );

  // Ctrl+Shift+T：只恢复 A 一个标签，撤销时必须把 B、X 挂回 A 下。
  const a14again = await openTab({ windowId: 14, url: "https://a14.example/", title: "A14" });
  assertTrue(await waitForParent(14, b14.id, a14again.id), "14：撤销后 B 重新挂回 A 下");
  assertTrue(await waitForParent(14, x14.id, a14again.id), "14：撤销后 X 重新挂回 A 下");
  parents14 = parentsOf(await tree.getTreeStructure([14]), 14);
  assertEqual(parents14[c14.id], b14.id, "14：孙标签 C 仍跟着 B（只重挂直属子标签）");

  // 14b：用户已经手动改过某个子标签的父 → 撤销时不得覆盖用户意图。
  const r14 = await openTab({ windowId: 14, url: "https://r14.example/", title: "R14" });
  const b14b = await openTab({ windowId: 14, url: "https://b14b.example/", openerTabId: a14again.id, title: "B14B" });
  await closeTabs([a14again.id]);
  // 关闭提升把 B14B 变成顶层；用户随后把它拖到 R14 下（用管理页拖拽的同一入口）。
  await tree.moveTabTree({ tabId: b14b.id, parentId: r14.id });
  const a14third = await openTab({ windowId: 14, url: "https://a14.example/", title: "A14" });
  await tick(300);
  parents14 = parentsOf(await tree.getTreeStructure([14]), 14);
  assertEqual(parents14[b14b.id], r14.id, "14b：用户改过父的子标签不被撤销覆盖");
  assertEqual(parents14[a14third.id], undefined, "14b：被恢复的 A 仍是顶层（没有被误挂）");

  // --- 场景 15：活动标签物理上排在新标签之后 → 同步落位不得挂到它下面 ---
  // 这正是用户报的现象：Ctrl+Shift+T 把标签放回原位置（活动标签在它后面），
  // 旧实现按"创建时刻的活动标签"挂父 → 产生非法父（父排在子之后），直到落盘前才被静默改回顶层——
  // 期间界面显示的就是 `B - A / C` 这种非法结构。
  console.log("场景 15：不得产生「父排在子之后」的非法父");
  windows.push({ id: 15 });
  await tree.getTreeStructure([15]);
  const p15 = await openTab({ windowId: 15, url: "https://p15.example/", title: "P15" });
  const q15 = await openTab({ windowId: 15, url: "https://q15.example/", title: "Q15" });
  // 让 Q 成为"创建时刻的活动标签"，随后在它**之前**插入一个没有 opener 的新标签。
  tree.handleTreeTabActivated({ windowId: 15, tabId: q15.id });
  const before15 = addTab({ windowId: 15, url: "https://before15.example/", title: "Before", index: p15.index });
  await emitAsync(listeners.created, { ...before15 });
  await tick(30);
  const structure15 = await tree.getTreeStructure([15]);
  assertEqual(
    parentsOf(structure15, 15)[before15.id],
    undefined,
    "15：活动标签在物理上之后 → 不挂父（顶层），而不是产生非法父"
  );
  assertTrue(
    parentsOf(structure15, 15)[q15.id] === undefined,
    "15：活动标签 Q 自己不受影响"
  );

  // --- 场景 16：结构变化推送 + 落盘前静默纠偏也要推送、并重写会话值 ---
  console.log("场景 16：结构变更推送（含落盘前的静默纠偏）");
  // 恢复 Firefox 的每标签会话值（场景 12 起被摘掉），用于验证"纠偏后重写会话值"。
  chrome.sessions.setTabValue = chromeSessions.setTabValue;
  chrome.sessions.getTabValue = chromeSessions.getTabValue;
  windows.push({ id: 16 });
  await tree.getTreeStructure([16]);
  const p16 = await openTab({ windowId: 16, url: "https://p16.example/", title: "P16" });
  const c16 = await openTab({ windowId: 16, url: "https://c16.example/", openerTabId: p16.id, title: "C16" });
  await tick(30);

  // 让物理顺序变非法（父 P 排到了子 C 之后）且**不派发事件**：模拟"插件不知情时结构已变"。
  moveTabPhysicallyRaw(c16.id, 0);
  // 再把窗口标脏（真实场景里由其它结构事件触发落盘）。
  await openTab({ windowId: 16, url: "https://filler16.example/", title: "Filler16" });
  await tick(30);
  const pushedBefore = revisionSnapshots.length;
  assertTrue(pushedBefore > 0, "16：结构变化后写下了树结构版本号（前端据此重拉父子映射）");
  const lastSnapshot = revisionSnapshots[pushedBefore - 1];
  assertTrue(
    Object.values(lastSnapshot.revisions || {}).some((value) => Number.isFinite(Number(value))),
    "16：版本号里带 revision"
  );
  assertTrue(
    typeof lastSnapshot.token === "string" && lastSnapshot.token.length > 0,
    "16：版本号里带后台实例令牌（后台重启后版本号不可比较）"
  );

  await tree.handleTreeSuspend(); // 等价于后台被回收前的落盘：会跑不变量校验并静默纠偏
  await tick(80);
  const structure16 = await tree.getTreeStructure([16]);
  assertEqual(
    parentsOf(structure16, 16)[c16.id],
    undefined,
    "16：落盘前的静默纠偏把非法父改回顶层（界面重拉即可看到真实结构）"
  );
  assertTrue(
    revisionSnapshots.length > pushedBefore,
    "16：静默纠偏也通知了前端（否则界面会停在旧层级）"
  );
  const newestSnapshot = revisionSnapshots[revisionSnapshots.length - 1];
  assertEqual(
    structure16.structures[16].revisionToken,
    newestSnapshot.token,
    "16：拉取结果与通知带同一个后台实例令牌"
  );
  assertTrue(
    Number(structure16.structures[16].revision) >= Number(newestSnapshot.revisions[16]),
    "16：拉取结果里的 revision 不旧于最后一次通知"
  );
  // 纠偏后必须把新的父写回每标签会话值（否则过期会话值会在下一次撤销时把错误父引回来）。
  await tick(400);
  const c16Value = tabValues.get(Number(c16.id));
  assertEqual(
    c16Value && c16Value["nesoi:tree-ref"] ? c16Value["nesoi:tree-ref"].parentId : "缺失",
    null,
    "16：纠偏后会话值被重写为顶层"
  );

  // --- 场景 17：内存树缺条目（创建事件落在树加载空档被丢弃）不得让"新标签挂到活动标签下"失效 ---
  // 用户现象：有时新标签不会落到当前激活页之下，过一会或者 Reload 才恢复。
  // 成因：那个"真实存在"的活动标签在内存树里没有条目，于是被当成不存在（日志里的"#X 不在树里"）。
  console.log("场景 17：内存树缺条目时要自愈，不能把真实存在的活动标签当成不存在");
  windows.push({ id: 17 });
  await tree.getTreeStructure([17]);
  const p17 = await openTab({ windowId: 17, url: "https://p17.example/", title: "P17" });
  // 造一个"在窗口里、但内存树不知道"的标签：直接进标签列表，**不派发 onCreated**
  // （等价于创建事件落在树加载的空档里被丢弃，随后因为树已装好、延迟对齐变成空操作）。
  const ghost17 = addTab({ windowId: 17, url: "https://ghost17.example/", title: "Ghost" });
  tree.handleTreeTabActivated({ windowId: 17, tabId: ghost17.id });
  const child17 = addTab({ windowId: 17, url: "https://child17.example/", title: "Child" });
  await emitAsync(listeners.created, { ...child17 });
  assertTrue(
    await waitForParent(17, child17.id, ghost17.id),
    "17：缺条目的活动标签被补为顶层后，新标签仍挂到它下面"
  );
  assertTrue(
    await waitForParent(17, ghost17.id, undefined),
    "17：被补的标签本身是顶层"
  );

  // --- 场景 18：撤销恢复时子标签物理上在父之前 → 仍要还原子树（A - B - C）---
  // 用户现象：原先是 A-B-C，关闭 A 后 B 被提升为顶层，撤销却只把 A 挂在顶层（"B-C 没变、A 单独在顶层"），
  // 原因是重挂要求"父在物理上排在子之前"，而原来的物理顺序是子在前。
  console.log("场景 18：子标签物理上在父之前时，撤销仍要还原子树");
  windows.push({ id: 18 });
  await tree.getTreeStructure([18]);
  const a18 = await openTab({ windowId: 18, url: "https://a18.example/", title: "A18" });
  const b18 = await openTab({ windowId: 18, url: "https://b18.example/", openerTabId: a18.id, title: "B18" });
  const c18 = await openTab({ windowId: 18, url: "https://c18.example/", openerTabId: a18.id, title: "C18" });
  let parents18 = parentsOf(await tree.getTreeStructure([18]), 18);
  assertEqual(parents18[b18.id], a18.id, "18 前置：B 是 A 的子标签");
  // 再把物理顺序改成"子标签都在父之前"且**不派发 onMoved**：树顺序与标签栏顺序本来就允许不一致
  // （用户可以拖动标签栏），这里模拟的正是"撤销时子标签物理上排在父之前"。
  moveTabPhysicallyRaw(a18.id, 2);
  assertTrue(tabById(b18.id).index < tabById(a18.id).index, "18 前置：B 物理上排在 A 之前");
  assertTrue(tabById(c18.id).index < tabById(a18.id).index, "18 前置：C 物理上排在 A 之前");

  await closeTabs([a18.id]); // 原生关闭 A：B、C 被提升出去
  parents18 = parentsOf(await tree.getTreeStructure([18]), 18);
  assertEqual(parents18[b18.id], undefined, "18 前置：A 关闭后 B 被提升为顶层");

  const a18again = await openTab({ windowId: 18, url: "https://a18.example/", title: "A18" });
  assertTrue(await waitForParent(18, b18.id, a18again.id), "18：撤销后 B 重新挂回 A 下");
  assertTrue(await waitForParent(18, c18.id, a18again.id), "18：撤销后 C 重新挂回 A 下");
  assertTrue(
    tabById(a18again.id).index < tabById(b18.id).index,
    "18：重挂后父在物理上排在子之前（不变量成立）"
  );

  // --- 场景 19：本插件自己写的会话值不能当"这是撤销恢复"的证据 ---
  // 成因：每个新标签在 250ms 后都会由本插件写下 `nesoi:tree-ref`，
  // 判定若采信它，就会把普通新标签误判成撤销恢复，并**提前结束判定**、跳过真正该走的 URL 兜底。
  console.log("场景 19：本插件自己写的会话值不算撤销证据");
  windows.push({ id: 19 });
  await tree.getTreeStructure([19]);
  const r19 = await openTab({ windowId: 19, url: "https://r19.example/", title: "R19" });
  const leaf19 = await openTab({ windowId: 19, url: "https://leaf19.example/", openerTabId: r19.id, title: "Leaf19" });
  const anchor19 = await openTab({ windowId: 19, url: "https://anchor19.example/", title: "Anchor19" });
  tree.handleTreeTabActivated({ windowId: 19, tabId: anchor19.id });
  await closeTabs([leaf19.id]);
  // 模拟 Ctrl+Shift+T：先 about:blank 出现，且本插件已经为它写下了"挂到活动标签下"的会话值。
  const ownRef19 = addTab({ windowId: 19, url: "about:blank", status: "loading", title: "" });
  await emitAsync(listeners.created, { ...ownRef19 });
  await tick(30);
  // 创建之后本插件自己写下的引用（真实时序就是 ~250ms 防抖）：
  // `at` 晚于创建时刻 → 判定必须把它当"自己的写入"而不是"撤销恢复的证据"。
  tabValues.set(Number(ownRef19.id), {
    "nesoi:tree-ref": { parentId: anchor19.id, at: Date.now() },
  });
  await tick(60);
  // 真实 URL 随后就绪：判定应当继续走 URL 兜底，按关闭记录挂回原父（而不是被自己的会话值带偏）。
  const live19 = tabById(ownRef19.id);
  live19.url = "https://leaf19.example/";
  live19.title = "Leaf19";
  live19.status = "complete";
  assertTrue(
    await waitForParent(19, ownRef19.id, r19.id),
    "19：自己的会话值被忽略后，仍按关闭记录挂回原父"
  );

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

/**
 * 场景 3 起把 sessions.setTabValue / getTabValue 去掉，模拟 Chrome（没有每标签会话值）。
 * 监听器保持不变——这正是本插件在两端唯一的差异点。
 */
function setupChromeMockKeepListeners() {
  const { setTabValue, getTabValue } = chrome.sessions;
  delete chrome.sessions.setTabValue;
  delete chrome.sessions.getTabValue;
  return { setTabValue, getTabValue };
}

await main();
