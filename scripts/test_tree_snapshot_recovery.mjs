import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  createTreeStateFromParents, encodeSnapshot, alignSnapshotToTabs, applyRemovePromotion,
} from "../background/tree_core.js";

const tests = [];
const test = (name, run) => tests.push({ name, run });

function recover(entries, removed, options = {}) {
  const tabs = entries.map(([id], index) => ({ id, index, url: `https://test.invalid/${id}`, pinned: false }));
  const state = createTreeStateFromParents(new Map(entries));
  const { payload } = encodeSnapshot(tabs, state, { sessionToken: "session" });
  const removedIds = new Set(removed);
  const live = tabs.filter((tab) => !removedIds.has(tab.id)).map((tab, index) => ({ ...tab, index }));
  return alignSnapshotToTabs(live, payload, { sessionToken: "session", ...options });
}

test("日志复现：顶层父关闭后首子接替，其余归到首子", () => {
  const result = recover([[12156, null], [12157, 12156], [12158, 12156], [12159, 12156], [12160, 12156]], [12156]);
  assert.deepEqual([...result.state.parentById], [[12157, null], [12158, 12157], [12159, 12157], [12160, 12157]]);
  assert.equal(result.matched, 4);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 1);
});

test("父节点有兄弟时继承规则一致，子树和其它顶层树保持完整", () => {
  const result = recover([[1, null], [2, 1], [3, 2], [4, 3], [5, 2], [6, 5], [7, 1], [8, null], [9, 8]], [2]);
  assert.deepEqual([...result.state.parentById], [[1, null], [3, 1], [4, 3], [5, 3], [6, 5], [7, 1], [8, null], [9, 8]]);
});

test("父节点是唯一孩子时提升所有孩子到祖父", () => {
  const result = recover([[1, null], [2, 1], [3, 2], [4, 2], [5, null]], [2]);
  assert.deepEqual([...result.state.parentById], [[1, null], [3, 1], [4, 1], [5, null]]);
});

test("旧快照通过唯一 URL 配对后使用相同继承规则", () => {
  const result = recover([[1, null], [2, 1], [3, 1]], [1], { sessionToken: "other-session" });
  assert.deepEqual([...result.state.parentById], [[2, null], [3, 2]]);
});

test("子树在物理序列中交错：首子按物理顺序而不是 DFS 顺序选择", () => {
  const result = recover([[1, null], [2, 1], [3, 1], [4, 2], [5, 3]], [1, 2]);
  assert.deepEqual([...result.state.parentById], [[3, null], [4, 3], [5, 3]]);
});

test("后台休眠期间兄弟换位：接替者按当前顺序而不是快照顺序选择", () => {
  const state = createTreeStateFromParents(new Map([[1, null], [2, 1], [3, 1], [4, 2], [5, 3]]));
  const tabs = [1, 2, 3, 4, 5].map((id, index) => ({ id, index, url: `https://test.invalid/${id}` }));
  const { payload } = encodeSnapshot(tabs, state, { sessionToken: "session" });
  const live = [3, 5, 2, 4].map((id, index) => ({ ...tabs[id - 1], index }));
  const result = alignSnapshotToTabs(live, payload, { sessionToken: "session" });
  assert.deepEqual(result.state.parentById, new Map([[2, 3], [3, null], [4, 2], [5, 3]]));
});

test("多个节点缺失：等价于逆快照顺序逐个执行既有关闭算法", () => {
  let seed = 42;
  const random = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  for (let round = 0; round < 150; round += 1) {
    const entries = Array.from({ length: 35 }, (_, index) => [index + 1, random(index + 1) || null]);
    const removed = entries.filter(() => random(3) === 0).map(([id]) => id).reverse();
    const warm = createTreeStateFromParents(new Map(entries));
    for (const id of removed) {
      // 与后台一样，在决定“第一个孩子”之前以物理顺序整理索引。
      warm.childIdsById.get(id)?.sort((a, b) => a - b);
      applyRemovePromotion(warm, id);
    }
    assert.deepEqual(recover(entries, removed).state.parentById, warm.parentById, `第 ${round} 组`);
  }
});

test("连续缺失长链携带大量存活孩子，无递归且保留首子继承", () => {
  const depth = 10000;
  const count = 2000;
  const entries = Array.from({ length: depth }, (_, id) => [id + 1, id || null]);
  for (let i = 1; i <= count; i += 1) entries.push([depth + i, depth]);
  const removed = entries.slice(0, depth).map(([id]) => id);
  const start = performance.now();
  const result = recover(entries, removed);
  assert.equal(result.state.parentById.get(depth + 1), null);
  for (let i = 2; i <= count; i += 1) assert.equal(result.state.parentById.get(depth + i), depth + 1);
  console.log(`长链恢复 ${entries.length} 节点：${(performance.now() - start).toFixed(1)} ms`);
});

let failures = 0;
for (const { name, run } of tests) {
  try { run(); console.log(`✓ ${name}`); }
  catch (error) { failures += 1; console.error(`✗ ${name}`, error); }
}
assert.equal(failures, 0, "快照继承回归失败");
