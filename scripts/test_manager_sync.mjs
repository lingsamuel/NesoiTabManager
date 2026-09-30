// 管理页「打开的窗口」数据同步（useWindowsSync）的单元测试。
//
// 为什么必须测：管理页被复用后不会重新挂载，列表是否最新完全取决于这套订阅与调度。
// 而它真正的难点都不是"能不能收到事件"，而是三个"什么时候**不**刷新"的判断——
// 页面不可见时不刷（置 pending，回来补一次）、不在「打开的窗口」视图时不刷、
// onUpdated 只改了 status/audible 时不刷。这些在浏览器里表现为"偶尔多一次查询"或
// "切回来还是旧的"，肉眼很难定位，因此用假 chrome / 假 document 固定住。
//
// 做法与 scripts/test_sidebar_manager.mjs 一致：直接跑真实源码，不在测试里重写一份逻辑。

import {
  REFRESH_DEBOUNCE_MS,
  RELEVANT_TAB_CHANGE_KEYS,
  useWindowsSync,
} from "../src/manager/composables/useWindowsSync.js";

let failures = 0;
let checks = 0;

function assertEqual(actual, expected, label) {
  checks += 1;
  if (Object.is(actual, expected)) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`✗ ${label}\n    期望 ${String(expected)}\n    实际 ${String(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  checks += 1;
  if (a === b) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`✗ ${label}\n    期望 ${b}\n    实际 ${a}`);
  }
}

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 可控的假定时器：不依赖真实时钟，撤掉的回调不会再触发。 */
function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** 触发定时器并返回此刻仍待执行的定时器数量。 */
    runAll() {
      const items = [...pending.entries()];
      pending.clear();
      for (const [, item] of items) {
        item.fn();
      }
      return pending.size;
    },
    size() {
      return pending.size;
    },
  };
}

/** 假 chrome：记录监听器数量，并提供 emit 来派发事件。 */
function createFakeChrome() {
  const store = new Map();
  const name = (group, event) => `${group}:${event}`;
  let idCounter = 0;
  const makeEvent = (key) => ({
    addListener(fn) {
      if (!store.has(key)) {
        store.set(key, []);
      }
      store.get(key).push({ id: (idCounter += 1), fn });
    },
    removeListener(fn) {
      const list = store.get(key) || [];
      store.set(
        key,
        list.filter((item) => item.fn !== fn)
      );
    },
  });
  const chrome = { tabs: {}, windows: {} };
  const tabEvents = ["onCreated", "onRemoved", "onMoved", "onAttached", "onDetached", "onUpdated", "onActivated"];
  const windowEvents = ["onCreated", "onRemoved"];
  for (const event of tabEvents) {
    chrome.tabs[event] = makeEvent(name("tabs", event));
  }
  for (const event of windowEvents) {
    chrome.windows[event] = makeEvent(name("windows", event));
  }
  return {
    chrome,
    emit(group, event, ...args) {
      for (const { fn } of [...(store.get(name(group, event)) || [])]) {
        fn(...args);
      }
    },
    listenerCount(group, event) {
      return (store.get(name(group, event)) || []).length;
    },
    totalListeners() {
      let total = 0;
      for (const list of store.values()) {
        total += list.length;
      }
      return total;
    },
  };
}

/** 假 document：只需 visibilityState 与 visibilitychange。 */
function createFakeDocument() {
  const listeners = [];
  const doc = {
    visibilityState: "visible",
    addEventListener(type, fn) {
      if (type === "visibilitychange") {
        listeners.push(fn);
      }
    },
    removeEventListener(type, fn) {
      if (type !== "visibilitychange") {
        return;
      }
      const index = listeners.indexOf(fn);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
  };
  return {
    doc,
    setVisibility(state) {
      doc.visibilityState = state;
      for (const fn of [...listeners]) {
        fn();
      }
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

/**
 * 搭一个"管理页"场景。
 * @param {object} [state] visible/view 由测试直接改，用来模拟"页面被切到后台 / 用户切到别的视图"。
 */
function createHarness(state = {}) {
  const timers = createFakeTimers();
  const fakeChrome = createFakeChrome();
  const fakeDoc = createFakeDocument();
  const view = { current: state.view || "windows" };
  let visible = state.visible !== false;
  fakeDoc.doc.visibilityState = visible ? "visible" : "hidden";

  const refreshes = [];
  const sync = useWindowsSync({
    chrome: fakeChrome.chrome,
    document: fakeDoc.doc,
    canRefresh: () => view.current === "windows",
    refresh: () => {
      refreshes.push({ visible, view: view.current });
      return Promise.resolve();
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  sync.start();

  return {
    sync,
    refreshes,
    timers,
    view,
    // 注意用箭头函数包一层：解构后直接赋值会丢掉 fakeChrome 的 this 绑定。
    emit: (...args) => fakeChrome.emit(...args),
    listenerCount: (...args) => fakeChrome.listenerCount(...args),
    totalListeners: () => fakeChrome.totalListeners(),
    docListeners: () => fakeDoc.listenerCount(),
    setVisible(next) {
      visible = next;
      fakeDoc.setVisibility(next ? "visible" : "hidden");
    },
    isVisible: () => visible,
  };
}

/** 刷新回调被排在微任务里，断言前先把微任务放干净。 */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log("管理页窗口数据同步");

  // --- 纯谓词：事件是否值得刷新 -------------------------------------------
  const h0 = createHarness();
  assertEqual(REFRESH_DEBOUNCE_MS, 250, "防抖窗口为 250ms（与侧边栏同口径）");
  assertDeepEqual(
    RELEVANT_TAB_CHANGE_KEYS,
    ["title", "url", "favIconUrl", "discarded", "pinned", "mutedInfo"],
    "onUpdated 只认影响展示的字段"
  );

  // onUpdated 只改了 status / audible → 不排队
  h0.emit("tabs", "onUpdated", 1, { status: "loading" }, { id: 1, windowId: 1 });
  assertEqual(h0.timers.size(), 0, "onUpdated 只改 status 时不触发刷新");
  h0.emit("tabs", "onUpdated", 1, { audible: true }, { id: 1, windowId: 1 });
  assertEqual(h0.timers.size(), 0, "onUpdated 只改 audible 时不触发刷新");
  // 改了展示字段 → 排队
  h0.emit("tabs", "onUpdated", 1, { title: "新标题" }, { id: 1, windowId: 1 });
  assertEqual(h0.timers.size(), 1, "onUpdated 改标题时排入一次刷新");
  h0.emit("windows", "onRemoved", 2);
  assertEqual(h0.timers.size(), 1, "连续事件共用同一个防抖定时器");
  h0.timers.runAll();
  await settle();
  assertEqual(h0.refreshes.length, 1, "多个事件只刷新一次");
  h0.sync.dispose();

  // --- 可见性：不可见只置 pending，回到可见补一次 --------------------------
  const h1 = createHarness();
  h1.emit("tabs", "onCreated", { id: 2, windowId: 1 });
  h1.timers.runAll();
  await settle();
  assertEqual(h1.refreshes.length, 1, "可见时事件到达即刷新");
  h1.emit("tabs", "onRemoved", 2, { windowId: 1 });
  assertEqual(h1.timers.size(), 1, "隐藏前先排入一次刷新");
  h1.setVisible(false);
  h1.timers.runAll();
  await settle();
  assertEqual(h1.refreshes.length, 1, "页面隐藏时不发起查询");
  h1.emit("tabs", "onCreated", { id: 3, windowId: 1 });
  h1.timers.runAll();
  await settle();
  assertEqual(h1.refreshes.length, 1, "隐藏期间到达的事件同样不查询");
  h1.setVisible(true);
  assertEqual(h1.timers.size(), 1, "回到可见时补排一次刷新");
  h1.timers.runAll();
  await settle();
  assertEqual(h1.refreshes.length, 2, "回到可见后补齐一次");
  h1.sync.dispose();

  // 隐藏期间没有事件 → 回到可见不产生多余的刷新
  const h2 = createHarness();
  h2.setVisible(false);
  h2.setVisible(true);
  assertEqual(h2.timers.size(), 0, "空闲时重新可见不触发刷新");
  assertEqual(h2.refreshes.length, 0, "空闲时重新可见没有查询");
  h2.sync.dispose();

  // --- 视图闸门：不在「打开的窗口」视图时不查询、不留补刷标记 --------------
  const h3 = createHarness({ view: "lists" });
  h3.emit("tabs", "onCreated", { id: 4, windowId: 1 });
  h3.timers.runAll();
  await settle();
  assertEqual(h3.refreshes.length, 0, "停在其它视图时事件不触发查询");
  h3.setVisible(false);
  h3.setVisible(true);
  assertEqual(h3.refreshes.length, 0, "视图不对时不会因为重新可见而补刷（由 setView 负责）");
  h3.view.current = "windows";
  h3.emit("tabs", "onCreated", { id: 5, windowId: 1 });
  h3.timers.runAll();
  await settle();
  assertEqual(h3.refreshes.length, 1, "切回本视图后事件恢复刷新");
  h3.sync.dispose();

  // --- 复用页面被激活：立即刷新，不等防抖 --------------------------------
  const h4 = createHarness();
  h4.sync.setSelfTabId(77);
  h4.emit("tabs", "onActivated", { tabId: 55, windowId: 1 });
  assertEqual(h4.refreshes.length, 0, "切到别的标签不刷新");
  h4.emit("tabs", "onActivated", { tabId: 77, windowId: 1 });
  await settle();
  assertEqual(h4.refreshes.length, 1, "管理页自己被激活时立即刷新");
  assertEqual(h4.timers.size(), 0, "被激活的刷新不等防抖窗口");
  h4.sync.dispose();

  // selfTabId 未知（查询还没回来）时不误判
  const h5 = createHarness();
  h5.emit("tabs", "onActivated", { tabId: 77, windowId: 1 });
  assertEqual(h5.refreshes.length, 0, "selfTabId 未知时不因激活刷新");
  h5.sync.setSelfTabId(null);
  h5.emit("tabs", "onActivated", { tabId: 77, windowId: 1 });
  assertEqual(h5.refreshes.length, 0, "selfTabId 为 null 时忽略激活事件");
  h5.sync.dispose();

  // --- 清理：dispose 摘掉全部监听与未执行定时器 ---------------------------
  const h6 = createHarness();
  assertEqual(h6.totalListeners(), 9, "订阅了 6 个 tabs 展示事件 + 3 个窗口/激活事件");
  assertEqual(h6.docListeners(), 1, "订阅了 visibilitychange");
  h6.emit("tabs", "onCreated", { id: 6, windowId: 1 });
  assertEqual(h6.timers.size(), 1, "存在待执行的防抖定时器");
  h6.sync.dispose();
  assertEqual(h6.totalListeners(), 0, "dispose 摘掉全部 chrome 监听");
  assertEqual(h6.docListeners(), 0, "dispose 摘掉 visibilitychange");
  assertEqual(h6.timers.size(), 0, "dispose 清掉未执行的防抖定时器");
  h6.timers.runAll();
  h6.emit("tabs", "onCreated", { id: 7, windowId: 1 });
  assertEqual(h6.refreshes.length, 0, "dispose 后事件与定时器都不再刷新");

  // --- 缺事件名的浏览器：跳过该事件而不是整页失败 ------------------------
  const timers = createFakeTimers();
  const partialChrome = {
    tabs: {
      onCreated: {
        addListener() {},
        removeListener() {},
      },
    },
  };
  const errors = [];
  const partialSync = useWindowsSync({
    chrome: partialChrome,
    document: createFakeDocument().doc,
    canRefresh: () => true,
    refresh: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onError: (...args) => errors.push(args.join(" ")),
  });
  partialSync.start();
  assertEqual(errors.length, 0, "缺事件名时静默跳过（不报错、不抛异常）");
  partialSync.dispose();

  // --- 刷新回调抛错：不影响后续事件 --------------------------------------
  // 回调被 Promise.resolve().then 包了一层，因此要用 await 让微任务跑完再断言。
  const throwChrome = createFakeChrome();
  const throwTimers = createFakeTimers();
  let throwAttempts = 0;
  const throwSync = useWindowsSync({
    chrome: throwChrome.chrome,
    document: createFakeDocument().doc,
    canRefresh: () => true,
    refresh: () => {
      throwAttempts += 1;
      throw new Error("模拟查询失败");
    },
    setTimeout: throwTimers.setTimeout,
    clearTimeout: throwTimers.clearTimeout,
  });
  throwSync.start();
  throwChrome.emit("tabs", "onCreated", { id: 8, windowId: 1 });
  throwTimers.runAll();
  await Promise.resolve();
  await Promise.resolve();
  throwChrome.emit("tabs", "onCreated", { id: 9, windowId: 1 });
  throwTimers.runAll();
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(throwAttempts, 2, "刷新回调抛错后仍能继续接收后续事件");
  throwSync.dispose();

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

main();
