// 滚动条轨道标记逻辑的单元测试。
//
// 这段逻辑的两处边界在浏览器里很难复现（活动标签被折叠、被筛选隐藏），
// 而算错的表现只是"小蓝条位置不对"，肉眼容易漏掉，因此用 Node 固定住。

import {
  buildTrackMarkers,
  isRowFullyVisible,
  isRowInView,
  resolveActiveRows,
  pickCurrentMatchFromVisibleRange,
  resolveActiveRow,
  shouldFollowActiveRow,
  toTrackTop,
} from "../src/manager/utils/scroll_markers.js";

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
      ["active-ancestor", 1],
      ["match-current", 2],
      ["match", 3],
    ],
    "匹配刻度 + 当前匹配加深 + 祖先行活动标记（按轨道位置排序）"
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

  console.log("场景 7：距离过近的刻度合并成一个");
  // 100 行、轨道 100px → 每行 1px；前 10 行都是匹配项 → 刻度间距 1px
  const dense = Array.from({ length: 100 }, (_, index) => row(index + 1, index < 10));
  const denseMarkers = buildTrackMarkers({
    rows: dense,
    highlightMatches: true,
    currentMatchIndex: 5,
    trackHeight: 100,
  });
  assertEqual(denseMarkers.length, 1, "10 个紧挨着的刻度合并成 1 条");
  assertEqual(denseMarkers[0].count, 10, "合并条记录了成员数");
  assertEqual(denseMarkers[0].merged, true, "标记为已合并");
  assertEqual(denseMarkers[0].kind, "match-current", "簇内含当前项 → 高亮");
  assertEqual(denseMarkers[0].index, 5, "点击目标优先当前项（不会把当前项点走）");
  assertEqual(denseMarkers[0].matchIndex, 5, "同步当前项也指向当前项本身");

  console.log("场景 8：蓝色活动刻度被合并时，蓝色优先 + 高亮边框");
  const mergedWithActive = buildTrackMarkers({
    rows: dense,
    activeRow: { index: 7, isAncestor: false },
    highlightMatches: true,
    currentMatchIndex: 5,
    trackHeight: 100,
  });
  assertEqual(mergedWithActive.length, 1, "活动刻度也参与合并");
  assertEqual(mergedWithActive[0].kind, "active-current", "蓝色优先 + 高亮边框");
  assertEqual(mergedWithActive[0].index, 5, "点击目标仍是当前项");
  const activeOnlyCluster = buildTrackMarkers({
    rows: dense,
    activeRow: { index: 20, isAncestor: false },
    highlightMatches: true,
    currentMatchIndex: 5,
    trackHeight: 100,
  });
  assertEqual(activeOnlyCluster.length, 2, "距离够远的活动刻度不参与合并");
  assertEqual(activeOnlyCluster[1].kind, "active", "单独一条蓝色刻度");

  console.log("场景 9：合并簇里没有当前项时的点击目标");
  // 前 4 行是匹配项、活动标签在第 3 行（索引 2）→ 与匹配刻度糊在一起
  const noCurrent = buildTrackMarkers({
    rows: Array.from({ length: 100 }, (_, index) => row(index + 1, index < 4)),
    activeRow: { index: 2, isAncestor: false },
    highlightMatches: true,
    currentMatchIndex: -1,
    trackHeight: 100,
  });
  assertEqual(noCurrent.length, 1, "仍然合并成一条");
  assertEqual(noCurrent[0].kind, "active", "没有当前项时显示蓝色");
  assertEqual(noCurrent[0].index, 2, "点击目标退到活动标签");
  assertEqual(noCurrent[0].matchIndex, null, "目标不是匹配项 → 不改动当前跳转项");

  console.log("场景 10：阈值为 6px 时的合并边界");
  // 轨道 12px、2 行 → 刻度分别在 3px 与 9px，间距 6px（不小于阈值 → 不合并）
  const boundary = Array.from({ length: 2 }, (_, index) => row(index + 1, true));
  assertEqual(
    buildTrackMarkers({ rows: boundary, highlightMatches: true, trackHeight: 12 }).length,
    2,
    "间距等于阈值（6px）不合并"
  );
  // 轨道 10px、2 行 → 2.5px 与 7.5px，间距 5px（小于阈值 → 合并）
  assertEqual(
    buildTrackMarkers({ rows: boundary, highlightMatches: true, trackHeight: 10 }).length,
    1,
    "间距小于阈值（5px）合并"
  );
  assertEqual(
    buildTrackMarkers({ rows: boundary, highlightMatches: true, trackHeight: 10, mergeThreshold: 0 }).length,
    2,
    "阈值为 0 时不合并"
  );

  console.log("场景 10b：轨道高度尚未测出时不画刻度");
  // 曾经的 bug：管理页的滚动容器在数据到达后才出现，高度一直没被测到（0），
  // 所有刻度的比例位置都算成 0，于是全部叠在顶端并被合并成一条。
  assertDeepEqual(
    buildTrackMarkers({ rows: dense, highlightMatches: true, currentMatchIndex: 5, trackHeight: 0 }),
    [],
    "轨道高度为 0 时不返回任何刻度"
  );
  assertDeepEqual(
    buildTrackMarkers({ rows: dense, activeRow: { index: 7 }, trackHeight: -1 }),
    [],
    "非法的轨道高度同样不画"
  );

  console.log("场景 11：管理页多窗口的活动行批量解析");
  const multiRows = [row(11), row(12), row(13), row(21), row(22)];
  const multiIndex = new Map(multiRows.map((item, index) => [item.id, index]));
  assertDeepEqual(
    resolveActiveRows(
      [
        { tabId: 12, parents: { 12: 11, 13: 12 } },
        { tabId: 22, parents: { 22: 21 } },
      ],
      multiIndex
    ),
    [
      { index: 1, isAncestor: false },
      { index: 4, isAncestor: false },
    ],
    "每个窗口各解析出一条活动行"
  );
  // 标签 13 不在渲染集合里（被折叠或筛选隐藏）→ 上溯到它的父 12
  const hiddenIndex = new Map([row(11), row(12), row(21)].map((item, index) => [item.id, index]));
  assertDeepEqual(
    resolveActiveRows([{ tabId: 13, parents: { 13: 12, 12: 11 } }], hiddenIndex),
    [{ index: 1, isAncestor: true }],
    "被折叠隐藏时上溯到最近的可见祖先"
  );
  assertDeepEqual(resolveActiveRows([{ tabId: 99, parents: {} }], multiIndex), [], "定位不到就整条丢弃");
  assertDeepEqual(resolveActiveRows([], multiIndex), [], "没有活动标签时返回空数组");

  console.log("场景 12：某一行在不在视口里（跟随活动标签的判定基础）");
  // 行高 30、视口高 300、停在顶部：正好显示 0..9 行
  const viewport = { itemHeight: 30, scrollTop: 0, viewportHeight: 300 };
  assertEqual(isRowFullyVisible({ index: 0, ...viewport }), true, "首行完整可见");
  assertEqual(isRowFullyVisible({ index: 9, ...viewport }), true, "视口最后一行完整可见");
  assertEqual(isRowFullyVisible({ index: 10, ...viewport }), false, "视口之外的一行不完整可见");
  assertEqual(isRowInView({ index: 10, ...viewport }), true, "紧贴视口下边界（容差内）算在视野里");
  assertEqual(isRowInView({ index: 12, ...viewport }), false, "再往下两行就不在视野里了");

  // 滚到行中间：第 5 行（150..180）被视口上边界切掉一截
  const midRow = { itemHeight: 30, scrollTop: 165, viewportHeight: 300 };
  assertEqual(isRowInView({ index: 5, ...midRow }), true, "被切掉一截的行仍在视野里");
  assertEqual(isRowFullyVisible({ index: 5, ...midRow }), false, "被切掉一截的行不算完整可见");

  // 容差：滚动位置是小数时，贴边的行不能因为零点几像素被判成不可见，
  // 否则每次切换标签都会重复居中一次。
  const fractional = { index: 9, itemHeight: 30, scrollTop: 1, viewportHeight: 298.5 };
  assertEqual(isRowFullyVisible(fractional), true, "容差内贴边视为完整可见（不会重复居中）");
  assertEqual(isRowFullyVisible({ ...fractional, tolerance: 0 }), false, "不带容差时同一行判成不可见");

  // 视口高度还没测出来（组件刚挂载）时无从判断，一律按"不可见"处理
  assertEqual(
    isRowFullyVisible({ index: 0, itemHeight: 30, scrollTop: 0, viewportHeight: 0 }),
    false,
    "视口高度为 0 时不认为可见"
  );
  assertEqual(
    isRowInView({ index: 0, itemHeight: 30, scrollTop: 0, viewportHeight: 0 }),
    false,
    "视口高度为 0 时不算在视野里"
  );

  console.log("场景 13：要不要跟随新的活动标签");
  // 目标行已经看得见 → 一律不动（否则每次切标签、点紧邻的行都会让列表抖一下）
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 3, previousActiveIndex: 4, listRecreated: true, ...viewport }),
    false,
    "目标行已完整可见 → 不滚"
  );
  // 目标行看不到，且列表刚重建（滚动位置是默认值，不代表用户意图）→ 跟随
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 40, listRecreated: true, ...viewport }),
    true,
    "列表刚重建 → 跟随（把初始滚动位置换成活动标签的位置）"
  );
  // 目标行看不到，但旧活动行还在视野里 → 说明用户没滚走，可以跟随
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 40, previousActiveIndex: 5, ...viewport }),
    true,
    "旧活动行在视野里 → 跟随"
  );
  // 目标行看不到，旧活动行也已经滚出视野 → 用户正看着别处，绝不拉走
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 40, previousActiveIndex: 12, ...viewport }),
    false,
    "旧活动行已滚出视野 → 不跟随"
  );
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 40, previousActiveIndex: -1, ...viewport }),
    false,
    "没有旧活动行（页面刚打开/旧活动定位不到）且不是重建 → 不跟随"
  );
  // 旧活动标签是固定标签：它常驻固定区、始终可见，等同于"用户没有滚走" → 跟随。
  // 对应"停在固定标签上按 Ctrl+T"：新标签成为活动标签，列表应当跟过去。
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 40, previousActiveIndex: -1, previousPinned: true, ...viewport }),
    true,
    "旧活动标签是固定标签 → 跟随"
  );
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 3, previousActiveIndex: -1, previousPinned: true, ...viewport }),
    false,
    "目标行已完整可见 → 即便旧活动标签是固定标签也不滚"
  );
  assertEqual(
    shouldFollowActiveRow({ activeIndex: -1, listRecreated: true, ...viewport }),
    false,
    "活动标签不在行序列里（固定标签/被筛掉）→ 不滚"
  );
  // 视口高度还没测出来时：重建仍要滚（否则初次打开时列表停在顶部），
  // 但"旧活动行在视野里"无从判断，只能不滚。
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 40, listRecreated: true, itemHeight: 30, scrollTop: 0, viewportHeight: 0 }),
    true,
    "视口高度未知 + 列表刚重建 → 仍然定位"
  );
  assertEqual(
    shouldFollowActiveRow({ activeIndex: 40, previousActiveIndex: 5, itemHeight: 30, scrollTop: 0, viewportHeight: 0 }),
    false,
    "视口高度未知 → 不拿旧的可见性结论去滚动"
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
