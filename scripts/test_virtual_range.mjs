// 虚拟列表可见区间（computeVisibleRange）的单元测试。
//
// 这段计算的失效表现是"整个列表空白，滚一下才恢复"，且只在特定的时序下出现，
// 很难在浏览器里复现；因此这里把两条不变量钉死：
//   1. 只要还有行，可见区间就不能为空；
//   2. 超出内容范围的滚动位置必须被夹回，不能让 startIndex 直接跳过整个列表。

import { computeVisibleRange } from "../src/manager/utils/virtual_range.js";

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

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

main();
