import assert from "node:assert/strict";
import { createTreeDiagnosticMonitor } from "../background/tree_diagnostic_monitor.js";

const tests = [];
const test = (name, run) => tests.push({ name, run });
const snapshot = (pairs, token = "old", extra = {}) => ({
  windowId: 31, source: "rows", sourceToken: token,
  parentById: new Map(pairs), physicalOrderIds: pairs.map(([id]) => id),
  entries: pairs.map(([id, parentId], index) => ({ id, parentId, index })), ...extra,
});
function harness() {
  const records = [], incidents = [];
  const monitor = createTreeDiagnosticMonitor({ preserveBaselineOnSourceChange: true,
    emit: e => records.push(e), incident: e => incidents.push(e) });
  return { monitor, records, incidents };
}
function removed(monitor, id) {
  assert.equal(typeof monitor.noteRemoved, "function", "需要保留前端实际收到的关闭事件");
  monitor.noteRemoved(id, { windowId: 31 });
}
const before = [[12164, null], [12173, 12164], [12174, 12173], [12175, 12174], [12176, 12174], [12160, 12173], [12166, 12164], [12167, 12164]];
const after = [[12164, null], [12174, 12164], [12175, 12174], [12176, 12174], [12160, 12174], [12166, 12164], [12167, 12164]];

test("实际日志：有真实关闭事件的跨后台正常继承不建异常包", () => {
  const { monitor, incidents, records } = harness();
  monitor.observe(snapshot(before), { aligned: true });
  removed(monitor, 12173);
  monitor.observe(snapshot(before.filter(([id]) => id !== 12173)), { aligned: false });
  monitor.observe(snapshot(after, "new"), { aligned: true, operations: [] });
  assert.equal(incidents.length, 0);
  assert.ok(records.some(e => e.classification === "explained" && e.observation.operations.some(o => o.explanation === "observed-removal")));
});

test("错误升顶层仍报警，之后修正为正确继承才能恢复", () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot(before), { aligned: true });
  removed(monitor, 12173);
  const wrong = after.map(([id, p]) => [id, id === 12174 || id === 12160 ? null : p]);
  monitor.observe(snapshot(wrong, "new"), { aligned: true });
  assert.ok(incidents.some(e => e.type === "parent-change" && e.status === "active"));
  const signature = incidents.find(e => e.type === "parent-change").signature;
  monitor.observe(snapshot(wrong, "new"), { aligned: true });
  assert.ok(!incidents.some(e => e.status === "recovered"));
  monitor.observe(snapshot(after, "new"), { aligned: true });
  assert.ok(incidents.some(e => e.signature === signature && e.status === "recovered"));
});

test("无关闭事件的相同改父仍保留疑点，不能仅按节点消失猜关闭", () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot(before), { aligned: true });
  monitor.observe(snapshot(after, "new"), { aligned: true });
  assert.ok(incidents.some(e => e.type === "parent-change"));
});

test("关闭的合法改父不解释共同存活节点的换位或旁支改父", () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot(before), { aligned: true });
  removed(monitor, 12173);
  const wrong = after.map(([id,p]) => [id, id === 12166 ? 12174 : p]);
  [wrong[5], wrong[6]] = [wrong[6], wrong[5]];
  monitor.observe(snapshot(wrong, "new"), { aligned: true });
  assert.ok(incidents.some(e => e.type === "parent-change" && e.ids.includes(12166)));
  assert.ok(incidents.some(e => e.type === "order-change"));
});

test("筛选隐藏行仍在完整父映射中，不能被误认为已关闭", () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot(before), { aligned: true });
  removed(monitor, 12173);
  const hidden = snapshot(after, "new", { parentById: new Map(before) });
  monitor.observe(hidden, { aligned: true });
  assert.ok(incidents.some(e => e.type === "parent-change"));
});

test("按事件顺序解释连续关闭；显式 gap 后不沿用旧事件", () => {
  const { monitor, incidents } = harness();
  const chain = [[1,null],[2,1],[3,2],[4,3],[5,3]];
  monitor.observe(snapshot(chain), { aligned: true });
  removed(monitor, 3); removed(monitor, 2);
  monitor.observe(snapshot([[1,null],[4,1],[5,1]], "new"), { aligned: true });
  assert.equal(incidents.length, 0);
  monitor.gap({ windowId: 31, reason: "hidden" });
  monitor.observe(snapshot(chain), { aligned: true });
  monitor.observe(snapshot([[1,null],[4,1],[5,1]], "new"), { aligned: true });
  assert.ok(incidents.some(e => e.status === "active"));
});

test("同一已对齐前态的重叠暂态合并，确认和恢复使用稳定身份", () => {
  const { monitor, incidents, records } = harness();
  const initial = snapshot([[1,null],[2,null],[3,null],[4,null],[5,null]]);
  const pending = snapshot([[1,null],[2,1],[3,2],[4,null],[5,null]]);
  const final = snapshot([[1,null],[2,1],[3,1],[4,3],[5,null]]);
  monitor.observe(initial, { aligned: true });
  monitor.observe(pending, { aligned: false, requestId: "first" });
  const signature = records.find(e => e.type === "tree-anomaly" && e.classification === "pending").signature;
  monitor.observe(final, { aligned: false });
  monitor.observe(final, { aligned: true });
  const active = incidents.filter(e => e.status === "active" && e.type === "parent-change");
  assert.equal(active.length, 1);
  assert.equal(active[0].signature, signature);
  assert.deepEqual(new Set(active[0].ids), new Set([2,3,4]));
  assert.equal(active[0].evidence.firstEvidence.observation.requestId, "first");
  assert.ok(active[0].evidence.nodes.some(n => n.id === 4 && n.before.parentId === null));
  monitor.observe(initial, { aligned: true });
  assert.ok(incidents.some(e => e.signature === signature && e.status === "recovered"));
});

test("无变化的 pending/complete 往返不重复写日志，真实改变与恢复必须更新", () => {
  const { monitor, incidents, records } = harness();
  const initial = snapshot([[1,null],[2,null]]);
  const wrong = snapshot([[1,null],[2,1]]);
  monitor.observe(initial, { aligned: true });
  monitor.observe(wrong, { aligned: true });
  const count = incidents.length, recordCount = records.length;
  for (let i=0;i<100;i++) monitor.observe(wrong, { aligned: Boolean(i % 2), requestId: `request-${i}`, revision: i });
  assert.equal(incidents.length, count);
  assert.equal(records.length, recordCount);
  const moved = snapshot([[1,null],[2,1]]); moved.entries[1].index = 4;
  monitor.observe(moved, { aligned: false });
  assert.equal(incidents.length, count + 1);
  assert.equal(incidents.at(-1).evidence.nodes.find(n=>n.id===2).after.index, 4);
  monitor.observe(initial, { aligned: true });
  assert.equal(incidents.at(-1).status, "recovered");
});

test("新的独立问题保留自己的前态，不与老问题混用恢复基线", () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([[1,null],[2,null],[3,null]]), { aligned:true });
  monitor.observe(snapshot([[1,null],[2,1],[3,null]]), { aligned:true });
  const first = incidents.at(-1).signature;
  monitor.observe(snapshot([[1,null],[2,1],[3,2]]), { aligned:true });
  const second = incidents.at(-1).signature;
  assert.notEqual(first,second);
  monitor.observe(snapshot([[1,null],[2,1],[3,null]]), { aligned:true });
  assert.ok(incidents.some(e=>e.signature===second && e.status==="recovered"));
  assert.ok(!incidents.some(e=>e.signature===first && e.status==="recovered"));
});

test("关闭后目标父部分错误不能借正确祖先分配被整体豁免", () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot(before), {aligned:true});
  removed(monitor,12173);
  const wrong = after.map(([id,p]) => [id,id === 12160 ? 12164 : p]);
  monitor.observe(snapshot(wrong,"new"),{aligned:true});
  assert.ok(incidents.some(e=>e.ids.includes(12160)));
  assert.ok(!incidents.some(e=>e.ids.includes(12174)));
});

test("关闭规则使用物理首子，不受可见行隐藏或排列影响", () => {
  const { monitor, incidents } = harness();
  const original = snapshot(before);
  original.entries = original.entries.filter(entry => entry.id !== 12174 && entry.id !== 12175 && entry.id !== 12176);
  monitor.observe(original,{aligned:true});
  removed(monitor,12173);
  const result = snapshot(after,"new");
  result.entries = result.entries.filter(entry => entry.id !== 12174 && entry.id !== 12175 && entry.id !== 12176);
  monitor.observe(result,{aligned:true});
  assert.equal(incidents.length,0);
});

test("关闭历史有界，缺失关闭依据时明确记录间隙并保留可疑变化", () => {
  const { monitor, records, incidents } = harness();
  const pairs = [[1,null],[2,1],...Array.from({length:257},(_,i)=>[i+10,null])];
  monitor.observe(snapshot(pairs),{aligned:true});
  removed(monitor,1);
  for(let id=10;id<267;id++) removed(monitor,id);
  monitor.observe(snapshot([[2,null]],"new"),{aligned:true});
  assert.ok(records.some(e=>e.reason==="removal-history-limit"));
  assert.ok(incidents.some(e=>e.type==="parent-change"));
});

test("2K 标签高频观察只保存变化；新问题和内容变化继续留证据", () => {
  const { monitor, records, incidents } = harness();
  const initial = Array.from({length:2000},(_,i)=>[i+1,null]);
  const changed = initial.map(([id,p])=>[id,id===1000 ? 999 : p]);
  monitor.observe(snapshot(initial),{aligned:true});
  monitor.observe(snapshot(changed),{aligned:true});
  const count=records.length, incidentCount=incidents.length;
  const start=performance.now();
  for(let i=0;i<50;i++) monitor.observe(snapshot(changed),{aligned:!!(i%2),requestId:`poll-${i}`});
  assert.equal(records.length,count);
  assert.equal(incidents.length,incidentCount);
  const content = snapshot(changed);
  content.entries[999].title="PRIVATE-CONTENT-1";
  monitor.observe(content,{aligned:true});
  content.entries[999].title="PRIVATE-CONTENT-2";
  monitor.observe(content,{aligned:true});
  assert.equal(incidents.length,incidentCount+2);
  assert.ok(!JSON.stringify(incidents).includes("PRIVATE-CONTENT"));
  const outputBytes=Buffer.byteLength(JSON.stringify({records,incidents}));
  assert.ok(outputBytes<20000,`局部输出 ${outputBytes} bytes 不应随整窗大小膨胀`);
  console.log(`2K 标签重复观察 50 次：${(performance.now()-start).toFixed(1)} ms，输出 ${outputBytes} bytes`);
});

test("采样间新增兄弟会改变关闭规则，不能用旧前态豁免错误继承", () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([[1,null],[2,1],[3,2],[4,2]]), {aligned:true});
  removed(monitor,2);
  monitor.observe(snapshot([[1,null],[3,1],[4,1],[5,1]],"new"), {aligned:true});
  assert.ok(incidents.some(e=>e.ids.includes(4)));
});

test("实际后台已有移动和关闭登记时不插入过期的关闭推导", () => {
  const { monitor, incidents } = harness();
  monitor.observe(snapshot([[1,null],[2,1],[3,2],[4,2],[5,null]]), {aligned:true});
  removed(monitor,2);
  monitor.observe(snapshot([[1,null],[5,null],[3,5],[4,5]],"new"), {aligned:true, operations:[
    {type:"move",registered:true,phase:"complete",correlationId:"move-2",focusIds:[2],
      expectedParents:[{childId:2,parentId:5}],expectedOrderIds:[1,5,3,4]},
    {type:"close",registered:true,phase:"complete",correlationId:"close-2",focusIds:[2],
      expectedParents:[{childId:3,parentId:5},{childId:4,parentId:5}]},
  ]});
  assert.equal(incidents.length,0);
});

test("合法继承不能豁免错误层级，隐藏祖先的正常投影仍可解释", () => {
  for (const hidden of [false,true]) {
    for (const wrong of [false,true]) {
      const { monitor, incidents } = harness();
      const initial=snapshot([[1,null],[2,1],[3,2],[4,3],[5,1]]);
      initial.entries.forEach((entry,index)=>entry.depth=[0,1,2,3,1][index]);
      if(hidden) {
        initial.entries=initial.entries.filter(e=>e.id!==3);
        initial.entries.find(e=>e.id===4).depth=2;
      }
      monitor.observe(initial,{aligned:true});
      removed(monitor,2);
      const result=snapshot([[1,null],[3,1],[4,3],[5,1]],"new");
      result.entries.forEach((entry,index)=>entry.depth=[0,1,2,1][index]);
      if(hidden) {
        result.entries=result.entries.filter(e=>e.id!==3);
        result.entries.find(e=>e.id===4).depth=1;
      }
      if(wrong) result.entries.find(e=>e.id===4).depth=6;
      monitor.observe(result,{aligned:true});
      assert.equal(incidents.some(e=>e.ids.includes(4)),wrong,`隐藏=${hidden} 错误=${wrong}`);
    }
  }
});

test("关闭后保持旧缩进也必须报警，连续观察不能误报恢复", () => {
  const { monitor, incidents } = harness();
  const initial=snapshot([[1,null],[2,1],[3,2],[4,3],[5,1]]);
  initial.entries.forEach((entry,index)=>entry.depth=[0,1,2,3,1][index]);
  monitor.observe(initial,{aligned:true});
  removed(monitor,2);
  const stale=snapshot([[1,null],[3,1],[4,3],[5,1]],"new");
  stale.entries.forEach((entry,index)=>entry.depth=[0,1,3,1][index]);
  // 只有后代保持旧层级，其父已正确渲染，不能靠父节点变化偶然发现。
  monitor.observe(stale,{aligned:true});
  assert.ok(incidents.some(e=>e.ids.includes(4) && e.status==='active'));
  const active=incidents.find(e=>e.ids.includes(4));
  assert.ok(active.evidence.nodes.some(n=>n.id===4 && n.before.depth===3 && n.after.depth===3));
  monitor.observe(stale,{aligned:true});
  assert.ok(!incidents.some(e=>e.status==='recovered'));
  const fixed=snapshot([[1,null],[3,1],[4,3],[5,1]],"new");
  fixed.entries.forEach((entry,index)=>entry.depth=[0,1,2,1][index]);
  monitor.observe(fixed,{aligned:true});
  assert.ok(incidents.some(e=>e.signature===active.signature && e.status==='recovered'));
});

test("后续新增标签导致关闭推导不可用时，不能把已知错误旧层级当恢复", () => {
  for (const [operation, staleId] of [[false,4],[true,4],[false,3]]) {
    const { monitor, incidents } = harness();
    const initial=snapshot([[1,null],[2,1],[3,2],[4,3],[5,1]]);
    initial.entries.forEach((entry,index)=>entry.depth=[0,1,2,3,1][index]);
    monitor.observe(initial,{aligned:true});
    removed(monitor,2);
    const stale=snapshot([[1,null],[3,1],[4,3],[5,1]],"new");
    stale.entries.forEach((entry,index)=>entry.depth=[0,1,2,1][index]);
    stale.entries.find(e=>e.id===staleId).depth+=1;
    monitor.observe(stale,{aligned:true});
    assert.ok(incidents.some(e=>e.ids.includes(staleId)));
    const updated=snapshot([[1,null],[3,1],[4,3],[5,1],[6,null]],"new");
    updated.entries.forEach((entry,index)=>entry.depth=[0,1,2,1,0][index]);
    updated.entries.find(e=>e.id===staleId).depth+=1;
    const context={aligned:true, operations: operation ? [
      {type:'expand',registered:true,phase:'complete',correlationId:'expand-6',focusIds:[6]},
    ] : []};
    monitor.observe(updated,context);
    assert.ok(!incidents.some(e=>e.status==='recovered'));
    updated.entries.find(e=>e.id===staleId).depth-=1;
    monitor.observe(updated,context);
    assert.equal(incidents.at(-1).status,'recovered');
  }
});

let failures = 0;
for (const { name, run } of tests) {
  try { run(); console.log(`✓ ${name}`); }
  catch (error) { failures++; console.error(`✗ ${name}\n${error.stack}`); }
}
assert.equal(failures,0,`${failures} 项诊断生命周期测试失败`);
