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
  function observe(input){
    const s=normalize(input),base=T.observe(asV3(s));
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
  function blockedAt(scene,obstacles,p,skipAgent=null){
    const radius=scene.player.collision.enabled?scene.player.collision.radius:.28;
    for(const agent of scene.agents){
      if(agent.id===skipAgent)continue;
      if(planar(p,agent.position)<radius+agent.radius+.02)return true;
    }
    for(const o of obstacles){
      if(!(o.kind==='item'?scene.items:scene.plots).find(x=>x.id===o.id)?.solid)continue;
      if(planar(p,o.center)>length(o.half)+radius+.02)continue;
      for(const y of [.35,.9,1.45]){
        if(S.distanceToBox(V(p.x,p.y+y,p.z),o)<radius+.015)return true;
      }
    }
    return false;
  }
  class MinHeap{
    constructor(){this.list=[]}
    push(v){const a=this.list;let i=a.length;a.push(v);while(i){const p=(i-1)>>1;if(a[p].score<=v.score)break;a[i]=a[p];i=p}a[i]=v}
    pop(){const a=this.list,first=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&a[c+1].score<a[c].score)c++;if(a[c].score>=last.score)break;a[i]=a[c];i=c}a[i]=last}return first}
    get size(){return this.list.length}
  }
  function planPath(input,target,options={}){
    const s=normalize(input);
    if(!target||!within(target.x,-1e5,1e5)||!within(target.z,-1e5,1e5))
      throw Error('invalid navigation target');
    const cell=options.cell===undefined?1:options.cell,maxNodes=options.maxNodes===undefined?2400:options.maxNodes;
    if(!within(cell,.4,2)||!Number.isInteger(maxNodes)||maxNodes<100||maxNodes>MAX_NODES)
      throw Error('invalid navigation budget');
    const from=s.player.position,to=V(target.x,from.y,target.z),distance=planar(from,to);
    if(distance>48)return {status:'target_too_far',path:[],expanded:0,cell,maxNodes};
    const obstacles=S.shapes(s);
    if(blockedAt(s,obstacles,from))return {status:'start_blocked',path:[],expanded:0,cell,maxNodes};
    if(blockedAt(s,obstacles,to))return {status:'target_blocked',path:[],expanded:0,cell,maxNodes};
    if(distance<.05)return {status:'already_there',path:[vec(from)],expanded:0,cell,maxNodes};
    const gx=Math.round((to.x-from.x)/cell),gz=Math.round((to.z-from.z)/cell);
    const limit=Math.ceil(52/cell),limitCells=limit*limit;
    if(Math.abs(gx)>limit||Math.abs(gz)>limit||limitCells>20000)
      return {status:'navigation_area_too_large',path:[],expanded:0,cell,maxNodes};
    const key=(x,z)=>x+','+z,loc=(x,z)=>V(from.x+x*cell,from.y,from.z+z*cell);
    const h=(x,z)=>{const dx=Math.abs(x-gx),dz=Math.abs(z-gz);
      return (Math.max(dx,dz)+(Math.SQRT2-1)*Math.min(dx,dz))*cell};
    const blocks=new Map();
    function blocked(x,z){
      const id=key(x,z);if(blocks.has(id))return blocks.get(id);
      const b=Math.abs(x)>limit||Math.abs(z)>limit||blockedAt(s,obstacles,loc(x,z));
      blocks.set(id,b);return b;
    }
    if(blocked(gx,gz))return {status:'goal_cell_blocked',path:[],expanded:0,cell,maxNodes};
    const open=new MinHeap(),gScore=new Map([['0,0',0]]),parent=new Map(),closed=new Set();
    open.push({x:0,z:0,g:0,score:h(0,0)});
    let expanded=0,reached=false;
    const dirs=[[-1,0],[0,-1],[0,1],[1,0],[-1,-1],[-1,1],[1,-1],[1,1]];
    while(open.size&&expanded<maxNodes){
      const p=open.pop(),id=key(p.x,p.z);
      if(closed.has(id)||p.g>gScore.get(id)+1e-8)continue;
      if(p.x===gx&&p.z===gz){reached=true;break}
      closed.add(id);expanded++;
      for(const [dx,dz] of dirs){
        const nx=p.x+dx,nz=p.z+dz,k=key(nx,nz);
        if(closed.has(k)||blocked(nx,nz))continue;
        if(dx&&dz&&(blocked(p.x+dx,p.z)||blocked(p.x,p.z+dz)))continue;
        const next=p.g+cell*(dx&&dz?Math.SQRT2:1);
        if(next<(gScore.get(k)??Infinity)-1e-8){
          parent.set(k,id);gScore.set(k,next);
          open.push({x:nx,z:nz,g:next,score:next+h(nx,nz)});
        }
      }
    }
    if(!reached)return {status:open.size?'budget_exhausted':'no_path',path:[],expanded,cell,maxNodes};
    let cursor=key(gx,gz),keys=[cursor],guard=0;
    while(cursor!=='0,0'&&guard++<maxNodes+1){
      cursor=parent.get(cursor);if(!cursor)throw Error('navigation parent chain broken');keys.push(cursor);
    }
    keys.reverse();
    const raw=keys.map(k=>{const [x,z]=k.split(',').map(Number);return loc(x,z)});
    const clear=(a,b)=>{
      const d=planar(a,b),samples=Math.ceil(d/(cell/4));
      for(let i=1;i<=samples;i++)if(blockedAt(s,obstacles,
        V(a.x+(b.x-a.x)*i/samples,from.y,a.z+(b.z-a.z)*i/samples)))return false;
      return true;
    };
    const path=[raw[0]];let i=0;
    while(i<raw.length-1){
      let j=raw.length-1;
      for(;j>i+1;j--)if(clear(raw[i],raw[j]))break;
      i=j;path.push(raw[j]);
    }
    if(!clear(path[path.length-1],to))
      return {status:'target_connection_blocked',path:path.map(vec),expanded,cell,maxNodes};
    path.push(to);
    return {status:'found',path:path.map(vec),expanded,cell,maxNodes,
      length:round(path.slice(1).reduce((sum,p,j)=>sum+planar(p,path[j]),0)),
      target:vec(to)};
  }
  function deltaReport(previous,next,motion=null){
    const before=normalize(previous),after=normalize(next);
    const events=[];
    const change=(kind,id,from,to)=>{
      const d=dist(from,to);
      if(d>1e-4)events.push({kind,id,distance:round(d),from:vec(from),to:vec(to)});
    };
    change('player_moved','player',before.player.position,after.player.position);
    change('camera_moved','camera',before.camera.position,after.camera.position);
    const old=new Map(before.agents.map(a=>[a.id,a]));
    for(const a of after.agents){
      const prior=old.get(a.id);
      if(!prior)events.push({kind:'agent_appeared',id:a.id,position:vec(a.position)});
      else change('agent_moved',a.id,prior.position,a.position);
    }
    const now=new Set(after.agents.map(a=>a.id));
    for(const a of before.agents)if(!now.has(a.id))
      events.push({kind:'agent_disappeared',id:a.id});
    if(motion?.impacts?.length)for(const hit of motion.impacts)
      events.push({kind:'collision',id:hit.id,normal:hit.normal,at:hit.at});
    const beforeHit=T.observe(asV3(before)).reticle.worldHit,
      afterHit=T.observe(asV3(after)).reticle.worldHit;
    if((beforeHit?.id||null)!==(afterHit?.id||null))
      events.push({kind:'aim_target_changed',before:beforeHit?.id||null,after:afterHit?.id||null});
    return {schema:'dsh-spatial-delta-v4',fromTime:round(before.clock),
      toTime:round(after.clock),events:events.slice(0,96),
      eventCount:events.length,truncated:events.length>96};
  }
  function step(input,action){
    const s=normalize(input),base=asV3(s);
    const result=T.step(base,action);
    const next=result.scene;next.schema=SCHEMA;
    next.agents=s.agents.map(a=>{
      const position=add(a.position,mul(a.velocity,action.seconds));
      if(['x','y','z'].some(k=>Math.abs(position[k])>1e5))
        throw Error('agent left supported world bounds');
      return {...a,position};
    });
    validate(next);
    const delta=deltaReport(s,next,result.motion);
    return {scene:next,observation:observe(next),motion:result.motion,delta};
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
  return {VERSION:4,defaultScene,normalize,validate,observe,traceAgent,
    blockedAt,planPath,deltaReport,step,replay,modelPacket};
});
