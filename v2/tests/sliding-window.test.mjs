import test from 'node:test';
import assert from 'node:assert/strict';
import { cellWindow, selectSlidingWindow } from '../dist/streaming/sliding-window.js';
import { RecyclingIndex } from '../dist/streaming/recycling.js';
import { CellScheduler } from '../dist/streaming/scheduler.js';
import { MercatorCellScheme, cellId } from '../dist/geo/mercator-cell-scheme.js';
import { geodeticDegrees } from '../dist/geo/geodetic.js';
import { geodeticToEcef } from '../dist/geo/ecef.js';
import { degrees, meters } from '../dist/geo/units.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { TerrainPhysics } from '../dist/physics/terrain-physics.js';
import { ecefToThreeLocal } from '../dist/geo/three-frame.js';

const scheme=new MercatorCellScheme(), key=id=>scheme.getStableKey(id);
const geo=(lon,lat,h=0)=>geodeticDegrees(degrees(lon),degrees(lat),meters(h));
const at=(lon,lat,h=0)=>geodeticToEcef(geo(lon,lat,h));
function velocity(lon,lat,east,south){
  const l=lon*Math.PI/180,p=lat*Math.PI/180;
  return [-Math.sin(l)*east+Math.sin(p)*Math.cos(l)*south,
    Math.cos(l)*east+Math.sin(p)*Math.sin(l)*south,-Math.cos(p)*south];
}
for(const [lon,lat] of [[0,0],[2.35,48.86],[-5.81,35.76],[179.9999,35],[-179.9999,-35],[0,85],[0,-85]]){
  test(`3x3 fixed scale neighbourhood at ${lon},${lat}`,()=>{
    const p=selectSlidingWindow(at(lon,lat),[0,0,0],17);
    assert.equal(p.activeKeys.size,9);assert.equal(p.wanted.length,9);assert.equal(p.prefetchKeys.size,0);
    assert(p.activeKeys.has(p.centerKey));assert.equal(p.wanted[0].key,p.centerKey);
    assert(p.wanted.every(c=>c.physics&&c.visible&&c.distanceMeters>=0));
    assert.deepEqual([...selectSlidingWindow(at(lon,lat,2000),[0,0,0],17).activeKeys],[...p.activeKeys]);
  });
}
for(const [east,south,expected] of [[7,0,3],[-7,0,3],[0,7,3],[0,-7,3],[5,5,5],[-5,-5,5]]){
  test(`directional prefetch ${east}/${south} contains only the next strip`,()=>{
    const p=selectSlidingWindow(at(2.35,48.86),velocity(2.35,48.86,east,south),17);
    assert.equal(p.activeKeys.size,9);assert.equal(p.prefetchKeys.size,expected);
    assert(p.wanted.filter(c=>!c.visible).every(c=>c.priority===4&&!c.physics&&!p.activeKeys.has(c.key)));
    assert(p.wanted.length<=14);
  });
}
test('cardinal and diagonal recenter request 3 and 5 new cells, not a rebuild',()=>{
  const id=cellId(17,70000,50000),a=new Set(cellWindow(id).map(key));
  assert.equal(cellWindow(id,1,0).filter(c=>!a.has(key(c))).length,3);
  assert.equal(cellWindow(id,1,1).filter(c=>!a.has(key(c))).length,5);
});
test('longitude wraps and coverage clips y instead of shifting the player',()=>{
  const n=2**17,cells=cellWindow(cellId(17,0,0));
  assert.equal(cells.length,6);assert(cells.some(c=>c.x===n-1));assert(cells.every(c=>c.y===0||c.y===1));
  assert.equal(new Set(cells.map(key)).size,cells.length);
  assert.throws(()=>selectSlidingWindow(at(0,89),[0,0,0],17));
});
test('bad levels, shifts and velocities fail before requesting a window',()=>{
  for(const level of [14,22,NaN,17.5])assert.throws(()=>selectSlidingWindow(at(0,0),[0,0,0],level));
  for(const v of [[NaN,0,0],[101,0,0],[0,0]])assert.throws(()=>selectSlidingWindow(at(0,0),v,17));
  assert.throws(()=>cellWindow(cellId(17,5,5),2,0));
});
test('rest jitter does not create prefetch traffic',()=>{
  assert.equal(selectSlidingWindow(at(2.35,48.86),velocity(2.35,48.86,.1,0),17).prefetchKeys.size,0);
});
test('recycling evicts least recently used, not merely first created',()=>{
  const cache=new RecyclingIndex(8,1000,2);
  for(const k of ['a','b','c'])cache.insert(k,10);
  cache.touch(['a']);assert.equal(cache.victim(new Set()),'b');
  cache.delete('b');assert.equal(cache.victim(new Set()),null);
  assert.equal(cache.bytes,20);assert.equal(cache.size,2);
});
test('visible, requested and pinned entries are not LRU victims',()=>{
  const cache=new RecyclingIndex(8,1000,1);
  for(const k of ['visible','spawn','requested','old','new'])cache.insert(k,10);
  assert.equal(cache.victim(new Set(['visible','spawn','requested'])),'old');
  assert.equal(cache.victim(new Set(['visible','spawn','requested','old','new']),1000,1),null);
});
test('count and byte reservations are checked before a new resource is installed',()=>{
  const cache=new RecyclingIndex(2,100,1);cache.insert('a',60);cache.insert('b',40);
  assert(!cache.fits(1));assert.equal(cache.victim(new Set(['b']),1,1),'a');
  assert.throws(()=>cache.insert('c',1));assert.equal(cache.bytes,100);
  cache.delete('a');assert(cache.fits(60));cache.insert('c',60);assert.equal(cache.bytes,100);
});
test('invalid recycling metadata cannot corrupt budget accounting',()=>{
  assert.throws(()=>new RecyclingIndex(0));const c=new RecyclingIndex();
  for(const size of [0,-1,Infinity,NaN,1.5,33*1048576])assert.throws(()=>c.insert('bad',size));
  c.insert('a',10);assert.throws(()=>c.insert('a',20));assert.throws(()=>c.fits(-1));assert.equal(c.bytes,10);
});
test('5000 recycling transitions remain bounded and preserve the protected cell',()=>{
  const c=new RecyclingIndex(16,160,8);c.insert('spawn',10);
  for(let i=0;i<5000;i++){
    const safe=new Set(['spawn',String(i-1)]);
    let victim=c.victim(safe,10,1);if(victim)c.delete(victim);
    c.insert(String(i),10);c.touch([String(i)]);
    victim=c.victim(new Set(['spawn',String(i)]));if(victim)c.delete(victim);
    assert(c.bytes<=160);assert(c.size<=16);
  }
});
test('recycled scheduler entries become wanted without worker regeneration',()=>{
  const s=new CellScheduler(),a=selectSlidingWindow(at(2.35,48.86),[0,0,0],17);
  for(const c of a.wanted)s.seed(c);
  const center=scheme.getCellAt(geo(2.35,48.86),17);
  const p=geodeticToEcef(scheme.getCenter(cellId(17,center.x+1,center.y)));
  const b=selectSlidingWindow(p,[0,0,0],17),resident=new Set(a.activeKeys);
  const actions=s.reconcile({...b,retained:new Set([...b.retained,...resident])},new Set());
  assert.equal(actions.evict.length,0);assert.equal(s.snapshot().states.RETAINED,3);
  s.reconcile({...a,retained:resident},new Set());assert.equal(s.next(0),null);
  s.dispose();
});
function physicsFixture(){
  const id=cellId(17,66391,45090),sampler=new TerrainSampler(syntheticElevation('flat'));
  const packets=cellWindow(id).map(c=>buildTerrainCell(c,sampler,16));
  const frame=createGeoAnchor(scheme.getCenter(id));return {id,packets,frame,physics:new TerrainPhysics(packets,frame)};
}
test('hidden recycled colliders do not support walking; reactivation does not rebuild',()=>{
  const {id,packets,frame,physics}=physicsFixture();
  const current=packets.find(p=>key(p.id)===key(id));const other=packets.find(p=>p.id.x===id.x+1&&p.id.y===id.y);
  const foot=p=>ecefToThreeLocal(geodeticToEcef(scheme.getCenter(p.id)),frame);
  const initial=physics.bvhBuildCount;physics.setActiveCells([current.id]);
  assert.equal(physics.activeColliderCount,1);assert(physics.hasSupport(foot(current),[0,1,0],.3));
  assert(!physics.hasSupport(foot(other),[0,1,0],.3));physics.setActiveCells(packets.map(p=>p.id));
  assert(physics.hasSupport(foot(other),[0,1,0],.3));assert.equal(physics.bvhBuildCount,initial);physics.dispose();
});
test('active collider eviction and invalid activation fail atomically',()=>{
  const {id,packets,physics}=physicsFixture();physics.setActiveCells([id]);
  assert.throws(()=>physics.syncPackets(packets.filter(p=>key(p.id)!==key(id))));
  assert.equal(physics.colliderCount,9);assert.equal(physics.activeColliderCount,1);
  assert.throws(()=>physics.setActiveCells([cellId(17,0,0)]));assert.equal(physics.activeColliderCount,1);
  physics.setActiveCells(null);assert.equal(physics.activeColliderCount,9);
});
test('recycled BVHs survive repeated origin changes and neighbour additions',()=>{
  const {id,packets,frame,physics}=physicsFixture();physics.setCapacity(16);physics.setActiveCells([id]);
  const builds=physics.bvhBuildCount;
  for(let i=0;i<100;i++)physics.rebase(createGeoAnchor(geo(2.35+i*.001,48.86)));
  physics.rebase(frame);physics.syncPackets(packets);assert.equal(physics.bvhBuildCount,builds);
  const extra=buildTerrainCell(cellId(17,id.x+2,id.y),new TerrainSampler(syntheticElevation('flat')),16);
  physics.syncPackets([...packets,extra]);assert.equal(physics.bvhBuildCount,builds+1);
  physics.syncPackets(packets);assert.equal(physics.bvhBuildCount,builds+1);assert.equal(physics.activeColliderCount,1);
});
