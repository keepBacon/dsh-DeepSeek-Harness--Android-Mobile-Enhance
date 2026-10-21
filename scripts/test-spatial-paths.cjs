'use strict';
/* Deterministic, independent path collision oracle with finer sampling. */
const assert=require('node:assert/strict');
const B=require('../app/src/main/assets/labs/spatial-core.js');
const S=require('../app/src/main/assets/labs/spatial-v2.js');
const V4=require('../app/src/main/assets/labs/spatial-v4.js');
const V=B.V;
const density=.065;
const radius=.28+.015;
let seed=13;
function rng(){ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; }
function scene(){
  const s=V4.defaultScene(); s.items=[];s.plots=[];s.agents=[];
  const count=1+Math.floor(rng()*9);
  for(let j=0;j<count;j++)s.items.push({
    id:'o'+j,position:V(Math.floor(rng()*16)-8,1,Math.floor(rng()*15)+1),
    half:V(.1+rng()*1.9,1,.1+rng()*1.3),
    rotation:{yaw:rng()*180,pitch:0,roll:0},solid:true
  });
  return s;
}
function independentCheck(s,route){
  const shapes=S.shapes(s);
  assert.ok(route.length>=2,'found path needs at least 2 points');
  for(let i=1;i<route.length;i++){
    const a=route[i-1],b=route[i],distance=B.dist(a,b);
    assert.ok(distance>1e-7,'duplicated waypoint');
    const steps=Math.max(1,Math.ceil(distance/density));
    for(let k=0;k<=steps;k++){
      const p=B.add(a,B.mul(B.sub(b,a),k/steps));
      for(const o of shapes)for(const y of [.35,.9,1.45]){
        const surface=S.distanceToBox(B.add(p,V(0,y,0)),o);
        assert.ok(surface>=radius-.005,
          'path crosses '+o.id+' segment '+i+' at '+JSON.stringify(p));
      }
    }
  }
}
(async()=>{
  let found=0,blocked=0,other=0;
  const start=Date.now();
  for(let i=0;i<180;i++){
    const s=scene(),target={x:rng()*20-10,z:rng()*19+1};
    const out=V4.planPath(s,target,{maxNodes:650});
    if(out.status==='found'){
      found++;independentCheck(s,out.path);
      assert.ok(Math.hypot(out.path.at(-1).x-target.x,out.path.at(-1).z-target.z)<.0002);
    }else if(out.status.endsWith('_blocked'))blocked++;
    else other++;
  }
  assert.ok(found>=100,'too many regression scenarios failed to find a path');
  const empty=V4.defaultScene();empty.items=[];empty.plots=[];empty.agents=[];
  const token={cancelled:false};let yielded=0;
  const cancelled=await V4.planPathAsync(empty,{x:30,z:0},{maxNodes:1000},()=>{
    yielded++;token.cancelled=true;
  },token);
  assert.ok(yielded>0,'async planner should yield before finishing');
  assert.equal(cancelled.status,'cancelled');
  console.log('Spatial randomized paths: '+found+' found / '+blocked+' blocked / '+other+
    ' other, all found segments independently verified; async cancel PASS ('+
    (Date.now()-start)+'ms)');
})().catch(e=>{console.error(e);process.exitCode=1});
