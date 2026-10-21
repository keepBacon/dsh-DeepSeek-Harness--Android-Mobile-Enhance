'use strict';
const A=require('node:assert/strict'),V=require('../app/src/main/assets/labs/spatial-v4.js'),B=require('../app/src/main/assets/labs/spatial-core.js');
const s=V.defaultScene();A.equal(V.observe(s).schema,'dsh-spatial-observation-v4');A.equal(V.normalize(B.defaultScene()).schema,'dsh-spatial-v4');
const before=JSON.stringify(s),next=V.step(s,{seconds:1,forward:1});A.equal(JSON.stringify(s),before);A.ok(next.delta.eventCount>=3);A.equal(next.observation.agents.length,2);
A.equal(V.replay(s,[{seconds:.1,forward:1},{seconds:.1,forward:1}]).frames.length,2);
A.equal(V.modelPacket(s).schema,'dsh-spatial-model-packet-v4');A.throws(()=>V.replay(s,Array(65).fill({seconds:0})),/too many/);
let open=V.defaultScene();open.items=[];open.plots=[];open.agents=[];const result=V.planPath(open,{x:6,z:10});A.equal(result.status,'found');A.ok(result.path.length>=2);
const reached=V.planPath(open,{x:0,z:0});A.equal(reached.status,'already_there');
const far=V.planPath(open,{x:100,z:100});A.equal(far.status,'target_too_far');
const wall=V.defaultScene();wall.items=[{id:'barrier',position:B.V(0,1,4),half:B.V(4,1,.3),rotation:{yaw:0,pitch:0,roll:0},solid:true}];wall.agents=[];wall.plots=[];const detour=V.planPath(wall,{x:0,z:9});A.equal(detour.status,'found');A.ok(detour.path.length>=3);
const blocked=V.planPath(wall,{x:0,z:4});A.equal(blocked.status,'target_blocked');
let count=0;for(let i=0;i<600;i++){const q=V.defaultScene();q.agents[0].position.x+=i/1000;const result=V.observe(q);A.ok(Number.isFinite(result.agents[0].relative.worldDistance));count++}
A.throws(()=>V.planPath(s,{x:2,z:3},{maxNodes:99999}),/budget/);
const future=V.step(s,{seconds:2});A.ok(future.scene.agents[0].position.x<s.agents[0].position.x);
console.log('Spatial V4: actor/visibility/delta/replay/navigation/bounds and '+count+' deterministic scenes PASS');
