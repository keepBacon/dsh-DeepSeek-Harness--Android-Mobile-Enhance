/* DSH Spatial V4 — deterministic model-oriented kinematics, navigation, evidence. */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./spatial-core.js'):root.DshSpatial,
    typeof module==='object'&&module.exports?require('./spatial-v2.js'):root.DshSpatialV2,
    typeof module==='object'&&module.exports?require('./spatial-v3.js'):root.DshSpatialV3);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DshSpatialV4=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(B,S,T){
  'use strict';
  if(!B||!S||!T)throw Error('spatial V1, V2, V3 required');
  const {V,add,sub,mul,dist,length,unit,dot,basis}=B;
  const SCHEMA='dsh-spatial-v4',OBSSCHEMA='dsh-spatial-observation-v4';
  const MAX_AGENTS=32,MAX_REPLAY=64,MAX_NODES=5000;
  const valid=n=>typeof n==='number'&&Number.isFinite(n);
  const round=n=>Math.round(n*1e4)/1e4,vec=p=>V(round(p.x),round(p.y),round(p.z));
  const clone=x=>JSON.parse(JSON.stringify(x));
  function asV3(scene) {
    const adapted=clone(scene);
    adapted.schema='dsh-spatial-v3';
    delete adapted.agents;
    return adapted;
  }
  const within=(n,lo,hi)=>valid(n)&&n>=lo&&n<=hi;
  const planar=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  function defaultScene(){
    const scene=T.defaultScene();scene.schema=SCHEMA;
    scene.agents=[
      {id:'scout',role:'neutral',position:V(4,0,9),velocity:V(-.35,0,0),yaw:270,radius:.4},
      {id:'guide',role:'ally',position:V(-4,0,7),velocity:V(0,0,.25),yaw:0,radius:.35},
    ];
    return scene;
  }
  function normalize(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||
      !['dsh-spatial-v1','dsh-spatial-v2','dsh-spatial-v3',SCHEMA].includes(input.schema))
      throw Error('unsupported scene schema');
    const c=clone(input);c.schema=c.schema===SCHEMA?'dsh-spatial-v3':c.schema;
    const s=T.normalize(c);s.schema=SCHEMA;
    if(!Array.isArray(s.agents))s.agents=[];
    return validate(s);
  }
  function validate(s){
    if(!s||s.schema!==SCHEMA)throw Error('invalid V4 schema');
    if(!Array.isArray(s.agents)||s.agents.length>MAX_AGENTS)throw Error('invalid agent count');
    const existing=new Set([...s.items,...s.plots].map(x=>x.id));
    for(const agent of s.agents){
      if(!agent||typeof agent.id!=='string'||!agent.id||agent.id.length>64||existing.has(agent.id))
        throw Error('invalid or duplicate agent id');
      existing.add(agent.id);
      if(!['ally','neutral','opponent','target'].includes(agent.role))throw Error('invalid agent role');
      for(const field of ['position','velocity']){
        const p=agent[field];
        if(!p||!['x','y','z'].every(k=>within(p[k],-1e5,1e5)))
          throw Error('invalid agent '+field);
      }
      if(length(agent.velocity)>20)throw Error('agent exceeds maximum simulated speed');
      if(!within(agent.yaw,-1e6,1e6)||!within(agent.radius,.1,3))
        throw Error('invalid agent orientation or radius');
    }
    const v=clone(s);v.schema='dsh-spatial-v3';delete v.agents;T.validate(v);
    return s;
  }
  function traceAgent(scene,agent){
    const origin=scene.camera.position,ray=sub(agent.position,origin),max=length(ray);
    if(max<1e-8)return {visibility:'camera_overlaps_agent',occludedBy:null};
    const direction=unit(ray),obstacles=S.shapes(scene);
    const solidHit=S.castPrepared(obstacles,[],origin,direction,{excludeSelf:true,maxDistance:max+1e-6});
    let nearerAgent=null;
    for(const other of scene.agents){
      if(other.id===agent.id)continue;
      const hit=B.sphereHit(origin,direction,other.position,other.radius);
      if(hit!==null&&hit<max&&(!nearerAgent||hit<nearerAgent.distance))
        nearerAgent={id:other.id,distance:hit};
    }
    const blockers=[...(solidHit?[{kind:solidHit.kind,id:solidHit.id,distance:solidHit.distance}]:[]),
      ...(nearerAgent?[{kind:'agent',...nearerAgent}]:[])].filter(h=>h.distance<max-agent.radius-1e-4);
    blockers.sort((a,b)=>a.distance-b.distance||a.id.localeCompare(b.id));
    return {visibility:blockers.length?'occluded':'visible',
      occludedBy:blockers.length?{kind:blockers[0].kind,id:blockers[0].id}:null};
  }
  /** The nearest reticle intersection comes from *both* static OBB and
   *  moving agents; the player body's own spheres are intentionally ignored. */
  function raycastReticle(scene) {
    const origin=scene.camera.position,
      direction=T.screenRay(scene.camera,scene.reticle.normalized,scene.viewport);
    const solids=S.castPrepared(S.shapes(scene),[],origin,direction,
      {excludeSelf:true,maxDistance:1000});
    let nearest=solids&&{...solids,screen:T.project(solids.point,scene.camera,scene.viewport)};
    for(const a of scene.agents){
      const distance=B.sphereHit(origin,direction,a.position,a.radius);
      if(distance===null||distance>1000||nearest&&distance>=nearest.distance-1e-8)continue;
      const point=add(origin,mul(direction,distance)),normal=unit(sub(point,a.position));
      nearest={kind:'agent',id:a.id,distance:round(distance),
        point:vec(point),normal:vec(normal),
        screen:T.project(point,scene.camera,scene.viewport)};
    }
    return nearest;
  }
  function observe(input){
    const s=normalize(input),base=T.observe(asV3(s));
    base.reticle.worldHit=raycastReticle(s);
    const player=s.player,b=basis(player.yaw,0);
    const agents=s.agents.map(a=>{
      const screen=T.project(a.position,s.camera,s.viewport);
      const relative=S.relative(player,a.position);
      const inView=!!screen?.inViewport;
      const los=inView?traceAgent(s,a):{visibility:screen?'outside_view':'behind_camera',occludedBy:null};
      const delta=sub(a.position,player.position);
      return {id:a.id,role:a.role,position:vec(a.position),
        velocity:vec(a.velocity),speed:round(length(a.velocity)),yaw:a.yaw,radius:a.radius,
        predictedAt1s:vec(add(a.position,a.velocity)),
        relative:{...relative,playerFrame:{
          right:round(dot(delta,b.right)),up:round(delta.y),forward:round(dot(delta,b.forward))}},
        screen,visibility:los.visibility,occludedBy:los.occludedBy};
    });
    const relations=agents.map(x=>({
      subject:'player',predicate:'relative_to',object:x.id,
      distance:x.relative.worldDistance,direction:x.relative.direction,
      lineOfSight:x.visibility==='visible',
      evidence:x.occludedBy?'blocked_by:'+x.occludedBy.id:
        x.visibility,
    }));
    return {...base,schema:OBSSCHEMA,sceneSchema:SCHEMA,agents,relations,
      navigationAssumptions:{
        algorithm:'bounded grid A* with corner blocking, static solid geometry and agent circles',
        geometry:'2D XZ; sampled capsule clearance at current player height',
        dynamicPrediction:'constant velocity for next second only; no physical forces or NPC AI',
      },
      metrics:{...base.metrics,agents:agents.length,
        agentVisible:agents.filter(x=>x.visibility==='visible').length}};
  }
  /** Reuse prepared solid shapes and the same capsule clearance assumptions
   *  for points, grid edges, smoothing and final path verification. */
  function navigationGeometry(scene) {
    const solids=S.shapes(scene).filter(o=>
      (o.kind==='item'?scene.items:scene.plots).some(x=>x.id===o.id&&x.solid));
    const agents=scene.agents;
    const radius=scene.player.collision.radius+.015;
    const combined=solids.map(o=>({...o,broad:Math.hypot(o.half.x,o.half.y,o.half.z)+radius+.015}));
    return {solids:combined,agents,radius};
  }
  function nearSegmentXZ(p,a,b) {
    const dx=b.x-a.x,dz=b.z-a.z,m=dx*dx+dz*dz;
    const t=m<1e-16?0:Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/m));
    return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz);
  }
  function navigationPointBlocked(scene,geometry,p) {
    const {solids,agents,radius}=geometry;
    for(const a of agents)if(planar(p,a.position)<radius+a.radius+.015)return true;
    for(const o of solids){
      if(planar(p,o.center)>o.broad)continue;
      for(const y of [.35,.9,1.45])
        if(S.distanceToBox(V(p.x,p.y+y,p.z),o)<radius)return true;
    }
    return false;
  }
  function navigationEdgeClear(scene,geometry,a,b) {
    if(navigationPointBlocked(scene,geometry,b))return false;
    const lengthXZ=planar(a,b);
    if(lengthXZ<1e-10)return true;
    const delta=sub(b,a),radius=geometry.radius;
    for(const actor of geometry.agents)
      if(nearSegmentXZ(actor.position,a,b)<radius+actor.radius+.015)return false;
    for(const o of geometry.solids) {
      if(nearSegmentXZ(o.center,a,b)>o.broad)continue;
      for(const y of [.35,.9,1.45]){
        if(T.sweepAgainst(add(a,V(0,y,0)),delta,o,radius))return false;
      }
      // Sweep is conservative, and does not handle initial overlap. Sample
      // even short edges so no unchecked interval reaches the returned path.
      const samples=Math.max(1,Math.ceil(lengthXZ/.15));
      for(let i=1;i<samples;i++)if(navigationPointBlocked(scene,geometry,
        V(a.x+(b.x-a.x)*i/samples,a.y,a.z+(b.z-a.z)*i/samples)))return false;
    }
    return true;
  }
  function blockedAt(scene,obstacles,p,skipAgent=null) {
    const solids=obstacles.filter(o=>(o.kind==='item'?scene.items:scene.plots)
      .some(x=>x.id===o.id&&x.solid));
    const geometry={solids:solids.map(o=>({...o,broad:Math.hypot(o.half.x,o.half.y,o.half.z)+scene.player.collision.radius+.03})),
      agents:scene.agents.filter(x=>x.id!==skipAgent),radius:scene.player.collision.radius+.015};
    return navigationPointBlocked(scene,geometry,p);
  }
  class MinHeap{
    constructor(){this.list=[]}
    push(v){const a=this.list;let i=a.length;a.push(v);while(i){const p=(i-1)>>1;if(a[p].score<=v.score)break;a[i]=a[p];i=p}a[i]=v}
    pop(){const a=this.list,first=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&a[c+1].score<a[c].score)c++;if(a[c].score>=last.score)break;a[i]=a[c];i=c}a[i]=last}return first}
    get size(){return this.list.length}
  }
  function* planPathWork(input,target,options={}){
    const s=normalize(input);
    if(!target||!within(target.x,-1e5,1e5)||!within(target.z,-1e5,1e5))
      throw Error('invalid navigation target');
    const cell=options.cell===undefined?1:options.cell,maxNodes=options.maxNodes===undefined?2400:options.maxNodes;
    if(!within(cell,.4,2)||!Number.isInteger(maxNodes)||maxNodes<100||maxNodes>MAX_NODES)
      throw Error('invalid navigation budget');
    const from=s.player.position,to=V(target.x,from.y,target.z),distance=planar(from,to);
    const status=(name,expanded=0,path=[])=>({status:name,path,expanded,cell,maxNodes});
    if(distance>48)return status('target_too_far');
    const geometry=navigationGeometry(s);
    if(navigationPointBlocked(s,geometry,from))return status('start_blocked');
    if(navigationPointBlocked(s,geometry,to))return status('target_blocked');
    if(distance<.05)return status('already_there',0,[vec(from)]);
    const gx=Math.round((to.x-from.x)/cell),gz=Math.round((to.z-from.z)/cell);
    const limit=Math.ceil(52/cell),limitCells=limit*limit;
    if(Math.abs(gx)>limit||Math.abs(gz)>limit||limitCells>20000)
      return status('navigation_area_too_large');
    const key=(x,z)=>x+','+z,loc=(x,z)=>V(from.x+x*cell,from.y,from.z+z*cell);
    const h=(x,z)=>{const dx=Math.abs(x-gx),dz=Math.abs(z-gz);
      return (Math.max(dx,dz)+(Math.SQRT2-1)*Math.min(dx,dz))*cell};
    const blocks=new Map(),edges=new Map();
    function blocked(x,z){
      const id=key(x,z);if(blocks.has(id))return blocks.get(id);
      const state=Math.abs(x)>limit||Math.abs(z)>limit||navigationPointBlocked(s,geometry,loc(x,z));
      blocks.set(id,state);return state;
    }
    function edgeClear(x,z,nx,nz) {
      const id=key(x,z)+'|'+key(nx,nz);
      if(edges.has(id))return edges.get(id);
      const ok=navigationEdgeClear(s,geometry,loc(x,z),loc(nx,nz));
      edges.set(id,ok);return ok;
    }
    if(blocked(gx,gz))return status('goal_cell_blocked');
    const open=new MinHeap(),gScore=new Map([['0,0',0]]),parent=new Map(),closed=new Set();
    open.push({x:0,z:0,g:0,score:h(0,0)});
    let expanded=0,reached=false;
    const dirs=[[-1,0],[0,-1],[0,1],[1,0],[-1,-1],[-1,1],[1,-1],[1,1]];
    while(open.size&&expanded<maxNodes){
      const p=open.pop(),id=key(p.x,p.z);
      if(closed.has(id)||p.g>gScore.get(id)+1e-8)continue;
      if(p.x===gx&&p.z===gz){reached=true;break}
      closed.add(id);expanded++;
      if(expanded%24===0)yield {stage:'search',expanded,maxNodes};
      for(const [dx,dz] of dirs){
        const nx=p.x+dx,nz=p.z+dz,k=key(nx,nz);
        if(closed.has(k)||blocked(nx,nz))continue;
        if(dx&&dz&&(blocked(p.x+dx,p.z)||blocked(p.x,p.z+dz)))continue;
        if(!edgeClear(p.x,p.z,nx,nz))continue;
        const next=p.g+cell*(dx&&dz?Math.SQRT2:1);
        if(next<(gScore.get(k)??Infinity)-1e-8){
          parent.set(k,id);gScore.set(k,next);
          open.push({x:nx,z:nz,g:next,score:next+h(nx,nz)});
        }
      }
    }
    if(!reached)return status(open.size?'budget_exhausted':'no_path',expanded);
    let cursor=key(gx,gz),keys=[cursor],guard=0;
    while(cursor!=='0,0'&&guard++<maxNodes+1){
      cursor=parent.get(cursor);if(!cursor)throw Error('navigation parent chain broken');keys.push(cursor);
    }
    keys.reverse();
    const raw=keys.map(k=>{const [x,z]=k.split(',').map(Number);return loc(x,z)});
    const path=[raw[0]];let i=0;
    while(i<raw.length-1){
      let j=raw.length-1;
      for(;j>i;j--){
        if(j%16===0)yield {stage:'smoothing',expanded,maxNodes};
        if(navigationEdgeClear(s,geometry,raw[i],raw[j]))break;
      }
      if(j<=i)return status('path_validation_failed',expanded);
      i=j;path.push(raw[j]);
    }
    if(!navigationEdgeClear(s,geometry,path[path.length-1],to))
      return status('target_connection_blocked',expanded);
    if(planar(path[path.length-1],to)>1e-7)path.push(to);
    // No success status without validating every final segment.
    for(let j=1;j<path.length;j++){
      if(j%16===0)yield {stage:'verifying',expanded,maxNodes};
      if(!navigationEdgeClear(s,geometry,path[j-1],path[j]))
        return status('path_validation_failed',expanded);
    }
    return {status:'found',path:path.map(vec),expanded,cell,maxNodes,
      length:round(path.slice(1).reduce((sum,p,j)=>sum+planar(p,path[j]),0)),
      target:vec(to)};
  }
  function planPath(input,target,options={}){
    const iterator=planPathWork(input,target,options);
    let value=iterator.next();
    while(!value.done)value=iterator.next();
    return value.value;
  }
  /** Cooperative UI scheduling: bounded work chunks, progress and cancellation.
   * The same generator supplies both synchronous tests and asynchronous UI. */
  async function planPathAsync(input,target,options={},onProgress=null,token=null){
    if(token?.cancelled)return {status:'cancelled',path:[],expanded:0};
    const iterator=planPathWork(input,target,options);
    let value=iterator.next();
    while(!value.done){
      if(token?.cancelled)return {status:'cancelled',path:[],expanded:value.value.expanded,
        cell:options.cell??1,maxNodes:options.maxNodes??2400};
      if(onProgress)onProgress(value.value);
      await new Promise(resolve=>setTimeout(resolve,0));
      value=iterator.next();
    }
    if(token?.cancelled)return {status:'cancelled',path:[],expanded:0};
    return value.value;
  }
  function deltaReport(previous,next,motion=null){
    const before=normalize(previous),after=normalize(next),events=[];
    const emit=(kind,data)=>events.push({kind,...data});
    const moved=(kind,id,from,to)=>{
      const d=dist(from,to);
      if(d>1e-4)emit(kind,{id,distance:round(d),from:vec(from),to:vec(to)});
    };
    const rotationChange=(kind,id,x,y,keys)=>{
      const values={};
      for(const k of keys){
        const old=x[k],current=y[k];
        const difference=((current-old+180)%360+360)%360-180;
        if(Math.abs(difference)>1e-4)values[k]={before:round(old),after:round(current),
          deltaDeg:round(difference)};
      }
      if(Object.keys(values).length)emit(kind,{id,angles:values});
    };
    const changed=(kind,id,k,x,y)=>{
      if(x!==y)emit(kind,{id,field:k,before:x,after:y});
    };
    moved('player_moved','player',before.player.position,after.player.position);
    moved('camera_moved','camera',before.camera.position,after.camera.position);
    rotationChange('player_rotated','player',before.player,after.player,['yaw','pitch']);
    rotationChange('camera_rotated','camera',before.camera,after.camera,['yaw','pitch','roll']);
    changed('camera_setting_changed','camera','fov',before.camera.fov,after.camera.fov);
    changed('camera_setting_changed','camera','follow',before.camera.follow,after.camera.follow);
    if(Math.abs(before.reticle.normalized.x-after.reticle.normalized.x)>1e-5||
      Math.abs(before.reticle.normalized.y-after.reticle.normalized.y)>1e-5)
      emit('reticle_moved',{id:'reticle',before:{x:before.reticle.normalized.x,
        y:before.reticle.normalized.y},after:{x:after.reticle.normalized.x,
        y:after.reticle.normalized.y}});
    const beforeAgents=new Map(before.agents.map(a=>[a.id,a]));
    for(const a of after.agents){
      const prior=beforeAgents.get(a.id);
      if(!prior){emit('agent_appeared',{id:a.id,position:vec(a.position)});continue}
      moved('agent_moved',a.id,prior.position,a.position);
      moved('agent_velocity_changed',a.id,prior.velocity,a.velocity);
      rotationChange('agent_rotated',a.id,prior,a,['yaw']);
      changed('agent_changed',a.id,'role',prior.role,a.role);
      changed('agent_changed',a.id,'radius',prior.radius,a.radius);
    }
    const afterAgentIds=new Set(after.agents.map(a=>a.id));
    for(const a of before.agents)
      if(!afterAgentIds.has(a.id))emit('agent_disappeared',{id:a.id});
    const oldObjects=new Map([...before.items,...before.plots].map(o=>[o.id,o]));
    const nextObjects=[...after.items,...after.plots];
    for(const obj of nextObjects){
      const prior=oldObjects.get(obj.id);
      if(!prior){emit('object_appeared',{id:obj.id,position:vec(obj.position||obj.center)});continue}
      moved('object_moved',obj.id,prior.position||prior.center,obj.position||obj.center);
      rotationChange('object_rotated',obj.id,prior.rotation,obj.rotation,['yaw','pitch','roll']);
      moved('object_resized',obj.id,prior.half,obj.half);
      changed('object_changed',obj.id,'solid',prior.solid,obj.solid);
    }
    const newIds=new Set(nextObjects.map(x=>x.id));
    for(const obj of [...before.items,...before.plots])
      if(!newIds.has(obj.id))emit('object_disappeared',{id:obj.id});
    if(motion?.impacts)for(const hit of motion.impacts)
      emit('collision',{id:hit.id,normal:hit.normal,at:hit.at});
    if(motion?.agentImpacts)for(const impact of motion.agentImpacts){
      const {kind:obstacleKind,...detail}=impact;
      emit('agent_collision',{...detail,obstacleKind});
    }
    const beforeHit=raycastReticle(before),afterHit=raycastReticle(after);
    if((beforeHit?.kind||null)!==(afterHit?.kind||null)||
      (beforeHit?.id||null)!==(afterHit?.id||null))
      emit('aim_target_changed',{before:beforeHit&&{kind:beforeHit.kind,id:beforeHit.id},
        after:afterHit&&{kind:afterHit.kind,id:afterHit.id}});
    return {schema:'dsh-spatial-delta-v4',fromTime:round(before.clock),
      toTime:round(after.clock),events:events.slice(0,96),eventCount:events.length,
      truncated:events.length>96};
  }
  /**
   * Each moving actor is a sphere swept continuously against solid OBBs.
   * Agent-vs-agent collision and initial interpenetration are deliberately
   * not silently 'solved' by this static-world approximation.
   */
  function moveAgent(agent,seconds,solids) {
    let pos=agent.position,remaining=mul(agent.velocity,seconds),
      velocity=agent.velocity;
    const impacts=[];
    if(seconds<=0||length(remaining)<1e-9)return {position:pos,velocity,impacts};
    for(let iteration=0;iteration<4;iteration++){
      if(length(remaining)<1e-9)break;
      let earliest=null;
      for(const obstacle of solids){
        if(S.distanceToBox(pos,obstacle)<agent.radius-1e-6){
          impacts.push({actor:agent.id,id:obstacle.id,kind:obstacle.kind,
            status:'initial_overlap_unresolved',at:vec(pos)});
          return {position:pos,velocity:V(0,0,0),impacts};
        }
        const hit=T.sweepAgainst(pos,remaining,obstacle,agent.radius);
        if(hit&&(!earliest||hit.fraction<earliest.fraction))earliest=hit;
      }
      if(!earliest){pos=add(pos,remaining);break}
      const skin=Math.min(.002/Math.max(length(remaining),1e-8),earliest.fraction);
      pos=add(pos,mul(remaining,Math.max(0,earliest.fraction-skin)));
      impacts.push({actor:agent.id,id:earliest.id,kind:earliest.kind,
        status:'static_collision',normal:vec(earliest.normal),at:vec(pos)});
      remaining=mul(remaining,1-earliest.fraction);
      const normalVelocity=dot(remaining,earliest.normal);
      if(normalVelocity<0)remaining=sub(remaining,mul(earliest.normal,normalVelocity));
      const into=dot(velocity,earliest.normal);
      if(into<0)velocity=sub(velocity,mul(earliest.normal,into));
    }
    return {position:pos,velocity,impacts};
  }
  // Sweep the player's sampled capsule against dynamic-agent spheres before
  // delegating to V3's static-world solver. This is a conservative 3D
  // approximation: agent positions are frozen during the current player step.
  function playerAgentContact(scene,start,delta) {
    if (!scene.player.collision.enabled || length(delta)<1e-9) return null;
    let nearest=null;
    for(const agent of scene.agents)for(const height of [.35,.9,1.45]){
      const center=add(start,V(0,height,0)),relative=sub(center,agent.position);
      const effective=scene.player.collision.radius+agent.radius;
      const a=dot(delta,delta),b=dot(relative,delta);
      const c=dot(relative,relative)-effective*effective;
      if(c<=0)continue; // Existing interpenetration remains an explicit limitation.
      const d=b*b-a*c;
      if(d<0)continue;
      const t=(-b-Math.sqrt(d))/a;
      if(t<0||t>1||nearest&&t>=nearest.fraction)continue;
      const normal=unit(add(relative,mul(delta,t)));
      nearest={fraction:t,normal,id:agent.id,kind:'agent'};
    }
    return nearest;
  }
  function sceneHasPlayerMotion(action) {
    return action&&Number.isFinite(action.seconds)&&action.seconds>0&&
      ['forward','strafe','vertical'].some(k=>!!action[k]);
  }
  /** Earliest continuous collision fraction for two moving spheres.
   * Conservative capsules are represented by three spheres for the player.
   * Initial penetration is reported, not silently treated as solved. */
  function sphereMotionContact(a,da,ar,b,db,br) {
    const origin=sub(a,b),relative=sub(da,db),r=ar+br,c=dot(origin,origin)-r*r;
    const speed=dot(relative,relative);
    if(c < -1e-8)return {fraction:0,initialOverlap:true,normal:V(0,0,0)};
    if(speed<1e-12)return null;
    const halfB=dot(origin,relative);
    if(c<=1e-8&&halfB>=0)return null;
    const d=halfB*halfB-speed*c;
    if(d<0)return null;
    const fraction=(-halfB-Math.sqrt(Math.max(0,d)))/speed;
    if(fraction < -1e-8||fraction>1+1e-8)return null;
    const t=Math.max(0,Math.min(1,fraction));
    const hitNormal=sub(add(a,mul(da,t)),add(b,mul(db,t)));
    return {fraction:t,initialOverlap:false,
      normal:length(hitNormal)>1e-9?unit(hitNormal):V(0,0,0)};
  }
  function resolveAgentInteractions(scene,next,provisional,impacts) {
    const initial=scene.agents,positions=provisional.map(x=>x.position);
    const deltas=positions.map((p,i)=>sub(p,initial[i].position));
    const playerBefore=scene.player.position,
      playerDelta=sub(next.player.position,playerBefore);
    const limit=Array(initial.length).fill(1);
    const contacts=[],seen=new Set();
    // Recompute after shortening a trajectory; limits monotonically decrease.
    for(let pass=0;pass<6;pass++){
      let changed=false;
      for(let i=0;i<initial.length;i++){
        for(let h of [.35,.9,1.45]){
          const contact=sphereMotionContact(initial[i].position,mul(deltas[i],limit[i]),
            initial[i].radius,add(playerBefore,V(0,h,0)),playerDelta,
            scene.player.collision.enabled?scene.player.collision.radius:0);
          // When collision is disabled, agents should not collide with player.
          if(!scene.player.collision.enabled||!contact)continue;
          const key='player|'+initial[i].id;
          if(!seen.has(key)){seen.add(key);contacts.push({actor:initial[i].id,
            id:'player',kind:'player',status:contact.initialOverlap?
              'initial_overlap_unresolved':'moving_sphere_contact'})}
          if(contact.fraction<1-1e-8){
            const cap=Math.max(0,limit[i]*contact.fraction-.0002);
            if(cap<limit[i]-1e-8){limit[i]=cap;changed=true}
          }
        }
      }
      for(let i=0;i<initial.length;i++)for(let j=i+1;j<initial.length;j++){
        const contact=sphereMotionContact(initial[i].position,mul(deltas[i],limit[i]),
          initial[i].radius,initial[j].position,mul(deltas[j],limit[j]),
          initial[j].radius);
        if(!contact)continue;
        const key=initial[i].id+'|'+initial[j].id;
        if(!seen.has(key)){seen.add(key);contacts.push({actor:initial[i].id,
          id:initial[j].id,kind:'agent',status:contact.initialOverlap?
            'initial_overlap_unresolved':'moving_sphere_contact'})}
        if(contact.fraction<1-1e-8){
          const cap=Math.max(0,contact.fraction-.0002);
          for(const index of [i,j]) {
            const shortened=limit[index]*cap;
            if(shortened<limit[index]-1e-8){limit[index]=shortened;changed=true}
          }
        }
      }
      if(!changed)break;
    }
    const output=provisional.map((p,i)=>({
      position:add(initial[i].position,mul(deltas[i],limit[i])),
      velocity:limit[i]<1-1e-8?V(0,0,0):p.velocity,
    }));
    impacts.push(...contacts.map(x=>({...x,
      at:vec(output[initial.findIndex(a=>a.id===x.actor)].position)})));
    return output;
  }
  function step(input,action){
    const s=normalize(input),base=asV3(s);
    // Player movement must honor the dynamic entities also used by A*.
    // V3 continues to resolve static OBB collisions; here we conservatively
    // shorten the requested movement at the earliest agent-sphere contact.
    let playerAgentImpact=null;
    let appliedAction=action;
    if(sceneHasPlayerMotion(action) && s.player.collision.enabled && s.agents.length){
      const direction=basis(s.player.yaw,0),raw=add(
        add(mul(direction.forward,action.forward||0),mul(direction.right,action.strafe||0)),
        V(0,action.vertical||0,0));
      const delta=mul(raw,length(raw)>1?1/length(raw):1);
      const intended=mul(delta,s.player.speed*action.seconds);
      const contact=playerAgentContact(s,s.player.position,intended);
      if(contact){
        const scale=Math.max(0,contact.fraction-Math.min(.002/Math.max(length(intended),1e-8),contact.fraction));
        appliedAction={...action,forward:(action.forward||0)*scale,
          strafe:(action.strafe||0)*scale,vertical:(action.vertical||0)*scale};
        playerAgentImpact={kind:'agent',id:contact.id,normal:vec(contact.normal),
          at:vec(add(s.player.position,mul(intended,scale)))};
      }
    }
    const result=T.step(base,appliedAction);
    const next=result.scene;next.schema=SCHEMA;
    if(playerAgentImpact){
      result.motion.impacts.push(playerAgentImpact);
      result.motion.collisionResolved=true;
      result.motion.collisions.push(playerAgentImpact.id);
    }
    const solidShapes=S.shapes(s).filter(o=>(o.kind==='item'?s.items:s.plots)
      .some(source=>source.id===o.id&&source.solid));
    const agentImpacts=[];
    const provisional=s.agents.map(a=>moveAgent(a,action.seconds,solidShapes));
    for(const r of provisional)agentImpacts.push(...r.impacts);
    // Moving-agent interaction is approximated with simultaneous relative
    // sweep and conservative stop. This is not a rigid-body physics solver.
    const dynamic=resolveAgentInteractions(s,next,provisional,agentImpacts);
    next.agents=s.agents.map((a,i)=>{
      const resolved=dynamic[i];
      if(['x','y','z'].some(k=>Math.abs(resolved.position[k])>1e5))
        throw Error('agent left supported world bounds');
      return {...a,position:resolved.position,velocity:resolved.velocity};
    });
    validate(next);
    const motion={...result.motion,agentImpacts,
      agentCollisionModel:'static OBB sweep + pairwise moving-sphere sweep; initial overlaps reported; no full rigid-body dynamics'};
    const delta=deltaReport(s,next,motion);
    return {scene:next,observation:observe(next),motion,delta};
  }
  function replay(input,actions){
    let s=normalize(input);
    if(!Array.isArray(actions)||actions.length>MAX_REPLAY)throw Error('too many replay actions');
    const frames=[];
    for(let i=0;i<actions.length;i++){
      const out=step(s,actions[i]);s=out.scene;
      frames.push({index:i+1,time:round(s.clock),action:clone(actions[i]),
        player:out.observation.player.position,agents:out.observation.agents.map(a=>({
          id:a.id,position:a.position,visibility:a.visibility})),
        events:out.delta.events});
    }
    return {schema:'dsh-spatial-replay-v4',initialClock:normalize(input).clock,
      finalClock:s.clock,frames,finalScene:s,finalObservation:observe(s)};
  }
  function modelPacket(input,{focus=null,limit=24}={}){
    const s=normalize(input),o=observe(s);
    if(!Number.isInteger(limit)||limit<1||limit>64)throw Error('invalid model packet limit');
    const entities=[...o.agents.map(a=>({type:'agent',id:a.id,role:a.role,
      position:a.position,velocity:a.velocity,direction:a.relative.direction,
      distance:a.relative.worldDistance,visibility:a.visibility,
      occludedBy:a.occludedBy})),
      ...o.objects.map(x=>({type:x.kind,id:x.id,position:x.world,
        direction:x.player.direction,distance:x.player.worldDistance,
        visibility:x.visibility,occludedBy:x.occludedBy}))];
    entities.sort((a,b)=>a.distance-b.distance||a.id.localeCompare(b.id));
    const selected=focus?entities.filter(x=>x.id===focus):entities.slice(0,limit);
    return {schema:'dsh-spatial-model-packet-v4',sourceObservation:o.schema,
      clock:o.clock,units:o.units,axes:o.coordinateSystem,
      player:o.player,camera:o.camera,reticle:o.reticle,
      entities:selected,entityCount:entities.length,truncated:!focus&&entities.length>limit,
      importantRelations:o.relations.filter(r=>selected.some(x=>x.id===r.object)),
      lastMotion:o.motion.last,
      interpretationRules:['positions are simulated meters, not observed gameplay',
        'visibility is approximate, not a pixel-perfect guarantee',
        'navigation status budget_exhausted does not prove no path',
        'predicted agent motion assumes constant velocity']};
  }
  return {VERSION:4,defaultScene,normalize,validate,observe,traceAgent,raycastReticle,
    blockedAt,planPath,planPathAsync,deltaReport,step,replay,modelPacket};
});
