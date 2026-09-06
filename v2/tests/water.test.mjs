import test from 'node:test';
import assert from 'node:assert/strict';
import { fraction,value,box } from '../dist/generation/roads/exact.js';
import { rectangle,area2,partition,intersect,bounds } from '../dist/generation/water/geometry.js';
import { buildHydroRegion,hydroLevel } from '../dist/generation/water/hydro.js';
import { buildWaterSurface,validateWaterPacket,waterPacketBytes,assertWaterReadSets } from '../dist/generation/water/surface.js';
import { WATER_LIMITS as L } from '../dist/generation/water/model.js';
import { canonicalizeEnvironmentTile } from '../dist/generation/environment/kernel.js';
import { normalizeMapboxEnvironment } from '../dist/providers/vectors/mapbox-environment.js';
import { cellId } from '../dist/geo/mercator-cell-scheme.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { threeLocalToEcef } from '../dist/geo/three-frame.js';
import { ecefToGeodetic } from '../dist/geo/ecef.js';
import { projectMercator } from '../dist/geo/mercator.js';
const z=16,x=32768,y=32768;
const rect=(w,n,e,s)=>rectangle({west:fraction(w),north:fraction(n),east:fraction(e),south:fraction(s)});
function geometry(xx=x,yy=y){const core=box(z,xx,yy),p=rectangle(core);return {z,x:xx,y:yy,core,sourceKey:`16/${xx}/${yy}@${'a'.repeat(64)}`,primitives:[{polygon:p,bounds:core,key:'area',kind:'area',basinKey:null}],basins:[],deferredWaterways:0};}
function tiles(xx=x,yy=y){return Array.from({length:9},(_,i)=>{
 const tx=(xx+i%3-1+65536)%65536,ty=yy+Math.floor(i/3)-1;
 return canonicalizeEnvironmentTile({z,x:tx,y:ty,providerId:'fixture',version:'1',digest:'a'.repeat(64),layers:[{name:'water',extent:4096,state:'present',features:[{sourceIndex:0,geometry:'polygon',attributes:normalizeMapboxEnvironment('water',{}),paths:[[[0,0],[4096,0],[4096,4096],[0,4096]]]}]}]});
});}
const source={id:'synthetic-water-height',verticalReference:'ELLIPSOIDAL_WGS84',provenance:'synthetic',heightAt:p=>{
 const uv=projectMercator(p.longitudeRad,p.latitudeRad);return 12+Math.sin(uv.u*400)*2+Math.cos(uv.v*200);}};
const terrain=id=>buildTerrainCell(id,new TerrainSampler(syntheticElevation('flat')),32);
const region=(g=geometry())=>buildHydroRegion(g,tiles(g.x,g.y),source);
const serial=p=>JSON.stringify(p,(_,v)=>typeof v==='bigint'?v.toString():v);

test('water exact partition conserves area and does not split disjoint or touching shapes',()=>{
 const a=rect(0,0,10,10);
 for(const b of [rect(20,20,30,30),rect(10,0,20,10)]){const p=partition(a,b);assert.equal(p.inside.length,0);assert.equal(p.outside.length,1);assert.equal(serial(p.outside[0]),serial(a));}
 const cut=partition(a,rect(2,3,7,8));assert.equal(value(area2(a)),value(area2(cut.inside))+cut.outside.reduce((s,p)=>s+value(area2(p)),0));
});
test('water exact rational cuts agree regardless of fragment and clipping order',()=>{
 const triangle=[{u:fraction(1,3),v:fraction(-2,5)},{u:fraction(7,3),v:fraction(2,7)},{u:fraction(-1,5),v:fraction(9,4)}];
 const a=rect(0,0,1,1),b=rect(0,0,2,2);
 assert.equal(value(area2(intersect(intersect(triangle,a),b))),value(area2(intersect(intersect(triangle,b),a))));
});
test('water regional nodes agree across source boundaries and reversed request order',()=>{
 const a=region(),b=region(geometry(x+1,y));
 for(let i=0;i<=L.gridDivisions;i++)assert.equal(a.levels[i*17+16],b.levels[i*17]);
 const reversed=buildHydroRegion(geometry(),tiles().reverse(),source);assert.deepEqual(a.levels,reversed.levels);
});
test('water region refuses missing coverage and nodata instead of inventing zero metres',()=>{
 assert.throws(()=>buildHydroRegion(geometry(),tiles().slice(1),source),/CONTEXT/);
 assert.throws(()=>buildHydroRegion(geometry(),tiles(),{...source,heightAt:()=>NaN}),/UNRESOLVED/);
});
test('water antimeridian nodes use the same wrapped source samples',()=>{
 const a=region(geometry(65535,y)),b=region(geometry(0,y));
 for(let i=0;i<=16;i++)assert.equal(a.levels[i*17+16],b.levels[i*17]);
});
test('water interpolated profiles preserve node heights and affine source gradients',()=>{
 const r=region();assert.equal(hydroLevel(r,x/65536,y/65536),r.levels[0]);
 assert.equal(hydroLevel(r,(x+1)/65536,(y+1)/65536),r.levels.at(-1));
 assert.throws(()=>hydroLevel(r,(x+2)/65536,y/65536),/OUTSIDE/);
});
test('water shared enclosed level stays constant across all four WorldCells',()=>{
 const g=geometry();g.primitives=g.primitives.map(p=>({...p,basinKey:'pond'}));
 const r={...region(g),basinLevels:new Map([['pond',17.5]])};
 for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
  const t=terrain(cellId(17,x*2+dx,y*2+dy)),before=t.positions.slice(),p=buildWaterSurface(r,t);
  assert.ok(p.triangleCount>0);assert.equal(p.minLevelMeters,17.5);assert.equal(p.maxLevelMeters,17.5);assert.deepEqual(before,t.positions);
  assert.equal(p.terrainModified,false);assert.equal(p.collidersAdded,0);assert.equal(p.swimming,false);
 }
});
test('water holes are never filled and duplicate area primitives do not double-fill',()=>{
 const g=geometry(),q=(a,b,c,d)=>rectangle({west:fraction(x*4+a,65536*4),north:fraction(y*4+b,65536*4),east:fraction(x*4+c,65536*4),south:fraction(y*4+d,65536*4)});
 const polys=[q(0,0,4,1),q(0,3,4,4),q(0,1,1,3),q(3,1,4,3)];
 g.primitives=polys.flatMap((p,i)=>[0,1].map(j=>({polygon:p,bounds:bounds(p),key:`${i}/${j}`,kind:'area',basinKey:null})));
 const r=region(g),t=terrain(cellId(16,x,y)),p=buildWaterSurface(r,t);assert.ok(p.triangleCount>0);
 for(let i=0;i<p.indices.length;i+=3){const center=[0,0,0];for(const idx of p.indices.slice(i,i+3))for(let j=0;j<3;j++)center[j]+=p.positions[idx*3+j]/3;
  const geo=ecefToGeodetic(threeLocalToEcef(center,t.anchor)),uv=projectMercator(geo.longitudeRad,geo.latitudeRad),u=uv.u*65536-x,v=uv.v*65536-y;
  assert.ok(!(u>.250001&&u<.749999&&v>.250001&&v<.749999));
 }
 g.primitives=g.primitives.filter((_,i)=>i%2===0);const single=buildWaterSurface(region(g),t);assert.equal(p.triangleCount,single.triangleCount);assert.equal(p.areaSquareMeters,single.areaSquareMeters);
});
test('water adjacent WorldCell border positions agree in ECEF under 1 mm',()=>{
 const r=region(),a=terrain(cellId(19,x*8+3,y*8+3)),b=terrain(cellId(19,x*8+4,y*8+3));
 const pa=buildWaterSurface(r,a),pb=buildWaterSurface(r,b),border=(x+0.5)/65536;
 const points=(p,t)=>Array.from({length:p.positions.length/3},(_,i)=>{
  const e=threeLocalToEcef([...p.positions.slice(i*3,i*3+3)],t.anchor),q=projectMercator(ecefToGeodetic(e).longitudeRad,ecefToGeodetic(e).latitudeRad);return {e,q};
 }).filter(p=>Math.abs(p.q.u-border)<1e-10);
 const aa=points(pa,a),bb=points(pb,b);assert.ok(aa.length&&bb.length);
 for(const p of aa)assert.ok(bb.some(q=>Math.hypot(p.e.xMeters-q.e.xMeters,p.e.yMeters-q.e.yMeters,p.e.zMeters-q.e.zMeters)<.001));
});
test('water packet validates bounds, datum and terrain revision without changing authority',()=>{
 const t=terrain(cellId(19,x*8+3,y*8+3)),p=buildWaterSurface(region(),t);validateWaterPacket(p,t);assert.ok(waterPacketBytes(p)<L.packetBytes);
 assert.throws(()=>validateWaterPacket({...p,terrainSourceId:'other'},t),/CONTRACT/);
 assert.throws(()=>validateWaterPacket({...p,verticalReference:'UNRESOLVED_DATUM_PREVIEW'},t),/CONTRACT/);
 assert.throws(()=>validateWaterPacket({...p,heightAuthority:'observed'},t),/CONTRACT/);
 const pos=p.positions.slice();pos[0]=NaN;assert.throws(()=>validateWaterPacket({...p,positions:pos},t),/CONTRACT/);
});
test('water readsets reject changed DEMs and vectors while allowing disjoint source footprints',()=>{
 const a={layer:'elevation',tile:'15/1/2',sha256:'a'.repeat(64)};
 assertWaterReadSets([a],[[a],[{...a,tile:'15/2/3',sha256:'b'.repeat(64)}]]);
 assert.throws(()=>assertWaterReadSets([a],[[{...a,sha256:'b'.repeat(64)}]]),/REVISION/);
 assert.throws(()=>assertWaterReadSets([{...a,tile:'15/999999/2'}],[]),/CONTRACT/);
});
test('water valid empty cells have no rendered geometry and no level claim',()=>{
 const g=geometry();g.primitives=[];const t=terrain(cellId(19,x*8,y*8)),p=buildWaterSurface(region(g),t);
 assert.equal(p.triangleCount,0);assert.equal(p.minLevelMeters,null);assert.equal(p.maxLevelMeters,null);validateWaterPacket(p,t);
});
test('water empty optional source layers are distinguished from missing source tiles',()=>{
 const context=tiles().map(t=>({...t,features:[],absentLayers:['water','waterway']}));
 const r=buildHydroRegion(geometry(),context,source);assert.equal(r.levels.length,289);assert.ok(r.levels.every(Number.isFinite));
});
test('water malformed region cannot produce partially unqualified geometry',()=>{
 const t=terrain(cellId(19,x*8,y*8)),r=region();
 for(const changed of [{...r,levels:new Float64Array(1)},{...r,heightAuthority:'measured'},{...r,verticalReference:'UNRESOLVED_DATUM_PREVIEW'}])assert.throws(()=>buildWaterSurface(changed,t),/REGION_CONTRACT/);
});
