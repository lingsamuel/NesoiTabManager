// 「Shift 连续选择」共用逻辑的单元测试。
//
// 这一层是纯函数（不依赖 Vue / chrome API），但语义细节很多、错了又很难被肉眼发现：
// 并集而不是替换、终点成为新锚点、锚点失效退化为普通点击、复选框上的 Shift 不能被 checked 带偏、
// 剪枝要同时剪掉锚点。因此把每条规则都钉死。

import {
  applySelectionClick,
  clearSelection,
  computeRangeKeys,
  pruneSelection,
  setManySelected,
  setSelectionChecked,
} from "../src/manager/utils/selection.js";

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
  checks += 1;
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    failures += 1;
    console.error(`✗ ${label}：期望 ${right}，实际 ${left}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

/** 把选中集合压成"按渲染顺序排列的已选 key"，方便断言。 */
function selectedInOrder(selection, order) {
  return order.filter((key) => Boolean(selection[String(key)]));
}

function main() {
  const order = ["1", "2", "3", "4", "5"];

  console.log("场景 1：区间计算（含两端、支持反向）");
  assertDeepEqual(computeRangeKeys(order, "2", "4"), ["2", "3", "4"], "锚点 2 → 终点 4");
  assertDeepEqual(computeRangeKeys(order, "4", "2"), ["2", "3", "4"], "反向拖选得到同一区间");
  assertDeepEqual(computeRangeKeys(order, "3", "3"), ["3"], "锚点即终点时只有这一项");
  assertEqual(computeRangeKeys(order, null, "3"), null, "没有锚点返回 null");

  console.log("场景 2：锚点不在渲染结果里（被过滤 / 折叠 / 换窗口）时返回 null");
  assertEqual(computeRangeKeys(order, "9", "3"), null, "锚点不存在");
  assertEqual(computeRangeKeys(order, "2", "9"), null, "终点不存在");
  assertEqual(computeRangeKeys(["a", "b"], "1", "b"), null, "锚点已被过滤掉");

  console.log("场景 3：普通点击 = 切换，并推进/清空锚点");
  let selection = {};
  let anchor = applySelectionClick(selection, { key: 1, orderedKeys: order, anchor: null });
  assertEqual(anchor, "1", "选中后锚点 = 该行");
  assertEqual(selection["1"], true, "该行被选中");

  anchor = applySelectionClick(selection, { key: 1, orderedKeys: order, anchor });
  assertEqual(anchor, null, "取消选中锚点自己 → 锚点清空");
  assertEqual(selection["1"], undefined, "该行被取消");

  selection = { 1: true };
  anchor = applySelectionClick(selection, { key: 3, orderedKeys: order, anchor: "1" });
  assertEqual(selection["1"], true, "普通点击不影响其它已选项");
  assertEqual(anchor, "3", "普通点击选中另一行后锚点跟着走");

  console.log("场景 4：Shift 区间是并集，且终点成为新锚点");
  selection = { 1: true };
  anchor = applySelectionClick(selection, {
    key: 4,
    shiftKey: true,
    orderedKeys: order,
    anchor: "1",
  });
  assertDeepEqual(selectedInOrder(selection, order), ["1", "2", "3", "4"], "1→4 全被选中");
  assertEqual(anchor, "4", "终点成为新锚点");

  // 连续两次 Shift：A..E ∪ E..C，区间外已选项保留。
  anchor = applySelectionClick(selection, {
    key: 2,
    shiftKey: true,
    orderedKeys: order,
    anchor,
  });
  assertDeepEqual(selectedInOrder(selection, order), ["1", "2", "3", "4"], "第二次 Shift 是并集，不取消任何行");

  console.log("场景 5：Shift 只做选中，不取消");
  selection = { 1: true, 2: true, 3: true };
  applySelectionClick(selection, { key: 2, shiftKey: true, orderedKeys: order, anchor: "3" });
  assertDeepEqual(selectedInOrder(selection, order), ["1", "2", "3"], "Shift 点到已选中项不会把它取消");

  console.log("场景 6：锚点失效时 Shift 退化为普通点击");
  selection = {};
  anchor = applySelectionClick(selection, {
    key: 3,
    shiftKey: true,
    orderedKeys: order,
    anchor: null,
  });
  assertDeepEqual(selectedInOrder(selection, order), ["3"], "没有锚点时只选中被点项");
  assertEqual(anchor, "3", "退化为普通点击后锚点是被点项");

  selection = { 1: true };
  applySelectionClick(selection, { key: 4, shiftKey: true, orderedKeys: order, anchor: "1" });
  assertDeepEqual(
    selectedInOrder(selection, order),
    ["1", "2", "3", "4"],
    "区间覆盖中间所有行，不论它们此前是否被选中"
  );

  console.log("场景 7：复选框上的 Shift 不能被 checked 带偏");
  selection = { 1: true };
  // 原本勾着的第 2 项被 Shift+点击时，浏览器会把 checked 变成 false；
  // 但 Shift 的语义是"选中整个区间、绝不取消"，因此这里必须忽略 checked。
  anchor = setSelectionChecked(selection, 2, false, {
    shiftKey: true,
    orderedKeys: order,
    anchor: "1",
  });
  assertDeepEqual(selectedInOrder(selection, order), ["1", "2"], "Shift+点复选框仍走区间并集");
  assertEqual(anchor, "2", "终点成为锚点");

  // 非 Shift 的取消仍然是精确取消。
  selection = { 1: true, 2: true };
  anchor = setSelectionChecked(selection, 2, false, { orderedKeys: order, anchor: "2" });
  assertDeepEqual(selectedInOrder(selection, order), ["1"], "普通取消只作用于该行");
  assertEqual(anchor, null, "取消的正是锚点 → 清空");

  console.log("场景 8：全选/全不选与剪枝");
  selection = {};
  setManySelected(selection, order, true);
  assertDeepEqual(selectedInOrder(selection, order), order, "全选覆盖全部 key");
  setManySelected(selection, ["2", "3"], false);
  assertDeepEqual(selectedInOrder(selection, order), ["1", "4", "5"], "精确取消只去掉指定 key");

  selection = { 1: true, 3: true, 5: true };
  let pruned = pruneSelection(selection, ["1", "5"], "3");
  assertDeepEqual(Object.keys(selection).sort(), ["1", "5"], "已不存在的选中项被剪掉");
  assertEqual(pruned, null, "锚点项已被剪掉 → 锚点清空");

  selection = { 1: true };
  pruned = pruneSelection(selection, new Set(["1", "2"]), "1");
  assertEqual(pruned, "1", "锚点仍存在时保留（Set 也能作为 existingKeys）");

  clearSelection(selection);
  assertDeepEqual(Object.keys(selection), [], "清空后没有任何选中项");

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

main();
