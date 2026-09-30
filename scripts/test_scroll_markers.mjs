// 滚动条轨道标记逻辑的单元测试。
//
// 这段逻辑的两处边界在浏览器里很难复现（活动标签被折叠、被筛选隐藏），
// 而算错的表现只是"小蓝条位置不对"，肉眼容易漏掉，因此用 Node 固定住。

import {
  buildTrackMarkers,
  pickCurrentMatchFromVisibleRange,
  resolveActiveRow,
  toTrackTop,
} from "../src/sidebar/scroll_markers.js";

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

function row(id, matched = false) {
  return { id, matched };
}

function main() {
  // 渲染中的行：1, 2（折叠了 3）, 4
  const rows = [row(1), row(2), row(4)];
  // 树：3 的父是 2，2 的父是 1
  const parents = { 2: 1, 3: 2, 4: 1 };

  console.log("场景 1：活动标签就在列表里");
  assertDeepEqual(resolveActiveRow(4, rows, parents), { index: 2, isAncestor: false }, "直接命中，且不是祖先行");

  console.log("场景 2：活动标签被折叠隐藏 → 标到最近的可见祖先");
  assertDeepEqual(
    resolveActiveRow(3, rows, parents),
    { index: 1, isAncestor: true },
    "3 被折叠，标到它的父 2（行 1）并标记为祖先行"
  );
  assertDeepEqual(
    resolveActiveRow(3, [row(1), row(4)], parents),
    { index: 0, isAncestor: true },
    "父也不可见时继续上溯到祖父 1"
  );

  console.log("场景 3：找不到任何可见祖先 / 空列表");
  assertEqual(resolveActiveRow(3, [row(4)], { 3: 2, 2: 1 }), null, "整条父链都不可见时返回 null");
  assertEqual(resolveActiveRow(99, rows, parents), null, "标签不在行里也没有父链时返回 null");
  assertEqual(resolveActiveRow(1, [], parents), null, "空列表返回 null");
  assertEqual(resolveActiveRow(null, rows, parents), null, "非法 id 返回 null");

  console.log("场景 4：比例换算");
  // 10 行、轨道 100px → 每行 10px，刻度落在该行对应区间的中心
  assertEqual(toTrackTop(0, 10, 100), 5, "第 1 行 → 5px");
  assertEqual(toTrackTop(9, 10, 100), 95, "最后一行 → 95px");
  assertEqual(toTrackTop(100, 10, 100), 95, "越界索引被夹到最后一行");
  assertEqual(toTrackTop(-5, 10, 100), 5, "负数索引被夹到第一行");
  assertEqual(toTrackTop(3, 0, 100), 0, "没有行时返回 0");
  assertEqual(toTrackTop(3, 10, 0), 0, "轨道高度为 0（尚未测量）时返回 0");

  console.log("场景 5：汇总标记");
  assertDeepEqual(
    buildTrackMarkers({ rows, activeRow: { index: 2, isAncestor: false }, trackHeight: 90 }).map((m) => [m.kind, m.index]),
    [["active", 2]],
    "没开跳转模式时只有活动标记"
  );
  const matchRows = [row(1, true), row(2), row(4, true), row(5, true)];
  assertDeepEqual(
    buildTrackMarkers({
      rows: matchRows,
      activeRow: { index: 1, isAncestor: true },
      highlightMatches: true,
      currentMatchIndex: 2,
      trackHeight: 80,
    }).map((m) => [m.kind, m.index]),
    [
      ["match", 0],
      ["match-current", 2],
      ["match", 3],
      ["active-ancestor", 1],
    ],
    "匹配刻度 + 当前匹配加深 + 祖先行活动标记"
  );
  assertDeepEqual(buildTrackMarkers({ rows: [], activeRow: null, trackHeight: 80 }), [], "空列表没有标记");

  console.log("场景 6：滚动时同步当前跳转项");
  // 10 个匹配项，行号 0..90（每 10 行一个）
  const matchRowIndexes = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const visible = (start, end) => ({ startIndex: start, endIndex: end });

  assertEqual(
    pickCurrentMatchFromVisibleRange({
      matchRowIndexes,
      currentMatchRowIndex: 45,
      ...visible(40, 60),
    }),
    null,
    "当前项可见时不动（避免滚动过程中反复改写）"
  );
  assertEqual(
    pickCurrentMatchFromVisibleRange({
      matchRowIndexes,
      currentMatchRowIndex: 10,
      ...visible(40, 60),
    }),
    40,
    "当前项滚出视野 → 取可见范围内第一个匹配项"
  );
  assertEqual(
    pickCurrentMatchFromVisibleRange({
      matchRowIndexes,
      currentMatchRowIndex: 90,
      ...visible(41, 59),
    }),
    50,
    "可见范围内只有中间的匹配项时也能选中它"
  );
  assertEqual(
    pickCurrentMatchFromVisibleRange({
      matchRowIndexes,
      currentMatchRowIndex: 10,
      ...visible(91, 100),
    }),
    null,
    "可见范围内没有任何匹配项 → 保持不变"
  );
  assertEqual(
    pickCurrentMatchFromVisibleRange({
      matchRowIndexes: [],
      currentMatchRowIndex: -1,
      ...visible(0, 100),
    }),
    null,
    "没有匹配项时不做任何事"
  );
  assertEqual(
    pickCurrentMatchFromVisibleRange({
      matchRowIndexes,
      currentMatchRowIndex: -1,
      ...visible(20, 40),
    }),
    20,
    "尚未选中任何匹配项时也会跟随可见范围"
  );
  assertEqual(
    pickCurrentMatchFromVisibleRange({
      matchRowIndexes,
      currentMatchRowIndex: 50,
      ...visible(50, 50),
    }),
    null,
    "空区间（可见高度尚未测量）时保持不变"
  );
  // 边界：可见范围恰好从一个匹配项开始、结束于最后一个匹配项
  assertEqual(
    pickCurrentMatchFromVisibleRange({
      matchRowIndexes,
      currentMatchRowIndex: 0,
      ...visible(90, 100),
    }),
    90,
    "滚到末尾时选中最末匹配项"
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
