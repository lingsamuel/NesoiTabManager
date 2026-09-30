// 固定标签区（pinned）纯逻辑的单元测试。
//
// 这里覆盖两处最容易出错、又完全无法靠肉眼在浏览器里验证的规则：
// 跨窗口分组顺序（决定图标列与窗口编号是否一致），以及同窗口重排的下标计算
// （算错会表现为"拖了之后标签跑到别的位置"）。

import {
  computePinnedReorderIndex,
  groupPinnedTabs,
  pinnedTabTooltip,
} from "../src/sidebar/pinned_data.js";

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

function assertEqual(actual, expected, label) {
  checks += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`✗ ${label}：期望 ${expected}，实际 ${actual}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function pin(id, windowId, index, extra = {}) {
  return {
    id,
    windowId,
    index,
    pinned: true,
    title: `标签 ${id}`,
    url: `https://tab${id}.example.org/`,
    favIconUrl: "",
    active: false,
    discarded: false,
    muted: false,
    ...extra,
  };
}

function main() {
  console.log("场景 1：跨窗口分组顺序与编号");
  // windows.getAll 顺序：窗口 10、窗口 20、窗口 30；侧边栏位于窗口 20
  const pinnedTabs = [
    pin(1, 30, 0),
    pin(2, 10, 0),
    pin(3, 20, 1),
    pin(4, 20, 0),
    pin(5, 10, 1),
    // 非固定标签必须被忽略
    { id: 99, windowId: 20, index: 5, pinned: false, title: "普通标签" },
  ];
  const groups = groupPinnedTabs(pinnedTabs, {
    currentWindowId: 20,
    windowOrder: [10, 20, 30],
  });
  assertDeepEqual(
    groups.map((group) => [group.windowId, group.label, group.isCurrent, group.tabs.map((tab) => tab.id)]),
    [
      [20, "窗口 2", true, [4, 3]],
      [10, "窗口 1", false, [2, 5]],
      [30, "窗口 3", false, [1]],
    ],
    "本窗口最前、其余按 windows.getAll 顺序，组内按 index 升序"
  );

  console.log("场景 2：窗口列表里没有的窗口");
  const unknownGroups = groupPinnedTabs(
    [pin(7, 99, 0), pin(8, 42, 0)],
    { currentWindowId: 7, windowOrder: [10, 20] }
  );
  assertDeepEqual(
    unknownGroups.map((group) => [group.windowId, group.label]),
    [
      [42, "其它窗口"],
      [99, "其它窗口"],
    ],
    "未知窗口排最后并按窗口 id 升序"
  );

  console.log("场景 3：没有固定标签");
  assertDeepEqual(groupPinnedTabs([], { currentWindowId: 1, windowOrder: [1] }), [], "空输入返回空分组");
  assertDeepEqual(groupPinnedTabs(null, { currentWindowId: 1 }), [], "null 输入也不报错");

  console.log("场景 4：同窗口内重排下标");
  // 窗口内固定标签：A(0) B(1) C(2) D(3)
  const siblings = [pin(101, 1, 0), pin(102, 1, 1), pin(103, 1, 2), pin(104, 1, 3)];
  // A 拖到 C 之后 → 移除 A 后剩 [B, C, D]，C 的位置是 1，插到其后 = 2
  assertEqual(computePinnedReorderIndex(siblings, 101, 103, "after"), 2, "A 拖到 C 之后 → index 2");
  // A 拖到 C 之前 → 插入位置 1
  assertEqual(computePinnedReorderIndex(siblings, 101, 103, "before"), 1, "A 拖到 C 之前 → index 1");
  // D 拖到 B 之前 → 移除 D 后剩 [A, B, C]，B 的位置是 1 → index 1
  assertEqual(computePinnedReorderIndex(siblings, 104, 102, "before"), 1, "D 拖到 B 之前 → index 1");
  // D 拖到 C 之后 → 移除 D 后剩 [A, B, C]，C 的位置 2 → index 3；但 D 本来就在 3，等于没动
  assertEqual(computePinnedReorderIndex(siblings, 104, 103, "after"), -1, "D 拖到 C 之后（原位）→ -1");
  // D 拖到 C 之前 → 插入位置 2，而 D 原本在 3，属于变化
  assertEqual(computePinnedReorderIndex(siblings, 104, 103, "before"), 2, "D 拖到 C 之前 → index 2");

  console.log("场景 5：没有变化或参数无效时返回 -1");
  assertEqual(computePinnedReorderIndex(siblings, 102, 101, "after"), -1, "B 拖到 A 之后（原位）→ -1");
  assertEqual(computePinnedReorderIndex(siblings, 101, 102, "before"), -1, "A 拖到 B 之前（原位）→ -1");
  assertEqual(computePinnedReorderIndex(siblings, 999, 101, "after"), -1, "被拖标签不在列表 → -1");
  assertEqual(computePinnedReorderIndex(siblings, 101, 999, "after"), -1, "目标标签不在列表 → -1");
  assertEqual(computePinnedReorderIndex([], 1, 2, "after"), -1, "空列表 → -1");

  console.log("场景 6：下标口径与 chrome.tabs.move 一致");
  // 固定标签永远占据标签栏最前面若干位，因此"去掉自己后的插入位置"可以直接当 index 用。
  // 用一组含 3 个固定标签、后面跟着普通标签的真实分布验证一遍。
  const realWorld = [pin(201, 5, 0), pin(202, 5, 1), pin(203, 5, 2)];
  assertEqual(computePinnedReorderIndex(realWorld, 203, 201, "before"), 0, "最后一个拖到最前 → index 0");
  assertEqual(computePinnedReorderIndex(realWorld, 201, 203, "after"), 2, "第一个拖到最后 → index 2");

  console.log("场景 7：tooltip 文案");
  assertEqual(pinnedTabTooltip({ title: "标题" }, { isCurrent: true, label: "窗口 1" }), "标题", "本窗口不加后缀");
  assertEqual(
    pinnedTabTooltip({ title: "标题" }, { isCurrent: false, label: "窗口 3" }),
    "标题（窗口 3）",
    "其它窗口补上窗口标签"
  );
  assertEqual(pinnedTabTooltip({ url: "https://x.example.org/" }, { isCurrent: true }), "https://x.example.org/", "无标题时退回 URL");

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

main();
