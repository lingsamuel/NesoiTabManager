// favicon 去重的回归测试。
//
// 两层：
// 1. 纯逻辑（background/favicons.js）：key 规则（内容指纹 / page-icon 归一 / 子域名隔离）、
//    写盘归一化与裁剪、读取解析、旧结构探测；
// 2. 真实写盘路径（background/lists.js）：用最小的 chrome.storage 模拟跑一遍
//    "保存 → 落盘只有 iconKey、表里只有一份 → 读取解析回 favIconUrl → 删列表后 GC →
//     导出文件紧凑（图标只出现一次）→ 落盘迁移幂等 → v2 文件导入保住图标"。
// 这一层正是"巨量重复"被消除的地方，纯函数测试覆盖不到，必须真跑 storage 往返。

import {
  computeIconKey,
  listsNeedMigration,
  normalizeListsForWrite,
  resolveLists,
} from "../background/favicons.js";

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function assertEqual(actual, expected, label) {
  checks += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`✗ ${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
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

// ---------------------------------------------------------------------------
// chrome 模拟（只为 lists.js 的 storage / tabs.get 提供最小实现）
// ---------------------------------------------------------------------------

const storageData = { local: {}, session: {} };
let tabs = [];

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
        Object.entries(storageData[area]).forEach(([k, v]) => {
          result[k] = clone(v);
        });
      } else if (Array.isArray(key)) {
        key.forEach((k) => {
          if (k in storageData[area]) {
            result[k] = clone(storageData[area][k]);
          }
        });
      }
      callback(result);
    },
    set(obj, callback) {
      Object.entries(obj).forEach(([k, v]) => {
        storageData[area][k] = clone(v);
      });
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
        delete storageData[area][key];
      });
      if (callback) {
        callback();
      }
    },
  };
}

function setupChromeMock() {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onSuspend: { addListener() {} },
    },
    storage: {
      local: storageArea("local"),
      session: storageArea("session"),
      onChanged: { addListener() {} },
    },
    alarms: { create() {}, clear() {} },
    action: { setPopup() {} },
    tabs: {
      get: (id, callback) => callback(tabs.find((tab) => tab.id === id) || null),
      query: (_info, callback) => callback(tabs.slice()),
      onCreated: { addListener() {} },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
      onMoved: { addListener() {} },
      onAttached: { addListener() {} },
      onDetached: { addListener() {} },
      onReplaced: { addListener() {} },
    },
    windows: {
      getAll: (callback) => callback([]),
      onCreated: { addListener() {} },
      onRemoved: { addListener() {} },
      onFocusChanged: { addListener() {} },
    },
    sessions: { setTabValue() {}, getTabValue() {} },
    contextMenus: { create() {}, remove() {}, removeAll() {}, update() {}, refresh() {} },
  };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const DATA_A = "data:image/png;base64,QUFBQQ==";
const DATA_B = "data:image/png;base64,QkJCQg==";
const DATA_C = "data:image/png;base64,Q0NDQw==";

function testIconKeyRules() {
  console.log("场景 1：iconKey 规则");
  assertEqual(computeIconKey(""), "", "空 favIconUrl → 空 key");
  assertEqual(computeIconKey(null), "", "null → 空 key");

  const keyA = computeIconKey(DATA_A);
  assertEqual(keyA.startsWith("d:"), true, "data: 形态 → d: 前缀（内容指纹）");
  assertEqual(keyA.length, 18, "d: + 16 位十六进制");
  assertEqual(computeIconKey(DATA_A), computeIconKey(DATA_A), "同一张图 → 同一个 key");
  assertEqual(computeIconKey(DATA_A) !== computeIconKey(DATA_B), true, "不同图片 → 不同 key");

  assertEqual(
    computeIconKey("page-icon:https://a.example.com/x"),
    computeIconKey("page-icon:https://a.example.com/y"),
    "同站点不同页面归一到同一个 key"
  );
  assertEqual(
    computeIconKey("page-icon:https://a.example.com/x"),
    "p:https://a.example.com",
    "page-icon → 页面 origin"
  );
  assertEqual(
    computeIconKey("page-icon:https://a.example.com/x") !==
      computeIconKey("page-icon:https://b.example.com/x"),
    true,
    "同一站点的不同子域名是两个 key（不能被合并）"
  );
  assertEqual(
    computeIconKey("page-icon:https://a.example.com/x") !==
      computeIconKey("page-icon:http://a.example.com/x"),
    true,
    "http 与 https 是两个 key"
  );

  assertEqual(
    computeIconKey("https://a.example.com/favicon.ico#v2"),
    "u:https://a.example.com/favicon.ico",
    "普通 URL 只去掉 fragment"
  );
  assertEqual(
    computeIconKey("https://a.example.com/favicon.ico") !==
      computeIconKey("https://b.example.com/favicon.ico"),
    true,
    "不同子域名的同名图标路径互不合并"
  );
  assertEqual(
    computeIconKey("https://cdn.example.com/i.png?v=3"),
    "u:https://cdn.example.com/i.png?v=3",
    "保留 query（可能用于区分图标版本）"
  );
  assertEqual(
    computeIconKey("page-icon:not-a-url").startsWith("u:"),
    true,
    "page-icon 内层不是绝对 URL 时退回按原字符串去重"
  );
}

function testNormalizeAndResolve() {
  console.log("场景 2：写盘归一化与读取解析");
  const lists = [
    {
      id: "l1",
      name: "n",
      description: "",
      items: [
        { url: "https://a.example.com/1", title: "A1", favIconUrl: DATA_A, savedAt: "t1" },
        { url: "https://a.example.com/2", title: "A2", favIconUrl: DATA_A, savedAt: "t2" },
        {
          url: "https://b.example.com/1",
          title: "B1",
          favIconUrl: "https://b.example.com/favicon.ico",
          savedAt: "t3",
        },
        { url: "https://c.example.com/1", title: "C1", savedAt: "t4" },
      ],
    },
  ];
  // 表里预置一条不再被引用的孤儿，验证裁剪。
  const stored = { "u:https://old.example.com/icon.png": "https://old.example.com/icon.png" };
  const out = normalizeListsForWrite(lists, stored);

  assertEqual("favIconUrl" in out.lists[0].items[0], false, "条目不再保留 favIconUrl");
  assertEqual(
    out.lists[0].items[0].iconKey,
    out.lists[0].items[1].iconKey,
    "同一张图的两个条目共用一个 key"
  );
  assertEqual(
    out.lists[0].items[0].iconKey !== out.lists[0].items[2].iconKey,
    true,
    "不同站点的图标各自独立"
  );
  assertEqual(out.lists[0].items[3].iconKey, "", "没有图标的条目 iconKey 为空串");
  assertEqual(Object.keys(out.favIcons).length, 2, "表里只留 2 条（内容指纹 + 站点 URL）");
  assertEqual(
    Object.prototype.hasOwnProperty.call(out.favIcons, "u:https://old.example.com/icon.png"),
    false,
    "未被引用的表项被裁剪"
  );
  assertEqual(out.favIcons[out.lists[0].items[0].iconKey], DATA_A, "表里存的是原始 favIconUrl");

  const resolved = resolveLists(out.lists, out.favIcons);
  assertEqual(resolved[0].items[0].favIconUrl, DATA_A, "读取时解析回 favIconUrl");
  assertEqual("iconKey" in resolved[0].items[0], false, "解析结果不含 iconKey");
  assertEqual(resolved[0].items[3].favIconUrl, "", "无图标条目解析为空串");

  // 懒迁移前的旧结构：表里没有对应项时也要照常显示。
  const legacy = resolveLists(
    [{ id: "l", items: [{ url: "u", title: "t", favIconUrl: "https://x.example.com/f.ico" }] }],
    {}
  );
  assertEqual(legacy[0].items[0].favIconUrl, "https://x.example.com/f.ico", "旧结构无表也照常返回");
  // 表项缺失（存储被手工清理）：不能抛错，返回空串让前端回退占位图。
  const missing = resolveLists([{ id: "l", items: [{ url: "u", iconKey: "d:0000000000000000" }] }], {});
  assertEqual(missing[0].items[0].favIconUrl, "", "表项缺失 → 空串（前端回退占位图）");

  // 旧结构探测：决定启动时要不要做迁移，判据是"字段是否存在"而不是"值是否为空"。
  assertEqual(
    listsNeedMigration([{ id: "l", items: [{ url: "u", iconKey: "" }] }]),
    false,
    "只有 iconKey 的条目不算待迁移（无图标的空 key 不会导致每次启动都白写）"
  );
  assertEqual(
    listsNeedMigration([{ id: "l", items: [{ url: "u", favIconUrl: "" }] }]),
    true,
    "带 favIconUrl 字段（即使为空串）就是旧结构，需要迁移"
  );
  assertEqual(listsNeedMigration([]), false, "空列表不需要迁移");
}

async function testListsStorageRoundTrip() {
  console.log("场景 3：保存到列表的真实写盘往返");
  setupChromeMock();
  tabs = [
    { id: 1, windowId: 10, url: "https://a.example.com/1", title: "A1", favIconUrl: DATA_A },
    { id: 2, windowId: 10, url: "https://a.example.com/2", title: "A2", favIconUrl: DATA_A },
    { id: 3, windowId: 10, url: "https://b.example.com/1", title: "B1", favIconUrl: DATA_B },
  ];
  const lists = await import("../background/lists.js");

  await lists.saveTabs({ tabIds: [1, 2, 3], newListName: "去重" });
  const raw = storageData.local.lists;
  assertEqual(raw.length, 1, "新建了一个列表");
  assertEqual(raw[0].items.length, 3, "三个标签页都保存了");
  assertEqual(
    raw[0].items.every((item) => item.iconKey && !("favIconUrl" in item)),
    true,
    "落盘条目只有 iconKey、没有 favIconUrl"
  );
  assertEqual(Object.keys(storageData.local.favIcons).length, 2, "三个条目两张图 → 图标表只有 2 条");
  assertEqual(raw[0].items[0].iconKey, raw[0].items[1].iconKey, "同站点同图共用 key");
  assertEqual(
    raw[0].items[0].iconKey !== raw[0].items[2].iconKey,
    true,
    "不同站点图标不共用 key"
  );

  const ui = await lists.getListsForUi();
  assertEqual(ui[0].items[0].favIconUrl, DATA_A, "getListsForUi 解析回 favIconUrl");
  assertEqual("iconKey" in ui[0].items[0], false, "UI 出口不含 iconKey");

  const summaries = await lists.getListSummaries();
  assertDeepEqual(
    summaries,
    [{ id: raw[0].id, name: "去重", count: 3 }],
    "getListSummaries 只返回 id/name/count"
  );

  console.log("场景 4：旧结构懒迁移与图标表 GC");
  // 直接往存储里塞一条旧结构（带 favIconUrl），模拟升级前保存的数据。
  storageData.local.lists[0].items.push({
    url: "https://a.example.com/3",
    title: "A3",
    favIconUrl: DATA_A,
    savedAt: "t-old",
  });
  await lists.renameList(raw[0].id, "改名");
  const migrated = storageData.local.lists[0].items;
  assertEqual(migrated.length, 4, "重命名不会丢条目");
  assertEqual("favIconUrl" in migrated[3], false, "旧条目在写盘时被迁移");
  assertEqual(migrated[3].iconKey, migrated[0].iconKey, "迁移后沿用同一张图的 key");
  assertEqual(Object.keys(storageData.local.favIcons).length, 2, "迁移不产生重复表项");

  // 导入：文件是自包含的（内联 favIconUrl），导入后同样被归一化。
  await lists.importLists(
    [{ name: "导入", description: "", items: [{ url: "https://d.example.com/1", title: "D1", favIconUrl: DATA_C }] }],
    "merge"
  );
  const imported = storageData.local.lists.find((list) => list.name === "导入");
  assertEqual(Boolean(imported), true, "导入成功");
  assertEqual("favIconUrl" in imported.items[0], false, "导入条目被归一化");
  assertEqual(Object.keys(storageData.local.favIcons).length, 3, "导入的图标进入图标表");

  // 删除列表 → 未被引用的图标被 GC。
  await lists.deleteList(raw[0].id);
  assertEqual(Object.keys(storageData.local.favIcons).length, 1, "删列表后只留仍被引用的图标");

  console.log("场景 5：导出文件必须紧凑（图标只出现一次），落盘迁移幂等");
  // 塞一条旧结构回去，模拟"升级后还没写过列表"的库。
  storageData.local.lists[0].items.push({
    url: "https://a.example.com/9",
    title: "A9",
    favIconUrl: DATA_A,
    savedAt: "t-legacy",
  });
  const exported = await lists.getListsExport();
  assertEqual(exported.version, 2, "导出载荷版本为 2");
  assertEqual(
    exported.lists.every((list) => list.items.every((item) => !("favIconUrl" in item))),
    true,
    "导出条目不含 favIconUrl（不逐条内联）"
  );
  assertEqual(
    exported.lists[0].items.some((item) => item.url.endsWith("/9")),
    true,
    "尚未迁移的旧条目也会被导出（导出时归一化）"
  );
  const exportedKeys = new Set();
  exported.lists.forEach((list) => {
    list.items.forEach((item) => {
      if (item.iconKey) {
        exportedKeys.add(item.iconKey);
      }
    });
  });
  assertDeepEqual(
    Object.keys(exported.favIcons).sort(),
    [...exportedKeys].sort(),
    "顶层图标表恰好覆盖条目引用的 key"
  );
  assertEqual(
    exported.favIcons[computeIconKey(DATA_A)] === DATA_A,
    true,
    "同一个图标在文件里只出现一次（正是这次修复的核心）"
  );
  // 导出是只读的：不能顺手把存储改掉，否则"导出"变成了隐式写盘。
  assertEqual(
    "favIconUrl" in storageData.local.lists[0].items.find((item) => item.url.endsWith("/9")),
    true,
    "导出不改写存储"
  );

  // 真正的落盘迁移（扩展安装/更新与浏览器启动时各跑一次）。
  assertEqual(await lists.migrateListsFavicons(), true, "检测到旧结构并执行迁移");
  assertEqual(
    storageData.local.lists.every((list) => list.items.every((item) => !("favIconUrl" in item))),
    true,
    "迁移后存储里不再有 favIconUrl（重复数据真正消失）"
  );
  assertEqual(await lists.migrateListsFavicons(), false, "迁移幂等：第二次不再写盘");

  console.log("场景 6：v2 文件（iconKey + 顶层图标表）导入后图标不丢");
  await lists.importLists(
    [
      {
        name: "v2导入",
        description: "",
        items: [
          {
            url: "https://v2.example.com/1",
            title: "V2",
            iconKey: "u:https://v2.example.com/icon.png",
            savedAt: "t",
          },
        ],
      },
    ],
    "merge",
    { "u:https://v2.example.com/icon.png": "https://v2.example.com/icon.png" }
  );
  const v2List = storageData.local.lists.find((list) => list.name === "v2导入");
  assertEqual(
    v2List.items[0].iconKey,
    "u:https://v2.example.com/icon.png",
    "v2 条目的 iconKey 被保留（图标表随文件并入）"
  );
  const v2Ui = await lists.getListsForUi();
  assertEqual(
    v2Ui.find((list) => list.name === "v2导入").items[0].favIconUrl,
    "https://v2.example.com/icon.png",
    "v2 导入的图标可被解析"
  );
}

async function main() {
  testIconKeyRules();
  testNormalizeAndResolve();
  await testListsStorageRoundTrip();

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

await main();
