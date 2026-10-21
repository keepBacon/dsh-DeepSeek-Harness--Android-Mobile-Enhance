/* DSH Spatial Lab v1. Pure deterministic 3-D math; no network or DOM. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DshSpatial = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PI = Math.PI, rad = deg => deg * PI / 180;
  const V = (x, y, z) => ({x, y, z});
  const add = (a,b) => V(a.x+b.x,a.y+b.y,a.z+b.z);
  const sub = (a,b) => V(a.x-b.x,a.y-b.y,a.z-b.z);
  const mul = (a,t) => V(a.x*t,a.y*t,a.z*t);
  const dot = (a,b) => a.x*b.x+a.y*b.y+a.z*b.z;
  const length = a => Math.hypot(a.x,a.y,a.z);
  const dist = (a,b) => length(sub(a,b));
  const unit = a => { const l=length(a); if(!(l>1e-12)) throw Error('zero-length vector'); return mul(a,1/l); };
  const clamp = (v,a,b) => Math.min(b,Math.max(a,v));
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  function checkVec(p,label) {
    if (!p || !['x','y','z'].every(k=>finite(p[k])&&Math.abs(p[k])<1e6)) throw Error('invalid vector: '+label);
    return p;
  }
  function forward(yaw,pitch=0) {
    const y=rad(yaw),p=rad(pitch);
    return V(Math.sin(y)*Math.cos(p),Math.sin(p),Math.cos(y)*Math.cos(p));
  }
  function basis(yaw,pitch=0) {
    const f=forward(yaw,pitch),r=V(Math.cos(rad(yaw)),0,-Math.sin(rad(yaw)));
    const u=V(-Math.sin(rad(yaw))*Math.sin(rad(pitch)),Math.cos(rad(pitch)),-Math.cos(rad(yaw))*Math.sin(rad(pitch)));
    return {forward:f,right:r,up:u};
  }
  function rotateY(offset,yaw) {
    const y=rad(yaw),c=Math.cos(y),s=Math.sin(y);
    return V(offset.x*c+offset.z*s,offset.y,-offset.x*s+offset.z*c);
  }
  function projection(point,camera,width,height) {
    const b=basis(camera.yaw,camera.pitch),p=sub(point,camera.position),depth=dot(p,b.forward);
    if(depth<=0.01) return null;
    const fov=rad(camera.fov),scale=height/(2*Math.tan(fov/2));
    return {x:width/2+dot(p,b.right)*scale/depth,y:height/2-dot(p,b.up)*scale/depth,depth};
  }
  function rayForScreen(camera,x,y,width,height) {
    if(width<=0||height<=0)throw Error('invalid viewport');
    const b=basis(camera.yaw,camera.pitch),spread=Math.tan(rad(camera.fov)/2);
    return unit(add(b.forward,add(mul(b.right,(x/width*2-1)*(width/height)*spread),
      mul(b.up,(1-y/height*2)*spread))));
  }
  function sphereHit(origin,dir,center,radius) {
    const d=sub(origin,center),b=dot(d,dir),c=dot(d,d)-radius*radius,h=b*b-c;
    if(h<0)return null;
    const s=Math.sqrt(h),t=-b-s;
    return t>=0?t:(-b+s>=0?-b+s:null);
  }
  function aabbHit(origin,dir,center,half) {
    let low=-Infinity,high=Infinity;
    for(const k of ['x','y','z']) {
      const lo=center[k]-half[k],hi=center[k]+half[k];
      if(Math.abs(dir[k])<1e-12){if(origin[k]<lo||origin[k]>hi)return null;continue;}
      let a=(lo-origin[k])/dir[k],b=(hi-origin[k])/dir[k];
      if(a>b)[a,b]=[b,a];
      low=Math.max(low,a);high=Math.min(high,b);
      if(low>high)return null;
    }
    return high<0?null:Math.max(0,low);
  }
  const limbs=[
    {id:'head',local:V(0,1.66,0),radius:0.23,dyaw:0,dpitch:0},
    {id:'torso',local:V(0,1.12,0),radius:0.38,dyaw:0,dpitch:0},
    {id:'left_arm',local:V(-0.48,1.18,0),radius:0.19,dyaw:-12,dpitch:0},
    {id:'right_arm',local:V(0.48,1.18,0),radius:0.19,dyaw:12,dpitch:0},
    {id:'left_leg',local:V(-0.18,0.44,0),radius:0.2,dyaw:0,dpitch:0},
    {id:'right_leg',local:V(0.18,0.44,0),radius:0.2,dyaw:0,dpitch:0},
  ];
  function defaultScene() {
    return {
      schema:'dsh-spatial-v1',units:'meters',coordinateSystem:'right-handed: +X right/east, +Y up, +Z forward/north',
      player:{position:V(0,0,0),yaw:0,pitch:0,speed:3.5,parts:limbs.map(v=>({...v,local:{...v.local}}))},
      camera:{position:V(0,1.65,-3.5),yaw:0,pitch:-2,fov:70,follow:true,offset:V(0,1.65,-3.5)},
      reticle:{normalized:V(0,0,0)}, // normalized x/y in [-1,+1] relative to viewport center
      items:[{id:'crate',position:V(2,0.55,8),half:V(.55,.55,.55)},
        {id:'marker',position:V(-2,1,5),half:V(.25,1,.25)}],
      plots:[{id:'plot_a',center:V(0,-.05,9),half:V(2,.05,2)},
        {id:'plot_b',center:V(5,.5,6),half:V(1.8,.5,1.8)}],
    };
  }
  function validate(scene) {
    if(!scene||scene.schema!=='dsh-spatial-v1')throw Error('unsupported scene schema');
    if(!scene.player||!scene.camera||!scene.reticle)throw Error('missing actors');
    checkVec(scene.player.position,'player');checkVec(scene.camera.position,'camera');
    for(const [n,o] of [['player',scene.player],['camera',scene.camera]]) {
      if(!finite(o.yaw)||!finite(o.pitch)||Math.abs(o.pitch)>89.9||Math.abs(o.yaw)>1e7)throw Error('invalid orientation: '+n);
    }
    if(!(scene.camera.fov>10&&scene.camera.fov<160))throw Error('camera FOV must be 10..160');
    if(!finite(scene.player.speed)||scene.player.speed<0||scene.player.speed>100)throw Error('invalid speed');
    if(!scene.reticle.normalized||!finite(scene.reticle.normalized.x)||!finite(scene.reticle.normalized.y)||
      Math.abs(scene.reticle.normalized.x)>1||Math.abs(scene.reticle.normalized.y)>1)throw Error('invalid reticle');
    for(const [listName,max] of [['items',200],['plots',200]]) {
      if(!Array.isArray(scene[listName])||scene[listName].length>max)throw Error('invalid '+listName);
      for(const entry of scene[listName]) {
        if(typeof entry.id!=='string'||!entry.id||entry.id.length>80)throw Error('invalid object id');
        checkVec(entry.position||entry.center,listName+'.'+entry.id);
        checkVec(entry.half,listName+'.half');
        if(Object.values(entry.half).some(v=>v<=0||v>1e4))throw Error('invalid object size');
      }
    }
    if(!Array.isArray(scene.player.parts)||scene.player.parts.length>50)throw Error('invalid parts');
    for(const p of scene.player.parts) {
      if(typeof p.id!=='string'||p.id.length>80||!p.id||!finite(p.radius)||p.radius<=0||
        p.radius>10||!finite(p.dyaw)||!finite(p.dpitch))throw Error('invalid body part');
      checkVec(p.local,'body part '+p.id);
    }
    if(scene.camera.follow)checkVec(scene.camera.offset,'camera offset');
    return scene;
  }
  function worldParts(scene) {
    return scene.player.parts.map(p=>{
      const world=add(scene.player.position,rotateY(p.local,scene.player.yaw));
      const yaw=scene.player.yaw+p.dyaw, pitch=clamp(scene.player.pitch+p.dpitch,-89.9,89.9);
      return {id:p.id,local:p.local,world,yaw,pitch,forward:forward(yaw,pitch),radius:p.radius};
    });
  }
  function raycast(scene,origin,direction,limit=1000) {
    const dir=unit(direction);let best=null;
    const record=(kind,id,t)=>{
      if(t===null||t>limit||(!best||t<best.distance))best=t!==null&&t<=limit?
        {kind,id,distance:t,point:add(origin,mul(dir,t))}:best;
    };
    for(const p of worldParts(scene))record('body',p.id,sphereHit(origin,dir,p.world,p.radius));
    for(const obj of scene.items)record('item',obj.id,aabbHit(origin,dir,obj.position,obj.half));
    for(const obj of scene.plots)record('plot',obj.id,aabbHit(origin,dir,obj.center,obj.half));
    return best;
  }
  const round=n=>Math.round(n*10000)/10000;
  const clean=p=>V(round(p.x),round(p.y),round(p.z));
  function observe(scene) {
    validate(scene);
    const player=scene.player,camera=scene.camera;
    const b=basis(camera.yaw,camera.pitch),parts=worldParts(scene);
    const ret=scene.reticle.normalized;
    const dir=unit(add(b.forward,add(
      mul(b.right,ret.x*(16/9)*Math.tan(rad(camera.fov)/2)),
      mul(b.up,ret.y*Math.tan(rad(camera.fov)/2))
    )));
    const hit=raycast(scene,camera.position,dir,1000);
    const objects=[...scene.items.map(o=>({...o,kind:'item',center:o.position})),
      ...scene.plots.map(o=>({...o,kind:'plot'}))];
    return {
      schema:'dsh-spatial-observation-v1',units:'meters',
      axes:scene.coordinateSystem,angleConvention:'yaw 0=+Z, yaw +90=+X; pitch positive up; degrees',
      player:{position:clean(player.position),yaw:player.yaw,pitch:player.pitch,
        forward:clean(forward(player.yaw,player.pitch)),speed:player.speed},
      camera:{position:clean(camera.position),yaw:camera.yaw,pitch:camera.pitch,
        forward:clean(b.forward),right:clean(b.right),up:clean(b.up),fov:camera.fov},
      reticle:{normalized:{x:ret.x,y:ret.y},rayOrigin:clean(camera.position),rayDirection:clean(dir),
        worldHit:hit&&{kind:hit.kind,id:hit.id,position:clean(hit.point),distance:round(hit.distance)},
        worldPointAt10m:clean(add(camera.position,mul(dir,10)))},
      bodyParts:parts.map(p=>({id:p.id,local:clean(p.local),world:clean(p.world),
        yaw:p.yaw,pitch:p.pitch,forward:clean(p.forward)})),
      objects:objects.map(o=>({kind:o.kind,id:o.id,world:clean(o.center),
        halfExtents:clean(o.half),playerDistance:round(dist(player.position,o.center)),
        cameraDistance:round(dist(camera.position,o.center)),
        playerBearingDeg:round((Math.atan2(o.center.x-player.position.x,
          o.center.z-player.position.z)*180/PI+360)%360)})),
      playerToCameraDistance:round(dist(player.position,camera.position)),
    };
  }
  function move(scene, action) {
    validate(scene);
    if(!action||!finite(action.seconds)||action.seconds<0||action.seconds>10)throw Error('invalid timestep');
    for(const n of ['forward','strafe','vertical','yawDelta','pitchDelta']) {
      if(action[n]!==undefined&&!finite(action[n]))throw Error('invalid '+n);
    }
    const a=clamp(action.forward||0,-1,1),s=clamp(action.strafe||0,-1,1),
      v=clamp(action.vertical||0,-1,1);
    const y=scene.player.yaw;
    const desired=add(add(mul(forward(y,0),a),mul(V(Math.cos(rad(y)),0,-Math.sin(rad(y))),s)),V(0,v,0));
    const lengthMove=length(desired);
    const delta=mul(desired,lengthMove>1?1/lengthMove:1);
    scene.player.position=add(scene.player.position,mul(delta,scene.player.speed*action.seconds));
    scene.player.yaw=((scene.player.yaw+(action.yawDelta||0))%360+360)%360;
    scene.player.pitch=clamp(scene.player.pitch+(action.pitchDelta||0),-89.9,89.9);
    if(scene.camera.follow) {
      scene.camera.position=add(scene.player.position,rotateY(scene.camera.offset,scene.player.yaw));
      scene.camera.yaw=scene.player.yaw;
      scene.camera.pitch=scene.player.pitch;
    }
    return observe(scene);
  }
  return {V,add,sub,mul,dot,length,dist,unit,forward,basis,rotateY,projection,
    rayForScreen,sphereHit,aabbHit,defaultScene,validate,worldParts,raycast,observe,move};
});
