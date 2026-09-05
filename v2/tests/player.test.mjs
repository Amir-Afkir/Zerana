import test from 'node:test';
import assert from 'node:assert/strict';
import { geodeticDegrees } from '../dist/geo/geodetic.js';
import { degrees, meters } from '../dist/geo/units.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { ecefToGeodetic } from '../dist/geo/ecef.js';
import { ecefToThreeLocal, threeLocalToEcef } from '../dist/geo/three-frame.js';
import { frameTransform, transformPoint } from '../dist/geo/floating-origin.js';
import { closestPoint, segmentTriangle, TriangleIndex } from '../dist/physics/geometry.js';
import { TerrainPhysics, COLLISION } from '../dist/physics/terrain-physics.js';
import { MetricPlayer, PLAYER } from '../dist/runtime/metric-player.js';
import { FixedClock } from '../dist/runtime/fixed-clock.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { terrainPatchCells } from '../dist/world/terrain-patch.js';

const geo=(lon=0,lat=0,h=0)=>geodeticDegrees(degrees(lon),degrees(lat),meters(h));
const anchor=createGeoAnchor(geo());
const xyz=p=>[p.xMeters,p.yMeters,p.zMeters];
const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const idle={forward:0,right:0,sprint:false,jump:false};
function packet(vertices,indices=[0,2,1,1,2,3],origin=anchor){
  return {anchor:origin,positions:new Float32Array(vertices),indices:new Uint16Array(indices),
    altitudeAuthority:'ellipsoidal',verticalReference:'ELLIPSOIDAL_WGS84'};
}
function plane(size=100,slope=0){return packet([-size,-size*slope,-size,size,size*slope,-size,-size,-size*slope,size,size,size*slope,size]);}
function setup(packets=[plane()],foot=[0,0,0]){
  const physics=new TerrainPhysics(packets,anchor),player=new MetricPlayer(threeLocalToEcef(foot,anchor),anchor,physics);
  return {physics,player};
}
const capsule=(foot=[0,.015,0])=>({foot,up:[0,1,0],height:1.8,radius:.3});
const floorTriangle={a:[-20,0,-20],b:[-20,0,20],c:[20,0,-20]};

test('closest points cover triangle face, edge and vertex',()=>{
  assert.deepEqual(closestPoint([0,5,-5],floorTriangle),[0,0,-5]);
  assert.deepEqual(closestPoint([-21,5,-21],floorTriangle),[-20,0,-20]);
  assert(distance(closestPoint([20,2,20],floorTriangle),[0,0,0])<1e-12);
});
test('capsule axis through face and degenerate sphere axis',()=>{
  assert.equal(segmentTriangle([0,2,-5],[0,-2,-5],floorTriangle).distance,0);
  assert.equal(segmentTriangle([0,2,-5],[0,2,-5],floorTriangle).distance,2);
  assert.deepEqual(segmentTriangle([0,2,-5],[0,3,-5],floorTriangle).normal,[0,1,0]);
});
test('BVH rejects malformed, non-finite and degenerate geometry',()=>{
  assert.throws(()=>new TriangleIndex(new Float32Array([NaN,0,0]),new Uint16Array([0,0,0])));
  assert.throws(()=>new TriangleIndex(new Float32Array(9),new Uint16Array([0,1,2])));
  assert.throws(()=>new TriangleIndex(new Float32Array(9),new Uint16Array([0,1,20])));
});
test('sweep seats a capsule above a plane at its declared skin',()=>{
  const world=new TerrainPhysics([plane()],anchor),result=world.move(capsule([0,10,0]),[0,-20,0]);
  assert(Math.abs(result.position[1]-COLLISION.skinMeters)<2e-6);
  assert.equal(result.limited,false);assert(result.normals.some(n=>n[1]>.999999));
});
test('continuous sweep cannot tunnel through a thin wall at 100 m motion',()=>{
  const wall=packet([1,-10,-10,1,10,-10,1,-10,10,1,10,10]);
  const world=new TerrainPhysics([plane(),wall],anchor),hit=world.move(capsule(),[100,0,0]);
  assert(Math.abs(hit.position[0]-(1-.3-.015))<2e-6);assert.equal(hit.limited,false);
});
test('capsule slides along a wall without penetrating the floor',()=>{
  const wall=packet([1,-10,-10,1,10,-10,1,-10,10,1,10,10]);
  const world=new TerrainPhysics([plane(),wall],anchor),hit=world.move(capsule(),[5,-1,5]);
  assert(hit.position[0]<=.685002);assert(Math.abs(hit.position[2]-5)<1e-5);assert(hit.position[1]>=.014999);
});
test('two-wall corner stops both horizontal components',()=>{
  const x=packet([1,-10,-10,1,10,-10,1,-10,10,1,10,10]);
  const z=packet([-10,-10,1,-10,10,1,10,-10,1,10,10,1]);
  const world=new TerrainPhysics([plane(),x,z],anchor),hit=world.move(capsule(),[5,-1,5]);
  assert(hit.position[0]<=.685002 && hit.position[2]<=.685002);
});
test('sphere camera sweep uses the same continuous collision contract',()=>{
  const world=new TerrainPhysics([plane()],anchor);
  const hit=world.move({foot:[0,1,0],up:[0,1,0],height:.3,radius:.15},[0,-5,0]);
  assert(Math.abs(hit.position[1]-.015)<2e-6);
});
test('motion rejects invalid direction, units and excessive distance',()=>{
  const world=new TerrainPhysics([plane()],anchor);
  assert.throws(()=>world.move({...capsule(),up:[0,2,0]},[0,0,0]));
  assert.throws(()=>world.move(capsule(),[101,0,0]));
  assert.throws(()=>world.move({...capsule(),height:.2},[0,0,0]));
  assert.throws(()=>world.raycast([0,0,0],[0,1,0],Infinity));
});
test('collider copies remain valid after visual buffers are mutated',()=>{
  const p=plane(),world=new TerrainPhysics([p],anchor);
  p.positions.fill(999);p.indices.fill(0);
  assert.equal(world.raycast([0,1,0],[0,-1,0],2).distance,1);
});
test('datum authority rejects unknown and preview without explicit opt-in',()=>{
  const p={...plane(),altitudeAuthority:'preview-only',verticalReference:'UNRESOLVED_DATUM_PREVIEW'};
  assert.throws(()=>new TerrainPhysics([p],anchor),/OPT_IN/);
  assert.equal(new TerrainPhysics([p],anchor,{allowPreview:true}).altitudeAuthority,'preview-only');
  assert.throws(()=>new TerrainPhysics([{...p,altitudeAuthority:'ellipsoidal'}],anchor,{allowPreview:true}));
});
test('query and collider budgets fail closed',()=>{
  assert.throws(()=>new TerrainPhysics([],anchor));
  assert.throws(()=>new TerrainPhysics(Array(10).fill(plane()),anchor));
  const world=new TerrainPhysics([plane()],anchor);world.dispose();assert.equal(world.colliderCount,0);
  assert.equal(world.hasSupport([0,0,0],[0,1,0],.3),false);
});
test('stationary player stays grounded and does not sink or bounce',()=>{
  const {player}=setup(),initial=player.state.ecefPosition;
  for(let i=0;i<600;i++){player.step(1/60);assert.equal(player.state.grounded,true);assert.equal(player.state.collisionLimited,false);}
  assert(distance(xyz(initial),xyz(player.state.ecefPosition))<1e-5);
  assert(Object.isFrozen(player.state));
});
for(const [name,input,speed] of [['walk',{...idle,forward:1},4],['sprint',{...idle,right:1,sprint:true},7],['diagonal',{...idle,forward:1,right:1},4]]){
  test(`${name} speed is metric and diagonal input is normalized`,()=>{
    const {player}=setup(),initial=player.state.ecefPosition;
    for(let i=0;i<120;i++) player.step(1/60,input);
    assert(Math.abs(distance(xyz(initial),xyz(player.state.ecefPosition))-speed*2)<.002);
  });
}
test('jump rises, lands, and does not auto-repeat while the key is held',()=>{
  const {player}=setup();let maxHeight=0,transitions=0,previousGrounded=true;
  for(let i=0;i<240;i++){
    player.step(1/60,{...idle,jump:true});
    const s=player.state;maxHeight=Math.max(maxHeight,ecefToThreeLocal(s.ecefPosition,anchor)[1]);
    if(previousGrounded&&!s.grounded)transitions++;previousGrounded=s.grounded;
  }
  assert(maxHeight>1.1 && maxHeight<1.4);assert.equal(transitions,1);assert.equal(player.state.grounded,true);
});
test('patch boundary holds the player on loaded terrain instead of falling',()=>{
  const {player}=setup([plane(3)]);
  for(let i=0;i<300;i++)player.step(1/60,{...idle,right:1});
  const local=ecefToThreeLocal(player.state.ecefPosition,anchor);
  assert(local[0]<2.66 && local[0]>2.4);assert.equal(player.state.boundaryBlocked,true);assert.equal(player.state.grounded,true);
});
test('unsupported and steep spawns are refused',()=>{
  assert.throws(()=>setup([plane(3)],[4,0,0]),/SPAWN/);
  assert.throws(()=>setup([plane(30,Math.tan(Math.PI/3))]),/WALKABLE/);
});
test('walking up a 30-degree ramp maintains capsule clearance',()=>{
  const ramp=packet([-30,0,-20,0,0,-20,-30,0,20,0,0,20,30,Math.tan(Math.PI/6)*30,-20,30,Math.tan(Math.PI/6)*30,20],[0,2,1,1,2,3,1,3,4,4,3,5]);
  const {player}=setup([ramp],[-2,0,0]);
  for(let i=0;i<180;i++)player.step(1/60,{...idle,right:1});
  const p=ecefToThreeLocal(player.state.ecefPosition,anchor);
  assert(p[0]>5);assert(p[1]>=Math.tan(Math.PI/6)*p[0]);assert(player.state.grounded);
});
test('steep ramp cannot turn forward motion into climbing',()=>{
  const ramp=packet([0,0,-20,20,Math.tan(Math.PI/3)*20,-20,0,0,20,20,Math.tan(Math.PI/3)*20,20]);
  const {player}=setup([plane(),ramp],[-2,0,0]);
  for(let i=0;i<180;i++)player.step(1/60,{...idle,right:1});
  const p=ecefToThreeLocal(player.state.ecefPosition,anchor);assert(p[0]<.05);assert(p[1]<.1);
});
for(const fps of [30,60,144]) test(`fixed clock: two seconds at ${fps} FPS gives 120 steps`,()=>{
  const clock=new FixedClock(),{player}=setup(),start=player.state.ecefPosition;
  for(let i=0;i<fps*2;i++)clock.advance(1/fps,dt=>player.step(dt,{...idle,right:1}));
  assert.equal(clock.steps,120);assert(Math.abs(distance(xyz(start),xyz(player.state.ecefPosition))-8)<.002);
});
test('fixed clock clamps background gaps, pause discards backlog',()=>{
  const clock=new FixedClock();clock.advance(10,()=>{});assert.equal(clock.steps,6);assert.equal(clock.droppedSeconds,9.9);
  clock.advance(.005,()=>{});clock.reset();assert.equal(clock.advance(.005,()=>{}),.3);
  assert.throws(()=>clock.advance(NaN,()=>{}));assert.throws(()=>clock.advance(-1,()=>{}));
});
test('500 frame changes preserve ECEF state, interpolated feet, camera and colliders',()=>{
  const {player,physics}=setup();player.step(1/60,{...idle,right:1});
  const state=player.state,pose=player.renderPose(.4),count=physics.triangleCount;
  for(let i=0;i<500;i++){
    const next=createGeoAnchor(ecefToGeodetic(threeLocalToEcef([Math.sin(i)*512,0,Math.cos(i)*512],anchor)));
    player.rebase(next);
    assert.deepEqual(player.state,state);assert.equal(physics.triangleCount,count);
    const current=player.renderPose(.4);
    assert(distance(xyz(current.footEcef),xyz(pose.footEcef))<1e-9);
    assert(distance(xyz(current.eyeEcef),xyz(pose.eyeEcef))<1e-6);
    assert(physics.hasSupport(current.foot,current.up,.3));
  }
});
test('moving with frequent rebases agrees with unre-based reference simulation',()=>{
  const a=setup().player,b=setup().player;
  for(let i=0;i<180;i++){
    a.step(1/60,{...idle,right:1});b.step(1/60,{...idle,right:1});
    if(i%7===0)b.rebase(createGeoAnchor(ecefToGeodetic(b.state.ecefPosition)));
  }
  assert(distance(xyz(a.state.ecefPosition),xyz(b.state.ecefPosition))<1e-5);
});
for(const [lon,lat] of [[0,0],[2.35,48.86],[-5.81,35.76],[179.99999,35],[0,85]]) test(`real cell geometry supports fixed-scale walking at ${lon},${lat}`,()=>{
  const position=geo(lon,lat),world=createGeoAnchor(position),sampler=new TerrainSampler(syntheticElevation('flat'));
  const cells=terrainPatchCells(position,17,3).map(id=>buildTerrainCell(id,sampler,8));
  const physics=new TerrainPhysics(cells,world),player=new MetricPlayer(world.ecef,world,physics),start=player.state.ecefPosition;
  for(let i=0;i<60;i++)player.step(1/60,{...idle,right:1});
  assert(Math.abs(distance(xyz(start),xyz(player.state.ecefPosition))-4)<.005);
  assert(player.state.grounded);assert.equal(PLAYER.heightMeters,1.8);
});
test('point and direction frame changes do not confuse velocity with translation',()=>{
  const {player}=setup();player.step(1/60,{...idle,right:1});const state=player.state;
  const next=createGeoAnchor(ecefToGeodetic(threeLocalToEcef([100,0,0],anchor)));
  const expected=transformPoint(ecefToThreeLocal(state.ecefPosition,anchor),frameTransform(anchor,next));
  player.rebase(next);assert.deepEqual(player.state.velocityEcefMetersPerSecond,state.velocityEcefMetersPerSecond);
  assert(distance(ecefToThreeLocal(state.ecefPosition,next),expected)<1e-6);
});
