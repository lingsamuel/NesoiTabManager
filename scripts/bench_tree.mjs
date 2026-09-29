// 树状结构的 10K 级性能基准。
//
// 直接引用后台真正使用的 background/tree_core.js，保证"基准测的就是生产代码"。
// 目的有两个：
//   1. 证明关键路径没有 O(n²) 退化（这是本功能最重要的性能约束）；
//   2. 给出可重复的耗时与体积基线，避免后续改动悄悄引入回退。
//
// 运行：npm run bench:tree
// 可通过环境变量放宽阈值（例如机器较慢时）：TREE_BENCH_SCALE=2 npm run bench:tree

import {
  alignSnapshotToTabs,
  applyRemovePromotion,
  buildTreeFromTabs,
  createTreeStateFromParents,
  encodeSnapshot,
  flattenTree,
  inferParentFromNewPosition,
} from "../background/tree_core.js";

const TAB_COUNT = Number(process.env.TREE_BENCH_TABS || 10000);
const SCALE = Number(process.env.TREE_BENCH_SCALE || 1);
// 阈值按 10K 规模给出，再按实际标签数线性缩放（算法都是 O(n) / O(n log n)）。
const sizeFactor = TAB_COUNT / 10000;
const LIMITS = {
  buildTree: 50 * sizeFactor * SCALE,
  encode: 50 * sizeFactor * SCALE,
  align: 100 * sizeFactor * SCALE,
  flatten: 30 * sizeFactor * SCALE,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 生成带层级、且父一定排在子之前的标签序列（模拟真实窗口）。
// URL 大部分唯一、少量来自固定小集合，贴近真实使用（大量重复 URL 会让"按 URL 对齐"先天歧义，
// 属于设计文档中已说明的降级场景，不应作为基准的主要口径）。
function makeTabs(count, random, { urlSuffix = "" } = {}) {
  const tabs = [];
  const duplicatePool = ["about:blank", "chrome://newtab/", "https://mail.example.com/inbox", "https://news.example.com/"];
  for (let i = 0; i < count; i += 1) {
    const pinned = i % 200 === 0;
    const id = 100000 + i;
    let openerTabId = null;
    if (!pinned && i > 0 && random() < 0.45) {
      // 以「前一个标签」为 opener，形成深度有限、带分支的树。
      openerTabId = tabs[i - 1].id;
    }
    const duplicated = random() < 0.1;
    tabs.push({
      id,
      index: i,
      pinned,
      openerTabId,
      url: duplicated
        ? duplicatePool[i % duplicatePool.length]
        : `https://site${i}.example.com/page/${i}${urlSuffix}`,
      title: `标签页 ${i} 的标题 - 用于估算快照体积的一段文本`,
    });
  }
  return tabs;
}

function time(label, fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { label, ms, value };
}

const failures = [];
function check(label, ms, limit) {
  const ok = ms <= limit;
  if (!ok) {
    failures.push(`${label} 耗时 ${ms.toFixed(2)}ms 超过阈值 ${limit.toFixed(2)}ms`);
  }
  return ok;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function main() {
  const random = mulberry32(20240930);
  const tabs = makeTabs(TAB_COUNT, random);
  const orderedIds = tabs.map((tab) => tab.id);

  console.log(`Nesoi 树结构基准：${TAB_COUNT} 个标签`);
  console.log("-".repeat(72));

  // 1) 冷启动建树（只依赖浏览器实际标签状态）
  const build = time("buildTree", () => buildTreeFromTabs(tabs));
  const state = build.value;
  report(build.label, build.ms, LIMITS.buildTree);
  assertInvariants("建树", tabs, state);

  // 2) 生成持久化快照
  let snapshot = null;
  const encode = time("encodeSnapshot", () => encodeSnapshot(tabs, state, { now: 1 }));
  snapshot = encode.value.payload;
  report(`${encode.label}（含标题，${formatBytes(encode.value.bytes)}）`, encode.ms, LIMITS.encode);
  const encodeNoTitle = encodeSnapshot(tabs, state, { includeTitles: false, now: 1 });
  console.log(
    `  ${"".padEnd(22)}不含标题体积：${formatBytes(encodeNoTitle.bytes)}`
  );

  // 3) 会话恢复对齐：四种典型场景
  const scenarios = [
    ["完全一致", tabs],
    ["头部插入 200 个标签", prependTabs(tabs, 200)],
    ["中间插入 100 个新标签", insertTabs(tabs, 100, random)],
    ["随机关闭 50 个标签", removeTabs(tabs, 50, random, orderedIds)],
    ["局部乱序 100 组（相邻换位）", shuffleLocally(tabs, 100, random)],
    ["5% 完全乱序（压力场景）", shuffleTabs(tabs, 0.05, random)],
  ];
  for (const [name, scenarioTabs] of scenarios) {
    const result = time("align", () => alignSnapshotToTabs(scenarioTabs, snapshot));
    const { state: aligned, exact, matched, added, removed } = result.value;
    report(
      `${result.label} · ${name}`,
      result.ms,
      LIMITS.align,
      `配对 ${matched} / 新增 ${added} / 缺失 ${removed}${exact ? " / 完全一致" : ""}`
    );
    assertInvariants(`对齐(${name})`, scenarioTabs, aligned);
  }

  // 4) DFS 扁平化（含折叠一半的父标签）
  const stateForFlatten = buildTreeFromTabs(tabs);
  const collapsedIds = new Set();
  for (const [parentId, children] of stateForFlatten.childIdsById) {
    if (children.length > 0 && parentId % 2 === 0) {
      collapsedIds.add(parentId);
    }
  }
  const flatten = time("flattenTree", () =>
    flattenTree(orderedIds, stateForFlatten.parentById, { collapsedIds })
  );
  report(`${flatten.label}（折叠后 ${flatten.value.length} 行）`, flatten.ms, LIMITS.flatten);
  const flattenAll = time("flattenTree", () =>
    flattenTree(orderedIds, stateForFlatten.parentById, { forceExpand: true })
  );
  report(`${flattenAll.label}（全展开 ${flattenAll.value.length} 行）`, flattenAll.ms, LIMITS.flatten);

  // 5) 单次事件的开销：关闭一个父标签 + 一次原生拖动推断
  const removeState = buildTreeFromTabs(tabs);
  const victim = tabs[Math.floor(TAB_COUNT / 3)];
  const remove = time("applyRemovePromotion", () => {
    const clone = createTreeStateFromParents(new Map(removeState.parentById));
    return applyRemovePromotion(clone, victim.id);
  });
  report(`${remove.label}（提升 ${remove.value} 个子标签）`, remove.ms, LIMITS.flatten);
  assertInvariants(
    "关闭提升",
    tabs.filter((tab) => tab.id !== victim.id),
    (() => {
      const clone = createTreeStateFromParents(new Map(removeState.parentById));
      applyRemovePromotion(clone, victim.id);
      return clone;
    })()
  );

  const moveState = buildTreeFromTabs(tabs);
  const move = time("inferParentFromNewPosition", () =>
    inferParentFromNewPosition({
      toIndex: 5000,
      fromIndex: 3000,
      prevTabId: tabs[4999].id,
      nextTabId: tabs[5001].id,
      movedTabId: tabs[3000].id,
      state: moveState,
      depthCache: new Map(),
    })
  );
  report(move.label, move.ms, LIMITS.flatten);

  console.log("-".repeat(72));
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`✗ ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

function report(label, ms, limit, extra = "") {
  check(label, ms, limit);
  const suffix = extra ? `  ${extra}` : "";
  console.log(
    `${label.padEnd(34)} ${ms.toFixed(2).padStart(8)} ms   阈值 ${limit.toFixed(1)} ms${suffix}`
  );
}

// 校验不变量：父必须存在、排在自己之前、非固定标签，且不存在自引用。
function assertInvariants(label, tabs, state) {
  const indexById = new Map();
  const pinnedIds = new Set();
  tabs.forEach((tab, index) => {
    indexById.set(tab.id, index);
    if (tab.pinned) {
      pinnedIds.add(tab.id);
    }
  });
  for (const [childId, parentId] of state.parentById) {
    if (parentId == null) {
      continue;
    }
    if (!indexById.has(parentId)) {
      throw new Error(`${label}：标签 ${childId} 的父 ${parentId} 不在窗口内`);
    }
    if (indexById.get(parentId) >= indexById.get(childId)) {
      throw new Error(`${label}：父 ${parentId} 没有排在子 ${childId} 之前`);
    }
    if (pinnedIds.has(parentId) || pinnedIds.has(childId)) {
      throw new Error(`${label}：固定标签 ${childId}/${parentId} 参与了父子关系`);
    }
  }
}

function insertTabs(tabs, count, random) {
  const result = tabs.slice();
  for (let i = 0; i < count; i += 1) {
    const at = Math.floor(random() * result.length);
    result.splice(at, 0, {
      id: 900000 + i,
      index: at,
      pinned: false,
      openerTabId: null,
      url: `https://inserted.example.com/${i}`,
      title: `插入的标签 ${i}`,
    });
  }
  return result.map((tab, index) => ({ ...tab, index }));
}

// 头部插入：对应"重启后固定标签或初始标签页先被恢复"导致的整体位移。
function prependTabs(tabs, count) {
  const inserted = [];
  for (let i = 0; i < count; i += 1) {
    inserted.push({
      id: 800000 + i,
      index: i,
      pinned: false,
      openerTabId: null,
      url: `https://prepended.example.com/${i}`,
      title: `头部插入的标签 ${i}`,
    });
  }
  return inserted
    .concat(tabs)
    .map((tab, index) => ({ ...tab, index }));
}

function removeTabs(tabs, count, random, _orderedIds) {
  const removed = new Set();
  while (removed.size < count) {
    removed.add(Math.floor(random() * tabs.length));
  }
  return tabs.filter((_tab, index) => !removed.has(index)).map((tab, index) => ({ ...tab, index }));
}

function shuffleTabs(tabs, ratio, random) {
  const result = tabs.slice();
  const swaps = Math.floor(result.length * ratio * 0.5);
  for (let i = 0; i < swaps; i += 1) {
    const a = Math.floor(random() * result.length);
    const b = Math.floor(random() * result.length);
    const tmp = result[a];
    result[a] = result[b];
    result[b] = tmp;
  }
  return result.map((tab, index) => ({ ...tab, index }));
}

// 局部乱序：对应"用户在标签栏里把邻近的几个标签拖来拖去"，是对齐算法最该扛住的场景。
function shuffleLocally(tabs, groups, random) {
  const result = tabs.slice();
  for (let i = 0; i < groups; i += 1) {
    const a = Math.floor(random() * (result.length - 2));
    const b = a + 1 + Math.floor(random() * 8);
    if (b >= result.length) {
      continue;
    }
    const tmp = result[a];
    result[a] = result[b];
    result[b] = tmp;
  }
  return result.map((tab, index) => ({ ...tab, index }));
}

main();
