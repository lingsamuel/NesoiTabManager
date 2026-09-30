// 「上次选择的分组」记忆的回归测试。
//
// 为什么值得单独测：这段逻辑跨越了"异步读盘 + 用户可能已经手动改选 + 列表可能被删除"三件事，
// 而它的失效方式很隐蔽——记忆不生效最多让人觉得"没记住"，但如果写回时机不对，
// 会在用户手动选好分组之后把选择改回旧值，属于会让人误操作的静默 bug。
// 因此这里用一份假的 chrome.storage 覆盖"恢复 / 存活校验 / 删除回退 / 排除源列表"四类边界。

const storageData = { local: {}, session: {} };

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
      for (const item of Array.isArray(keys) ? keys : [keys]) {
        delete storageData[name][item];
      }
      if (callback) {
        callback();
      }
    },
  };
}

// 后台消息的应答内容由每个场景自行替换。
let listsResponse = [];
let messageLog = [];

globalThis.chrome = {
  runtime: {
    lastError: null,
    getURL: (path) => `chrome-extension://test/${path}`,
    sendMessage: (message, callback) => {
      messageLog.push(message);
      if (message.action === "getLists") {
        callback({ ok: true, lists: listsResponse });
        return;
      }
      callback({ ok: true, result: {} });
    },
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  storage: {
    local: area("local"),
    session: area("session"),
    onChanged: { addListener() {} },
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
    console.error(`✗ ${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

const MEMORY_KEY = "listTargetMemory";

async function main() {
  const { request } = await import("../src/manager/utils/request.js");
  const { useLists, NEW_LIST_VALUE, MOVE_NEW_LIST_VALUE } = await import(
    "../src/manager/composables/useLists.js"
  );
  const { resolveRememberedListId } = await import(
    "../src/manager/utils/list_target_memory.js"
  );

  const makeLists = () => [
    { id: "a", name: "列表 A", description: "", items: [] },
    { id: "b", name: "列表 B", description: "", items: [] },
  ];

  console.log("场景 1：没有任何记忆时，保存弹窗默认是「新建列表」");
  listsResponse = makeLists();
  const first = useLists({ request });
  await first.loadLists();
  assertEqual(first.selectedListTarget.value, NEW_LIST_VALUE, "保存目标回退为新建列表");
  assertEqual(first.moveTargetListId.value, MOVE_NEW_LIST_VALUE, "移动目标回退为新建列表");

  console.log("场景 2：用户主动选择后写盘，下一个页面实例能恢复");
  first.setSaveListTarget("b");
  // 选一个与当前列表（默认选中 a）不同的目标，才能体现"移动目标真的被记住了"。
  first.setMoveTargetListId("b");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(storageData.local[MEMORY_KEY].save, "b", "保存目标写进了 storage.local");
  assertEqual(storageData.local[MEMORY_KEY].move, "b", "移动目标写进了 storage.local");

  const second = useLists({ request });
  await second.loadLists();
  // loadLists 里的恢复是异步的（读 storage），等一轮微任务后再断言。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(second.selectedListTarget.value, "b", "新实例恢复了上次的保存目标");
  assertEqual(second.moveTargetListId.value, "b", "新实例恢复了上次的移动目标");

  console.log("场景 3：选择「新建列表」不会被记忆（否则会顶掉真正用过的分组）");
  second.setSaveListTarget(NEW_LIST_VALUE);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(storageData.local[MEMORY_KEY].save, "b", "memory 里仍是上一次真实分组");

  console.log("场景 4：记忆的列表被删除后回退为新建列表");
  listsResponse = [{ id: "b", name: "列表 B", description: "", items: [] }];
  const third = useLists({ request });
  await third.loadLists();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(third.selectedListTarget.value, "b", "仍存在的那一个被恢复");
  // 把 a 的记忆搬到第三实例上验证"已删除即回退"：换成一条不存在于列表里的记忆。
  storageData.local[MEMORY_KEY] = { save: "ghost", move: "ghost" };
  const fourth = useLists({ request });
  await fourth.loadLists();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(fourth.selectedListTarget.value, NEW_LIST_VALUE, "已删除的分组回退为新建列表");

  console.log("场景 5：「移动到」的记忆不能是当前列表本身");
  storageData.local[MEMORY_KEY] = { save: "a", move: "b" };
  listsResponse = makeLists();
  const fifth = useLists({ request });
  // 当前选中的列表是 a（列表第一项），移动目标记忆里的 b 合法，应被恢复。
  await fifth.loadLists();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(fifth.selectedListId.value, "a", "默认选中第一个列表");
  assertEqual(fifth.moveTargetListId.value, "b", "移动目标恢复为 b");
  // 记忆值就是当前列表时，必须回退，否则弹窗会把"移动到自身"这个后台会拒绝的操作当默认值。
  storageData.local[MEMORY_KEY] = { save: "a", move: "a" };
  const sixth = useLists({ request });
  await sixth.loadLists();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(sixth.moveTargetListId.value, MOVE_NEW_LIST_VALUE, "记忆指向当前列表时回退为新建");

  console.log("场景 6：纯函数 resolveRememberedListId 的边界");
  storageData.local[MEMORY_KEY] = { save: "a" };
  assertEqual(
    await resolveRememberedListId("save", makeLists()),
    "a",
    "存在即返回该 id"
  );
  assertEqual(
    await resolveRememberedListId("save", makeLists(), "a"),
    null,
    "被 excludeListId 排除时返回 null"
  );
  assertEqual(
    await resolveRememberedListId("save", []),
    null,
    "列表为空时返回 null"
  );
  assertEqual(
    await resolveRememberedListId("unknown-slot", makeLists()),
    null,
    "未知入口返回 null"
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
