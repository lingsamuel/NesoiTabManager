import assert from "node:assert/strict";

// 真实后台 + 两种浏览器回调次序：query 必须返回捕获时的副本，才能暴露迟到结果。
for (const timing of ['before-callback','after-callback']) {
  let actual=[{id:1,index:0},{id:2,index:1},{id:3,index:2,openerTabId:1}]
    .map(tab=>({...tab,windowId:1,url:`https://test.invalid/${tab.id}`}));
  const data={};
  const area={get:(key,cb)=>cb({[key]:data[key]}),set:(values,cb)=>{Object.assign(data,values);cb?.();},remove:(_key,cb)=>cb?.()};
  let moving=false;
  let captured;
  let backend;
  const nativeEvent=()=>{
    backend.handleTreeTabMoved(3,{windowId:1,fromIndex:1,toIndex:0});
    captured={child:backend.getTabStructureInfo(3,1)?.index,neighbor:backend.getTabStructureInfo(2,1)?.index};
    actual=actual.filter(tab=>tab.id!==2).map((tab,index)=>({...tab,index}));
    backend.handleTreeTabRemoved(2,{windowId:1});
  };
  globalThis.chrome={
    runtime:{lastError:null},storage:{local:area,session:area},alarms:{create(){},clear(){}},
    windows:{getAll:cb=>cb([{id:1}])},
    tabs:{
      query:(_query,cb)=>{
        const captured=actual.map(tab=>({...tab}));
        if(moving) setTimeout(()=>cb(captured),20);else cb(captured);
      },
      move:(ids,info,cb)=>{
        const set=new Set(ids), block=ids.map(id=>actual.find(tab=>tab.id===id));
        actual=actual.filter(tab=>!set.has(tab.id));actual.splice(info.index,0,...block);
        actual=actual.map((tab,index)=>({...tab,index}));moving=true;
        if(timing==='before-callback') nativeEvent();
        cb(block);
        if(timing==='after-callback') setTimeout(nativeEvent,0);
      },
    },
  };
  backend=await import(`../background/tree.js?native-order-${timing}`);
  await backend.getTreeStructure([1]);
  actual=actual.filter(tab=>tab.id!==1).map((tab,index)=>({...tab,index}));
  backend.handleTreeTabRemoved(1,{windowId:1});
  await backend.getTreeStructure([1]);
  assert.deepEqual(captured,{child:0,neighbor:1},`${timing}: 关闭记录之前下标已同步`);
  assert.equal(backend.getTabStructureInfo(2,1),null,`${timing}: 迟到query不能复活关闭项的index`);
  assert.deepEqual(actual.map(tab=>tab.id),[3]);
  console.log(`✓ 原生移动事件 ${timing}：关闭现场下标与最终查询一致`);
}
process.exit(0);
