import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeEnvironmentTile } from '../../src/generation/environment/kernel.ts';
import { normalizeMapboxEnvironment } from '../../src/providers/vectors/mapbox-environment.ts';
import { WaterSource } from '../../demo/water/source.mjs';
import { prepareWaterGeometry } from '../../demo/water/prepare.mjs';
import { buildHydroRegion } from '../../src/generation/water/hydro.ts';
import { buildWaterSurface } from '../../src/generation/water/surface.ts';
import { buildTerrainCell } from '../../src/generation/terrain/terrain-builder.ts';
import { TerrainSampler } from '../../src/generation/terrain/terrain-sampler.ts';
import { syntheticElevation } from '../../src/generation/terrain/synthetic-elevation.ts';
import { cellId } from '../../src/geo/mercator-cell-scheme.ts';
import { area2 } from '../../src/generation/water/geometry.ts';
import { value } from '../../src/generation/roads/exact.ts';
const ring=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
function tile(x=32768,y=32768,{empty=false,line=false,intermittent=false}={}){
 return canonicalizeEnvironmentTile({z:16,x,y,providerId:'fixture',version:'1',digest:'a'.repeat(64),layers:[
  {name:'water',extent:4096,state:'present',features:empty?[]:[{sourceIndex:0,geometry:'polygon',attributes:normalizeMapboxEnvironment('water',{}),paths:[ring(128,128,3840,3840),ring(1000,1000,600,600).reverse()]}]},
  {name:'waterway',extent:4096,state:'present',features:line?[{sourceIndex:0,geometry:'line',attributes:normalizeMapboxEnvironment('waterway',{class:intermittent?'stream_intermittent':'stream'}),paths:[[[0,2048],[4096,2048]]]}]:[]}
 ]});
}
function context(options={}){return Array.from({length:9},(_,i)=>tile(32767+i%3,32767+Math.floor(i/3),options));}
const t=id=>buildTerrainCell(id,new TerrainSampler(syntheticElevation('flat')),32);
const terrain=t(cellId(19,262148,262148));
const sig=()=>new AbortController().signal;
function input(extra={}){return {tiles:context(),terrain,source:'mapbox',profile:'flat',token:'pk.fixture',signal:sig(),...extra};}
const heights={id:'fixture/dem',verticalReference:'UNRESOLVED_DATUM_PREVIEW',provenance:'estimated',heightAt:()=>11};
const preview={...terrain,verticalReference:'UNRESOLVED_DATUM_PREVIEW',altitudeAuthority:'preview-only',sourceId:'mapbox.terrain-rgb/fixture/unresolved-preview-v1'};

test('water Earcut triangulates the original polygon and island without filling its hole',()=>{
 const g=prepareWaterGeometry(tile()),area=g.primitives.reduce((s,p)=>s+value(area2(p.polygon)),0);
 assert.ok(Math.abs(area-(3840**2-600**2)*2/(4096*65536)**2)<1e-20);assert.equal(g.basins.length,1);
});
test('water closed footprint is shared at one level; flowing axes avoid false lake classification',()=>{
 const g=prepareWaterGeometry(tile()),r=buildHydroRegion(g,context(),syntheticElevation('flat'));
 assert.equal(r.basinLevels.size,1);assert.equal([...r.basinLevels.values()][0],0);
 assert.equal(prepareWaterGeometry(tile(32768,32768,{line:true})).basins.length,0);
});
test('water geometry clips source buffers without adding water outside the source core',()=>{
 const raw=tile();const g=prepareWaterGeometry(raw);
 for(const p of g.primitives)for(const q of p.polygon){assert.ok(value(q.u)>=32768/65536&&value(q.u)<=32769/65536);assert.ok(value(q.v)>=32768/65536&&value(q.v)<=32769/65536);}
});
test('water small waterway widths stay metric at equator and high latitude',()=>{
 for(const y of [32768,22000,10000]){
  const g=prepareWaterGeometry(tile(32768,y,{empty:true,line:true})),p=g.primitives.find(p=>p.kind==='waterway'&&!p.key.includes('/cap/'));
  const vv=(y+.5)/65536,lat=Math.atan(Math.sinh(Math.PI*(1-2*vv))),s=Math.sin(lat),q=1-.0066943799901413165*s*s;
  const metric=2*Math.PI*6378137*(1-.0066943799901413165)/q**1.5*Math.cos(lat);
  const width=(Math.max(...p.polygon.map(p=>value(p.v)))-Math.min(...p.polygon.map(p=>value(p.v))))*metric;
  assert.ok(Math.abs(width-1.5)<.0001,`${width}`);
 }
});
test('water intermittent streams remain explicitly deferred rather than always wet',()=>{
 const g=prepareWaterGeometry(tile(32768,32768,{empty:true,line:true,intermittent:true}));assert.equal(g.primitives.length,0);assert.equal(g.deferredWaterways,1);
});
test('water area and line overlap is a disjoint mesh union, not double transparency',()=>{
 const owner=tile(32768,32768,{line:true}),g=prepareWaterGeometry(owner),r=buildHydroRegion(g,context({line:true}),syntheticElevation('flat'));
 const p=buildWaterSurface(r,terrain);assert.ok(p.triangleCount>0);assert.ok(p.triangleCount<20000);assert.ok(p.areaSquareMeters>0);
});
test('water source prepares one geographic region and reuses it for neighbouring cells and returns',async()=>{
 let calls=0;const source=new WaterSource(async options=>{calls++;assert.equal(options.cells.length,9);assert.equal(options.layers,'terrain');options.onHttpAttempt();return {source:heights,evidence:[{layer:'elevation',tile:'15/16384/16384',sha256:'b'.repeat(64)}],attributions:[]};});
 let attempts=0;const a=await source.build(input({terrain:preview,onAttempt:()=>attempts++}));
 const b=await source.build(input({terrain:{...t(cellId(19,262149,262148)),sourceId:preview.sourceId,verticalReference:preview.verticalReference},onAttempt:()=>attempts++}));
 const c=await source.build(input({terrain:preview,onAttempt:()=>attempts++}));
 assert.equal(calls,1);assert.equal(attempts,1);assert.equal(source.built,1);assert.equal(a.packet.regionKey,b.packet.regionKey);assert.deepEqual(c.packet.positions,a.packet.positions);
});
test('water empty cells do not request elevation and have no asserted water level',async()=>{
 const s=new WaterSource(()=>{throw Error('HTTP not permitted');});const r=await s.build(input({tiles:context({empty:true})}));
 assert.equal(r.packet.triangleCount,0);assert.equal(r.packet.minLevelMeters,null);assert.equal(s.built,0);
});
test('water source rejects changed DEM evidence, cancellation and exhausted quota',async()=>{
 const s=new WaterSource(async options=>{options.onHttpAttempt();return {source:heights,evidence:[{layer:'elevation',tile:'15/16384/16384',sha256:'b'.repeat(64)}],attributions:[]};});
 await assert.rejects(s.build(input({terrain:preview,onAttempt:()=>{throw Error('WATER_HTTP_BUDGET');}})),/BUDGET/);
 assert.equal(s.built,0);
 await assert.rejects(s.build(input({terrain:preview,evidence:[{layer:'elevation',tile:'15/16384/16384',sha256:'c'.repeat(64)}]})),/REVISION/);
 const c=new AbortController();c.abort();await assert.rejects(s.build(input({signal:c.signal})),e=>e.name==='AbortError');
});
test('water credential changes clear derived regions as well as raw session cache',async()=>{
 let calls=0;const s=new WaterSource(async()=>{calls++;return {source:heights,evidence:[],attributions:[]};});
 await s.build(input({terrain:preview}));await s.build(input({terrain:preview,token:'pk.different'}));assert.equal(calls,2);assert.equal(s.built,1);
});
test('water fetched dry context tiles do not incorrectly invalidate a neighbouring mapped pond',async()=>{
 let calls=0;const s=new WaterSource(async()=>{calls++;return {source:heights,evidence:[],attributions:[]};});
 const tiles=context().map((t,i)=>i===4?t:{...t,features:[],absentLayers:['water','waterway']});
 const result=await s.build(input({terrain:preview,tiles}));assert.ok(result.packet.triangleCount>0);assert.equal(calls,1);
});
test('water empty geometry cache is bounded and reset with the source session',async()=>{
 const s=new WaterSource(()=>{throw Error('unexpected DEM');});await s.build(input({tiles:context({empty:true})}));
 const bytes=s.bytes;assert.ok(bytes>0);await s.build(input({tiles:context({empty:true})}));assert.equal(s.bytes,bytes);
});
