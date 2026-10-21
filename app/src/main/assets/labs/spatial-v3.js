/* DSH Spatial Lab V3: deterministic camera, visibility and collision simulation. */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports
    ?require('./spatial-core.js'):root.DshSpatial,
    typeof module==='object'&&module.exports?require('./spatial-v2.js'):root.DshSpatialV2);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DshSpatialV3=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(B,S){
  'use strict';
  if(!B||!S)throw Error('spatial V1/V2 required');
  const V=B.V,{add,sub,mul,dot,dist,length,unit,forward,basis,rotateY}=B;
  const DEG=180/Math.PI,rad=x=>x/DEG,finite=n=>typeof n==='number'&&Number.isFinite(n);
  const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
  const round=x=>Math.round(x*10000)/10000,vec=x=>V(round(x.x),round(x.y),round(x.z));
  const clone=x=>JSON.parse(JSON.stringify(x));
  const MAX_PROBES=24,MAX_SAMPLES=7,MAX_HISTORY=60;
  const CAPSULE_HEIGHTS=[.35,.9,1.45];
  function defaultScene(){
    const s=S.defaultScene();s.schema='dsh-spatial-v3';
    s.player.collision={enabled:true,radius:.28};
    s.items.forEach(o=>o.solid=true);
    s.plots.forEach(o=>o.solid=false);
    s.history=[];
    return s;
  }
  function normalize(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||
      !['dsh-spatial-v1','dsh-spatial-v2','dsh-spatial-v3'].includes(input.schema))
      throw Error('unsupported scene schema');
    const original=clone(input);
    const roll=original.camera?.roll??0;
    if(!finite(roll)||Math.abs(roll)>180)throw Error('invalid camera roll');
    original.schema=original.schema==='dsh-spatial-v3'?'dsh-spatial-v2':original.schema;
    if(original.camera)original.camera.roll=0; // V2 refuses roll; V3 handles projection.
    const s=S.normalize(original);s.schema='dsh-spatial-v3';
    s.camera.roll=roll;
    if(!s.player.collision)s.player.collision={enabled:true,radius:.28};
    for(const o of s.items)if(o.solid===undefined)o.solid=true;
    for(const o of s.plots)if(o.solid===undefined)o.solid=false;
    if(s.history===undefined)s.history=[];
    return validate(s);
  }
  function validate(s){
    if(!s||s.schema!=='dsh-spatial-v3')throw Error('invalid V3 schema');
    if(!finite(s.camera?.roll)||Math.abs(s.camera.roll)>180)throw Error('invalid camera roll');
    if(!s.player?.collision||typeof s.player.collision.enabled!=='boolean'||
      !finite(s.player.collision.radius)||s.player.collision.radius<.1||
      s.player.collision.radius>.8)throw Error('invalid capsule collider');
    for(const o of [...s.items,...s.plots])if(typeof o.solid!=='boolean')throw Error('invalid solid flag');
    if(!Array.isArray(s.history)||s.history.length>MAX_HISTORY)throw Error('invalid motion history');
    for(const t of s.history){
      if(!t||!finite(t.time)||t.time<0||t.time>s.clock+1e-6||
        !t.position||!['x','y','z'].every(k=>finite(t.position[k])&&Math.abs(t.position[k])<=1e5)||
        !Array.isArray(t.collisions)||t.collisions.length>16||
        t.collisions.some(x=>typeof x!=='string'||x.length>80))
        throw Error('invalid history entry');
    }
    // Reuse V2 validation for all geometry, with its documented roll restriction masked.
    const parent=clone(s);parent.schema='dsh-spatial-v2';parent.camera.roll=0;
    S.validate(parent);
    return s;
  }
  function cameraBasis(camera){return S.rotationBasis(camera.yaw,camera.pitch,camera.roll)}
  function project(p,camera,viewport){
    const b=cameraBasis(camera),d=sub(p,camera.position),depth=dot(d,b.forward);
    if(depth<=.01)return null;
    const scale=viewport.height/(2*Math.tan(rad(camera.fov)/2));
    const x=viewport.width/2+dot(d,b.right)*scale/depth;
    const y=viewport.height/2-dot(d,b.up)*scale/depth;
    const nx=2*x/viewport.width-1,ny=1-2*y/viewport.height;
    return {pixels:{x:round(x),y:round(y)},normalized:{x:round(nx),y:round(ny)},
      depth:round(depth),inViewport:Math.abs(nx)<=1&&Math.abs(ny)<=1};
  }
  function screenRay(camera,reticle,viewport){
    const b=cameraBasis(camera),factor=Math.tan(rad(camera.fov)/2),aspect=viewport.width/viewport.height;
    return unit(add(b.forward,add(mul(b.right,reticle.x*factor*aspect),
      mul(b.up,reticle.y*factor))));
  }
  function allShapes(scene){return S.shapes(scene)}
  function samples(o){
    const v=[o.center];
    for(const axis of ['x','y','z'])for(const sign of [-1,1]){
      const half=V(0,0,0);half[axis]=o.half[axis]*sign;
      v.push(add(o.center,S.axisPoint(half,o.basis)));
    }
    return v;
  }
  function trace(obstacles,origin,dir,maxDistance=1000){
    return S.castPrepared(obstacles,[],origin,dir,{excludeSelf:true,maxDistance});
  }
  function visibility(scene,objects){
    const camera=scene.camera;
    const evaluations=objects.map(o=>({
      o,views:samples(o).map(p=>({p,screen:project(p,camera,scene.viewport)})),
      distance:dist(o.center,camera.position),
    }));
    const candidates=evaluations.filter(x=>x.views.some(q=>q.screen?.inViewport))
      .sort((a,b)=>a.distance-b.distance||a.o.id.localeCompare(b.o.id));
    const probed=new Set(candidates.slice(0,MAX_PROBES).map(x=>x.o.id));
    return evaluations.map(({o,views})=>{
      const projected=views[0].screen,inside=views.filter(x=>x.screen?.inViewport);
      let state='outside_view',blockedBy=null,clear=0,covered=0;
      if(inside.length===0){
        state=views.every(x=>x.screen===null)?'behind_camera':'outside_view';
      }else if(!probed.has(o.id)){
        state='not_tested';
      }else {
        const causes=new Map();
        for(const view of inside.slice(0,MAX_SAMPLES)){
          const ray=sub(view.p,camera.position),len=length(ray);
          if(len<1e-8){clear++;continue}
          const hit=trace(objects,camera.position,ray,len+1e-5);
          if(!hit||hit.id===o.id){clear++;continue}
          covered++;causes.set(hit.id,(causes.get(hit.id)||0)+1);
        }
        state=clear&&covered?'partially_visible':clear?'visible':'occluded';
        if(covered)blockedBy=[...causes].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
      }
      return {kind:o.kind,id:o.id,world:vec(o.center),rotation:o.rotation,
        halfExtents:vec(o.half),corners:S.boxCorners(o).map(vec),
        screen:projected,visibility:state,occludedBy:blockedBy,
        sampleCount:inside.length?Math.min(MAX_SAMPLES,inside.length):0,
        visibleSamples:clear,blockedSamples:covered,
        player:S.relative(scene.player,o.center),
        cameraDistance:round(dist(o.center,camera.position)),
        distanceToSurface:S.distanceToBox(scene.player.position,o),
        playerOnPlot:o.kind==='plot'?S.playerOnPlot(scene.player,o):null,
        solid:o.kind==='item'?scene.items.find(x=>x.id===o.id)?.solid:
          scene.plots.find(x=>x.id===o.id)?.solid};
    });
  }
  function sweepAgainst(start,delta,o,radius){
    // Ray vs OBB enlarged by the player's capsule sphere: a conservative
    // continuous collision approximation, not an exact capsule/OBB solver.
    const dir=S.localPoint(delta,o.basis),origin=S.localPoint(sub(start,o.center),o.basis);
    const ext=V(o.half.x+radius,o.half.y+radius,o.half.z+radius);
    if(['x','y','z'].every(k=>Math.abs(origin[k])<ext[k]-1e-9))return null;
    let entry=0,exit=1,axis=null,sign=0;
    for(const k of ['x','y','z']){
      if(Math.abs(dir[k])<1e-12){
        if(origin[k]<-ext[k]||origin[k]>ext[k])return null;
        continue;
      }
      const near=((-ext[k])-origin[k])/dir[k],far=((ext[k])-origin[k])/dir[k];
      const nearT=Math.min(near,far),farT=Math.max(near,far);
      if(nearT>entry){entry=nearT;axis=k;sign=dir[k]>0?-1:1}
      exit=Math.min(exit,farT);
      if(entry>exit)return null;
    }
    if(axis===null||entry<0||entry>1)return null;
    const n=V(0,0,0);n[axis]=sign;
    return {fraction:entry,normal:unit(S.axisPoint(n,o.basis)),id:o.id,kind:o.kind};
  }
  function collide(scene,start,delta){
    const solids=allShapes(scene).filter(o=>
      (o.kind==='item'?scene.items:scene.plots).find(x=>x.id===o.id)?.solid);
    const radius=scene.player.collision.radius;
    let at=start,remaining=delta;const impacts=[],path=[vec(start)];
    if(!scene.player.collision.enabled||length(delta)<1e-10)
      return {end:add(start,delta),impacts,path:[vec(start),vec(add(start,delta))]};
    for(let iter=0;iter<4;iter++){
      if(length(remaining)<1e-8)break;
      let hit=null;
      for(const o of solids)for(const h of CAPSULE_HEIGHTS){
        const trial=sweepAgainst(add(at,V(0,h,0)),remaining,o,radius);
        if(trial&&(!hit||trial.fraction<hit.fraction))hit=trial;
      }
      if(!hit){at=add(at,remaining);path.push(vec(at));break}
      const skin=Math.min(.002/Math.max(length(remaining),1e-8),hit.fraction);
      const fraction=Math.max(0,hit.fraction-skin);
      at=add(at,mul(remaining,fraction));path.push(vec(at));
      impacts.push({kind:hit.kind,id:hit.id,at:vec(at),normal:vec(hit.normal)});
      remaining=mul(remaining,1-hit.fraction);
      const into=dot(remaining,hit.normal);
      if(into<0)remaining=sub(remaining,mul(hit.normal,into));
    }
    return {end:at,impacts,path};
  }
  function observe(input){
    const s=normalize(input),objects=allShapes(s),body=S.bodyShapes(s);
    const dir=screenRay(s.camera,s.reticle.normalized,s.viewport);
    const hit=trace(objects,s.camera.position,dir);
    const relations=visibility(s,objects);
    const axes=cameraBasis(s.camera),parts=body.map(p=>({
      id:p.id,local:vec(p.local),world:vec(p.center),
      yaw:p.yaw,pitch:p.pitch,forward:vec(p.forward),radius:p.radius,
      screen:project(p.center,s.camera,s.viewport)
    }));
    const last=s.history.length?s.history[s.history.length-1]:null;
    const counts={visible:0,partiallyVisible:0,occluded:0,notTested:0};
    for(const o of relations){
      if(o.visibility==='visible')counts.visible++;
      if(o.visibility==='partially_visible')counts.partiallyVisible++;
      if(o.visibility==='occluded')counts.occluded++;
      if(o.visibility==='not_tested')counts.notTested++;
    }
    return {schema:'dsh-spatial-observation-v3',
      sceneSchema:s.schema,units:'meters',clock:round(s.clock),
      coordinateSystem:'+X right, +Y up, +Z forward; yaw +90 toward +X',
      viewport:s.viewport, player:{position:vec(s.player.position),
        yaw:s.player.yaw,pitch:s.player.pitch,speed:s.player.speed,
        forward:vec(forward(s.player.yaw,s.player.pitch)),collision:s.player.collision},
      camera:{position:vec(s.camera.position),yaw:s.camera.yaw,
        pitch:s.camera.pitch,roll:s.camera.roll,fov:s.camera.fov,follow:s.camera.follow,
        forward:vec(axes.forward),right:vec(axes.right),up:vec(axes.up)},
      reticle:{normalized:{x:s.reticle.normalized.x,y:s.reticle.normalized.y},
        pixels:{x:round((s.reticle.normalized.x+1)*s.viewport.width/2),
          y:round((1-s.reticle.normalized.y)*s.viewport.height/2)},
        rayOrigin:vec(s.camera.position),rayDirection:vec(dir),
        worldHit:hit&&{...hit,screen:project(hit.point,s.camera,s.viewport)},
        worldPointAt10m:vec(add(s.camera.position,mul(dir,10)))},
      bodyParts:parts,objects:relations,
      motion:{last:last,history:s.history.slice(-MAX_HISTORY)},
      metrics:{...counts,occlusionProbes:Math.min(MAX_PROBES,
        relations.filter(x=>x.visibility!=='outside_view'&&x.visibility!=='behind_camera').length),
        sampleBudget:MAX_SAMPLES,historyLength:s.history.length},
      limitations:['visibility samples object center and six faces, not complete raster occlusion',
        'collision is a conservative swept-sphere capsule approximation',
        'no gravity, dynamic rigid bodies or game integration']};
  }
  function step(input,action){
    const s=normalize(input);
    if(!action||!finite(action.seconds)||action.seconds<0||action.seconds>5)throw Error('invalid timestep');
    const keys=['forward','strafe','vertical','yawDelta','pitchDelta','cameraYawDelta',
      'cameraPitchDelta','cameraRollDelta','cameraForward','cameraStrafe','cameraVertical'];
    for(const key of keys)if(action[key]!==undefined&&!finite(action[key]))throw Error('invalid '+key);
    for(const key of ['forward','strafe','vertical','cameraForward','cameraStrafe','cameraVertical'])
      if(Math.abs(action[key]||0)>1)throw Error('invalid motion axis');
    for(const key of ['yawDelta','pitchDelta','cameraYawDelta','cameraPitchDelta','cameraRollDelta'])
      if(Math.abs(action[key]||0)>180)throw Error('invalid angular step');
    const original=s.player.position,dir=basis(s.player.yaw,0);
    const desired=add(add(mul(dir.forward,action.forward||0),
      mul(dir.right,action.strafe||0)),V(0,action.vertical||0,0));
    const motion=mul(desired,length(desired)>1?1/length(desired):1);
    const resolved=collide(s,original,mul(motion,s.player.speed*action.seconds));
    s.player.position=resolved.end;
    s.player.yaw=((s.player.yaw+(action.yawDelta||0))%360+360)%360;
    s.player.pitch=clamp(s.player.pitch+(action.pitchDelta||0),-89.9,89.9);
    if(s.camera.follow){
      s.camera.position=add(s.player.position,rotateY(s.camera.offset,s.player.yaw));
      s.camera.yaw=s.player.yaw;s.camera.pitch=s.player.pitch;
    }else{
      const cam=basis(s.camera.yaw,0),d=add(add(mul(cam.forward,action.cameraForward||0),
        mul(cam.right,action.cameraStrafe||0)),V(0,action.cameraVertical||0,0));
      s.camera.position=add(s.camera.position,mul(d,length(d)>1?
        s.player.speed*action.seconds/length(d):s.player.speed*action.seconds));
      s.camera.yaw=((s.camera.yaw+(action.cameraYawDelta||0))%360+360)%360;
      s.camera.pitch=clamp(s.camera.pitch+(action.cameraPitchDelta||0),-89.9,89.9);
      s.camera.roll=clamp(s.camera.roll+(action.cameraRollDelta||0),-180,180);
    }
    s.clock+=action.seconds;
    const event={time:round(s.clock),position:vec(s.player.position),
      displacement:vec(sub(s.player.position,original)),collisions:resolved.impacts.map(x=>x.id)};
    s.history.push(event);if(s.history.length>MAX_HISTORY)s.history.splice(0,s.history.length-MAX_HISTORY);
    return {scene:s,observation:observe(s),motion:{...event,
      requestedDisplacement:vec(mul(motion,s.player.speed*action.seconds)),
      path:resolved.path,impacts:resolved.impacts,collisionResolved:resolved.impacts.length>0}};
  }
  function aimAt(input,kind,id){
    const s=normalize(input);
    const target=kind==='body'?S.bodyShapes(s).find(o=>o.id===id):
      allShapes(s).find(o=>o.kind===kind&&o.id===id);
    if(!target)throw Error('unknown target');
    const d=sub(target.center,s.camera.position),distance=length(d);
    if(distance<1e-8)throw Error('target at camera origin');
    // Keep roll and solve the reticle via a projection. If target sits behind,
    // turn yaw/pitch first, then center reticle.
    s.camera.follow=false;s.camera.roll=0;
    s.camera.yaw=((Math.atan2(d.x,d.z)*DEG)%360+360)%360;
    s.camera.pitch=clamp(Math.atan2(d.y,Math.hypot(d.x,d.z))*DEG,-89.9,89.9);
    s.reticle.normalized={x:0,y:0,z:0};return s;
  }
  return {VERSION:3,MAX_HISTORY,defaultScene,normalize,validate,cameraBasis,
    project,screenRay,visibility,sweepAgainst,collide,observe,step,aimAt};
});
