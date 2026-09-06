import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRealEngineeringRegion,engineeringRegionAt,engineeringRegionsForCell } from '../dist/generation/roads/real-engineering.js';
import { canonicalReadSet,assertReadSetsCompatible } from '../dist/generation/roads/snapshot-readset.js';
import { buildRoadGraph } from '../dist/generation/roads/kernel.js';
import { normalizeMapboxRoad } from '../dist/providers/vectors/mapbox-roads.js';
import { MercatorCellScheme,cellId } from '../dist/geo/mercator-cell-scheme.js';
import { geodeticDegrees,geodeticRadians } from '../dist/geo/geodetic.js';
import { meters,degrees } from '../dist/geo/units.js';
import { unprojectMercator } from '../dist/geo/mercator.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { measureTerrainSeams } from '../dist/debug/seam-metrics.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { geodeticToEcef,ecefToGeodetic } from '../dist/geo/ecef.js';
import { ecefToThreeLocal,threeLocalToEcef } from '../dist/geo/three-frame.js';
import { TerrainPhysics } from '../dist/physics/terrain-physics.js';
const scheme=new MercatorCellScheme(),region=engineeringRegionAt(geodeticDegrees(degrees(2.35),degrees(48.86),meters(0))),rev='a'.repeat(64),n=2**16;
const point=(x,y,id=region)=>{const p=unprojectMercator({u:(id.x+x)/n,v:(id.y+y)/n});return geodeticRadians(p.longitudeRad,p.latitudeRad,meters(0));};
const anchor=createGeoAnchor(scheme.getCenter(region));
const source=(rough=true)=>({id:'synthetic-regional-reference-v1',verticalReference:'ELLIPSOIDAL_WGS84',provenance:'synthetic',
 heightAt(p){const v=ecefToThreeLocal(geodeticToEcef(geodeticRadians(p.longitudeRad,p.latitudeRad,meters(0))),anchor);return meters(30+(rough?.65*Math.sin(v[0]/3):0)+.004*v[0]);}});
function graph({cross=false,structure='none',layer=0,reverse=false}={}){
 const tiles=[];
 for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
  const lines=[[[-4096,2048-dy*4096],[2048,2048-dy*4096],[8192,2048-dy*4096]]];
  if(cross)lines.push([[2048-dx*4096,-4096],[2048-dx*4096,2048],[2048-dx*4096,8192]]);
  const valid=lines.filter(line=>line.every(p=>p.every(v=>v>=-4096&&v<=8192)));
  tiles.push({z:16,x:region.x+dx,y:region.y+dy,extent:4096,providerId:'fixture',version:'1',digest:rev,
   features:valid.map(line=>({attributes:normalizeMapboxRoad({class:'primary',type:'primary',structure,layer,oneway:'false',surface:'paved'}),lines:[reverse?[...line].reverse():line]}))});
 }
 return buildRoadGraph(reverse?tiles.reverse():tiles);
}
test('real-road compiler yields estimated profiles without a WorldCell input',()=>{
 const r=buildRealEngineeringRegion(region,graph(),source(),rev);
 assert.ok(r.diagnostics.accepted>0,JSON.stringify(r.diagnostics));assert.equal(r.diagnostics.authority,'estimated-game-earthwork');
 assert.equal(r.diagnostics.qualifiedForDriving,false);assert.equal(r.diagnostics.boundaryMode,'fixed-raw-collar');
 const mid=r.sample(point(.45,.5));assert.ok(Math.abs(mid.deltaMeters)>.1,JSON.stringify(mid));
 assert.ok(Math.abs(mid.deltaMeters)<=3);
});
test('reversed source geometry and tile order produce the identical field',()=>{
 const a=buildRealEngineeringRegion(region,graph(),source(),rev),b=buildRealEngineeringRegion(region,graph({reverse:true}),source(),rev);
 assert.deepEqual(a.diagnostics,b.diagnostics);
 for(let i=1;i<50;i++)assert.deepEqual(a.sample(point(i/50,.5)),b.sample(point(i/50,.5)));
});
test('fixed regional collar returns to the raw DEM at the same geographic border',()=>{
 const r=buildRealEngineeringRegion(region,graph(),source(),rev);
 for(const x of [0,1e-8,.99999999])assert.ok(Math.abs(r.sample(point(x,.5)).deltaMeters)<1e-8);
 assert.throws(()=>r.sample(point(1.1,.5)),/OWNERSHIP/);
});
test('junction plane shares altitude and zero local slope instead of averaging independent road ends',()=>{
 const raw=source(false),r=buildRealEngineeringRegion(region,graph({cross:true}),raw,rev);
 assert.ok(r.diagnostics.junctions>0,JSON.stringify(r.diagnostics));
 const center=r.sample(point(.5,.5));
 assert.ok(Math.abs(center.heightMeters-raw.heightAt(point(.5,.5)))<1e-5);
 for(const xy of [[.5005,.5],[.4995,.5],[.5,.5005],[.5,.4995]])assert.ok(Math.abs(r.sample(point(...xy)).heightMeters-center.heightMeters)<1e-6);
});
for(const structure of ['bridge','tunnel','ford','future'])test(`no earthwork is invented for ${structure}`,()=>{
 const r=buildRealEngineeringRegion(region,graph({structure}),source(),rev);
 assert.equal(r.diagnostics.accepted,0);assert.equal(r.sample(point(.5,.5)).deltaMeters,0);
});
test('known nonzero layer is excluded; unknown drawing layer is not rewritten as zero',()=>{
 assert.equal(buildRealEngineeringRegion(region,graph({layer:1}),source(),rev).diagnostics.accepted,0);
 const r=buildRealEngineeringRegion(region,graph({layer:null}),source(),rev);assert.equal(r.diagnostics.topologyAuthority,'cartographic-not-routable');
});
test('excessive longitudinal terrain changes are refused rather than clamped',()=>{
 const r=buildRealEngineeringRegion(region,graph(),{...source(),heightAt:p=>meters(20*source().heightAt(p))},rev);
 assert.equal(r.diagnostics.accepted,0);assert.ok(Object.keys(r.diagnostics.deferred).some(k=>k.startsWith('STRUCTURE_REQUIRED')));
});
test('cell planning covers the exact halo and refuses coarse physical resolution',()=>{
 assert.throws(()=>engineeringRegionsForCell(cellId(17,0,0),32),/RESOLUTION/);
 assert.throws(()=>engineeringRegionsForCell(cellId(19,0,0),16),/RESOLUTION/);
 for(const id of [cellId(19,region.x*8,region.y*8),cellId(21,2**21-1,2**20)]){
  const regions=engineeringRegionsForCell(id,32),keys=new Set(regions.map(r=>`${r.x}/${r.y}`));assert.ok(regions.length<=4);
  for(let y=-1;y<=33;y++)for(let x=-1;x<=33;x++){
   const p=unprojectMercator({u:((id.x+x/32)/2**id.level+1)%1,v:(id.y+y/32)/2**id.level});
   const owner=engineeringRegionAt(geodeticRadians(p.longitudeRad,p.latitudeRad,meters(0)));
   assert.ok(keys.has(`${owner.x}/${owner.y}`));
  }
 }
});
test('content readsets are canonical, bounded and reject different bytes for the same source tile',()=>{
 const a={layer:'elevation',tile:'15/1/2',sha256:rev},b={layer:'road',tile:'16/2/4',sha256:'b'.repeat(64)};
 assert.deepEqual(canonicalReadSet([b,a,a]),canonicalReadSet([a,b]));
 assertReadSetsCompatible([a],[[a,b]]);
 assert.throws(()=>assertReadSetsCompatible([a],[[{...a,sha256:'c'.repeat(64)}]]),/REVISION_CONFLICT/);
 assert.throws(()=>canonicalReadSet(Array(257).fill(a)),/BUDGET/);
 for(const bad of [{...a,tile:'16/99999999/2'},{...a,sha256:'no'},{...a,layer:'untrusted'}])assert.throws(()=>canonicalReadSet([bad]),/CONTRACT/);
});
test('real-data adapter retains an explicitly unresolved datum instead of certifying it',()=>{
 const r=buildRealEngineeringRegion(region,graph(),{...source(),verticalReference:'UNRESOLVED_DATUM_PREVIEW',provenance:'estimated'},rev);
 assert.equal(r.raw.verticalReference,'UNRESOLVED_DATUM_PREVIEW');assert.ok(r.diagnostics.accepted>0);
});
test('independently generated adjacent WorldCells share physical engineered ground',t=>{
 const raw=source(),r=buildRealEngineeringRegion(region,graph(),raw,rev);
 const field={...raw,id:'synthetic-engineered-field-v1',heightAt:p=>meters(r.sample(p).heightMeters)};
 const ids=[cellId(19,region.x*8+3,region.y*8+3),cellId(19,region.x*8+4,region.y*8+3),cellId(19,region.x*8+3,region.y*8+4),cellId(19,region.x*8+4,region.y*8+4)];
 const build=id=>{const s=new TerrainSampler(field);const p=buildTerrainCell(id,s,32);s.clear();return p;};
 const packets=ids.map(build),reversed=ids.slice().reverse().map(build).reverse();
 for(let i=0;i<4;i++){assert.deepEqual(packets[i].positions,reversed[i].positions);assert.deepEqual(packets[i].normals,reversed[i].normals);}
 const seams=measureTerrainSeams(packets,packets[0].anchor);assert.ok(seams.maxGapMeters<.001);assert.ok(seams.maxNormalDelta<.001);
 const physics=new TerrainPhysics(packets,anchor);let maxError=0;
 try {for(let i=0;i<40;i++){
   const g=point(.4+i*.005,.5),height=field.heightAt(g);
   const hi=ecefToThreeLocal(geodeticToEcef(geodeticRadians(g.longitudeRad,g.latitudeRad,meters(height+5))),anchor);
   const lo=ecefToThreeLocal(geodeticToEcef(geodeticRadians(g.longitudeRad,g.latitudeRad,meters(height))),anchor);
   const hit=physics.raycast(hi,lo.map((v,k)=>v-hi[k]),10);assert.ok(hit);maxError=Math.max(maxError,Math.abs(hit.distance-5));
 }}finally{physics.dispose();}
 assert.ok(maxError<.15,`measured mesh/analytic error ${maxError}`);t.diagnostic(JSON.stringify({maxError,seams}));
});

test('independent fixed-region recipes meet through the raw collar without a cell seam',()=>{
 const raw=source(),east=cellId(16,region.x+1,region.y),g=graph();
 const recipes=new Map([region,east].map(id=>[`${id.x}/${id.y}`,buildRealEngineeringRegion(id,g,raw,rev)]));
 const field={...raw,id:'synthetic-multiple-real-recipes',heightAt:p=>{const id=engineeringRegionAt(p);return meters(recipes.get(`${id.x}/${id.y}`).sample(p).heightMeters);}};
 const ids=[cellId(19,region.x*8+7,region.y*8+4),cellId(19,(region.x+1)*8,region.y*8+4)];
 const packets=ids.map(id=>{const sampler=new TerrainSampler(field);try{return buildTerrainCell(id,sampler,32);}finally{sampler.clear();}});
 const seams=measureTerrainSeams(packets,packets[0].anchor);
 assert.equal(seams.edgePairs,1);assert.ok(seams.maxGapMeters<.001);assert.ok(seams.maxNormalDelta<.001);
 for(const x of [.9999999,1,1.0000001]){const p=point(x,.5),id=engineeringRegionAt(p);assert.ok(Math.abs(recipes.get(`${id.x}/${id.y}`).sample(p).deltaMeters)<1e-7);}
});

test('a shallow polyline turn has no nearest-segment height jump at its bisector',()=>{
 const attributes=normalizeMapboxRoad({class:'primary',type:'primary',structure:'none',layer:0,surface:'paved'});
 const g=buildRoadGraph([{z:16,x:region.x,y:region.y,extent:4096,providerId:'fixture',version:'1',digest:rev,
  features:[{attributes,lines:[[[500,2048],[2048,2048],[3500,2100]]]}]}]);
 const r=buildRealEngineeringRegion(region,g,source(false),rev);assert.ok(r.diagnostics.accepted>0,JSON.stringify(r.diagnostics));
 let largest=0;
 for(let y=-30;y<=30;y++){
  const a=r.sample(point(.5-1e-7,.5+y/4096)),b=r.sample(point(.5+1e-7,.5+y/4096));
  largest=Math.max(largest,Math.abs(a.heightMeters-b.heightMeters));
 }
 assert.ok(largest<.00001,`continuous projection blend difference ${largest}`);
});

test('malformed source revision cannot establish a geographic recipe identity',()=>{
 for(const revision of ['', 'not-a-digest', 'g'.repeat(64)])assert.throws(()=>buildRealEngineeringRegion(region,graph(),source(),revision),/CONTRACT/);
 assert.throws(()=>canonicalReadSet([{layer:'road',tile:'16/02/4',sha256:rev}]),/CONTRACT/);
});
