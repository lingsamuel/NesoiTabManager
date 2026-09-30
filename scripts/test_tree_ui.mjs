// 管理页树状行构建的单元测试。
//
// useWindows 里的"把父子映射变成带缩进的行序列"是整个前端树视图的核心，
// 且包含三处容易出错的地方：DFS 顺序、折叠隐藏子树、筛选时补齐祖先并把被隐藏标签的子标签就近提升。
// 这些逻辑与 chrome API 无关，因此可以直接在 Node 里验证。
//
// 运行：npm run test:tree

import { ref } from "vue";
import { buildTreeRows, selectTreeIds } from "../background/tree_core.js";
import { useWindows } from "../src/manager/composables/useWindows.js";

let failures = 0;
let checks = 0;

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

// 只保留 tab 行，转成便于断言的 [id, depth, hasChildren, collapsed] 序列。
function tabRows(rows) {
  return rows
    .filter((row) => row.type === "tab")
    .map((row) => [row.tab.id, row.tab.depth, row.tab.hasChildren, row.tab.collapsed]);
}

function rowIds(rows) {
  return rows.filter((row) => row.type === "tab").map((row) => row.tab.id);
}

function makeTab(id, index, title, extra = {}) {
  return {
    id,
    index,
    windowId: 1,
    title,
    // 刻意使用不含字母 c 的域名：关键词 "C" 只应命中标题里带 C 的那一个标签
    url: `https://tab${id}.example.org/`,
    favIconUrl: "",
    discarded: false,
    pinned: false,
    active: false,
    ...extra,
  };
}

function main() {
  // 窗口结构（index 顺序）：
  //   A(0) ├ B(1) ─ C(2)
  //        └ D(3)
  //   E(4)
  const tabs = [
    makeTab(1, 0, "A"),
    makeTab(2, 1, "B"),
    makeTab(3, 2, "C"),
    makeTab(4, 3, "D"),
    makeTab(5, 4, "E"),
  ];
  const parents = { 2: 1, 3: 2, 4: 1 };

  const treeMode = ref(true);
  const collapsed = ref({});
  const tree = {
    mode: treeMode,
    parentsFor: () => ({ ...parents }),
    isCollapsed: (windowId, tabId) => Boolean(collapsed.value[String(windowId)]?.[String(tabId)]),
    collapsedSetFor: (windowId) => {
      const map = collapsed.value[String(windowId)];
      if (!map) {
        return null;
      }
      const ids = Object.keys(map);
      return ids.length > 0 ? new Set(ids.map(Number)) : null;
    },
  };

  const hideDiscarded = ref(false);
  const filterQuery = ref("");
  const filterMode = ref("filter");

  const api = useWindows({ hideDiscarded, filterQuery, filterMode, tree });
  api.windows.value = [{ id: 1, tabs }];

  console.log("场景 1：树状 DFS 顺序与深度");
  assertDeepEqual(
    tabRows(api.windowRows.value),
    [
      [1, 0, true, false],
      [2, 1, true, false],
      [3, 2, false, false],
      [4, 1, false, false],
      [5, 0, false, false],
    ],
    "父 → 子树 → 下一个兄弟，深度正确"
  );

  console.log("场景 2：折叠子树后其后代不再出现在行里");
  collapsed.value = { 1: { 2: true } };
  assertDeepEqual(rowIds(api.windowRows.value), [1, 2, 4, 5], "B 折叠后 C 被隐藏");
  assertDeepEqual(
    tabRows(api.windowRows.value).map((row) => row[3]),
    [false, true, false, false],
    "B 行标记为已折叠"
  );

  console.log("场景 3：过滤模式补齐祖先，并忽略折叠");
  filterQuery.value = "C"; // 只有标题含 C 的标签匹配（tab3）
  assertDeepEqual(rowIds(api.windowRows.value), [1, 2, 3], "保留匹配项及其全部祖先");
  assertDeepEqual(
    tabRows(api.windowRows.value).map((row) => row[0]),
    [1, 2, 3],
    "折叠状态被忽略，匹配项可见"
  );
  // 祖先只作为路径显示，不应被算作匹配项
  const matchedIds = api.windowRows.value
    .filter((row) => row.type === "tab" && row.tab.matched)
    .map((row) => row.tab.id);
  assertDeepEqual(matchedIds, [3], "只有真正匹配的标签被标记为 matched");
  // 高亮规则的依据：树状+过滤会把非匹配的祖先行一并渲染出来，
  // 所以必须把"匹配项"和"只是路径的祖先"在视觉上区分开。
  assertDeepEqual(
    api.windowRows.value
      .filter((row) => row.type === "tab" && !row.tab.matched)
      .map((row) => row.tab.id),
    [1, 2],
    "树状+过滤确实会渲染非匹配的祖先行（需要高亮匹配项）"
  );

  console.log("场景 4：跳转模式保持完整树，同时仍然标记匹配项");
  filterMode.value = "jump";
  assertDeepEqual(rowIds(api.windowRows.value), [1, 2, 3, 4, 5], "跳转模式不隐藏任何标签");
  // 回归：曾经跳转模式下 matchId 传的是 null，导致没有任何行被标记为匹配，
  // 匹配导航的匹配数恒为 0，界面一直显示"无匹配"。
  assertDeepEqual(
    api.windowRows.value
      .filter((row) => row.type === "tab" && row.tab.matched)
      .map((row) => row.tab.id),
    [3],
    "跳转模式下匹配项仍被标记（否则会显示无匹配）"
  );

  console.log("场景 5：隐藏已冻结时，子标签提升到最近的可见祖先");
  filterQuery.value = "";
  filterMode.value = "filter";
  hideDiscarded.value = true;
  tabs[1].discarded = true; // B 被隐藏
  assertDeepEqual(
    tabRows(api.windowRows.value),
    [
      [1, 0, true, false],
      [3, 1, false, false],
      [4, 1, false, false],
      [5, 0, false, false],
    ],
    "C 被提升到 A 之下（B 不可见），深度从 2 变为 1"
  );
  tabs[1].discarded = false;
  hideDiscarded.value = false;

  console.log("场景 6：平铺模式行为与改动前一致");
  treeMode.value = false;
  assertDeepEqual(rowIds(api.windowRows.value), [1, 2, 3, 4, 5], "平铺模式按 index 顺序输出");
  assertDeepEqual(
    tabRows(api.windowRows.value).map((row) => row[1]),
    [0, 0, 0, 0, 0],
    "平铺模式深度恒为 0"
  );

  console.log("场景 7：全选口径");
  treeMode.value = true;
  filterQuery.value = "C";
  api.setVisibleSelection(true);
  const selectedInFilter = Object.keys(api.selectedTabIds).map(Number).sort((a, b) => a - b);
  assertDeepEqual(selectedInFilter, [3], "过滤模式全选只作用于匹配项，不含祖先");
  api.setVisibleSelection(false);
  filterMode.value = "jump";
  api.setVisibleSelection(true);
  const selectedInJump = Object.keys(api.selectedTabIds).map(Number).sort((a, b) => a - b);
  assertDeepEqual(selectedInJump, [1, 2, 3, 4, 5], "跳转模式全选作用于完整列表");

  // 平铺+过滤：渲染出来的每一行都是匹配项，此时整表高亮只是噪声（因此不高亮）。
  treeMode.value = false;
  filterMode.value = "filter";
  assertDeepEqual(
    api.windowRows.value.filter((row) => row.type === "tab").map((row) => row.tab.matched),
    [true],
    "平铺+过滤：列表里没有非匹配行"
  );

  // 场景 8 直接测共享核心：Firefox 侧边栏不走 useWindows，但用的是同一对函数，
  // 因此这里覆盖到的行为同样适用于侧边栏。
  console.log("场景 8：共享行模型（buildTreeRows / selectTreeIds）");
  const orderedIds = [1, 2, 3, 4, 5];
  const parentMap = new Map([
    [2, 1],
    [3, 2],
    [4, 1],
  ]);
  assertDeepEqual(
    buildTreeRows(tabs, parentMap).map((row) => [row.id, row.depth, row.hasChildren, row.matched]),
    [
      [1, 0, true, false],
      [2, 1, true, false],
      [3, 2, false, false],
      [4, 1, false, false],
      [5, 0, false, false],
    ],
    "无关键词时按 DFS 输出且全部未标记匹配"
  );
  assertDeepEqual(
    buildTreeRows(tabs, parentMap, { collapsedIds: new Set([2]) }).map((row) => row.id),
    [1, 2, 4, 5],
    "折叠节点的后代被隐藏"
  );
  const matchedRows = buildTreeRows(tabs, parentMap, { matchId: (id) => id === 3 });
  assertDeepEqual(matchedRows.map((row) => row.id), [1, 2, 3], "匹配项及其祖先被保留");
  assertDeepEqual(
    matchedRows.filter((row) => row.matched).map((row) => row.id),
    [3],
    "祖先只作为路径，不算匹配项"
  );
  assertDeepEqual(
    selectTreeIds(orderedIds, parentMap, (id) => id === 4),
    [1, 4],
    "selectTreeIds 只返回「匹配项 + 祖先」"
  );
  // pruneToMatches=false 是"跳转模式"的语义：保留完整树，但把匹配项标出来。
  const jumpRows = buildTreeRows(tabs, parentMap, { matchId: (id) => id === 4, pruneToMatches: false });
  assertDeepEqual(jumpRows.map((row) => row.id), [1, 2, 3, 4, 5], "pruneToMatches=false 时不裁掉非匹配行");
  assertDeepEqual(
    jumpRows.filter((row) => row.matched).map((row) => row.id),
    [4],
    "pruneToMatches=false 时仍然标记匹配项"
  );
  assertDeepEqual(
    buildTreeRows(tabs, parentMap, { matchId: (id) => id === 4 }).map((row) => row.id),
    [1, 4],
    "默认 pruneToMatches=true 仍然只保留匹配项与祖先"
  );
  // 父标签不可见时，子标签提升到最近的可见祖先（侧边栏隐藏固定/冻结标签时同样适用）
  const withoutParent = [tabs[0], tabs[2], tabs[3], tabs[4]];
  assertDeepEqual(
    buildTreeRows(withoutParent, parentMap).map((row) => [row.id, row.depth]),
    [
      [1, 0],
      [3, 1],
      [4, 1],
      [5, 0],
    ],
    "父标签不在渲染集合内时子标签就近提升"
  );

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

main();
