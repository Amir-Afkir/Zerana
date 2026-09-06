import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeEnvironmentTile as canonical,clipEnvironmentCell as clipCell,environmentAt,pointInRing } from '../dist/generation/environment/kernel.js';
import { buildEnvironmentPacket,validateEnvironmentPacket,environmentPacketBytes } from '../dist/generation/environment/debug-packet.js';
import { normalizeMapboxEnvironment as attrs } from '../dist/providers/vectors/mapbox-environment.js';
import { ENV_LIMITS } from '../dist/generation/environment/model.js';
import { fraction,pointKey,value } from '../dist/generation/roads/exact.js';
import { cellId } from '../dist/geo/mercator-cell-scheme.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { threeLocalToEcef } from '../dist/geo/three-frame.js';
const ring=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const tile=(paths=[ring(128,128,3840,3840)],extra={},name='water',c='')=>({providerId:'fixture',version:'1',digest:'0'.repeat(64),z:16,x:32768,y:32768,
 layers:[{name,extent:4096,state:'present',features:[{sourceIndex:0,attributes:attrs(name,{class:c}),geometry:name==='waterway'?'line':'polygon',paths}]}],...extra});
const point=(x,y,t=tile())=>({u:fraction(BigInt(t.x)*4096n+BigInt(x),4096n*2n**BigInt(t.z)),v:fraction(BigInt(t.y)*4096n+BigInt(y),4096n*2n**BigInt(t.z))});
const cells=[cellId(17,65536,65536),cellId(17,65537,65536),cellId(17,65536,65537),cellId(17,65537,65537)];
const serial=v=>JSON.stringify(v,(_,v)=>typeof v==='bigint'?String(v):v);
const terrain=id=>buildTerrainCell(id,new TerrainSampler(syntheticElevation('waves')),32);

test('environment: cover and land use remain independent source classifications',()=>{
 assert.equal(attrs('landuse',{class:'park'}).cover,'UNKNOWN');assert.equal(attrs('landuse',{class:'park'}).use,'PARK');
 assert.equal(attrs('landuse',{class:'wood'}).cover,'WOOD');assert.equal(attrs('landuse',{class:'wood'}).use,'UNKNOWN');
 assert.equal(attrs('landuse',{class:'residential'}).cover,'UNKNOWN');assert.equal(attrs('water',{}).water,'WATER_AREA');assert.equal(attrs('water',{}).waterHeightMeters,null);
});
test('environment: wetlands do not imply permanent open water and intermittent streams stay marked',()=>{
 const a=attrs('landuse_overlay',{class:'wetland'});assert.equal(a.wetland,true);assert.equal(a.water,'UNKNOWN');
 assert.equal(attrs('waterway',{class:'stream_intermittent'}).intermittent,true);
});
test('environment: new source classes are preserved without fabricated cover, prototype keys are safe',()=>{
 for(const c of ['future','__proto__','constructor']){const a=attrs('landuse',{class:c});assert.equal(a.cover,'UNKNOWN');assert.equal(a.sourceClass,c);}
 assert.equal(attrs('landuse',{class:'x'.repeat(500)}).sourceClass.length,128);
});
test('environment: a lake spanning four cells retains its island on all sides',()=>{
 const t=canonical(tile([ring(128,128,3840,3840),ring(1700,1700,700,700).reverse()]));
 for(const id of cells){const c=clipCell([t],id);assert.equal(c.fragments.length,1);assert.equal(c.fragments[0].shape.polygons[0].length,2);assert.equal(c.fragments[0].representation,'polygon-intersect-box');}
 assert.equal(environmentAt(clipCell([t],cells[0]),point(1800,1800)).length,0);
 assert.equal(environmentAt(clipCell([t],cells[0]),point(500,500)).length,1);
 assert.equal(environmentAt(clipCell([t],cells[0]),point(1700,1800)).length,0);
});
test('environment: a concave clipped shape keeps disconnected components instead of a fake bridge',()=>{
 // C-shaped exterior: its right-hand clipping produces two disjoint strips.
 const t=canonical(tile([[[100,100],[3900,100],[3900,500],[500,500],[500,3500],[3900,3500],[3900,3900],[100,3900]]]));
 const c=clipCell([t],cells[1]);assert.equal(environmentAt(c,point(3000,300)).length,1);assert.equal(environmentAt(c,point(3000,1500)).length,0);
 assert.equal(environmentAt(clipCell([t],cells[3]),point(3000,3700)).length,1);
});
test('environment: cell fully inside a water polygon is present even without an outline',()=>{
 const t=canonical(tile([ring(-8,-8,4112,4112)]));const c=clipCell([t],cellId(19,262147,262147));
 assert.equal(c.fragments.length,1);assert.equal(c.fragments[0].boundaries.length,0);assert.equal(environmentAt(c,point(1800,1800)).length,1);
});
test('environment: a cell inside an island has no water despite intersecting outer bbox',()=>{
 const t=canonical(tile([ring(0,0,4096,4096),ring(1000,1000,2000,2000).reverse()]));
 assert.equal(clipCell([t],cellId(19,262147,262147)).fragments.length,0);
});
test('environment: multiple exteriors and associated holes are not merged into a single ring',()=>{
 const t=canonical(tile([ring(100,100,900,900),ring(300,300,200,200).reverse(),ring(2000,2000,1000,1000)]));
 const c=clipCell([t],cells[0]);assert.equal(c.fragments[0].shape.polygons.length,2);assert.equal(environmentAt(c,point(400,400)).length,0);
 assert.equal(environmentAt(clipCell([t],cells[3]),point(2200,2200)).length,1);
});
test('environment: line boundary ownership is half-open and clipping endpoints are exact',()=>{
 const t=canonical(tile([[[2048,0],[2048,4096]]],{},'waterway','stream'));
 assert.equal(clipCell([t],cells[0]).fragments.length,0);assert.equal(clipCell([t],cells[1]).fragments.length,1);
 const diag=canonical(tile([[[0,300],[4096,3001]]],{},'waterway','river'));
 const a=clipCell([diag],cells[0]).fragments[0].boundaries,b=clipCell([diag],cells[1]).fragments[0].boundaries;
 assert.equal(pointKey(a.at(-1)[1]),pointKey(b[0][0]));
});
test('environment: polygon clip boundaries do not become artificial shorelines',()=>{
 const t=canonical(tile([ring(0,0,4096,4096)]));const c=clipCell([t],cells[0]);
 assert.equal(c.fragments.length,1);assert.equal(c.fragments[0].boundaries.length,0);
});
test('environment: overlapping woodland and wetland retain both meanings, independent of arrival order',()=>{
 const raw=tile(undefined,{},'landuse','wood');raw.layers.push(tile(undefined,{},'landuse_overlay','wetland').layers[0]);
 const a=clipCell([canonical(raw)],cells[0]);raw.layers.reverse();const b=clipCell([canonical(raw)],cells[0]);assert.equal(serial(a),serial(b));
 const at=environmentAt(a,point(800,800));assert.equal(at.length,2);assert.ok(at.some(x=>x.wetland));assert.ok(at.some(x=>x.cover==='WOOD'));
});
test('environment: each layer extent is normalized independently',()=>{
 const a=tile();const b=tile([ring(256,256,7680,7680)]);b.layers[0].extent=8192;
 const aa=clipCell([canonical(a)],cells[0]),bb=clipCell([canonical(b)],cells[0]);assert.equal(serial(aa),serial(bb));
});
test('environment: duplicate tile requests are idempotent and conflicting digests refuse admission',()=>{
 const t=canonical(tile());assert.equal(serial(clipCell([t,t],cells[0])),serial(clipCell([t],cells[0])));
 assert.throws(()=>clipCell([t,{...t,digest:'1'.repeat(64)}],cells[0]),/SNAPSHOT_CONFLICT/);
 assert.throws(()=>clipCell([t,{...t,version:'2'}],cells[0]),/MIXED_SOURCE/);
});
test('environment: absent layers are explicit, missing source coverage is not an empty map',()=>{
 const t=canonical(tile(undefined,{layers:[{name:'water',extent:4096,state:'absent',features:[]}]}));
 assert.deepEqual(clipCell([t],cells[0]).missingLayers,['water']);assert.throws(()=>clipCell([t],cellId(17,1,1)),/COVERAGE/);
});
test('environment: winding and budgets reject malformed geometry before rendering',()=>{
 assert.throws(()=>canonical(tile([ring(1,1,100,100).reverse()])),/ORPHAN_HOLE/);
 assert.throws(()=>canonical(tile([[[0,0],[100,100],[0,100],[100,0]]])),/ZERO_AREA/);
 assert.throws(()=>canonical(tile([[[0,0],[NaN,100],[0,100]]])),/COORDINATE/);
 assert.throws(()=>canonical(tile([Array.from({length:ENV_LIMITS.maxPoints+1},()=>[0,0])])),/BUDGET/);
 assert.throws(()=>canonical(tile(undefined,{z:25})),/CONTRACT/);
});
test('environment: exact ring predicate distinguishes borders from interiors',()=>{
 const r=canonical(tile([ring(0,0,4096,4096)])).features[0].paths[0];
 assert.equal(pointInRing(point(0,10),r),'boundary');assert.equal(pointInRing(point(10,10),r),'inside');assert.equal(pointInRing(point(-1,10),r),'outside');
});
test('environment: antimeridian fragments remain in their owning cells without globe-spanning edges',()=>{
 const a=canonical(tile([ring(-8,100,4112,3700)],{x:65535})),b=canonical(tile([ring(-8,100,4112,3700)],{x:0}));
 for(const id of [cellId(17,131071,65536),cellId(17,0,65536)]){
  const c=clipCell([a,b],id);assert.equal(c.fragments.length,1);
  for(const [p,q] of c.fragments[0].boundaries)assert.ok(Math.abs(value(p.u)-value(q.u))<1e-4);
 }
});
test('environment: debug packets are bounded and bound to the actual terrain revision',()=>{
 const t=canonical(tile()),tr=terrain(cells[0]),p=buildEnvironmentPacket([t],tr);assert.ok(p.segmentCount>0);assert.ok(environmentPacketBytes(p)<=ENV_LIMITS.maxPacketBytes);
 assert.equal(p.hydroAuthority,'unresolved');assert.throws(()=>validateEnvironmentPacket(p,{...tr,sourceId:'different'}),/CONTRACT/);
 const bad={...p,positions:new Float32Array(p.positions)};bad.positions[0]=NaN;assert.throws(()=>validateEnvironmentPacket(bad,tr),/CONTRACT/);
});
test('environment: independent cell debug endpoints agree in ECEF below one millimetre',()=>{
 const t=canonical(tile([[[0,300],[4096,1700]]],{},'waterway','stream'));const a=terrain(cells[0]),b=terrain(cells[1]);
 const pa=buildEnvironmentPacket([t],a),pb=buildEnvironmentPacket([t],b);
 const last=threeLocalToEcef([...pa.positions.slice(-3)],a.anchor),first=threeLocalToEcef([...pb.positions.slice(0,3)],b.anchor);
 assert.ok(Math.hypot(last.xMeters-first.xMeters,last.yMeters-first.yMeters,last.zMeters-first.zMeters)<.001);
});
test('environment: empty snapshots create valid terminal packets, not repeated requests',()=>{
 const t=canonical(tile(undefined,{layers:[]}));const tr=terrain(cells[0]),p=buildEnvironmentPacket([t],tr);
 assert.equal(p.fragmentCount,0);assert.equal(p.segmentCount,0);validateEnvironmentPacket(p,tr);
});
