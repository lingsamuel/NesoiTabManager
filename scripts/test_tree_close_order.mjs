import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createTreeStateFromParents, flattenTree, applyRemovePromotion, encodeSnapshot, alignSnapshotToTabs } from "../background/tree_core.js";
import { planCloseOrder, needsCloseOrder, planSnapshotCloseOrder, closeOrderPlacement, createCloseOrderScheduler } from "../background/tree_close_order.js";

const tests = [];
const test = (name, run) => tests.push({ name, run });
const tabsFor = ids => ids.map((id,index)=>({id,index,pinned:false,url:`https://test.invalid/${id}`}));
const rows = (ids, state) => flattenTree(ids, state.parentById).map(row=>row.id);

// 对照真实纯关闭算法验证性质，避免只检验计划函数返回自己构造的数组。
test("随机交错树关闭：所有存活行维持次序，全部父在子前", () => {
  let seed = 17;
  const random = limit => (seed = (Math.imul(seed,1664525)+1013904223) >>> 0) % limit;
  for(let round=0;round<300;round++) {
    const ids=Array.from({length:30},(_,i)=>i+1);
    const state=createTreeStateFromParents(new Map(ids.map((id,i)=>[id, random(i+1)||null])));
    const closed=ids[random(ids.length)];
    const expected=rows(ids,state).filter(id=>id!==closed);
    const plan=planCloseOrder(state,ids,closed);
    applyRemovePromotion(state,closed);
    let actual=ids.filter(id=>id!==closed);
    if(needsCloseOrder(plan,state.parentById)) actual=closeOrderPlacement(plan,tabsFor(actual)).targetIds;
    assert.deepEqual(rows(actual,state),expected,`round ${round}`);
    const positions=new Map(actual.map((id,index)=>[id,index]));
    for(const [id,p] of state.parentById) if(p!=null) assert.ok(positions.get(p)<positions.get(id));
  }
});

test("冷加载多重缺失以已恢复的父关系排序，不能把子搬到父前", () => {
  const tabs=tabsFor([1,9,2,3,4]);
  const state=createTreeStateFromParents(new Map([[1,null],[9,null],[2,1],[3,1],[4,2]]));
  const {payload}=encodeSnapshot(tabs,state,{sessionToken:'same'});
  let actual=tabsFor([9,3,4]);
  const restored=alignSnapshotToTabs(actual,payload,{sessionToken:'same'}).state;
  assert.equal(restored.parentById.get(4),3);
  const plans=planSnapshotCloseOrder(actual,payload,'same',restored.parentById);
  for(const plan of plans) actual=tabsFor(closeOrderPlacement(plan,actual).targetIds);
  assert.deepEqual(actual.map(t=>t.id),[3,4,9]);
  assert.deepEqual(rows(actual.map(t=>t.id),restored),[3,4,9]);
  assert.equal(planSnapshotCloseOrder(actual,payload,'other',restored.parentById).length,0);
  assert.equal(planSnapshotCloseOrder(tabsFor([9,4,3]),payload,'same',restored.parentById).length,0);
  assert.equal(planSnapshotCloseOrder(tabsFor([9,3,4,10]),payload,'same',restored.parentById).length,0);
});

test("冷加载多个独立缺失父项的虚拟顺序累积，不覆盖前一块定位", () => {
  const tabs=tabsFor([1,9,2,8,3,4]);
  const state=createTreeStateFromParents(new Map([[1,null],[9,null],[2,1],[8,null],[3,null],[4,8]]));
  const {payload}=encodeSnapshot(tabs,state,{sessionToken:'same'});
  const live=tabsFor([9,2,3,4]);
  const restored=alignSnapshotToTabs(live,payload,{sessionToken:'same'}).state;
  const plans=planSnapshotCloseOrder(live,payload,'same',restored.parentById);
  const ids=new Set(live.map(t=>t.id));
  assert.deepEqual(plans.at(-1).targetIds.filter(id=>ids.has(id)),[2,9,4,3]);
});

test("冷加载的视图本来不跳时不移动原生标签", () => {
  const state=createTreeStateFromParents(new Map([[1,null],[2,1],[3,null],[4,2]]));
  const {payload}=encodeSnapshot(tabsFor([1,2,3,4]),state,{sessionToken:'same'});
  const live=tabsFor([1,3,4]);
  const restored=alignSnapshotToTabs(live,payload,{sessionToken:'same'}).state;
  assert.equal(planSnapshotCloseOrder(live,payload,'same',restored.parentById).length,0);
});

test("2K 标签只搬被关闭父项的后代，规划和比较不改变旁支顺序", () => {
  const ids=Array.from({length:2000},(_,i)=>i+1);
  const state=createTreeStateFromParents(new Map(ids.map(id=>[id,id>=1998?100:null])));
  const start=performance.now();
  const plan=planCloseOrder(state,ids,100);
  applyRemovePromotion(state,100);
  const placement=closeOrderPlacement(plan,tabsFor(ids.filter(id=>id!==100)));
  assert.deepEqual(placement.movingIds,[1998,1999,2000]);
  assert.deepEqual(placement.targetIds.filter(id=>id<1998),ids.filter(id=>id!==100 && id<1998));
  assert.ok(needsCloseOrder(plan,state.parentById));
  console.log(`2K 标签局部计划：${(performance.now()-start).toFixed(1)} ms，移动 ${placement.movingIds.length} 项`);
});

test("定位失败后取消依赖计划并校准真实下标，等待者不会悬挂", async () => {
  const actual=tabsFor([9,2,3,4]);
  const results=[], synced=[];
  let moves=0;
  const scheduler=createCloseOrderScheduler({
    query:async()=>actual,
    move:async()=>{moves++;throw new Error('move rejected');},
    begin:(_windowId,ids)=>({ids}),finish:(token,result)=>results.push({token,result}),
    sync:(_windowId,tabs)=>synced.push(tabs.map(t=>t.id)),changed:()=>{},
  });
  const before=[1,9,2,3,4];
  const state=createTreeStateFromParents(new Map([[1,null],[9,null],[2,1],[3,2],[4,1]]));
  const first=planCloseOrder(state,before,1);
  scheduler.enqueue(1,first);
  scheduler.enqueue(1,{...first,removedId:2,movingIds:[3]});
  await scheduler.wait(1);
  assert.equal(moves,1);
  assert.equal(results.length,2);
  assert.ok(results.every(item=>item.result.failed));
  assert.ok(synced.length);
  assert.equal(scheduler.pending(1),false);
  assert.deepEqual(scheduler.orderFor(1,[9,2,3,4]),[9,2,3,4]);
});

test("移动请求发出后成员又被关闭：过滤消失身份，在原目标重试存活块", async () => {
  let actual=tabsFor([9,2,3]);
  const results=[];
  let moves=0;
  const scheduler=createCloseOrderScheduler({
    query:async()=>actual,
    async move(_windowId,ids,index) {
      if (++moves===1) { actual=tabsFor([9,3]); throw new Error('No tab with id 2'); }
      const moving=new Set(ids);
      const rest=actual.map(t=>t.id).filter(id=>!moving.has(id));
      rest.splice(index,0,...ids);actual=tabsFor(rest);
    },
    begin:()=>({}),finish:(_token,result)=>results.push(result),sync:()=>{},changed:()=>{},
  });
  const state=createTreeStateFromParents(new Map([[1,null],[9,null],[2,1],[3,1]]));
  scheduler.enqueue(1,planCloseOrder(state,[1,9,2,3],1));
  await scheduler.wait(1);
  assert.deepEqual(actual.map(t=>t.id),[3,9]);
  assert.equal(results.at(-1).failed,undefined);
  assert.equal(moves,2);
});

test("定位期间新增无关标签不能取消下一个关闭块", async () => {
  let actual=tabsFor([9,2,8,4]);
  let moves=0;
  const results=[];
  const scheduler=createCloseOrderScheduler({
    query:async()=>actual,
    async move(_windowId,ids,index) {
      const moving=new Set(ids);
      const remaining=actual.map(t=>t.id).filter(id=>!moving.has(id));
      remaining.splice(index,0,...ids);
      if (++moves===1) remaining.push(10);
      actual=tabsFor(remaining);
    },
    begin:()=>({}),finish:(_token,result)=>results.push(result),sync:()=>{},changed:()=>{},
  });
  const state=createTreeStateFromParents(new Map([[1,null],[9,null],[2,1],[3,null],[8,null],[4,3]]));
  const first=planCloseOrder(state,[1,9,2,3,8,4],1);
  scheduler.enqueue(1,first);
  scheduler.enqueue(1,planCloseOrder(state,first.targetIds,3));
  await scheduler.wait(1);
  assert.deepEqual(actual.map(t=>t.id),[2,9,4,8,10]);
  assert.ok(results.every(result=>!result.failed));
});

let failures=0;
for(const {name,run} of tests) {
  try { await run(); console.log(`✓ ${name}`); }
  catch(error) { failures++;console.error(`✗ ${name}`,error); }
}
assert.equal(failures,0);
