import test from 'node:test';
import assert from 'node:assert/strict';
import { TriangleIndex } from '../dist/physics/geometry.js';
import { TerrainPhysics } from '../dist/physics/terrain-physics.js';
import { RecyclingIndex } from '../dist/streaming/recycling.js';
import { CellScheduler } from '../dist/streaming/scheduler.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { MercatorCellScheme } from '../dist/geo/mercator-cell-scheme.js';
import { geodeticDegrees } from '../dist/geo/geodetic.js';
import { degrees, meters } from '../dist/geo/units.js';

const scheme=new MercatorCellScheme();
function packet(lon=2.35,lat=48.86,n=16){
  const position=geodeticDegrees(degrees(lon),degrees(lat),meters(0));
  return buildTerrainCell(scheme.getCellAt(position,17),new TerrainSampler(syntheticElevation('flat')),n);
}
function adopt(snapshot,p){
  const validation=TriangleIndex.adopt(snapshot,p.positions,p.indices);let next,yields=0;
  do{next=validation.next();if(!next.done)yields++;}while(!next.done);
  return {index:next.value,yields};
}
const clean=items=>items.map(({a,b,c})=>({a,b,c}));
for(const [lon,lat] of [[2.35,48.86],[0,0],[-5.81,35.76],[179.999,35],[0,85]]){
  test(`prepared BVH queries match the original index exactly at ${lon},${lat}`,()=>{
    const p=packet(lon,lat),reference=new TriangleIndex(p.positions,p.indices);
    const {index,yields}=adopt(structuredClone(reference.snapshot()),p);
    assert(yields>0);assert.equal(index.triangleCount,reference.triangleCount);
    for(let i=0;i<25;i++){
      const x=(i%5-2)*30,z=(Math.floor(i/5)-2)*30;
      const box={min:[x-15,-10,z-15],max:[x+15,10,z+15]};
      assert.deepEqual(clean(index.query(box)),clean(reference.query(box)));
    }
  });
}
const corruptions={
  'format':s=>{s.version='unknown';},
  'shape':s=>{s.boxes=new Float32Array(5);},
  'NaN triangle':s=>{s.triangles[0]=NaN;},
  'changed position':s=>{s.triangles[0]+=1;},
  'duplicate triangle':s=>{s.sourceIds[1]=s.sourceIds[0];},
  'out-of-range triangle':s=>{s.sourceIds[0]=999999;},
  'cycle':s=>{s.links[0]=0;},
  'duplicate child':s=>{s.links[1]=s.links[0];},
  'invalid root bounds':s=>{s.boxes[0]=s.boxes[3]+1;},
  'missing triangles':s=>{const leaf=s.links.findIndex((_,i)=>i%4===0&&s.links[i]===-1);s.links[leaf+3]=0;},
};
for(const [name,mutate] of Object.entries(corruptions))test(`prepared collider rejects ${name}`,()=>{
  const p=packet(),snapshot=new TriangleIndex(p.positions,p.indices).snapshot();mutate(snapshot);
  assert.throws(()=>adopt(snapshot,p),/INVALID_PREPARED_COLLIDER/);
});
test('validation yields at bounded batches and retains Float32 source coordinates',()=>{
  const p=packet(2.35,48.86,32),snapshot=new TriangleIndex(p.positions,p.indices).snapshot();
  const {index,yields}=adopt(snapshot,p);assert(yields>=16);assert.equal(index.triangleCount,2048);
  const before=clean(index.query({min:[-1e5,-1e5,-1e5],max:[1e5,1e5,1e5]}));
  p.positions.fill(0);assert.deepEqual(clean(index.query({min:[-1e5,-1e5,-1e5],max:[1e5,1e5,1e5]})),before);
});
test('streaming adopts a validated collider without a main-thread BVH build',()=>{
  const a=packet(),b=buildTerrainCell(scheme.getNeighbors(a.id)[0],new TerrainSampler(syntheticElevation('flat')),16);
  const physics=new TerrainPhysics([a],a.anchor,{maxCells:9});
  const index=adopt(new TriangleIndex(b.positions,b.indices).snapshot(),b).index;
  physics.syncPackets([a,b],new Map([[b,index]]));
  assert.equal(physics.mainThreadBvhBuildCount,1);assert.equal(physics.preparedBvhAdoptions,1);
  physics.syncPackets([a,b]);physics.rebase(b.anchor);
  assert.equal(physics.bvhBuildCount,2);assert.equal(physics.mainThreadBvhBuildCount,1);
  physics.dispose();
});
test('late imagery byte resizing keeps residency bounded and LRU recency unchanged',()=>{
  const cache=new RecyclingIndex(4,100,1);cache.insert('a',10);cache.insert('b',20);
  cache.resize('a',40);assert.equal(cache.bytes,60);assert.equal(cache.victim(new Set()),'a');
  assert.throws(()=>cache.resize('a',100),/RECYCLING_CAPACITY/);assert.equal(cache.bytes,60);
  for(const n of [NaN,-1,0,Infinity])assert.throws(()=>cache.resize('a',n));
});
test('a cancelled ready ticket cannot publish a staged cell or a stale replacement',()=>{
  const p=packet(),key=scheme.getStableKey(p.id),interest={key,id:p.id,priority:0,distanceMeters:0,visible:true,physics:true};
  const scheduler=new CellScheduler();
  const plan={wanted:[interest],retained:new Set(),centerKey:key,candidates:1};
  scheduler.reconcile(plan,new Set());const job=scheduler.next(0);scheduler.complete(job.ticket,{},100);
  assert(scheduler.isReady(job.ticket));
  scheduler.reconcile({...plan,wanted:[]},new Set());assert(!scheduler.isReady(job.ticket));
  scheduler.reconcile(plan,new Set());const next=scheduler.next(0);assert.notEqual(next.ticket.revision,job.ticket.revision);
});
