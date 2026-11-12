'use strict';
const A=require('node:assert/strict');
const S=require('../app/src/main/assets/labs/spatial-v4.js');
const B=require('../app/src/main/assets/labs/spatial-core.js');
const V=B.V;

// Two dynamic agents would swap positions in one timestep without a sweep test.
const s=S.defaultScene();s.items=[];s.plots=[];
s.agents=[
  {id:'left',role:'neutral',position:V(-2,1,8),velocity:V(4,0,0),yaw:90,radius:.5},
  {id:'right',role:'neutral',position:V(2,1,8),velocity:V(-4,0,0),yaw:270,radius:.5},
];
const r=S.step(s,{seconds:1});
A.ok(B.dist(r.scene.agents[0].position,r.scene.agents[1].position)>=.99,
  'head-on agents must not tunnel through each other');
A.ok(r.motion.agentImpacts.some(x=>x.kind==='agent'&&x.status==='moving_sphere_contact'),
  'agent contact must be observable');
A.ok(r.delta.events.some(x=>x.kind==='agent_collision'),
  'agent collision must be emitted as a delta event');

// A moving agent crossing a stationary player must stop at the swept contact.
const p=S.defaultScene();p.items=[];p.plots=[];
p.agents=[{id:'runner',role:'neutral',position:V(0,.9,3),velocity:V(0,0,-6),yaw:180,radius:.5}];
const q=S.step(p,{seconds:.75});
A.ok(q.scene.agents[0].position.z>0,
  'moving agent must not pass through a stationary player');
A.ok(q.motion.agentImpacts.some(x=>x.id==='player'),
  'agent-player contact must be observable');

// Collision-disabled actors retain the documented ghost-through behavior.
const ghost=S.defaultScene();ghost.items=[];ghost.plots=[];ghost.player.collision.enabled=false;
ghost.agents=[{id:'runner',role:'neutral',position:V(0,.9,3),velocity:V(0,0,-6),yaw:180,radius:.5}];
const g=S.step(ghost,{seconds:.75});
A.ok(g.scene.agents[0].position.z<0,'disabled player collision does not constrain agent motion');
console.log('V4 dynamic agent-agent and agent-player continuous collision: PASS');
