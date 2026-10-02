// 虚拟列表可见区间（computeVisibleRange）的单元测试。
//
// 这段计算的失效表现是"整个列表空白，滚一下才恢复"，且只在特定的时序下出现，
// 很难在浏览器里复现；因此这里把两条不变量钉死：
//   1. 只要还有行，可见区间就不能为空；
//   2. 超出内容范围的滚动位置必须被夹回，不能让 startIndex 直接跳过整个列表。

import {
  clampScrollTop,
  computeBottomAnchorScrollTop,
  computeRevealScrollTop,
  computeVisibleRange,
} from "../src/manager/utils/virtual_range.js";

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

function assertNonEmptyRange(range, label) {
  checks += 1;
  if (!(range.startIndex < range.endIndex && range.endIndex > 0)) {
    failures += 1;
    console.error(`✗ ${label}：区间为空 [${range.startIndex}, ${range.endIndex})`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function main() {
  const base = { itemCount: 1000, itemHeight: 30, viewportHeight: 300, overscan: 6 };

  console.log("场景 1：常规滚动位置");
  const normal = computeVisibleRange({ ...base, scrollTop: 3000 });
  assertEqual(normal.startIndex, 94, "startIndex = 100 - overscan");
  assertEqual(normal.endIndex, 116, "endIndex = 110 + overscan");
  assertEqual(normal.safeScrollTop, 3000, "范围内的滚动位置不被改动");

  console.log("场景 2：滚动位置远超内容高度（状态发散的典型表现）");
  // 这正是切换筛选/跳转模式时出现的情况：内容还没变长，滚动位置已经按新模式算好了。
  const outOfRange = computeVisibleRange({ ...base, scrollTop: 999999 });
  assertEqual(outOfRange.safeScrollTop, 1000 * 30 - 300, "被夹到最大滚动位置");
  assertNonEmptyRange(outOfRange, "越界的滚动位置仍然渲染出可见行（不会整片空白）");
  assertEqual(outOfRange.endIndex, 1000, "渲染到列表末尾");

  console.log("场景 3：视口高度尚未测量（viewportHeight = 0）");
  const unmeasured = computeVisibleRange({ ...base, scrollTop: 999999, viewportHeight: 0 });
  assertNonEmptyRange(unmeasured, "视口未测量时也不会算出空区间");

  console.log("场景 4：边界与退化输入");
  assertNonEmptyRange(computeVisibleRange({ ...base, scrollTop: 0 }), "滚到顶部");
  assertNonEmptyRange(computeVisibleRange({ ...base, scrollTop: -50 }), "负数滚动位置");
  assertEqual(computeVisibleRange({ ...base, itemCount: 1, scrollTop: 0 }).startIndex, 0, "只有一行");
  assertEqual(computeVisibleRange({ ...base, itemCount: 1, scrollTop: 0 }).endIndex, 1, "只有一行时结束于 1");
  const empty = computeVisibleRange({ ...base, itemCount: 0, scrollTop: 100 });
  assertEqual(empty.startIndex, 0, "没有行时 startIndex 为 0");
  assertEqual(empty.endIndex, 0, "没有行时 endIndex 为 0");
  const badHeight = computeVisibleRange({ ...base, itemHeight: 0, scrollTop: 100 });
  assertEqual(badHeight.endIndex, 0, "行高为 0 时退化为空区间而不是除零");

  console.log("场景 5：区间永远不越过行数");
  for (const scrollTop of [0, 1, 29999, 30000, 30001, 123456]) {
    const range = computeVisibleRange({ ...base, scrollTop });
    checks += 1;
    if (range.startIndex < 0 || range.endIndex > base.itemCount || range.startIndex >= range.endIndex) {
      failures += 1;
      console.error(`✗ scrollTop=${scrollTop} 时区间非法：[${range.startIndex}, ${range.endIndex})`);
    }
  }
  if (failures === 0) {
    console.log("  ✓ 各滚动位置下的区间都在 [0, itemCount] 内且非空");
  } else {
    checks += 1;
  }

  console.log("场景 6：滚动位置夹取（所有滚动计算的底座）");
  assertEqual(clampScrollTop(3000, base), 3000, "范围内的滚动位置原样返回");
  assertEqual(clampScrollTop(999999, base), 1000 * 30 - 300, "超出内容高度时夹到最大滚动位置");
  assertEqual(clampScrollTop(-50, base), 0, "负数夹到 0");
  assertEqual(clampScrollTop(100, { ...base, itemCount: 0 }), 0, "没有行时恒为 0");
  assertEqual(clampScrollTop(NaN, base), 0, "非法输入退化为 0");

  console.log("场景 7：多选条压小视口后的底边锚定");
  // 62 行、行高 30、原视口 600：滚到底时视口下边缘的内容坐标是 62*30 = 1860。
  const sidebar = { itemCount: 62, itemHeight: 30 };
  const bottomAnchor = 1860;
  assertEqual(
    computeBottomAnchorScrollTop({ ...sidebar, anchorBottom: bottomAnchor, viewportHeight: 510 }),
    1860 - 510,
    "视口被多选条压小 90px → 滚动位置下移 90px，底边内容仍在视口下边缘"
  );
  assertEqual(
    computeBottomAnchorScrollTop({ ...sidebar, anchorBottom: bottomAnchor, viewportHeight: 600 }),
    1860 - 600,
    "视口没变时等价于原来的滚动位置"
  );
  assertEqual(
    computeBottomAnchorScrollTop({ ...sidebar, anchorBottom: 120, viewportHeight: 510 }),
    0,
    "内容比视口还矮时夹到 0"
  );

  console.log("场景 8：让选中区间尽量完整可见（多选条出现后的第二步）");
  const list = { itemCount: 62, itemHeight: 30, viewportHeight: 510, scrollTop: 1350 };
  // 短区间（放得下）：整体可见，且不越过区间下边缘。
  assertEqual(
    computeRevealScrollTop({ ...list, firstIndex: 59, lastIndex: 61, focusIndex: 59, scrollTop: 0 }),
    1860 - 510,
    "区间在列表底部时滚到「区间下边缘贴住视口下边缘」"
  );
  assertEqual(
    computeRevealScrollTop({ ...list, firstIndex: 1, lastIndex: 3, focusIndex: 3, scrollTop: 1350 }),
    1 * 30,
    "区间在上方时滚到区间首行，不被底部锚定留在下面"
  );
  // 长区间（长过视口）：做不到全见，退化为"视口完全落在区间内部 + 被点行完整可见"。
  const longRange = computeRevealScrollTop({
    ...list,
    firstIndex: 5,
    lastIndex: 61,
    focusIndex: 61,
    scrollTop: 0,
  });
  const rangeTop = 5 * 30;
  const rangeBottom = 62 * 30;
  assertEqual(longRange, rangeBottom - 510, "长区间：被点行在底部 → 视口下边缘贴住被点行下边缘");
  checks += 1;
  if (!(longRange >= rangeTop && longRange + 510 <= rangeBottom)) {
    failures += 1;
    console.error(`✗ 长区间时视口没有完全落在区间内部：scrollTop=${longRange}`);
  } else {
    console.log("  ✓ 长区间时视口完全落在区间内部（可见的选中行最多）");
  }
  assertEqual(
    computeRevealScrollTop({ ...list, firstIndex: 5, lastIndex: 61, focusIndex: 5, scrollTop: 1350 }),
    5 * 30,
    "长区间：被点行在顶部 → 滚到被点行首行"
  );

  console.log("场景 9：被点行永远完整可见 + 退化输入");
  // 各种基准位置下都必须满足"被点行完整可见"这条硬约束。
  for (const scrollTop of [0, 300, 900, 1350, 999999]) {
    for (const focusIndex of [0, 5, 30, 61]) {
      const result = computeRevealScrollTop({
        ...list,
        scrollTop,
        firstIndex: Math.min(focusIndex, 5),
        lastIndex: Math.max(focusIndex, 61),
        focusIndex,
      });
      const top = focusIndex * 30;
      const bottom = top + 30;
      checks += 1;
      const maxScroll = 62 * 30 - 510;
      if (!(result >= 0 && result <= maxScroll && top >= result && bottom <= result + 510)) {
        failures += 1;
        console.error(
          `✗ scrollTop=${scrollTop} focus=${focusIndex} 时被点行没有完整可见：结果 ${result}`
        );
      }
    }
  }
  if (failures === 0) {
    console.log("  ✓ 各基准位置下被点行都完整可见，且结果在合法范围内");
  }
  const tinyViewport = computeRevealScrollTop({
    ...list,
    firstIndex: 3,
    lastIndex: 3,
    focusIndex: 3,
    viewportHeight: 10,
  });
  checks += 1;
  if (!(tinyViewport >= 0 && tinyViewport < 3 * 30 + 30 && tinyViewport + 10 > 3 * 30)) {
    failures += 1;
    console.error(`✗ 视口比一行还矮时被点行没有露出：结果 ${tinyViewport}`);
  } else {
    console.log("  ✓ 视口比一行还矮的退化情况：不抛错，被点行至少部分露出");
  }
  assertEqual(
    computeRevealScrollTop({ ...list, firstIndex: 0, lastIndex: 0, focusIndex: 0, itemCount: 0 }),
    0,
    "没有行时返回 0"
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
