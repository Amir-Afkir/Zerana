import test from 'node:test';
import assert from 'node:assert/strict';
import { CellScheduler } from '../dist/streaming/scheduler.js';
import { WeightedLru } from '../dist/streaming/weighted-lru.js';
import { selectStreamCells, cellFootprintVolume, DEFAULT_STREAM, STREAM_LIMITS, streamCellKey } from '../dist/streaming/selection.js';
import { geodeticDegrees } from '../dist/geo/geodetic.js';
import { degrees,meters } from '../dist/geo/units.js';
import { geodeticToEcef,ecefToGeodetic } from '../dist/geo/ecef.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { ecefToThreeLocal,threeLocalToEcef } from '../dist/geo/three-frame.js';
import { MercatorCellScheme,cellId } from '../dist/geo/mercator-cell-scheme.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { TerrainPhysics } from '../dist/physics/terrain-physics.js';
import { MetricPlayer } from '../dist/runtime/metric-player.js';
import { measureTerrainSeams } from '../dist/debug/seam-metrics.js';
import { StreamWorkerPool } from '../demo/streaming/worker-pool.mjs';
const scheme=new MercatorCellScheme();
const geo=(lon=2.35,lat=48.86,h=0)=>geodeticDegrees(degrees(lon),degrees(lat),meters(h));
const ecef=(lon=2.35,lat=48.86)=>geodeticToEcef(geo(lon,lat));
const dist=(a,b)=>Math.hypot(a.xMeters-b.xMeters,a.yMeters-b.yMeters,a.zMeters-b.zMeters);
const interest=(x,priority=3)=>({id:cellId(17,x,40000),key:`cell-${x}`,priority,distanceMeters:x,physics:priority<2,visible:true});
const plan=(values,retained=[])=>({wanted:values,retained:new Set([...values.map(v=>v.key),...retained]),centerKey:values[0]?.key||'',candidates:values.length});

for(const [lon,lat,level] of [[0,0,17],[2.35,48.86,17],[-5.81,35.76,17],[179.9999,35,17],[-179.9999,-35,17],[0,85,15],[0,-85,15]]){
  test(`metric selection covers sampled disk and has one canonical centre at ${lon},${lat}`,()=>{
    const origin=ecef(lon,lat),frame=createGeoAnchor(geo(lon,lat)),config={...DEFAULT_STREAM,level};
    const selected=selectStreamCells(origin,[0,0,0],config),keys=new Set(selected.wanted.map(i=>i.key));
    assert.equal(keys.size,selected.wanted.length);assert(keys.has(selected.centerKey));
    for(let radius=0;radius<=config.visibleRadiusMeters;radius+=20)for(let k=0;k<72;k++){
      const moved=ecefToGeodetic(threeLocalToEcef([radius*Math.cos(k*Math.PI/36),0,radius*Math.sin(k*Math.PI/36)],frame));
      assert(keys.has(streamCellKey(scheme.getCellAt(moved,level))),'Missing sampled physical disk cell');
    }
    assert(selected.candidates<=STREAM_LIMITS.maxCandidates);
    assert.deepEqual(selected,selectStreamCells(origin,[0,0,0],config));
  });
}
test('cell bounding volume covers sampled cell interiors, including high latitude and antimeridian',()=>{
  for(const p of [geo(),geo(179.999,80),geo(-179.999,-80),geo(0,0)]){
    const id=scheme.getCellAt(p,17),volume=cellFootprintVolume(id),b=scheme.getBounds(id);
    for(let i=0;i<=10;i++)for(let j=0;j<=10;j++){
      const sampled=geodeticToEcef(geo((b.westRad+(b.eastRad-b.westRad)*i/10)*180/Math.PI,
        (b.southRad+(b.northRad-b.southRad)*j/10)*180/Math.PI));
      assert(dist(volume.center,sampled)<=volume.radiusMeters);
    }
  }
});
test('altitude does not change footprint scale or physical cell membership',()=>{
  const high=selectStreamCells(geodeticToEcef(geo(2.35,48.86,10000)),[0,0,0],DEFAULT_STREAM).wanted;
  const low=selectStreamCells(ecef(),[0,0,0],DEFAULT_STREAM).wanted;
  assert.deepEqual(high.map(i=>[i.key,i.physics,i.visible]),low.map(i=>[i.key,i.physics,i.visible]));
  high.forEach((item,i)=>assert(Math.abs(item.distanceMeters-low[i].distanceMeters)<1e-6));
});
test('prediction adds directional work without discarding safety cells',()=>{
  const still=selectStreamCells(ecef(),[0,0,0],DEFAULT_STREAM),moving=selectStreamCells(ecef(),[80,0,0],DEFAULT_STREAM);
  for(const key of still.wanted.filter(v=>v.physics).map(v=>v.key))assert(moving.wanted.some(v=>v.key===key));
  assert(moving.wanted.length>=still.wanted.length);
});
test('unsupported radii/levels/velocities and over-dense selections fail before generation',()=>{
  for(const override of [{physicsRadiusMeters:150},{visibleRadiusMeters:200},{level:NaN},{level:22},{predictionSeconds:-1},{retentionRadiusMeters:1001}])
    assert.throws(()=>selectStreamCells(ecef(),[0,0,0],{...DEFAULT_STREAM,...override}));
  assert.throws(()=>selectStreamCells(ecef(),[NaN,0,0],DEFAULT_STREAM));
  assert.throws(()=>selectStreamCells(ecef(),[101,0,0],DEFAULT_STREAM));
  assert.throws(()=>selectStreamCells(ecef(),[0,0,0],{...DEFAULT_STREAM,level:21}));
  assert.throws(()=>selectStreamCells(ecef(0,90),[0,0,0],DEFAULT_STREAM));
});
test('antimeridian neighbors wrap x, never y',()=>{
  const result=selectStreamCells(ecef(179.999999,0),[0,0,0],DEFAULT_STREAM);
  assert(result.wanted.some(i=>i.id.x===0));assert(result.wanted.some(i=>i.id.x===2**17-1));
  for(const entry of result.wanted)assert(entry.id.y>=0&&entry.id.y<2**entry.id.level);
});
test('LRU is byte-weighted, recency-ordered, and take transfers ownership',()=>{
  const removed=[],cache=new WeightedLru(10,3,v=>removed.push(v));
  cache.set('a','A',4);cache.set('b','B',4);assert.equal(cache.get('a'),'A');cache.set('c','C',5);
  assert.deepEqual(removed,['B']);assert.equal(cache.bytes,9);assert.equal(cache.take('a'),'A');
  assert.equal(cache.bytes,5);cache.clear();assert.deepEqual(removed,['B','C']);assert.equal(cache.bytes,0);
});
test('LRU oversized refusal does not destroy an existing cache value',()=>{
  const cache=new WeightedLru(10,2);cache.set('a',1,5);assert.equal(cache.set('a',2,11),false);assert.equal(cache.get('a'),1);
  assert.throws(()=>cache.set('a',2,NaN));assert.throws(()=>new WeightedLru(0,1));
});
test('LRU count limit, replacement, misses and disposal are bounded',()=>{
  let released=0;const cache=new WeightedLru(100,2,()=>released++);
  cache.set('a',1,5);cache.set('b',2,5);cache.set('c',3,5);cache.set('c',4,7);
  assert.equal(cache.size,2);assert.equal(cache.bytes,12);assert.equal(released,2);assert.equal(cache.get('a'),undefined);
  cache.clear();assert.equal(released,4);
});
test('priority is safety-first and deterministic, independent of insertion order',()=>{
  const scheduler=new CellScheduler();scheduler.reconcile(plan([interest(5,4),interest(4,1),interest(2,0)]),new Set());
  assert.equal(scheduler.next(0).ticket.key,'cell-2');assert.equal(scheduler.next(0).ticket.key,'cell-4');assert.equal(scheduler.next(0),null);
});
test('revision rejects ABA completion after cell leaves and is requested again',()=>{
  let freed=0;const scheduler=new CellScheduler(()=>freed++),i=interest(2);
  scheduler.reconcile(plan([i]),new Set());const old=scheduler.next(0).ticket;
  assert.deepEqual(scheduler.reconcile(plan([]),new Set()).cancel,[old]);
  scheduler.reconcile(plan([i]),new Set());const fresh=scheduler.next(0).ticket;
  assert(fresh.revision>old.revision);assert.equal(scheduler.complete(old,{},10),false);assert.equal(freed,1);
  assert(scheduler.complete(fresh,{correct:true},10));assert(scheduler.ready().value.correct);
});
test('backpressure includes reservations and completed buffers, not just job count',()=>{
  const scheduler=new CellScheduler();scheduler.reconcile(plan(Array.from({length:12},(_,i)=>interest(i))),new Set());
  for(let i=0;i<4;i++){const work=scheduler.next(0);assert(work);scheduler.complete(work.ticket,{},STREAM_LIMITS.reservedCellBytes);}
  assert.equal(scheduler.next(0),null);assert.equal(scheduler.queuedBytes,STREAM_LIMITS.maxQueuedBytes);
  scheduler.installed(scheduler.ready().ticket);assert(scheduler.next(0));
});
test('oversized, nonfinite and negative byte counts fail closed',()=>{
  for(const bytes of [NaN,-1,0,STREAM_LIMITS.reservedCellBytes+1]){
    const scheduler=new CellScheduler();scheduler.reconcile(plan([interest(1)]),new Set());
    assert.equal(scheduler.complete(scheduler.next(0).ticket,{},bytes),false);assert.equal(scheduler.queuedBytes,0);
    assert.equal(scheduler.snapshot().states.ERROR,1);
  }
});
test('retention avoids regeneration; pins cannot be evicted by reconciliation',()=>{
  const scheduler=new CellScheduler(),i=interest(1);scheduler.seed(i);
  assert.equal(scheduler.reconcile(plan([]),new Set([i.key])).evict.length,0);
  assert.equal(scheduler.snapshot().states.RETAINED,1);
  scheduler.reconcile(plan([i]),new Set());assert.equal(scheduler.next(0),null);
  assert.deepEqual(scheduler.reconcile(plan([]),new Set()).evict,[i.key]);
});
test('obsolete CPU-ready results are released and cannot reach install',()=>{
  let released=0;const scheduler=new CellScheduler(()=>released++);scheduler.reconcile(plan([interest(1)]),new Set());
  const t=scheduler.next(0).ticket;scheduler.complete(t,{},42);scheduler.reconcile(plan([]),new Set());
  assert.equal(scheduler.ready(),null);assert.equal(scheduler.queuedBytes,0);assert.equal(released,1);
  assert.throws(()=>scheduler.installed(t));
});
test('retry uses supplied time, exponential delay, and a finite attempt cap',()=>{
  const scheduler=new CellScheduler();scheduler.reconcile(plan([interest(1)]),new Set());
  let work=scheduler.next(0);scheduler.fail(work.ticket,'TIMEOUT',0,true);assert.equal(scheduler.next(499),null);
  work=scheduler.next(500);assert(work);scheduler.fail(work.ticket,'TIMEOUT',500,true);assert.equal(scheduler.next(1499),null);
  work=scheduler.next(1500);assert(work);scheduler.fail(work.ticket,'TIMEOUT',1500,true);assert.equal(scheduler.next(100000),null);
});
test('non-retryable auth failure never loops',()=>{
  const scheduler=new CellScheduler();scheduler.reconcile(plan([interest(1)]),new Set());
  scheduler.fail(scheduler.next(0).ticket,'AUTH',0,false);assert.equal(scheduler.next(1e12),null);
});
test('5,000 successive windows retain a bounded state machine and release stale work',()=>{
  let freed=0;const scheduler=new CellScheduler(()=>freed++),cache=new WeightedLru(4096,8);
  for(let step=0;step<5000;step++){
    const interests=Array.from({length:9},(_,i)=>interest(step+i,i===4?0:3));
    scheduler.reconcile(plan(interests),new Set());
    for(let i=0;i<9;i++){const job=scheduler.next(step*100);if(!job)break;scheduler.complete(job.ticket,{id:job.ticket.key},128);}
    let ready;while((ready=scheduler.ready())){cache.set(ready.ticket.key,ready.value,128);scheduler.installed(ready.ticket);}
    assert(scheduler.size<=9);assert(scheduler.queuedBytes<=STREAM_LIMITS.maxQueuedBytes);assert(cache.size<=8);
  }
  scheduler.dispose();cache.clear();assert.equal(scheduler.size,0);assert.equal(cache.bytes,0);assert.equal(freed,0);
});
const makePacket=(id,sampler)=>buildTerrainCell(id,sampler,16);
test('incremental colliders preserve player state and support while neighbors change',()=>{
  const sampler=new TerrainSampler(syntheticElevation('flat')),p=geo(),anchor=createGeoAnchor(p),id=scheme.getCellAt(p,17);
  const cells=[id,...scheme.getNeighbors(id)],packets=cells.map(c=>makePacket(c,sampler));
  const physics=new TerrainPhysics([packets[0]],anchor,{maxCells:64});
  const player=new MetricPlayer(geodeticToEcef(p),anchor,physics),before=player.state;
  physics.syncPackets(packets);assert.deepEqual(player.state,before);assert.equal(physics.colliderCount,5);
  physics.syncPackets([packets[0]]);assert.equal(physics.colliderCount,1);
  player.step(1/60,{forward:0,right:0,jump:false,sprint:false});assert(player.state.grounded);
  assert.throws(()=>physics.syncPackets([]));assert.equal(physics.colliderCount,1);physics.dispose();assert.equal(physics.triangleCount,0);
});
test('incremental collider update is atomic on invalid geometry and authority',()=>{
  const p=geo(),anchor=createGeoAnchor(p),id=scheme.getCellAt(p,17),packet=makePacket(id,new TerrainSampler(syntheticElevation('flat')));
  const physics=new TerrainPhysics([packet],anchor,{maxCells:64});
  assert.throws(()=>physics.syncPackets([packet,packet]));
  assert.throws(()=>physics.syncPackets([{...packet,altitudeAuthority:'preview-only'}]));
  assert.throws(()=>physics.syncPackets([{...packet,positions:new Float32Array([NaN])}]));
  assert.equal(physics.colliderCount,1);assert.equal(physics.triangleCount,512);
});
test('seam diagnostics keep strict defaults; snapshot mode still measures actual disagreement',()=>{
  const sampler=new TerrainSampler(syntheticElevation('flat')),id=scheme.getCellAt(geo(),17);
  const a=makePacket(id,sampler),b=makePacket(cellId(id.level,id.x+1,id.y),sampler),world=createGeoAnchor(geo());
  assert.throws(()=>measureTerrainSeams([a,{...b,sourceId:'different'}],world));
  assert(measureTerrainSeams([a,{...b,sourceId:'different'}],world,{allowSourceSnapshots:true}).maxGapMeters<.001);
  const shifted={...b,sourceId:'different',positions:b.positions.slice()};for(let i=1;i<shifted.positions.length;i+=3)shifted.positions[i]+=1;
  assert(measureTerrainSeams([a,shifted],world,{allowSourceSnapshots:true}).maxGapMeters>.5);
});
class FakeWorker {postMessage(data){this.sent=data;}terminate(){this.killed=true;}respond(data){this.onmessage({data});}}
test('worker pool enforces concurrency and rejects wrong revisions without freeing the slot',async()=>{
  const workers=[],pool=new StreamWorkerPool(1,()=>{const w=new FakeWorker();workers.push(w);return w;});
  const pending=pool.run({key:'a',revision:1},{},new AbortController().signal);assert.equal(pool.available,0);
  workers[0].respond({kind:'result',ticket:{key:'a',revision:0}});assert.equal(pool.available,0);assert.equal(pool.lateResults,1);
  workers[0].respond({kind:'result',ticket:{key:'a',revision:1},bundle:{}});await pending;assert.equal(pool.available,1);pool.dispose();assert(workers[0].killed);
});
test('worker errors free the slot and a subsequent task uses a fresh worker',async()=>{
  const workers=[],pool=new StreamWorkerPool(1,()=>{const w=new FakeWorker();workers.push(w);return w;});
  const pending=pool.run({key:'a',revision:1},{},new AbortController().signal);workers[0].onerror();await assert.rejects(pending,/STREAM_WORKER_ERROR/);
  const next=pool.run({key:'b',revision:2},{},new AbortController().signal);assert.equal(workers.length,2);
  workers[1].respond({kind:'result',ticket:{key:'b',revision:2}});await next;pool.dispose();
});
test('worker construction failure does not leave a ghost occupied slot',async()=>{
  const pool=new StreamWorkerPool(1,()=>{throw Error('creation failed');});
  await assert.rejects(pool.run({key:'a',revision:1},{},new AbortController().signal));assert.equal(pool.available,1);pool.dispose();
});
test('pool disposal rejects pending tasks and terminates every worker exactly once',async()=>{
  const pool=new StreamWorkerPool(2,()=>new FakeWorker()),signal=new AbortController().signal;
  const a=pool.run({key:'a',revision:1},{},signal),b=pool.run({key:'b',revision:2},{},signal);pool.dispose();
  await assert.rejects(a,/ABORTED/);await assert.rejects(b,/ABORTED/);assert.equal(pool.terminated,2);pool.dispose();assert.equal(pool.terminated,2);
});

test('six simulated minutes of metric walking stream across cells with bounded residency',()=>{
  const position=geo(),frame=createGeoAnchor(position),sampler=new TerrainSampler(syntheticElevation('flat'));
  let active=new Map();const initial=selectStreamCells(geodeticToEcef(position),[0,0,0],DEFAULT_STREAM);
  for(const i of initial.wanted)active.set(i.key,buildTerrainCell(i.id,sampler,16));
  const physics=new TerrainPhysics([...active.values()],frame,{maxCells:64}),player=new MetricPlayer(geodeticToEcef(position),frame,physics);
  const origin=player.state.ecefPosition;let admitted=0,evicted=0,peak=active.size,rebases=0;
  for(let step=0;step<21600;step++){
    if(step%60===0){
      const plan=selectStreamCells(player.state.ecefPosition,player.state.velocityEcefMetersPerSecond,DEFAULT_STREAM);
      for(const key of active.keys())if(!plan.retained.has(key)){active.delete(key);evicted++;}
      for(const i of plan.wanted)if(!active.has(i.key)){active.set(i.key,buildTerrainCell(i.id,sampler,16));admitted++;}
      physics.syncPackets([...active.values()]);peak=Math.max(peak,active.size);
      if(Math.hypot(...ecefToThreeLocal(player.state.ecefPosition,player.frame))>128){player.rebase(createGeoAnchor(ecefToGeodetic(player.state.ecefPosition)));rebases++;}
    }
    player.step(1/60,{forward:1,right:0,sprint:true,jump:false});
    assert(player.state.grounded);assert(!player.state.boundaryBlocked);assert(!player.state.collisionLimited);
  }
  assert(dist(origin,player.state.ecefPosition)>2500);assert(admitted>10);assert(evicted>10);assert(peak<32);assert(rebases>10);
  assert(sampler.size<=sampler.maxEntries);physics.dispose();sampler.clear();
});
