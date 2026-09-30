// 右键菜单注册与点击处理的回归测试。
//
// 这一层完全无法在 Node 里"跑起来看效果"，但它是纯逻辑 + chrome API 调用序列：
// 用一套最小 chrome 模拟就能验证"注册了哪些项、上下文是不是 tab、onShown 有没有按被右键标签改状态、
// 每个菜单项点击后调了哪个 API"。菜单文案/状态算错、或点错 API，都会在这里被抓住。

// ---------------------------------------------------------------------------
// chrome API 模拟
// ---------------------------------------------------------------------------

const createdItems = [];
const removedIds = [];
const updatedItems = [];
let refreshCount = 0;
const calls = { reload: [], updateTab: [], discard: [], move: [], createWindow: [], clipboard: [] };

let windows = [];
let tabs = [];
const storageData = { local: {}, session: {} };
const onShownListeners = [];
const onClickedListeners = [];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function storageArea(area) {
  return {
    get(key, callback) {
      const result = {};
      if (typeof key === "string") {
        if (key in storageData[area]) {
          result[key] = clone(storageData[area][key]);
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
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete storageData[area][key];
      }
      if (callback) {
        callback();
      }
    },
  };
}

function eventBucket(bucket) {
  return { addListener: (fn) => bucket.push(fn) };
}

function setupChromeMock() {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `moz-extension://test/${path}`,
      onMessage: eventBucket([]),
      onInstalled: eventBucket([]),
      onStartup: eventBucket([]),
      onSuspend: eventBucket([]),
    },
    // 存在 sidebarAction 即被判定为 Firefox，从而注册 tab 上下文菜单项
    sidebarAction: {},
    storage: { local: storageArea("local"), session: storageArea("session") },
    alarms: { create() {}, clear() {} },
    action: { setPopup() {} },
    windows: {
      getAll: (callback) => callback(windows.map((win) => ({ id: win.id }))),
      create: (options, callback) => {
        calls.createWindow.push(clone(options));
        if (callback) {
          callback({ id: 999 });
        }
      },
      onCreated: eventBucket([]),
      onRemoved: eventBucket([]),
    },
    tabs: {
      get: (id, callback) => callback(tabs.find((tab) => tab.id === id)),
      update: (id, changes, callback) => {
        calls.updateTab.push({ id, changes: clone(changes) });
        if (callback) {
          callback({ id });
        }
      },
      reload: (id) => calls.reload.push(id),
      discard: (id, callback) => {
        calls.discard.push(id);
        if (callback) {
          callback();
        }
      },
      move: (id, info, callback) => {
        calls.move.push({ id, info: clone(info) });
        if (callback) {
          callback({ id });
        }
      },
      query: (_info, callback) => callback(tabs.slice()),
    },
    contextMenus: {
      create: (options, callback) => {
        createdItems.push(clone(options));
        if (callback) {
          callback();
        }
      },
      remove: (id, callback) => {
        removedIds.push(id);
        if (callback) {
          callback();
        }
      },
      removeAll: (callback) => {
        createdItems.length = 0;
        if (callback) {
          callback();
        }
      },
      update: (id, changes, callback) => {
        updatedItems.push({ id, changes: clone(changes) });
        if (callback) {
          callback();
        }
      },
      refresh: () => {
        refreshCount += 1;
      },
      onClicked: eventBucket(onClickedListeners),
      onShown: eventBucket(onShownListeners),
    },
  };

  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text) => calls.clipboard.push(text) } },
    configurable: true,
    writable: true,
  });
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
    console.error(`✗ ${label}\n    期望 ${b}\n    实际 ${a}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function findCreated(id) {
  return createdItems.find((item) => item.id === id) || null;
}

function findUpdate(id) {
  return updatedItems.filter((item) => item.id === id).map((item) => item.changes);
}

function lastUpdate(id) {
  const list = findUpdate(id);
  return list.length > 0 ? list[list.length - 1] : null;
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

async function main() {
  setupChromeMock();
  windows = [{ id: 10 }, { id: 20 }, { id: 30 }];
  tabs = [
    {
      id: 5,
      windowId: 10,
      index: 0,
      pinned: true,
      muted: true,
      discarded: false,
      url: "https://example.org/page",
      title: "示例",
    },
  ];
  // 让「保存到列表」有一个可用的列表
  storageData.local.lists = [
    { id: "list1", name: "研究资料", description: "", items: [] },
  ];

  const menu = await import("../background/context_menu.js");

  console.log("场景 1：注册了网页项与（Firefox 专有的）tab 项");
  await menu.rebuildContextMenus();
  assertEqual(Boolean(findCreated("saveTo")), true, "注册了网页右键的「保存到列表」");
  assertEqual(Boolean(findCreated("save:list1")), true, "列表子项按现有列表生成");
  const tabItemIds = ["nesoi-tab:reload", "nesoi-tab:pin", "nesoi-tab:mute", "nesoi-tab:discard", "nesoi-tab:copyUrl", "nesoi-tab:moveTo"];
  assertDeepEqual(
    tabItemIds.map((id) => Boolean(findCreated(id))),
    [true, true, true, true, true, true],
    "六个标签菜单项都已注册"
  );
  assertDeepEqual(
    tabItemIds.map((id) => findCreated(id).contexts),
    tabItemIds.map(() => ["tab"]),
    "标签菜单项的上下文是 tab（否则不会出现在标签菜单里）"
  );

  console.log("场景 2：「移动到窗口」子菜单按 windows.getAll 的顺序生成，新窗口排最后");
  const moveChildren = createdItems.filter((item) => item.parentId === "nesoi-tab:moveTo");
  assertDeepEqual(
    moveChildren.map((item) => item.id),
    ["nesoi-tab:moveTo:win:10", "nesoi-tab:moveTo:win:20", "nesoi-tab:moveTo:win:30", "nesoi-tab:moveTo:new"],
    "三个窗口 + 移动到新窗口，顺序与编号口径一致"
  );
  assertDeepEqual(
    moveChildren.map((item) => item.title),
    ["窗口 1", "窗口 2", "窗口 3", "移动到新窗口"],
    "窗口编号 = getAll 的位次 + 1"
  );
  assertDeepEqual(
    moveChildren.map((item) => item.contexts),
    moveChildren.map(() => ["tab"]),
    "子项也必须显式声明 tab 上下文"
  );

  console.log("场景 3：onShown 按被右键的那个标签刷新文案与可用性");
  refreshCount = 0;
  updatedItems.length = 0;
  await menu.handleContextMenuShown({ contexts: ["tab"] }, tabs[0]);
  assertDeepEqual(lastUpdate("nesoi-tab:pin"), { title: "取消固定" }, "已固定的标签显示「取消固定」");
  assertDeepEqual(lastUpdate("nesoi-tab:mute"), { title: "取消静音" }, "已静音的标签显示「取消静音」");
  assertDeepEqual(lastUpdate("nesoi-tab:discard"), { enabled: true }, "未冻结时「冻结标签页」可用");
  assertEqual(lastUpdate("nesoi-tab:moveTo:win:10").visible, false, "隐藏「移动到当前窗口」");
  assertEqual(lastUpdate("nesoi-tab:moveTo:win:20").visible, true, "其它窗口保持可见");
  assertEqual(refreshCount > 0, true, "更新后调用了 menus.refresh()");

  console.log("场景 4：网页上下文不干扰（不应改动 tab 项）");
  updatedItems.length = 0;
  refreshCount = 0;
  await menu.handleContextMenuShown({ contexts: ["page"] }, tabs[0]);
  assertEqual(updatedItems.length, 0, "page 上下文不更新 tab 菜单项");
  assertEqual(refreshCount, 0, "page 上下文不触发 refresh");

  console.log("场景 5：状态没变时不重复刷新（避免 onShown↔refresh 死循环）");
  updatedItems.length = 0;
  refreshCount = 0;
  await menu.handleContextMenuShown({ contexts: ["tab"] }, tabs[0]);
  assertEqual(refreshCount, 0, "状态相同的第二次 onShown 不再 refresh");
  assertEqual(updatedItems.length, 0, "也不再重复 menus.update");
  // 换到另一个窗口的标签：窗口子项可见性必须变化并触发刷新
  updatedItems.length = 0;
  refreshCount = 0;
  await menu.handleContextMenuShown({ contexts: ["tab"] }, { ...tabs[0], windowId: 20 });
  assertEqual(refreshCount > 0, true, "被右键标签换了窗口时会重新刷新");
  assertEqual(lastUpdate("nesoi-tab:moveTo:win:20").visible, false, "隐藏新窗口对应的子项");
  assertEqual(lastUpdate("nesoi-tab:moveTo:win:10").visible, true, "原窗口子项恢复可见");

  console.log("场景 6：各菜单项点击后调到正确的 API");
  const tab = tabs[0];
  await menu.handleContextMenuClick({ menuItemId: "nesoi-tab:reload" }, tab);
  assertDeepEqual(calls.reload, [5], "刷新标签页 → tabs.reload(5)");

  await menu.handleContextMenuClick({ menuItemId: "nesoi-tab:pin" }, tab);
  assertDeepEqual(calls.updateTab.slice(-1)[0], { id: 5, changes: { pinned: false } }, "已固定 → 取消固定");

  await menu.handleContextMenuClick({ menuItemId: "nesoi-tab:mute" }, tab);
  assertDeepEqual(calls.updateTab.slice(-1)[0], { id: 5, changes: { muted: false } }, "已静音 → 取消静音");

  await menu.handleContextMenuClick({ menuItemId: "nesoi-tab:discard" }, tab);
  assertDeepEqual(calls.discard, [5], "冻结标签页 → tabs.discard(5)");

  await menu.handleContextMenuClick({ menuItemId: "nesoi-tab:copyUrl" }, tab);
  assertDeepEqual(calls.clipboard, ["https://example.org/page"], "复制链接 → 写入剪贴板");

  await menu.handleContextMenuClick({ menuItemId: "nesoi-tab:moveTo:new" }, tab);
  assertDeepEqual(calls.createWindow, [{ tabId: 5 }], "移动到新窗口 → windows.create({tabId})");

  await menu.handleContextMenuClick({ menuItemId: "nesoi-tab:moveTo:win:20" }, tab);
  assertDeepEqual(calls.move, [{ id: 5, info: { windowId: 20, index: -1 } }], "移动到窗口 → tabs.move 到目标窗口末尾");

  console.log("场景 7：网页项仍然把标签保存进列表");
  await menu.handleContextMenuClick({ menuItemId: "save:list1" }, tab);
  const saved = storageData.local.lists[0].items;
  assertEqual(saved.length, 1, "保存到列表写入了一条记录");
  assertEqual(saved[0].url, "https://example.org/page", "保存的是被点击标签的网址");

  console.log("场景 8：窗口增删会重建「移动到窗口」子菜单");
  createdItems.length = 0;
  removedIds.length = 0;
  windows = [{ id: 10 }, { id: 40 }];
  await menu.handleWindowsChanged();
  assertDeepEqual(
    createdItems.filter((item) => item.parentId === "nesoi-tab:moveTo").map((item) => item.id),
    ["nesoi-tab:moveTo:win:10", "nesoi-tab:moveTo:win:40", "nesoi-tab:moveTo:new"],
    "重建后只剩当前存在的窗口"
  );
  assertEqual(removedIds.includes("nesoi-tab:moveTo:win:20"), true, "旧窗口子项被移除");

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

await main();
