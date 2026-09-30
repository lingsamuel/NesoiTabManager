// "过滤/跳转"模式持久化的测试。
//
// 这条链路出问题的表现很隐蔽：模式看起来记住了、但某个实例没同步，
// 或者刷新后又被默认值覆盖。因此这里把三件事钉死：
//   1. 多个实例（管理页 4 个筛选框 + 侧边栏）共用同一份模式；
//   2. 切换时写进 chrome.storage.local 的 filterMode 键；
//   3. 重新加载模块后能从存储里读回上次的模式。

const storageData = {};
const setCalls = [];

globalThis.chrome = {
  storage: {
    local: {
      get(key, callback) {
        const result = {};
        if (typeof key === "string" && key in storageData) {
          result[key] = storageData[key];
        }
        callback(result);
      },
      set(obj, callback) {
        setCalls.push(JSON.parse(JSON.stringify(obj)));
        Object.assign(storageData, obj);
        if (callback) {
          callback();
        }
      },
    },
    session: {
      get(_key, callback) {
        callback({});
      },
      set(_obj, callback) {
        callback();
      },
    },
  },
};

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function main() {
  // 用查询串强制拿到全新的模块实例，模拟"页面重新加载"。
  const fresh = (tag) => import(`../src/manager/composables/useFilterQuery.js?${tag}`);

  console.log("场景 1：多个实例共用同一份模式");
  const module1 = await fresh("a");
  const windowsFilter = module1.useFilterQuery();
  const listsFilter = module1.useFilterQuery();
  const recentFilter = module1.useFilterQuery();
  assertEqual(windowsFilter.mode.value, "filter", "默认是过滤模式");
  windowsFilter.setMode("jump");
  assertEqual(listsFilter.mode.value, "jump", "切换一个实例，其它实例跟着变");
  assertEqual(recentFilter.mode.value, "jump", "第三个实例同样跟着变");
  assertEqual(windowsFilter.mode, listsFilter.mode, "它们引用同一个 ref");

  console.log("场景 2：切换时写入 chrome.storage.local");
  assertEqual(setCalls.length, 1, "写了一次");
  assertEqual(setCalls[0].filterMode, "jump", "写入键为 filterMode、值为 jump");
  windowsFilter.setMode("jump");
  assertEqual(setCalls.length, 1, "重复切到同一模式不再写");
  windowsFilter.setMode("filter");
  assertEqual(setCalls.length, 2, "切回过滤模式再写一次");
  assertEqual(setCalls[1].filterMode, "filter", "写入的是过滤模式");

  console.log("场景 3：非法值归一化为过滤模式");
  windowsFilter.setMode("bogus");
  assertEqual(windowsFilter.mode.value, "filter", "非法值退化为 filter");

  console.log("场景 4：重新加载后读回上次的模式");
  storageData.filterMode = "jump";
  const module2 = await fresh("b");
  const reloaded = module2.useFilterQuery();
  assertEqual(reloaded.mode.value, "filter", "读取是异步的，同步阶段仍是默认值");
  await tick();
  assertEqual(reloaded.mode.value, "jump", "读取完成后应用存储里的模式");
  const laterInstance = module2.useFilterQuery();
  assertEqual(laterInstance.mode.value, "jump", "同一页面内后续实例直接拿到已加载的模式");

  console.log("场景 5：存储里的值非法时回到默认");
  storageData.filterMode = "whatever";
  const module3 = await fresh("c");
  const fallback = module3.useFilterQuery();
  await tick();
  assertEqual(fallback.mode.value, "filter", "非法存储值退化为过滤模式");

  console.log("场景 6：存储里没有该键时保持默认，不额外写入");
  delete storageData.filterMode;
  const writesBefore = setCalls.length;
  const module4 = await fresh("d");
  const untouched = module4.useFilterQuery();
  await tick();
  assertEqual(untouched.mode.value, "filter", "没有存储值时用默认值");
  assertEqual(setCalls.length, writesBefore, "仅仅读取不会产生写入");

  console.log("场景 7：读取完成前用户已手动切换时，不被存储里的旧值覆盖");
  storageData.filterMode = "filter";
  const module5 = await fresh("e");
  const raced = module5.useFilterQuery();
  raced.setMode("jump");
  await tick();
  assertEqual(raced.mode.value, "jump", "用户的选择优先于存储里的旧值");

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

await main();
