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
  const setTabValue = (tabId, key, value, callback) => {
    const entry = tabValues.get(Number(tabId)) || {};
    entry[key] = clone(value);
    tabValues.set(Number(tabId), entry);
    callback && callback();
  };
  const getTabValue = (tabId, key, callback) => {
    const entry = tabValues.get(Number(tabId)) || {};
    callback(entry[key]);
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
  await tick(20);
  structure = await tree.getTreeStructure([1]);
  assertEqual(parentsOf(structure, 1)[reopened.id], root.id, "原生撤销后回到原父 Root 之下");
  assertEqual(tabById(reopened.id).index, leafIndex, "原生撤销后回到原物理位置");

  // --- 场景 4：Firefox 的每标签会话值 ---
  console.log("场景 4：Firefox 每标签会话值——有值精确恢复，无值退回默认规则");
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
  // 会话值必须在派发 onCreated **之前**就位：判定与套用都发生在创建事件的同步/近同步阶段。
  const firefoxReopen = addTab({ url: "https://fleaf.example/", title: "FLeaf" });
  tabValues.set(Number(firefoxReopen.id), { "nesoi:tree-ref": { parentId: froot.id, at: Date.now() } });
  await emitAsync(listeners.created, { ...firefoxReopen });
  await tick(20);
  structure = await tree.getTreeStructure([1]);
  assertEqual(
    parentsOf(structure, 1)[firefoxReopen.id],
    froot.id,
    "Firefox：有会话值时精确挂回原父"
  );

  // 4b：用户手动打开了同一个 URL（没有会话值）→ 判定失败，退回默认规则且记录被放回。
  const anchor = await openTab({ url: "https://anchor.example/", title: "Anchor" });
  tree.handleTreeTabActivated({ windowId: 1, tabId: anchor.id });
  const secondLeaf = await openTab({ url: "https://fleaf.example/", openerTabId: froot.id, title: "FLeaf" });
  await tick(350);
  await closeTabs([secondLeaf.id]);
  const manual = await openTab({ url: "https://fleaf.example/", title: "FLeaf" });
  await tick(20);
  structure = await tree.getTreeStructure([1]);
  assertEqual(
    parentsOf(structure, 1)[manual.id],
    anchor.id,
    "Firefox：无会话值时不按 URL 误判（退回默认规则挂到活动标签）"
  );
  assertEqual(
    (storageData.session.closedTabLog || []).some((record) => record.url === "https://fleaf.example/"),
    true,
    "判定失败后关闭记录被放回栈里"
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
