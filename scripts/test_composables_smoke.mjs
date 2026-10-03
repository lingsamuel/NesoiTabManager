// 共用 composable 的冒烟测试。
//
// 存在的理由：`useTree()` 在**组装阶段**就会挂上 storage 变更监听、读取偏好，
// 因此它内部任何一个未定义符号都会让整个页面初始化抛错——表现为"全白屏"，
// 而这类错误既不会让 vite build 失败（未定义标识符会被当成全局变量），
// 之前的测试也从未实例化过 `useTree()`，于是漏到了线上。
// 这里把"实例化 + 走一遍主要方法"固定下来。

const storageData = { local: {}, session: {} };
const changeListeners = [];
const sentMessages = [];
// 可切换的 getTreeStructure 响应：用于验证"更旧的 structureRevision 不得覆盖新结构"。
let nextTreeStructureResponse = { ok: true, structures: {}, parents: {} };

function area(name) {
  return {
    get(key, callback) {
      const result = {};
      if (typeof key === "string" && key in storageData[name]) {
        result[key] = storageData[name][key];
      }
      callback(result);
    },
    set(obj, callback) {
      Object.assign(storageData[name], obj);
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete storageData[name][key];
      }
      if (callback) {
        callback();
      }
    },
  };
}

globalThis.chrome = {
  runtime: {
    lastError: null,
    getURL: (path) => `chrome-extension://test/${path}`,
    sendMessage: (message, callback) => {
      sentMessages.push(message);
      if (callback) {
        callback(
          message && message.action === "getTreeStructure"
            ? nextTreeStructureResponse
            : { ok: true, structures: {}, parents: {} }
        );
      }
    },
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  storage: {
    local: area("local"),
    session: area("session"),
    onChanged: { addListener: (fn) => changeListeners.push(fn) },
  },
};

let failures = 0;
let checks = 0;

function assert(condition, label) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`✗ ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  checks += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`✗ ${label}：期望 ${expected}，实际 ${actual}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

async function main() {
  console.log("场景 1：useTree 能在组装阶段完成初始化（此前这里漏出过全白屏级别的错误）");
  const { useTree } = await import("../src/manager/composables/useTree.js");
  let tree = null;
  try {
    tree = useTree();
  } catch (error) {
    assert(false, `useTree() 抛错：${error && error.message ? error.message : error}`);
    console.log("");
    console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
    process.exitCode = 1;
    return;
  }
  assert(Boolean(tree), "useTree() 正常返回");
  for (const name of [
    "loadPreferences",
    "loadCollapsed",
    "setMode",
    "loadForWindows",
    "onStructureChanged",
    "parentsFor",
    "toggleCollapse",
  ]) {
    assert(typeof tree[name] === "function", `暴露了 ${name}()`);
  }
  assert(changeListeners.length > 0, "组装阶段就挂上了 storage 变更监听（跨页面同步折叠状态）");

  console.log("场景 2：偏好与折叠状态的读写不抛错");
  await tree.loadPreferences();
  await tree.loadCollapsed();
  tree.setMode(false);
  assertEqual(sentMessages.length >= 0, true, "setMode 未抛错");
  const loaded = await tree.loadForWindows([1]);
  assert(Boolean(loaded), "loadForWindows 正常返回");
  // 没有折叠项时约定返回 null（渲染侧按"没有折叠"处理），有折叠项时返回 Set
  assertEqual(tree.collapsedSetFor(1), null, "没有折叠项时 collapsedSetFor 返回 null");

  console.log("场景 3：storage 变更回调可以被安全调用");
  // 模拟另一个页面改动折叠状态：回调内部不能因为缺符号而抛错。
  let callbackError = null;
  try {
    changeListeners.forEach((listener) =>
      listener({ treeCollapsed: { newValue: { 1: [2, 3] } } }, "session")
    );
  } catch (error) {
    callbackError = error;
  }
  assert(callbackError === null, `变更回调不抛错${callbackError ? `（${callbackError.message}）` : ""}`);

  console.log("场景 3b：结构变更通知（后台改了结构 → 前端必须重拉）");
  // 订阅回调：后台发布的 treeStructureRevision 到达时，订阅方应当被通知去重拉父子映射。
  const structureCalls = [];
  const unsubscribe = tree.onStructureChanged((windowIds) => structureCalls.push(windowIds));
  assert(typeof unsubscribe === "function", "onStructureChanged 返回取消订阅函数");
  const emitRevision = (value) =>
    changeListeners.forEach((listener) => listener({ treeStructureRevision: { newValue: value } }, "session"));
  // 第一次通知时页面还不知道令牌（等价于"没拉过"）：按变化未知处理 → 空列表 = 全量刷新。
  emitRevision({ token: "sw-a", revisions: { 1: 3, 2: 1 } });
  assertEqual(structureCalls.length, 1, "收到结构变更通知 → 通知订阅方一次");
  assertEqual(structureCalls[0].length, 0, "令牌未知时按变化未知通知（空列表 = 全量刷新）");
  // 拉一次后页面记下了令牌与版本号。
  nextTreeStructureResponse = {
    ok: true,
    structures: {
      1: { parents: {}, revision: 3, revisionToken: "sw-a" },
      2: { parents: {}, revision: 1, revisionToken: "sw-a" },
    },
  };
  await tree.loadForWindows([1, 2]);
  emitRevision({ token: "sw-a", revisions: { 1: 3, 2: 1 } });
  assertEqual(structureCalls.length, 1, "同一实例、版本号没前进 → 不重复通知");
  emitRevision({ token: "sw-a", revisions: { 1: 4, 2: 1 } });
  assertEqual(structureCalls.length, 2, "版本号前进 → 再次通知");
  assertEqual(structureCalls[1].join(","), "1", "只通知版本号前进的窗口");
  // 后台实例重启：版本号从头开始，不能与本地已知值比较，必须按"变化未知"通知一次全量刷新。
  emitRevision({ token: "sw-b", revisions: { 1: 1 } });
  assertEqual(structureCalls.length, 3, "后台重启（令牌变化）→ 仍然通知");
  assertEqual(structureCalls[2].length, 0, "令牌变化时按变化未知通知（空列表 = 全量刷新）");

  console.log("场景 3c：更旧的结构结果不得覆盖新结构");
  nextTreeStructureResponse = {
    ok: true,
    structures: { 1: { parents: { 11: 10 }, revision: 5, revisionToken: "sw-c" } },
  };
  await tree.loadForWindows([1]);
  assertEqual(tree.parentsFor(1)[11], 10, "同一实例内接受更新的结果");
  nextTreeStructureResponse = {
    ok: true,
    structures: { 1: { parents: { 12: 10 }, revision: 4, revisionToken: "sw-c" } },
  };
  await tree.loadForWindows([1]);
  assertEqual(tree.parentsFor(1)[11], 10, "更旧的结果被丢弃（保留新结构）");
  assertEqual(tree.parentsFor(1)[12], undefined, "旧结果里的父关系没有写入");
  // 后台重启后令牌不同：即使版本号更小也必须接受，否则界面会永久停在旧结构上。
  nextTreeStructureResponse = {
    ok: true,
    structures: { 1: { parents: { 13: 10 }, revision: 1, revisionToken: "sw-d" } },
  };
  await tree.loadForWindows([1]);
  assertEqual(tree.parentsFor(1)[13], 10, "令牌变化（后台重启）时无条件接受新结果");
  unsubscribe();

  console.log("场景 4：useFilterQuery 与 useTree 使用同一份 storage 封装");
  const { useFilterQuery } = await import("../src/manager/composables/useFilterQuery.js");
  const filter = useFilterQuery();
  filter.setMode("jump");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(storageData.local.filterMode, "jump", "模式写进了 storage.local");
  assertEqual(filter.mode.value, "jump", "模式状态同步更新");

  console.log("场景 5：其余在 setup 阶段实例化的 composable 也能安全初始化");
  const { ref, computed } = await import("vue");
  const { useMatchNavigation } = await import("../src/manager/composables/useMatchNavigation.js");
  const rows = ref([{ type: "tab", tab: { matched: true } }]);
  let navigation = null;
  try {
    navigation = useMatchNavigation({
      rows: computed(() => rows.value),
      isMatchRow: (item) => Boolean(item && item.tab && item.tab.matched),
      mode: ref("jump"),
      hasQuery: ref(true),
    });
  } catch (error) {
    assert(false, `useMatchNavigation() 抛错：${error && error.message ? error.message : error}`);
  }
  if (navigation) {
    assertEqual(navigation.matchCount.value, 1, "识别出 1 个匹配项");
    assertEqual(typeof navigation.setCurrentMatchByRowIndex, "function", "暴露了 setCurrentMatchByRowIndex()");
  }

  const { useWindows } = await import("../src/manager/composables/useWindows.js");
  let windowsApi = null;
  try {
    windowsApi = useWindows();
  } catch (error) {
    assert(false, `useWindows() 抛错：${error && error.message ? error.message : error}`);
  }
  if (windowsApi) {
    assert(typeof windowsApi.activeRows !== "undefined", "useWindows 暴露了 activeRows（管理页轨道刻度用）");
    assert(Array.isArray(windowsApi.windowRows.value), "windowRows 初始为空数组");
    assertEqual(windowsApi.activeRows.value.length, 0, "没有窗口时没有活动刻度");
  }

  console.log("场景 6：AI 分组的数据传输授权门（Firefox 140+ 内置同意 / 其它环境降级）");
  const { ensureAiDataConsent, AI_DATA_COLLECTION } = await import(
    "../src/manager/utils/data_collection.js"
  );
  const savedPermissions = globalThis.chrome.permissions;

  // 非扩展页面等拿不到 permissions API 的环境不应阻断功能
  delete globalThis.chrome.permissions;
  assertEqual(await ensureAiDataConsent(), true, "没有 permissions API 时放行");

  // Chrome 与 Firefox <140 不认识 data_collection：request 回调里带 lastError
  globalThis.chrome.permissions = {
    request: (payload, callback) => {
      globalThis.chrome.runtime.lastError = { message: "Unexpected property" };
      callback(false);
      globalThis.chrome.runtime.lastError = null;
    },
  };
  assertEqual(await ensureAiDataConsent(), true, "浏览器不支持 data_collection 时放行（交由商店披露）");

  // Firefox 140+：用户同意
  let requested = null;
  globalThis.chrome.permissions = {
    request: (payload, callback) => {
      requested = payload.data_collection;
      callback(true);
    },
  };
  assertEqual(await ensureAiDataConsent(), true, "用户同意时放行");
  assertEqual(
    Array.isArray(requested) ? requested.join(",") : String(requested),
    AI_DATA_COLLECTION.join(","),
    "请求的分类与清单 optional 完全一致"
  );

  // Firefox 140+：用户拒绝，调用方必须中止
  globalThis.chrome.permissions = { request: (payload, callback) => callback(false) };
  assertEqual(await ensureAiDataConsent(), false, "用户拒绝时返回 false");

  // 清单字段校验失败会同步抛错（Chrome 的 "Invalid value for argument 1"）
  globalThis.chrome.permissions = {
    request: () => {
      throw new Error("Invalid value for argument 1");
    },
  };
  assertEqual(await ensureAiDataConsent(), true, "request 同步抛错时放行");

  globalThis.chrome.permissions = savedPermissions;

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

await main();
