/* DSH Spatial Lab V2; pure deterministic geometry, no browser or I/O. */
(function (root, factory) {
  const api=factory(typeof module==='object'&&module.exports?require('./spatial-core.js'):root.DshSpatial);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DshSpatialV2=api;
})(typeof globalThis!=='undefined'?globalThis:this,function (base) {
  'use strict';
  if(!base)throw Error('Spatial Lab V1 core required');
  const PI=Math.PI, DEG=180/PI, rad=x=>x/DEG, V=base.V;
  const {add,sub,mul,dot,dist,length,unit,forward,basis,rotateY}=base;
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
  const round=x=>Math.round(x*10000)/10000;
  const vec=v=>V(round(v.x),round(v.y),round(v.z));
  const angle=x=>((x+180)%360+360)%360-180;
  const copy=x=>JSON.parse(JSON.stringify(x));
  const eq=(a,b)=>a.kind===b.kind&&a.id===b.id;
  const MAX_OBJECTS=128,MAX_PROBES=48;
  const sceneSchema='dsh-spatial-v2', observationSchema='dsh-spatial-observation-v2';
  function defaultScene(){
    const s=base.defaultScene();
    s.schema=sceneSchema;
    s.viewport={width:960,height:600};
    s.clock=0;
    s.camera.follow=true;
    s.camera.roll=0;
    for(const key of ['items','plots'])for(const obj of s[key])
      obj.rotation={yaw:0,pitch:0,roll:0};
    s.items[0].rotation.yaw=20;
    s.plots[1].rotation.yaw=15;
    return s;
  }
  function normalize(input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('scene must be object');
    const s=copy(input);
    if(s.schema!=='dsh-spatial-v1'&&s.schema!==sceneSchema)throw Error('unsupported scene schema');
    s.schema=sceneSchema;
    if(!s.viewport)s.viewport={width:960,height:600};
    if(s.clock===undefined)s.clock=0;
    if(s.camera&&s.camera.roll===undefined)s.camera.roll=0;
    for(const key of ['items','plots'])if(Array.isArray(s[key]))for(const o of s[key]){
      if(o.rotation===undefined)o.rotation={yaw:0,pitch:0,roll:0};
    }
    return validate(s);
  }
  function validVec(p,label,positive=false) {
    if(!p||typeof p!=='object'||!['x','y','z'].every(k=>finite(p[k])&&Math.abs(p[k])<=1e5))throw Error('invalid '+label);
    if(positive&&['x','y','z'].some(k=>p[k]<=0))throw Error('invalid positive '+label);
  }
  function validRot(r,label) {
    if(!r||!['yaw','pitch','roll'].every(k=>finite(r[k])&&Math.abs(r[k])<=1e6))throw Error('invalid '+label);
  }
  function validate(s){
    if(!s||s.schema!==sceneSchema)throw Error('invalid V2 schema');
    if(!s.viewport||!Number.isInteger(s.viewport.width)||!Number.isInteger(s.viewport.height)||
      s.viewport.width<240||s.viewport.height<180||s.viewport.width>4096||s.viewport.height>4096)throw Error('invalid viewport');
    if(!finite(s.clock)||s.clock<0||s.clock>1e9)throw Error('invalid clock');
    if(!s.player||!s.camera||!s.reticle)throw Error('missing actor');
    validVec(s.player.position,'player');validVec(s.camera.position,'camera');
    validVec(s.reticle.normalized,'reticle');
    if(Math.abs(s.reticle.normalized.x)>1||Math.abs(s.reticle.normalized.y)>1||
       Math.abs(s.reticle.normalized.z)>1e-8)throw Error('invalid reticle coordinates');
    for(const [tag,o] of [['player',s.player],['camera',s.camera]]){
      if(!finite(o.yaw)||Math.abs(o.yaw)>1e6||!finite(o.pitch)||Math.abs(o.pitch)>89.9)throw Error('invalid '+tag+' orientation');
    }
    if(!finite(s.camera.roll)||Math.abs(s.camera.roll)>360)throw Error('invalid camera roll');
    if(Math.abs(s.camera.roll)>1e-8)throw Error('camera roll projection is not supported in V2');
    if(!finite(s.camera.fov)||s.camera.fov<12||s.camera.fov>150)throw Error('invalid field of view');
    if(typeof s.camera.follow!=='boolean')throw Error('invalid camera follow flag');
    if(s.camera.follow)validVec(s.camera.offset,'camera offset');
    if(!finite(s.player.speed)||s.player.speed<0||s.player.speed>80)throw Error('invalid player speed');
    if(!Array.isArray(s.player.parts)||s.player.parts.length>32)throw Error('invalid body parts');
    const partIds=new Set();
    for(const p of s.player.parts){
      if(!p||typeof p.id!=='string'||!p.id||p.id.length>80||partIds.has(p.id))throw Error('invalid/duplicate body part id');
      partIds.add(p.id);
      validVec(p.local,'body part');
      if(!finite(p.radius)||p.radius<=0||p.radius>10||!finite(p.dyaw)||!finite(p.dpitch)||
        Math.abs(p.dyaw)>1e6||Math.abs(p.dpitch)>1e6)throw Error('invalid body part attitude');
    }
    const ids=new Set();
    for(const group of ['items','plots']){
      if(!Array.isArray(s[group])||s[group].length>MAX_OBJECTS)throw Error('invalid '+group+' count');
      for(const o of s[group]){
        if(!o||typeof o.id!=='string'||!o.id||o.id.length>80||ids.has(o.id))throw Error('invalid/duplicate object id');
        ids.add(o.id);
        validVec(o.position||o.center,'object position');
        validVec(o.half,'half extents',true);
        validRot(o.rotation,'object rotation');
      }
    }
    return s;
  }
  function rotationBasis(yaw=0,pitch=0,roll=0) {
    const b=basis(yaw,pitch),c=Math.cos(rad(roll)),s=Math.sin(rad(roll));
    // Roll rotates right/up about the forward axis, preserving orthonormality.
    return {forward:b.forward,right:add(mul(b.right,c),mul(b.up,s)),
      up:sub(mul(b.up,c),mul(b.right,s))};
  }
  function axisPoint(v,b){return add(add(mul(b.right,v.x),mul(b.up,v.y)),mul(b.forward,v.z));}
  function localPoint(v,b){return V(dot(v,b.right),dot(v,b.up),dot(v,b.forward));}
  function shapes(scene) {
    const result=[];
    for(const group of ['items','plots'])for(const o of scene[group]) {
      result.push({kind:group==='items'?'item':'plot',id:o.id,
        center:o.position||o.center,half:o.half,rotation:o.rotation,
        basis:rotationBasis(o.rotation.yaw,o.rotation.pitch,o.rotation.roll)});
    }
    return result;
  }
  function bodyShapes(scene){
    return base.worldParts(scene).map(p=>({kind:'body',id:p.id,center:p.world,
      radius:p.radius,yaw:p.yaw,pitch:p.pitch,forward:p.forward,local:p.local}));
  }
  function boxCorners(o){
    const out=[];
    for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
      out.push(add(o.center,axisPoint(V(x*o.half.x,y*o.half.y,z*o.half.z),o.basis)));
    }
    return out;
  }
  function boxContact(origin,dir,o){
    const localOrigin=localPoint(sub(origin,o.center),o.basis);
    const localDir=localPoint(dir,o.basis);
    const t=base.aabbHit(localOrigin,localDir,V(0,0,0),o.half);
    if(t===null)return null;
    const p=add(localOrigin,mul(localDir,t)),axis=['x','y','z'];
    let best=Infinity,k='z',sign=1;
    for(const c of axis){
      const score=Math.abs(Math.abs(p[c])-o.half[c]);
      if(score<best){best=score;k=c;sign=p[c]<0?-1:1;}
    }
    const n=V(0,0,0);n[k]=sign;
    return {distance:t,normal:unit(axisPoint(n,o.basis))};
  }
  function sphereContact(origin,dir,o){
    const t=base.sphereHit(origin,dir,o.center,o.radius);
    if(t===null)return null;
    const hit=add(origin,mul(dir,t));
    return {distance:t,normal:unit(sub(hit,o.center))};
  }
  function castPrepared(objects,bodies,origin,direction,opts={}){
    const dir=unit(direction),limit=opts.maxDistance===undefined?1000:opts.maxDistance;
    if(!finite(limit)||limit<0||limit>1e6)throw Error('invalid max distance');
    let best=null;
    const consider=(s)=>{
      if(opts.ignoreId&&opts.ignoreId===s.id)return;
      const hit=s.kind==='body'?sphereContact(origin,dir,s):boxContact(origin,dir,s);
      if(hit&&hit.distance<=limit&&(!best||hit.distance<best.distance-1e-9)){
        best={kind:s.kind,id:s.id,distance:round(hit.distance),point:vec(add(origin,mul(dir,hit.distance))),
          normal:vec(hit.normal)};
      }
    };
    if(!opts.excludeSelf)for(const p of bodies)consider(p);
    for(const o of objects)consider(o);
    return best;
  }
  function raycast(scene,origin,direction,opts={}) {
    const s=normalize(scene);validVec(origin,'ray origin');validVec(direction,'ray direction');
    return castPrepared(shapes(s),bodyShapes(s),origin,direction,opts);
  }
  function project(point,camera,viewport) {
    const screen=base.projection(point,camera,viewport.width,viewport.height);
    if(!screen)return null;
    const nx=2*screen.x/viewport.width-1,ny=1-2*screen.y/viewport.height;
    return {pixels:{x:round(screen.x),y:round(screen.y)},normalized:{x:round(nx),y:round(ny)},
      depth:round(screen.depth),inViewport:Math.abs(nx)<=1+1e-9&&Math.abs(ny)<=1+1e-9};
  }
  function rayForNormalized(camera,reticle,viewport) {
    return base.rayForScreen(camera,(reticle.x+1)*viewport.width/2,
      (1-reticle.y)*viewport.height/2,viewport.width,viewport.height);
  }
  function relative(player,target) {
    const delta=sub(target,player.position);
    const flat=Math.hypot(delta.x,delta.z),d=length(delta);
    const bearing=flat<1e-8?player.yaw:Math.atan2(delta.x,delta.z)*DEG;
    const relativeYaw=angle(bearing-player.yaw);
    const magnitude=Math.abs(relativeYaw);
    const sector=magnitude<22.5?'front':magnitude>157.5?'behind':
      magnitude<67.5?'front_':magnitude>112.5?'back_':'';
    const direction=(sector==='front'||sector==='behind')?sector:
      (sector||'')+(relativeYaw>0?'right':'left');
    return {worldDistance:round(d),horizontalDistance:round(flat),
      verticalDelta:round(delta.y),bearingDeg:round((bearing%360+360)%360),
      relativeYawDeg:round(relativeYaw),direction,
      elevationDeg:round(Math.atan2(delta.y,flat)*DEG)};
  }
  function distanceToBox(point,o) {
    const p=localPoint(sub(point,o.center),o.basis);
    return round(Math.hypot(...['x','y','z'].map(k=>Math.max(0,Math.abs(p[k])-o.half[k]))));
  }
  function playerOnPlot(player,o) {
    const local=localPoint(sub(player.position,o.center),o.basis);
    return Math.abs(local.x)<=o.half.x+1e-8&&Math.abs(local.z)<=o.half.z+1e-8&&
      Math.abs(local.y-o.half.y)<=0.35;
  }
  function observe(input) {
    const s=normalize(input),p=s.player,c=s.camera,b=rotationBasis(c.yaw,c.pitch,c.roll);
    const objects=shapes(s),bodies=bodyShapes(s);
    const ret=s.reticle.normalized,dir=rayForNormalized(c,ret,s.viewport);
    const hit=castPrepared(objects,bodies,c.position,dir,{excludeSelf:true});
    const candidates=objects.map(o=>({o,screen:project(o.center,c,s.viewport),
      distance:dist(o.center,c.position)}));
    const visible=candidates.filter(x=>x.screen&&x.screen.inViewport)
      .sort((a,b)=>a.distance-b.distance||a.o.id.localeCompare(b.o.id))
      .slice(0,MAX_PROBES);
    const tested=new Set(visible.map(x=>x.o.id));
    const rendered=candidates.map(({o,screen})=>{
      let visibility=!screen?'behind_camera':!screen.inViewport?'outside_view':
        !tested.has(o.id)?'not_tested':'visible';
      let blocker=null;
      if(visibility==='visible'){
        const nearest=castPrepared(objects,bodies,c.position,sub(o.center,c.position),
          {excludeSelf:true,maxDistance:dist(c.position,o.center)+1e-6});
        if(nearest&&!eq(nearest,o)){
          visibility='occluded';blocker={kind:nearest.kind,id:nearest.id};
        }
      }
      return {kind:o.kind,id:o.id,world:vec(o.center),rotation:o.rotation,
        halfExtents:vec(o.half),corners:boxCorners(o).map(vec),
        player:relative(p,o.center),distanceToSurface:distanceToBox(p.position,o),
        cameraDistance:round(dist(o.center,c.position)),screen,
        visibility,occludedBy:blocker,
        playerOnPlot:o.kind==='plot'?playerOnPlot(p,o):null};
    });
    const body=bodies.map(o=>({
      id:o.id,local:vec(o.local),world:vec(o.center),yaw:o.yaw,pitch:o.pitch,
      forward:vec(o.forward),radius:o.radius,screen:project(o.center,c,s.viewport),
      player:relative(p,o.center)
    }));
    const hitPoint=hit&&{...hit,screen:project(hit.point,c,s.viewport)};
    const right=vec(b.right),up=vec(b.up),fwd=vec(b.forward);
    return {schema:observationSchema,sourceSchema:input.schema,clock:round(s.clock),
      units:'meters',axes:'+X right; +Y up; +Z forward',
      angles:'yaw 0=+Z, +90=+X; pitch + up; degrees',
      viewport:s.viewport,
      limitations:['center-point visibility only','no physics collision response',
        'geometry simulation; not connected to a game engine'],
      player:{position:vec(p.position),yaw:p.yaw,pitch:p.pitch,
        forward:vec(forward(p.yaw,p.pitch)),speed:p.speed},
      camera:{position:vec(c.position),yaw:c.yaw,pitch:c.pitch,roll:c.roll,
        follow:c.follow,fov:c.fov,forward:fwd,right,up},
      reticle:{normalized:{x:ret.x,y:ret.y},
        pixels:{x:round((ret.x+1)*s.viewport.width/2),y:round((1-ret.y)*s.viewport.height/2)},
        rayOrigin:vec(c.position),rayDirection:vec(dir),worldHit:hitPoint,
        worldPointAt10m:vec(add(c.position,mul(dir,10)))},
      bodyParts:body,objects:rendered,
      metrics:{playerToCameraDistance:round(dist(p.position,c.position)),
        objectsVisible:rendered.filter(x=>x.visibility==='visible').length,
        objectsOccluded:rendered.filter(x=>x.visibility==='occluded').length,
        objectsUntested:rendered.filter(x=>x.visibility==='not_tested').length,
        maxOcclusionProbes:MAX_PROBES},
    };
  }
  function step(input,action){
    const s=normalize(input);
    if(!action||!finite(action.seconds)||action.seconds<0||action.seconds>5)throw Error('invalid timestep');
    for(const key of ['forward','strafe','vertical','yawDelta','pitchDelta',
      'cameraYawDelta','cameraPitchDelta','cameraForward','cameraStrafe','cameraVertical']){
      if(action[key]!==undefined&&!finite(action[key]))throw Error('invalid '+key);
    }
    for(const key of ['forward','strafe','vertical','cameraForward','cameraStrafe','cameraVertical']){
      if(Math.abs(action[key]||0)>1)throw Error('movement axis exceeds [-1,1]');
    }
    for(const key of ['yawDelta','pitchDelta','cameraYawDelta','cameraPitchDelta']){
      if(Math.abs(action[key]||0)>360)throw Error('rotation delta too large');
    }
    const start=copy(s.player.position),yaw=s.player.yaw;
    const b=basis(yaw,0),raw=add(add(mul(b.forward,action.forward||0),
      mul(b.right,action.strafe||0)),V(0,action.vertical||0,0));
    const delta=mul(raw,length(raw)>1?1/length(raw):1);
    s.player.position=add(s.player.position,mul(delta,s.player.speed*action.seconds));
    s.player.yaw=((s.player.yaw+(action.yawDelta||0))%360+360)%360;
    s.player.pitch=clamp(s.player.pitch+(action.pitchDelta||0),-89.9,89.9);
    if(s.camera.follow){
      s.camera.position=add(s.player.position,rotateY(s.camera.offset,s.player.yaw));
      s.camera.yaw=s.player.yaw;
      s.camera.pitch=s.player.pitch;
    }else{
      const cb=basis(s.camera.yaw,0);
      const cd=add(add(mul(cb.forward,action.cameraForward||0),
        mul(cb.right,action.cameraStrafe||0)),V(0,action.cameraVertical||0,0));
      const norm=length(cd)>1?mul(cd,1/length(cd)):cd;
      s.camera.position=add(s.camera.position,mul(norm,s.player.speed*action.seconds));
      s.camera.yaw=((s.camera.yaw+(action.cameraYawDelta||0))%360+360)%360;
      s.camera.pitch=clamp(s.camera.pitch+(action.cameraPitchDelta||0),-89.9,89.9);
    }
    s.clock+=action.seconds;
    const n=Math.min(16,Math.max(1,Math.ceil(dist(start,s.player.position)/0.75)));
    const path=Array.from({length:n+1},(_,i)=>vec(add(start,mul(sub(s.player.position,start),i/n))));
    const obstacles=shapes(s).filter(o=>o.kind==='item');
    const overlapWarnings=[];
    for(const o of obstacles){
      if(path.some(pt=>distanceToBox(pt,o)<0.25))overlapWarnings.push(o.id);
    }
    return {scene:s,observation:observe(s),
      motion:{seconds:action.seconds,start:vec(start),end:vec(s.player.position),
        displacement:vec(sub(s.player.position,start)),path,
        overlapWarnings,collisionResolved:false}};
  }
  function aimAt(input,kind,id){
    const s=normalize(input);
    let target=null;
    if(kind==='body')target=bodyShapes(s).find(p=>p.id===id);
    else target=shapes(s).find(o=>o.id===id&&o.kind===kind);
    if(!target)throw Error('unknown target');
    const d=sub(target.center,s.camera.position),flat=Math.hypot(d.x,d.z);
    if(length(d)<1e-9)throw Error('target at camera origin');
    s.camera.follow=false;
    s.camera.yaw=((Math.atan2(d.x,d.z)*DEG)%360+360)%360;
    s.camera.pitch=clamp(Math.atan2(d.y,flat)*DEG,-89.9,89.9);
    s.reticle.normalized={x:0,y:0,z:0};
    return s;
  }
  return {VERSION:2,defaultScene,normalize,validate,rotationBasis,axisPoint,localPoint,
    shapes,bodyShapes,boxCorners,boxContact,castPrepared,raycast,project,
    rayForNormalized,relative,distanceToBox,playerOnPlot,observe,step,aimAt};
});
