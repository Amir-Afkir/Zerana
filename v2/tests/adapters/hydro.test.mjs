import test from 'node:test';
import assert from 'node:assert/strict';
import { HydroSource } from '../../demo/hydro/source.mjs';
import { validateHydroCohort,admitHydroCohort } from '../../demo/hydro/cohort.mjs';
import { validatePacket,packetBytes } from '../../demo/streaming/packet.mjs';
import { WeightedLru } from '../../src/streaming/weighted-lru.ts';
import { canonicalizeEnvironmentTile } from '../../src/generation/environment/kernel.ts';
import { normalizeMapboxEnvironment } from '../../src/providers/vectors/mapbox-environment.ts';
import { cellId } from '../../src/geo/mercator-cell-scheme.ts';
import { buildWaterSurfaceProfile } from '../../src/generation/hydro/profiles.ts';
import { prepareWaterGeometry } from '../../demo/water/prepare.mjs';
import { TriangleIndex } from '../../src/physics/geometry.ts';
const token='pk.hydro-fixture',z=16,x=32768,y=32768;
const signal=()=>new AbortController().signal;
const sourceHeight={id:'mapbox.terrain-rgb/fixture',verticalReference:'UNRESOLVED_DATUM_PREVIEW',provenance:'estimated',heightAt:()=>10};
function context(){return Array.from({length:9},(_,i)=>{
 const xx=x+i%3-1,yy=y+Math.floor(i/3)-1;
 const environment=canonicalizeEnvironmentTile({z,x:xx,y:yy,providerId:'fixture',version:'1',digest:'a'.repeat(64),layers:[
  {name:'water',extent:4096,state:'present',features:[{sourceIndex:0,geometry:'polygon',attributes:normalizeMapboxEnvironment('water',{}),paths:[[[0,0],[4096,0],[4096,4096],[0,4096]]]}]},
  {name:'waterway',extent:4096,state:'present',features:[]}]});
 return {z,x:xx,y:yy,extent:4096,providerId:'fixture',version:'1',digest:'a'.repeat(64),features:[],environment};
 });}
function fixture(options={}){
 const calls={vector:0,raster:0};const cache=new WeightedLru(16*1048576,128);
 const roads={cache:{bytes:0},load:async(_ids,_token,sig,_grant,consume)=>{calls.vector++;if(sig.aborted)throw new DOMException('Cancelled','AbortError');consume();return {sourceZoom:16,tiles:context(),attribution:'fixture'};}};
 const raster=async opts=>{calls.raster++;opts.onHttpAttempt();if(options.cancel)options.cancel.abort();return {source:sourceHeight,evidence:[{layer:'elevation',tile:'15/16384/16384',sha256:'b'.repeat(64)}],attributions:[],decodedHeightBytes:options.oversize?17*1048576:262144};};
 return {source:new HydroSource(cache,{roads,raster}),calls};
}
const job=(dx=3)=>({source:'mapbox',profile:'flat',allowPreview:true,token,hydro:true,engineering:false,id:cellId(19,x*8+dx,y*8+3),subdivisions:32});
async function build(f,dx=3,sig=signal(),consume=()=>{}){const b=await f.source.build(job(dx),sig,consume);b.collider=new TriangleIndex(b.packet.positions,b.packet.indices).snapshot();return b;}

test('hydro adapter: a complete ground/water/collider cohort is constructed before admission',async()=>{
 const f=fixture(),b=await build(f);validatePacket(b,job());validateHydroCohort(b);
 assert.ok(b.hydro.modifiedSamples>0);assert.ok(b.hydro.certificate.maxTerrainAboveWaterMeters<-.49);
 assert.equal(b.water.terrainSourceId,b.packet.sourceId);assert.equal(b.water.renderLiftMeters,0);assert.ok(packetBytes(b)<=1048576);
 assert.ok(b.rawHeightsMeters.every(h=>h===10));assert.ok(b.packet.heightsMeters.every(h=>h===9.5));
 const snapshot=new TriangleIndex(b.packet.positions,b.packet.indices).snapshot();assert.deepEqual(snapshot,b.collider);
});
test('hydro adapter: adjacent cells and recycling share the source and water revision with no HTTP',async()=>{
 const f=fixture();let attempts=0;const a=await build(f,3,signal(),()=>attempts++),b=await build(f,4,signal(),()=>attempts++),c=await build(f,3,signal(),()=>attempts++);
 assert.equal(f.calls.vector,1);assert.equal(f.calls.raster,1);assert.equal(attempts,2);assert.equal(a.hydro.revision,b.hydro.revision);
 assert.deepEqual(a.packet.positions,c.packet.positions);assert.deepEqual(a.water.positions,c.water.positions);admitHydroCohort(b,[a]);
});
test('hydro adapter: abort after provider completion cannot publish a partial cohort',async()=>{
 const controller=new AbortController(),f=fixture({cancel:controller});await assert.rejects(build(f,3,controller.signal),e=>e.name==='AbortError');assert.equal(f.source.regions.size,0);
});
test('hydro adapter: pre-aborted and unconsented jobs do not contact providers',async()=>{
 const f=fixture(),c=new AbortController();c.abort();await assert.rejects(build(f,3,c.signal));assert.equal(f.calls.vector,0);
 await assert.rejects(f.source.build({...job(),allowPreview:false},signal(),()=>{}),/CONTRACT/);assert.equal(f.calls.vector,0);
});
test('hydro adapter: quota applies before vector and DEM calls',async()=>{
 const f=fixture();await assert.rejects(build(f,3,signal(),()=>{throw Error('STREAM_HTTP_BUDGET');}),/BUDGET/);assert.equal(f.source.regions.size,0);assert.equal(f.calls.raster,0);
});
test('hydro adapter: one region cannot exceed the existing 16 MiB cache ceiling',async()=>{
 const f=fixture({oversize:true});await assert.rejects(build(f),/REGION_BUDGET/);assert.equal(f.source.regions.size,0);
});
test('hydro adapter: modified metadata or incompatible resident source revisions are rejected',async()=>{
 const f=fixture(),a=await build(f),b=await build(f,4);
 assert.throws(()=>validateHydroCohort({...a,hydro:{...a.hydro,revision:'f'.repeat(64)}}),/CONTRACT/);
 const conflict={...a,evidence:[{layer:'elevation',tile:'15/16384/16384',sha256:'c'.repeat(64)}],hydro:null};
 assert.throws(()=>admitHydroCohort(b,[conflict]),/CONFLICT/);
 assert.throws(()=>validateHydroCohort({...a,hydro:{...a.hydro,certificate:{...a.hydro.certificate,passed:false}}}),/CONTRACT/);
});
test('hydro adapter: token replacement drops all derived and raw session caches',async()=>{
 const f=fixture();await build(f);await f.source.build({...job(),token:'pk.new-fixture'},signal(),()=>{});assert.equal(f.calls.raster,2);assert.equal(f.calls.vector,2);
});
test('hydro profiles: closed lake levels use banks, not a raised DEM interior',()=>{
 const tiles=context().map(t=>t.environment);const center=tiles.find(t=>t.x===x&&t.y===y);
 const modified=canonicalizeEnvironmentTile({z,x,y,providerId:'fixture',version:'1',digest:'a'.repeat(64),layers:[{name:'water',extent:4096,state:'present',features:[{sourceIndex:0,geometry:'polygon',attributes:normalizeMapboxEnvironment('water',{}),paths:[[[512,512],[3584,512],[3584,3584],[512,3584]]]}]}]});
 const all=tiles.map(t=>t===center?modified:{...t,features:[]});const p=buildWaterSurfaceProfile(all,all.map(prepareWaterGeometry),sourceHeight,'a'.repeat(64));
 assert.equal(p.footprints.filter(f=>f.kind==='CLOSED_STANDING_WATER').length,1);assert.equal(p.footprints[0].level,10);
});
