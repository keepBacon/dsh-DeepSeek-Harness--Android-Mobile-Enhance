'use strict';
const assert=require('node:assert/strict');
const S=require('../app/src/main/assets/labs/spatial-v4.js');
const B=require('../app/src/main/assets/labs/spatial-core.js');
const V=B.V;
function wallScene(){const s=S.defaultScene();s.items=[{id:'thin',position:V(.5,1,0),half:V(.02,1,4),rotation:{yaw:0,pitch:0,roll:0},solid:true}];s.plots=[];s.agents=[];return s;}
let s=wallScene(),p=S.planPath(s,{x:4,z:0});assert.equal(p.status,'found');
assert.ok(p.path.length>2);
assert.ok(p.path.some(q=>q.z>4.2||q.z< -4.2),'thin wall must be bypassed');
assert.ok(!p.path.some((q,i)=>i&&q.x===p.path[i-1].x&&q.z===p.path[i-1].z),'no duplicate goals');
s=S.defaultScene();s.camera.follow=false;s.camera.position=V(0,1.5,0);s.camera.yaw=0;s.camera.pitch=0;s.items=[];s.plots=[];
s.agents=[{id:'target',role:'target',position:V(0,1.5,5),velocity:V(0,0,0),yaw:0,radius:.7}];
let o=S.observe(s);assert.equal(o.reticle.worldHit.kind,'agent');assert.equal(o.reticle.worldHit.id,'target');
assert.equal(o.agents[0].visibility,'visible');
// Camera at the exact center of an agent must not produce a zero-vector normal.
s=S.defaultScene();s.camera.follow=false;s.camera.position=V(0,1.5,0);
s.camera.yaw=0;s.camera.pitch=0;s.items=[];s.plots=[];
s.agents=[{id:'overlap',role:'target',position:V(0,1.5,0),velocity:V(0,0,0),yaw:0,radius:.7}];
o=S.observe(s);assert.equal(o.reticle.worldHit.kind,'agent');
assert.equal(o.reticle.worldHit.id,'overlap');
assert.deepEqual(o.reticle.worldHit.normal,{x:0,y:0,z:-1});
assert.equal(o.agents[0].visibility,'camera_overlaps_agent');
s=S.defaultScene();s.items=[{id:'wall',position:V(0,1,3),half:V(4,1,.1),rotation:{yaw:0,pitch:0,roll:0},solid:true}];s.plots=[];
s.agents=[{id:'moving',role:'ally',position:V(0,1,1),velocity:V(0,0,5),yaw:0,radius:.3}];
o=S.step(s,{seconds:1});assert.ok(o.scene.agents[0].position.z<2.7);assert.ok(o.delta.events.some(e=>e.kind==='agent_collision'&&e.id==='wall'));
s=S.defaultScene();const d=S.normalize(s);d.player.yaw=30;d.camera.pitch=10;d.reticle.normalized.x=.5;d.items[0].position.x+=3;
d.agents[0].velocity=V(0,0,1);d.agents[0].yaw=15;
const eventKinds=S.deltaReport(s,d).events.map(e=>e.kind);
for(const kind of ['player_rotated','camera_rotated','reticle_moved','object_moved','agent_velocity_changed','agent_rotated'])assert.ok(eventKinds.includes(kind),kind);
(async()=>{
  const result=await S.planPathAsync(wallScene(),{x:4,z:0});assert.equal(result.status,'found');
  const cancelled=await S.planPathAsync(wallScene(),{x:4,z:0},{},null,{cancelled:true});
  assert.equal(cancelled.status,'cancelled');
  console.log('Issue #30 regression: thin walls, center-overlap hit, unified hit, agent collision, delta, async/cancel PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
