'use strict';
const a=require('node:assert/strict'),b=require('../app/src/main/assets/labs/spatial-core.js'),s=require('../app/src/main/assets/labs/spatial-v2.js');
const eq=(x,y,e=1e-5)=>a.ok(Math.abs(x-y)<e,String(x)+' != '+String(y)),V=b.V;
let sc=s.defaultScene();a.equal(s.normalize(b.defaultScene()).schema,'dsh-spatial-v2');
a.equal(s.observe(sc).bodyParts.length,6);a.equal(s.observe(sc).objects.length,4);
const basis=s.rotationBasis(35,15,25);eq(b.dot(basis.forward,basis.right),0);eq(b.length(basis.up),1);
const vp={width:820,height:380},camera={position:V(0,0,0),yaw:0,pitch:0,fov:70};
const point=V(2,1,10),screen=s.project(point,camera,vp),ray=s.rayForNormalized(camera,screen.normalized,vp);
eq(ray.x/ray.z,.2,1e-4);eq(ray.y/ray.z,.1,1e-4);
const box={kind:'item',id:'box',center:V(0,0,6),half:V(1,1,1),basis:s.rotationBasis(45,0,0)};
const hit=s.boxContact(V(0,0,0),V(0,0,1),box);a.ok(hit&&hit.distance>4);eq(b.length(hit.normal),1);
a.equal(s.boxContact(V(8,0,0),V(0,0,1),box),null);
a.equal(s.relative({position:V(0,0,0),yaw:0},V(10,0,0)).direction,'right');
a.equal(s.relative({position:V(0,0,0),yaw:0},V(0,0,-10)).direction,'behind');
const previous=JSON.stringify(sc),step=s.step(sc,{forward:1,seconds:1});a.equal(JSON.stringify(sc),previous);
eq(step.scene.player.position.z,3.5);a.ok(step.motion.path.length>1);
const free=s.normalize(sc);free.camera.follow=false;eq(s.step(free,{cameraForward:1,seconds:1}).scene.camera.position.z,free.camera.position.z+3.5);
a.equal(s.aimAt(sc,'item','crate').camera.follow,false);
const oc=s.defaultScene();oc.items=[{id:'near',position:V(0,1.5,4),half:V(1,1,1),rotation:{yaw:0,pitch:0,roll:0}},{id:'far',position:V(0,1.5,8),half:V(1,1,1),rotation:{yaw:0,pitch:0,roll:0}}];oc.camera.position=V(0,1.5,0);oc.camera.pitch=0;
const o=s.observe(oc);a.equal(o.objects.find(t=>t.id==='far').visibility,'occluded');a.equal(o.objects.find(t=>t.id==='far').occludedBy.id,'near');a.equal(o.reticle.worldHit.id,'near');
a.throws(()=>s.step(sc,{seconds:8}),/timestep/);a.throws(()=>s.normalize({...sc,viewport:{width:0,height:300}}),/viewport/);
const du=s.defaultScene();du.items.push({...du.items[0]});a.throws(()=>s.validate(du),/duplicate/);
let seed=3;function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
for(let n=0;n<2000;n++){const v=s.defaultScene();v.player.yaw=rand()*360;v.camera.yaw=rand()*360;v.camera.pitch=rand()*120-60;v.viewport={width:300+Math.floor(rand()*1400),height:200+Math.floor(rand()*900)};v.reticle.normalized={x:rand()*2-1,y:rand()*2-1,z:0};const ob=s.observe(v);a.ok(Number.isFinite(ob.reticle.rayDirection.z));eq(b.length(s.rayForNormalized(v.camera,v.reticle.normalized,v.viewport)),1)}
console.log('V2: OBB, ray/projection, occlusion, motion, V1 import, 2000 fuzz: PASS');
