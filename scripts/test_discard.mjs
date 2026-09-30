// 冻结（discard）模块的回归测试。
//
// 背景：修复前所有冻结路径都调用 `chrome.tabs.discard(tabId, callback)`。
// Firefox 的 tabs.discard schema 只有 tabIds 一个形参（Promise 形式），多传回调会被
// schema 校验拒绝："Incorrect argument types for tabs.discard"。这类 bug 在真实浏览器里
// 表现为"点了没反应/控制台报错"，而 Node 里如果不模拟 schema 校验就永远测不出来。
//
// 因此这里的 chrome.tabs.discard 模拟**刻意实现 Firefox 的严格校验**：
// 参数多于一个、或 id 不是非负整数，就抛同样的错误。这样只要有人把回调写法改回来，
// 测试立刻失败——这正是本文件存在的意义。

// ---------------------------------------------------------------------------
// chrome API 模拟
// ---------------------------------------------------------------------------

const DISCARD_CONFIG_KEY = "discardConfig";
const DISCARD_SESSION_KEY = "discardSession";
const DISCARD_TAB_ACTIVITY_KEY = "discardTabActivity";
const DISCARD_ALARM = "discardSweep";

let tabs = [];
const storageData = { local: {}, session: {} };
// 每次 discard 的完整实参表：用于断言"只传 tabId、没有回调"。
const discardCalls = [];
// 需要模拟"浏览器拒绝冻结"的标签（例如页面有 beforeunload 确认框）。
const failingTabIds = new Set();

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
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    tabs: {
      get(id, callback) {
        const tab = tabs.find((item) => item.id === Number(id));
        // Firefox 的 tabs.get 同样只接受整数 id：字符串会先在这里炸掉。
        if (!Number.isInteger(Number(id)) || Number(id) < 0) {
          throw new Error("Incorrect argument types for tabs.get");
        }
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
      // 关键模拟：与 Firefox 的 schema 一致，只接受一个非负整数参数。
      discard(...args) {
        discardCalls.push(args);
        if (args.length !== 1 || !Number.isInteger(args[0]) || args[0] < 0) {
          throw new Error("Incorrect argument types for tabs.discard");
        }
        const id = args[0];
        if (failingTabIds.has(id)) {
          return Promise.reject(new Error("页面正在等待确认，无法冻结。"));
        }
        const tab = tabs.find((item) => item.id === id);
        if (tab) {
          tab.discarded = true;
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

/** 断言所有 discard 调用都只有一个参数（回归保护：绝不能再传回调）。 */
function assertDiscardArity(label) {
  const bad = discardCalls.filter((args) => args.length !== 1);
  assertEqual(bad.length, 0, label);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await delay(10);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

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
    lastAccessed: Date.now() - 10 * 60 * 1000,
    ...overrides,
  };
}

async function main() {
  setupChromeMock();

  const now = Date.now();
  tabs = [
    makeTab({ id: 5, index: 0, active: true, title: "当前页" }),
    makeTab({ id: 6, index: 1, title: "闲置页", url: "https://idle.example/page" }),
    makeTab({ id: 7, index: 2, discarded: true, title: "已冻结" }),
    makeTab({ id: 8, index: 3, url: "chrome://settings/", title: "特殊协议" }),
    makeTab({ id: 9, index: 4, audible: true, url: "https://audio.example/", title: "发声页" }),
    makeTab({ id: 10, index: 5, pinned: true, url: "https://pinned.example/", title: "固定页" }),
    makeTab({ id: 11, index: 6, url: "https://blocked.example/x", title: "白名单页" }),
    makeTab({ id: 12, index: 7, url: "https://another.example/", title: "另一个闲置页" }),
    makeTab({ id: 20, index: 8, url: "https://string-id.example/", title: "字符串 id 用例" }),
    // 30 / 40 的 lastAccessed 是"刚刚"：手动冻结不看闲置时间，但自动扫描会因此跳过它们，
    // 这样两个用例不会污染"自动扫描候选集合"的断言。
    makeTab({ id: 30, index: 9, url: "https://reject.example/", title: "拒绝冻结用例", lastAccessed: now }),
    makeTab({ id: 31, index: 10, url: "https://batch-a.example/", title: "批量 A" }),
    makeTab({ id: 32, index: 11, url: "https://batch-b.example/", title: "批量 B" }),
    makeTab({ id: 40, index: 12, url: "https://batch-fail.example/", title: "批量失败用例", lastAccessed: now }),
  ];
  // 预置一份"一小时前开启自动冻结"的会话：否则 getLastActive 会把闲置时间夹到"现在"，
  // 首次扫描天然没有候选（这是产品行为，不是 bug），测不到批量冻结。
  storageData.local[DISCARD_CONFIG_KEY] = {
    enabled: true,
    idleMinutes: 1,
    sweepMinutes: 3,
    batchLimit: 20,
    historyLimit: 0,
    allowPinned: false,
    allowAudible: false,
    matchMode: "domain",
    regexMode: false,
    whitelist: ["blocked.example"],
  };
  storageData.session[DISCARD_SESSION_KEY] = {
    startEpoch: now - 60 * 60 * 1000,
    lastDiscarded: [],
    lastDiscardedAt: "",
    historyBatches: [],
    freezeCounts: {},
  };
  storageData.session[DISCARD_TAB_ACTIVITY_KEY] = {};

  const discard = await import("../background/discard.js");
  discard.initializeDiscardSystem();
  await delay(20);

  console.log("场景 1：单个手动冻结只能传 tabId（Firefox 无 callback 形参）");
  const single = await discard.manualDiscard(6);
  assertDiscardArity("tabs.discard 每次调用都只有一个实参");
  assertDeepEqual(discardCalls.map((args) => args[0]), [6], "冻结的是标签 6");
  assertEqual(single.item.freezeCount, 1, "冻结次数记为 1");

  console.log("");
  console.log("场景 2：字符串 id（消息传递中可能出现的形态）同样可用");
  discardCalls.length = 0;
  const fromString = await discard.manualDiscard("20");
  assertDeepEqual(discardCalls.map((args) => args[0]), [20], "字符串 id 被归一成整数 20 后调用");
  assertEqual(fromString.item.id, 20, "冻结记录里的 id 是整数");

  console.log("");
  console.log("场景 3：非法 id 在浏览器校验前就被挡下");
  let invalidMessage = "";
  try {
    await discard.manualDiscard(null);
  } catch (error) {
    invalidMessage = String(error.message || error);
  }
  assertEqual(invalidMessage, "缺少标签页 ID。", "空 id 报错清晰");
  assertEqual(discardCalls.length, 1, "非法 id 不会触发 tabs.discard");

  console.log("");
  console.log("场景 4：浏览器拒绝冻结时，错误会原样上抛给界面");
  failingTabIds.add(30);
  let rejectedMessage = "";
  try {
    await discard.manualDiscard(30);
  } catch (error) {
    rejectedMessage = String(error.message || error);
  }
  assertEqual(rejectedMessage, "页面正在等待确认，无法冻结。", "失败原因透传到调用方");
  failingTabIds.delete(30);

  console.log("");
  console.log("场景 5：批量手动冻结（管理页「冻结所选」）");
  discardCalls.length = 0;
  const batch = await discard.manualDiscardTabs([31, 32, "bad"]);
  assertDeepEqual(discardCalls.map((args) => args[0]), [31, 32], "合法 id 全部提交冻结");
  assertEqual(batch.discarded, 2, "成功 2 个");
  assertEqual(batch.skipped, 1, "非法 id 记为跳过");
  assertDiscardArity("批量冻结同样不传回调");

  console.log("");
  console.log("场景 6：自动冻结扫描（alarm 触发）能真正冻结候选标签");
  discardCalls.length = 0;
  const candidates = await discard.getDiscardCandidates(50);
  assertDeepEqual(
    candidates.candidates.map((item) => item.id),
    [12],
    "候选只剩 12（5 活动 / 7 已冻结 / 8 特殊协议 / 9 发声 / 10 固定 / 11 白名单 / 30·40 刚访问过）"
  );
  const historyBefore = await discard.getDiscardHistory();
  // getDiscardHistory 返回的是模块内那个活数组，必须立刻把数量取出来，
  // 否则扫描 unshift 新批次后，"之前"的快照也会跟着变长。
  const beforeBatches = historyBefore.historyBatches.length;
  const beforeTotal = historyBefore.historyTotal;
  discard.handleDiscardAlarm({ name: DISCARD_ALARM });
  await waitFor(() => discardCalls.length >= 1);
  await delay(30);
  assertDeepEqual(discardCalls.map((args) => args[0]), [12], "扫描冻结了闲置标签 12");
  assertDiscardArity("自动冻结同样不传回调");

  const historyAfter = await discard.getDiscardHistory();
  assertEqual(historyAfter.historyBatches.length - beforeBatches, 1, "扫描产生 1 批冻结历史");
  assertEqual(historyAfter.historyTotal - beforeTotal, 1, "历史里记录了 1 条");

  console.log("");
  console.log("场景 7：一批中有失败时，不中断其余标签、也不虚报成功数");
  discardCalls.length = 0;
  failingTabIds.add(40);
  const mixed = await discard.manualDiscardTabs([40, 12]);
  assertDeepEqual(discardCalls.map((args) => args[0]), [40], "只提交了仍未冻结的 40");
  assertEqual(mixed.discarded, 0, "失败的单条不计入成功");
  assertEqual(mixed.skipped, 2, "失败 1 条 + 已冻结 1 条都计入跳过");
  failingTabIds.delete(40);

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

await main();
