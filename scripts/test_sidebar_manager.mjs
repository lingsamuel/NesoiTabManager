// 侧边栏「管理」按钮复用逻辑的回归测试。
//
// 为什么要测：这段逻辑的核心价值是"点一次就聚焦、不要越点越多"，而且它经过一次性能优化
// （全量 tabs.query 改成两次精确 URL 查询 + 一次本窗口 pinned 查询）。
// 优化本身很容易把语义改坏（例如把 ?mode=overlay 的浮层标签也当成管理页、
// 或者查不到就当成"没有"而永远新建），因此用假 chrome 把真实源码跑一遍。
//
// 做法与 scripts/test_tree.mjs 一致：从 .vue 里抽出真实函数体，而不是在测试里重写一份，
// 避免"测的是一套、线上跑的是另一套"。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveActiveRow, shouldFollowActiveRow } from "../src/manager/utils/scroll_markers.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "sidebar", "SidebarApp.vue"), "utf8");

/** 从源码里截取一个具名函数（含嵌套大括号），保证测的就是生产代码。 */
function extractFunction(name) {
  // 允许 `function` 前有 `async`：正则要连 async 一起截进来，否则函数体内出现 await 会语法错误。
  const pattern = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`源码里找不到 function ${name}`);
  }
  const start = match.index;
  const index = source.indexOf("{", start);
  let depth = 0;
  for (let i = index; i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`function ${name} 的大括号不闭合`);
}

const functionNames = ["queryTabsOnce", "findManagerTab", "openManager"];
// openManager / findManagerTab 在源码里必须是 async（内部用 await），并且要连 `async` 关键字
// 一起截取：否则函数体里的 await 会让外壳语法错误。这条断言也能挡住"有人把 async 去掉"的回归。
const body = functionNames
  .map((name) => {
    const raw = extractFunction(name);
    if (name !== "queryTabsOnce" && !/^async\s+function\s+/.test(raw)) {
      throw new Error(`function ${name} 不再是 async function，请同步更新测试`);
    }
    return raw;
  })
  .join("\n\n");
const build = new Function(
  "chrome",
  "windowId",
  "setStatus",
  "MANAGER_PAGE",
  `"use strict";
   return (async () => {
     ${body}
     return { queryTabsOnce, findManagerTab, openManager };
   })();`
);

let failures = 0;
let checks = 0;

function assert(condition, label) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`✗ ${label}`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

function assertEqual(actual, expected, label) {
  return assert(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

const MANAGER_PAGE = "ui/manager.html";
const MANAGER_URL = "chrome-extension://abc/ui/manager.html";
const OVERLAY_URL = "chrome-extension://abc/ui/manager.html?mode=overlay";

/**
 * 构造一个假的 chrome：query 结果按 queryInfo 的关键字段查表；
 * 记录所有查询参数，供"是否退化成全量查询"这类断言使用。
 */
function makeChrome(options = {}) {
  const queries = [];
  const calls = { created: [], updated: [], focused: [] };
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://abc/${path}`,
    },
    tabs: {
      query(queryInfo, callback) {
        queries.push(queryInfo);
        if (options.queryThrows) {
          throw new Error("query 抛错");
        }
        const key = queryInfo.url
          ? `url:${queryInfo.url}`
          : queryInfo.pinned
            ? `pinned:${queryInfo.windowId}`
            : "all";
        if (options.failKeys && options.failKeys.includes(key)) {
          chrome.runtime.lastError = { message: "查询失败" };
          callback(undefined);
          chrome.runtime.lastError = null;
          return;
        }
        const table = options.results || {};
        const list = table[key];
        callback(list === undefined ? [] : list);
      },
      update(tabId, props, callback) {
        calls.updated.push({ tabId, ...props });
        if (callback) {
          callback();
        }
      },
      create(props, callback) {
        calls.created.push(props);
        if (callback) {
          if (options.createError) {
            chrome.runtime.lastError = { message: "无法创建标签页" };
            callback(undefined);
            chrome.runtime.lastError = null;
            return;
          }
          callback({ id: 99 });
        }
      },
    },
    windows: {
      update(windowId, props, callback) {
        calls.focused.push({ windowId, ...props });
        if (callback) {
          callback();
        }
      },
    },
  };
  return { chrome, queries, calls };
}

function makeStatus() {
  const state = { message: "", type: "" };
  return {
    state,
    setStatus(message, type) {
      state.message = message || "";
      state.type = type || "";
    },
  };
}

function run(chrome, windowIdValue, status) {
  return build(
    chrome,
    { value: windowIdValue },
    status.setStatus,
    MANAGER_PAGE
  );
}

console.log("场景 1：已有管理页时只聚焦复用，不新建");
{
  const { chrome, calls, queries } = makeChrome({
    results: {
      [`url:${OVERLAY_URL}`]: [],
      [`url:${MANAGER_URL}`]: [{ id: 7, windowId: 3, url: MANAGER_URL }],
    },
  });
  const status = makeStatus();
  const api = await run(chrome, 5, status);
  await api.openManager();
  assertEqual(calls.created.length, 0, "没有新建标签页");
  assertEqual(calls.updated.length, 1, "激活了已有标签页");
  assertEqual(calls.updated[0].tabId, 7, "激活的是找到的那个标签页");
  assertEqual(calls.focused.length, 1, "聚焦了它所在的窗口");
  assertEqual(calls.focused[0].windowId, 3, "聚焦的是标签所在窗口而不是当前窗口");
  assert(!queries.some((q) => Object.keys(q).length === 0), "没有退化成全量 tabs.query({})");
}

console.log("场景 2：只有浮层形态的管理页时也能复用");
{
  const { chrome, calls } = makeChrome({
    results: { [`url:${OVERLAY_URL}`]: [{ id: 8, windowId: 2, url: OVERLAY_URL }] },
  });
  const status = makeStatus();
  const api = await run(chrome, 5, status);
  await api.openManager();
  assertEqual(calls.updated.length, 1, "复用了带 ?mode=overlay 的那个标签页");
  assertEqual(calls.created.length, 0, "没有新建");
}

console.log("场景 3：没有管理页时新建，并按宿主窗口是否已有固定标签决定 index");
{
  const { chrome, calls, queries } = makeChrome({
    results: { "pinned:5": [{ id: 1, windowId: 5, pinned: true }] },
  });
  const status = makeStatus();
  const api = await run(chrome, 5, status);
  await api.openManager();
  assertEqual(calls.created.length, 1, "新建了一个标签页");
  assertEqual(calls.created[0].pinned, true, "新建的标签页是固定标签");
  assertEqual(calls.created[0].index, undefined, "已有固定标签时不指定 index（不打断用户已有排列）");
  assert(queries.some((q) => q.windowId === 5 && q.pinned === true), "只为宿主窗口查固定标签");
}
{
  const { chrome, calls } = makeChrome({ results: {} });
  const status = makeStatus();
  const api = await run(chrome, 6, status);
  await api.openManager();
  assertEqual(calls.created[0].index, 0, "一个固定标签都没有时用 index: 0 落到最左");
}

console.log("场景 4：窗口未知或查询失败时降级为普通新建（不报错、不固定）");
{
  // Number(null) === 0 这个坑：窗口未知必须走降级，而不是去查"窗口 0"。
  const { chrome, calls, queries } = makeChrome({ results: {} });
  const status = makeStatus();
  const api = await run(chrome, null, status);
  await api.openManager();
  assertEqual(calls.created.length, 1, "窗口未知时仍然新建");
  assertEqual(calls.created[0].pinned, undefined, "降级成普通新建（不 pinned、不 index）");
  assert(!queries.some((q) => q.windowId === 0), "没有把窗口未知当成窗口 0 去查询");
}
{
  const { chrome, calls } = makeChrome({ failKeys: [`url:${OVERLAY_URL}`] });
  const status = makeStatus();
  const api = await run(chrome, 5, status);
  await api.openManager();
  assertEqual(calls.created.length, 1, "URL 查询失败时降级新建");
  assertEqual(calls.created[0].pinned, undefined, "降级时不做 pinned");
}
{
  const { chrome, calls } = makeChrome({
    results: { [`url:${OVERLAY_URL}`]: [], [`url:${MANAGER_URL}`]: [] },
    failKeys: ["pinned:5"],
  });
  const status = makeStatus();
  const api = await run(chrome, 5, status);
  await api.openManager();
  assertEqual(calls.created.length, 1, "固定标签查询失败时仍能新建");
  assertEqual(calls.created[0].pinned, true, "仍然按 pinned 新建");
  assertEqual(calls.created[0].index, 0, "查询失败按没有固定标签处理，用 index: 0 兜底");
}

console.log("场景 5：create 报错时给出中文提示，而不是静默失败");
{
  const { chrome, calls } = makeChrome({ results: {}, createError: true });
  const status = makeStatus();
  const api = await run(chrome, 5, status);
  await api.openManager();
  assertEqual(calls.created.length, 1, "尝试了新建");
  assert(status.state.type === "error" && status.state.message.includes("无法创建标签页"), "状态栏显示后台返回的错误信息");
}

console.log("场景 6：切换到一个还没进列表的标签（新建标签）");
{
  // 这段是真实源码里的 applyActiveTab：本地改高亮是性能优化，但目标标签未知时必须退化，
  // 否则会先清掉所有活动标记 —— 界面短期显示成"没有活动标签"，同时把自动跟随活动标签
  // 赖以判断的"变化前那条活动行"一起丢掉（表现为"新建标签后跟随不生效"）。
  const applyActiveTab = new Function(
    "tabs",
    "scheduleRefresh",
    `"use strict";
     ${extractFunction("applyActiveTab")}
     return applyActiveTab;`
  );

  const list = [
    { id: 1, active: true, pinned: false, title: "A" },
    { id: 2, active: false, pinned: false, title: "B" },
  ];
  const tabs = { value: list };
  const refreshes = [];
  const apply = applyActiveTab(tabs, (scope) => refreshes.push(scope));

  apply(99);
  assertEqual(refreshes.length, 1, "未知标签 → 补一次整窗刷新（新标签必须进列表）");
  assertEqual(refreshes[0], "full", "补的是整窗刷新而不是固定标签刷新");
  assertEqual(tabs.value[0].active, true, "旧活动标签仍保持活动（信息不能丢）");
  assertEqual(tabs.value[1].active, false, "其它标签不受影响");
  assertEqual(tabs.value, list, "没有替换数组，不触发无意义的渲染");

  const beforeKnown = tabs.value;
  apply(2);
  assertEqual(refreshes.length, 1, "已知标签仍然走本地更新，不触发刷新");
  assertEqual(tabs.value[0].active, false, "旧活动标签被取消");
  assertEqual(tabs.value[1].active, true, "目标标签变为活动");
  assert(tabs.value !== beforeKnown, "替换数组以触发渲染");

  const sameAgain = tabs.value;
  apply(2);
  assertEqual(tabs.value, sameAgain, "活动标签没变化时不产生新数组");
}

console.log("场景 7：新建标签后的跟随判定（端到端串一遍事件顺序）");
{
  // 复刻真实顺序：活动标签在列表里 → onActivated 先到（新标签还没进列表）→ 整窗刷新落地。
  // 用真实模块的 resolveActiveRow / shouldFollowActiveRow，避免"测的是一套、线上跑的是另一套"。
  // 列表要足够长，否则新标签本来就在视野里、按规则不该滚动，测不出区别。
  const tabs = {
    value: Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      active: index === 0,
      pinned: false,
    })),
  };
  const applyActiveTab = new Function(
    "tabs",
    "scheduleRefresh",
    `"use strict";
     ${extractFunction("applyActiveTab")}
     return applyActiveTab;`
  )(tabs, () => {});

  const activeEntryOf = (list) => {
    const tab = list.find((item) => item.active && !item.pinned);
    if (!tab) {
      return null;
    }
    const row = resolveActiveRow(tab.id, list, {});
    return row ? { tabId: Number(tab.id), index: Number(row.index) } : null;
  };

  const entryBefore = activeEntryOf(tabs.value);
  assertEqual(entryBefore.tabId, 1, "切换前的活动标签可解析");
  assertEqual(entryBefore.index, 0, "它在第 0 行");

  applyActiveTab(99);
  const entryDuring = activeEntryOf(tabs.value);
  assert(entryDuring !== null, "切换事件到达时活动标签没有变成 null（跟随依据保住了）");
  assertEqual(entryDuring ? entryDuring.index : -1, entryBefore.index, "行号也保持不变");

  // 整窗刷新落地：新标签追加在窗口末尾并成为活动标签（查询结果里同时只有一个活动标签）
  tabs.value = tabs.value
    .map((tab) => ({ ...tab, active: false }))
    .concat([{ id: 99, active: true, pinned: false }]);
  const entryAfter = activeEntryOf(tabs.value);
  assertEqual(entryAfter.index, 40, "新活动标签在列表末尾（远在视野之外）");
  assertEqual(
    shouldFollowActiveRow({
      activeIndex: entryAfter.index,
      previousActiveIndex: entryDuring ? entryDuring.index : -1,
      itemHeight: 30,
      scrollTop: 0,
      viewportHeight: 300,
    }),
    true,
    "旧活动行仍在视野里 → 跟随到新建的标签"
  );
}

console.log("");
console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("✓ 全部通过");
}
