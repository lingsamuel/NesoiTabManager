// 外部拖放"执行层"（background/dropped_item.js）的测试。
//
// 这一层要同时踩三块容易出错的逻辑，而它们在真实浏览器里很难复现：
// 1. `chrome.search.search` 与 `tabs.discard` 一样是 Promise 形式（没有 callback），传错参数会被
//    Firefox 的 schema 直接拒绝 —— 这里用一个"严格校验"的模拟把它固定住；
// 2. 新建标签页的物理下标必须与"树里的落位"一致（父标签 + 子树末尾）；
// 3. 新建后 `tabs.onCreated` 必须同步套用落位（本测试手动触发该事件，验证父子关系真的落进了树里）。

// ---------------------------------------------------------------------------
// chrome API 模拟
// ---------------------------------------------------------------------------

let tabs = [];
let nextTabId = 100;
const storageData = { local: {}, session: {} };
const createdTabs = [];
const updatedTabs = [];
const focusedWindows = [];
const searchCalls = [];

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

function setupChromeMock() {
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: { local: storageArea("local"), session: storageArea("session") },
    alarms: { create() {}, clear() {} },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: (callback) => callback([{ id: 10 }]),
      update: (windowId, info, callback) => {
        focusedWindows.push({ windowId, info: clone(info) });
        if (callback) {
          callback({ id: windowId });
        }
      },
    },
    tabs: {
      get(id, callback) {
        if (!Number.isInteger(Number(id)) || Number(id) < 0) {
          throw new Error("Incorrect argument types for tabs.get");
        }
        const tab = tabs.find((item) => item.id === Number(id));
        if (!tab) {
          chrome.runtime.lastError = { message: "No tab with id" };
          callback(undefined);
          chrome.runtime.lastError = null;
          return;
        }
        callback(clone(tab));
      },
      query(queryInfo, callback) {
        const info = queryInfo || {};
        callback(
          tabs
            .filter((tab) => (info.windowId === undefined ? true : tab.windowId === info.windowId))
            .filter((tab) => (info.active === undefined ? true : Boolean(tab.active) === info.active))
            .map(clone)
        );
      },
      create(info, callback) {
        const created = {
          id: nextTabId,
          windowId: info.windowId,
          index: info.index,
          pinned: Boolean(info.pinned),
          active: Boolean(info.active),
          discarded: false,
          audible: false,
          url: info.url || "",
          title: info.url || "新标签页",
          favIconUrl: "",
          openerTabId: undefined,
        };
        nextTabId += 1;
        createdTabs.push({ info: clone(info), tab: clone(created) });
        // 真实浏览器会把它插进窗口序列：这里保持一致，后续树对齐才读得到。
        const ordered = tabs.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
        const at = Math.max(0, Math.min(Number(info.index) || 0, ordered.length));
        ordered.splice(at, 0, created);
        ordered.forEach((tab, index) => {
          tab.index = index;
        });
        tabs = ordered;
        if (callback) {
          callback(clone(created));
        }
        return undefined;
      },
      update(id, changes, callback) {
        const numericId = Number(id);
        updatedTabs.push({ id: numericId, changes: clone(changes) });
        const tab = tabs.find((item) => item.id === numericId);
        if (!tab) {
          chrome.runtime.lastError = { message: "No tab with id" };
          if (callback) {
            callback(undefined);
          }
          chrome.runtime.lastError = null;
          return;
        }
        if (changes.url) {
          tab.url = changes.url;
        }
        if (changes.active) {
          tabs.forEach((item) => {
            item.active = item.id === numericId;
          });
        }
        if (callback) {
          callback(clone(tab));
        }
      },
    },
    // 与 Firefox schema 一致：只接受一个对象参数，返回 Promise（没有 callback）。
    search: {
      search(...args) {
        searchCalls.push(args);
        if (args.length !== 1 || !args[0] || typeof args[0].query !== "string") {
          throw new Error("Incorrect argument types for search.search");
        }
        return Promise.resolve();
      },
    },
  };
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

function resetCalls() {
  createdTabs.length = 0;
  updatedTabs.length = 0;
  focusedWindows.length = 0;
  searchCalls.length = 0;
}

function makeTab(overrides) {
  return {
    id: 0,
    windowId: 10,
    index: 0,
    active: false,
    pinned: false,
    discarded: false,
    audible: false,
    url: "https://example.org/",
    title: "示例",
    favIconUrl: "",
    ...overrides,
  };
}

function resetTabs() {
  nextTabId = 100;
  // 窗口 10：固定标签 1；顶层 2；2 的子标签 3、4；顶层 5。
  tabs = [
    makeTab({ id: 1, index: 0, pinned: true, url: "https://pinned.example/" }),
    makeTab({ id: 2, index: 1, url: "https://a.example/" }),
    makeTab({ id: 3, index: 2, url: "https://a.example/child1", openerTabId: 2 }),
    makeTab({ id: 4, index: 3, url: "https://a.example/child2", openerTabId: 2 }),
    makeTab({ id: 5, index: 4, url: "https://b.example/" }),
  ];
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

async function main() {
  setupChromeMock();
  resetTabs();

  const droppedItem = await import("../background/dropped_item.js");
  const tree = await import("../background/tree.js");

  console.log("场景 1：覆盖某个标签 —— 用链接");
  resetCalls();
  let result = await droppedItem.openDroppedItem({ replaceTabId: 5, url: "https://target.example/x" });
  assertDeepEqual(result, { mode: "replace", tabId: 5 }, "返回覆盖结果");
  assertEqual(createdTabs.length, 0, "不新建标签页");
  assertDeepEqual(
    updatedTabs,
    [
      { id: 5, changes: { url: "https://target.example/x" } },
      { id: 5, changes: { active: true } },
    ],
    "先改 url 再激活该标签"
  );
  assertDeepEqual(focusedWindows, [{ windowId: 10, info: { focused: true } }], "聚焦所在窗口");

  console.log("");
  console.log("场景 2：覆盖某个标签 —— 用搜索词（默认搜索引擎）");
  resetCalls();
  result = await droppedItem.openDroppedItem({ replaceTabId: 5, query: "怎么修 tabs.discard" });
  assertDeepEqual(result, { mode: "replace", tabId: 5 }, "返回覆盖结果");
  assertEqual(createdTabs.length, 0, "不新建标签页");
  assertDeepEqual(
    searchCalls.map((args) => args.length),
    [1],
    "search.search 只传一个对象参数（Firefox 没有 callback 形参）"
  );
  assertDeepEqual(
    searchCalls[0][0],
    { query: "怎么修 tabs.discard", tabId: 5 },
    "搜索落在被覆盖的那个标签上"
  );
  assertEqual(
    updatedTabs.some((item) => item.changes.url),
    false,
    "搜索路径不改 url（交给搜索引擎）"
  );

  console.log("");
  console.log("场景 3：插入到某个标签之后（父标签 + 子树末尾）");
  resetCalls();
  result = await droppedItem.openDroppedItem({
    windowId: 10,
    parentId: 2,
    afterTabId: 4,
    url: "https://new.example/",
  });
  assertEqual(result.mode, "insert", "返回插入结果");
  assertDeepEqual(
    createdTabs[0].info,
    {
      windowId: 10,
      index: 4,
      url: "https://new.example/",
      active: true,
      pinned: false,
    },
    "物理下标落在 4 的整棵子树之后（4 没有子标签 → 下标 4）"
  );
  // 手动派发 onCreated：验证落位标记让后台**同步**套用父子关系。
  await tree.handleTreeTabCreated(createdTabs[0].tab);
  const structure = await tree.getTreeStructure([10]);
  assertDeepEqual(
    structure.structures[10].parents[result.tabId],
    2,
    "新标签挂在与落点行相同的父标签下"
  );

  console.log("");
  console.log("场景 4：在固定标签之间插入一个固定标签");
  resetCalls();
  resetTabs();
  result = await droppedItem.openDroppedItem({
    windowId: 10,
    pinned: true,
    beforeTabId: 1,
    url: "https://new-pinned.example/",
  });
  assertDeepEqual(
    createdTabs[0].info,
    {
      windowId: 10,
      index: 0,
      url: "https://new-pinned.example/",
      active: true,
      pinned: true,
    },
    "固定标签的插入下标落在固定区间内"
  );
  await tree.handleTreeTabCreated(createdTabs[0].tab);
  const pinnedStructure = await tree.getTreeStructure([10]);
  assertEqual(
    Object.prototype.hasOwnProperty.call(pinnedStructure.structures[10].parents, result.tabId),
    false,
    "固定标签始终是顶层，不写进父子映射"
  );

  console.log("");
  console.log("场景 5：搜索词 + 插入 —— 先建标签页，再让搜索落在这个 tabId 上");
  resetCalls();
  resetTabs();
  result = await droppedItem.openDroppedItem({
    windowId: 10,
    parentId: null,
    beforeTabId: 5,
    query: "example domain",
  });
  assertEqual(createdTabs[0].info.url, "about:blank", "先建空白页占位");
  assertEqual(createdTabs[0].info.index, 4, "空白页就落在目标位置");
  assertDeepEqual(
    searchCalls[0][0],
    { query: "example domain", tabId: result.tabId },
    "搜索结果灌进刚建的那个标签"
  );

  console.log("");
  console.log("场景 6：非法或空内容被拒绝");
  const errors = [];
  for (const payload of [
    { windowId: 10, url: "" },
    { windowId: 10, url: "javascript:alert(1)" },
    { replaceTabId: 999, url: "https://example.org/" },
    { url: "https://example.org/" },
  ]) {
    try {
      await droppedItem.openDroppedItem(payload);
      errors.push("");
    } catch (error) {
      errors.push(String(error.message || error));
    }
  }
  assertDeepEqual(
    errors,
    [
      "拖放的内容为空或不被允许。",
      "拖放的内容为空或不被允许。",
      "目标标签页不存在或已被关闭。",
      "窗口参数无效。",
    ],
    "四类非法输入都有中文错误"
  );

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

await main();
