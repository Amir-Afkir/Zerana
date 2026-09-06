import test from 'node:test';
import assert from 'node:assert/strict';
import { HydroConditionedElevationSource,HYDRO_POLICY,HYDRO_VERSION,smoothQuintic,metricFactors } from '../dist/generation/hydro/conditioned-elevation.js';
import { certifyHydroTriangles } from '../dist/generation/hydro/certificate.js';
import { deferHydroCrossings } from '../dist/generation/hydro/crossings.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { buildWaterSurface,assertWaterReadSets,validateWaterPacket } from '../dist/generation/water/surface.js';
import { cellId } from '../dist/geo/mercator-cell-scheme.js';
import { projectMercator,unprojectMercator } from '../dist/geo/mercator.js';
import { geodeticRadians } from '../dist/geo/geodetic.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { threeLocalToEcef } from '../dist/geo/three-frame.js';
import { meters } from '../dist/geo/units.js';
import { fraction,box,value } from '../dist/generation/roads/exact.js';
import { rectangle,bounds } from '../dist/generation/water/geometry.js';
import { measureTerrainSeams } from '../dist/debug/seam-metrics.js';
const revision='a'.repeat(64),z=16,x=32768,y=32768,n=2**z,core=[x/n,y/n,(x+1)/n,(y+1)/n];
const ring=(a,b,c,d)=>[[a,b],[c,b],[c,d],[a,d]];
const footprint={key:'closed',kind:'CLOSED_STANDING_WATER',rings:[ring(...core)],core,level:10};
const profile=(extra={})=>({revision,verticalReference:'ELLIPSOIDAL_WGS84',authority:'estimated-not-hydraulically-qualified',footprints:[footprint],levelAt:()=>10,...extra});
const geo=(u,v)=>{const g=unprojectMercator({u,v});return geodeticRadians(g.longitudeRad,g.latitudeRad,meters(0));};
const raw=(fn=()=>12)=>Object.freeze({id:'synthetic-hydro-fixture-v1',verticalReference:'ELLIPSOIDAL_WGS84',provenance:'synthetic',heightAt:p=>{const m=projectMercator(p.longitudeRad,p.latitudeRad);return meters(fn(m.u,m.v));}});
const region=()=>{const c=box(z,x,y);return {key:'fixture',z,x,y,geometry:{z,x,y,core:c,sourceKey:`16/${x}/${y}@${revision}`,primitives:[{polygon:rectangle(c),bounds:c,key:'water',kind:'area',basinKey:null}],basins:[],deferredWaterways:0},levels:new Float64Array(289).fill(10),basinLevels:new Map(),sourceTiles:[],verticalReference:'ELLIPSOIDAL_WGS84',heightAuthority:'estimated-not-hydraulically-qualified'};};
const cell=(dx=3,dy=3)=>cellId(19,x*8+dx,y*8+dy);
const build=(source,id=cell())=>buildTerrainCell(id,new TerrainSampler(source),32);
function water(t,r=region()){return buildWaterSurface(r,t,[],{hydroRevision:revision});}

test('hydro closed lake: four WorldCells share one exact level and triangle certificate',()=>{
 const source=new HydroConditionedElevationSource(raw(),profile());
 for(const id of [cell(),cell(4,3),cell(3,4),cell(4,4)]){
  const t=build(source,id),w=water(t),proof=certifyHydroTriangles(t,w);
  assert.equal(w.minLevelMeters,10);assert.equal(w.maxLevelMeters,10);assert.equal(w.renderLiftMeters,0);
  assert.ok(proof.passed);assert.ok(proof.maxTerrainAboveWaterMeters<-.49);assert.ok(proof.testedVertices>0);
 }
});
test('hydro removes an interior DEM bump before meshing, not with a water offset',()=>{
 const mid=(x+.5)/n;const r=raw((u,v)=>8+4*Math.exp(-((u-mid)**2+(v-mid)**2)/(1e-7**2)));
 const original=build(r,cell(4,4));
 const oldWater=buildWaterSurface(region(),original);assert.equal(certifyHydroTriangles(original,oldWater).passed,false);
 const source=new HydroConditionedElevationSource(r,profile()),t=build(source,cell(4,4)),w=water(t);
 assert.ok(Math.max(...t.heightsMeters)<=9.5);assert.ok(certifyHydroTriangles(t,w).passed);
 assert.equal(r.heightAt(geo(mid,mid)),12);
});
test('hydro derived source preserves the raw object and deep natural bottoms',()=>{
 const r=raw(()=>-4),source=new HydroConditionedElevationSource(r,profile());
 assert.equal(source.heightAt(geo((x+.5)/n,(y+.5)/n)),-4);assert.equal(r.id,'synthetic-hydro-fixture-v1');assert.ok(Object.isFrozen(r));
});
test('hydro flowing profile is non-horizontal and shared across cells',()=>{
 const slope=(u)=>10+(u-(x+.5)/n)*metricFactors((y+.5)/n)[0]*.01;
 const f={...footprint,kind:'FLOWING_WATER',level:null};
 const source=new HydroConditionedElevationSource(raw(()=>12),profile({footprints:[f],levelAt:slope}));
 const a=source.sample(geo((x+.4)/n,(y+.4)/n)),b=source.sample(geo((x+.6)/n,(y+.4)/n));
 assert.ok(b.waterHeightMeters>a.waterHeightMeters);assert.ok(a.heightMeters<=a.waterHeightMeters-.5);
});
test('hydro bank falloff is metric, smooth, bounded and exactly raw beyond its support',()=>{
 const v=(y+.5)/n,m=metricFactors(v)[0],edge=(x+.25)/n;
 const f={...footprint,rings:[ring(edge,(y+.1)/n,(x+.8)/n,(y+.9)/n)]};
 const source=new HydroConditionedElevationSource(raw(),profile({footprints:[f]}));
 const h=d=>source.sampleUV(edge-d/m,v,12).heightMeters;
 assert.equal(h(3),9.5);assert.ok(h(7)>h(4));assert.equal(h(11),12);
 assert.equal(smoothQuintic(-1),0);assert.equal(smoothQuintic(2),1);assert.ok(Math.abs((smoothQuintic(1e-5)-smoothQuintic(0))/1e-5)<1e-8);
});
test('hydro explicit island is never lowered, even inside the falloff support',()=>{
 const mid=(x+.5)/n,hole=ring(mid-1e-7,mid-1e-7,mid+1e-7,mid+1e-7).reverse();
 const source=new HydroConditionedElevationSource(raw(()=>15),profile({footprints:[{...footprint,rings:[footprint.rings[0],hole]}]}));
 const sample=source.sampleUV(mid,mid,15);assert.equal(sample.heightMeters,15);assert.equal(sample.island,true);assert.equal(sample.alpha,0);
});
test('hydro island crossing a WorldCell edge is unchanged from either source invocation',()=>{
 const u=(x+.5)/n,v=(y+.5)/n,hole=ring(u-1e-7,v-2e-7,u+1e-7,v+2e-7).reverse();
 const f={...footprint,rings:[footprint.rings[0],hole]},a=new HydroConditionedElevationSource(raw(()=>15),profile({footprints:[f]})),b=new HydroConditionedElevationSource(raw(()=>15),profile({footprints:[f]}));
 for(const p of [geo(u,v),geo(u,v+1e-7)])assert.equal(a.heightAt(p),b.heightAt(p));
 assert.equal(a.heightAt(geo(u,v)),15);
});
test('hydro shoreline/cell boundary is not itself a bank or a zero-level fallback',()=>{
 const source=new HydroConditionedElevationSource(raw(),profile());
 assert.equal(source.sampleUV(core[0],(y+.5)/n,12).heightMeters,9.5);
});
test('hydro request and footprint iteration order do not change common samples',()=>{
 const a=footprint,b={...footprint,key:'other',kind:'FLOWING_WATER',level:null};
 const aa=new HydroConditionedElevationSource(raw(),profile({footprints:[a,b]})),bb=new HydroConditionedElevationSource(raw(),profile({footprints:[b,a]}));
 assert.deepEqual(build(aa).heightsMeters,build(bb).heightsMeters);
});
test('hydro one global sample has one height and common normals',()=>{
 const source=new HydroConditionedElevationSource(raw(),profile()),a=build(source),b=build(source,cell(4,3));
 for(let j=0;j<=32;j++){assert.equal(a.heightsMeters[j*33+32],b.heightsMeters[j*33]);assert.equal(a.sampleKeys[j*33+32],b.sampleKeys[j*33]);}
 const seams=measureTerrainSeams([a,b],a.anchor);assert.equal(seams.mismatchedKeys,0);assert.ok(seams.maxGapMeters<.001);assert.ok(seams.maxNormalDelta<.001);
});
test('hydro rebuilding after cache eviction is deterministic',()=>{
 const a=build(new HydroConditionedElevationSource(raw(),profile())),b=build(new HydroConditionedElevationSource(raw(),profile()));
 assert.deepEqual(a.positions,b.positions);assert.deepEqual(a.normals,b.normals);
});
test('hydro rebase changes only the local frame, not ECEF ground',()=>{
 const t=build(new HydroConditionedElevationSource(raw(),profile())),p=[...t.positions.slice(0,3)],ecef=threeLocalToEcef(p,t.anchor);
 const anchor=createGeoAnchor(geo((x+.75)/n,(y+.5)/n));assert.notDeepEqual(anchor,t.anchor);
 assert.deepEqual(threeLocalToEcef(p,t.anchor),ecef);
});
test('hydro incompatible DEM revisions fail closed',()=>{
 assert.throws(()=>assertWaterReadSets([{layer:'elevation',tile:'15/1/1',sha256:revision}],[[{layer:'elevation',tile:'15/1/1',sha256:'b'.repeat(64)}]]),/CONFLICT/);
});
test('hydro incompatible vector revisions fail closed',()=>{
 assert.throws(()=>assertWaterReadSets([{layer:'vector',tile:'16/1/1',sha256:revision}],[[{layer:'vector',tile:'16/1/1',sha256:'b'.repeat(64)}]]),/CONFLICT/);
});
test('hydro keeps known bridge and tunnel strata, marks an ambiguous ground crossing',()=>{
 const pt=(u,v)=>({u:fraction(Math.round(u*2**32),2**32),v:fraction(Math.round(v*2**32),2**32)}),a=pt(core[0],(y+.5)/n),b=pt(core[2],(y+.5)/n);
 const edge=structure=>({key:structure,a,b,context:[a,b],attributes:{structure},evidence:[]});
 const input={edges:['bridge','tunnel','ground'].map(edge),nodes:[]},g=region().geometry;
 const r=deferHydroCrossings(input,[g]);assert.equal(r.deferredStructures,1);
 assert.equal(r.graph.edges[0],input.edges[0]);assert.equal(r.graph.edges[1],input.edges[1]);assert.equal(r.graph.edges[2].attributes.structure,'unknown');
});
test('hydro budget and vertical authority do not silently fall back to raw',()=>{
 assert.throws(()=>new HydroConditionedElevationSource(raw(),profile({verticalReference:'UNRESOLVED_DATUM_PREVIEW'})),/DATUM/);
 const source=new HydroConditionedElevationSource(raw(()=>100),profile());assert.throws(()=>source.heightAt(geo((x+.5)/n,(y+.5)/n)),/CLEARANCE_LIMIT/);
 assert.throws(()=>new HydroConditionedElevationSource(raw(),profile({footprints:Array(16385).fill(footprint)})),/BUDGET/);
});
test('hydro certificate finds a peak inside water although every water vertex is safe',()=>{
 // Four terrain triangles with an interior peak; a single water triangle has
 // all three vertices below water but covers the peak between them.
 const t={sourceId:'proof-fixture',positions:new Float32Array([0,0,0,10,0,0,10,0,10,0,0,10,5,2,5]),indices:new Uint32Array([0,1,4,1,2,4,2,3,4,3,0,4]),bounds:{min:[0,0,0],max:[10,2,10]}};
 const w={terrainSourceId:t.sourceId,positions:new Float32Array([1,1,1,9,1,1,5,1,9]),indices:new Uint32Array([0,1,2]),triangleCount:1};
 // Terrain heights at water vertices are 0.4 m; the interior peak is 2 m.
 const proof=certifyHydroTriangles(t,w);assert.equal(proof.passed,false);assert.ok(proof.maxTerrainAboveWaterMeters>.99);assert.ok(proof.testedIntersections>=3);
});
test('hydro conditioned water requires the exact source revision and zero render lift',()=>{
 const t=build(new HydroConditionedElevationSource(raw(),profile())),w=water(t);
 assert.throws(()=>validateWaterPacket({...w,hydroRevision:'b'.repeat(64)},t),/CONTRACT/);
 assert.throws(()=>validateWaterPacket({...w,renderLiftMeters:.03},t),/CONTRACT/);
 assert.equal(HYDRO_VERSION,HYDRO_POLICY.version);
});

test('hydro certificate refuses a water triangle with no terrain support coverage',()=>{
 const t={sourceId:'coverage',positions:new Float32Array([0,0,0,1,0,0,0,0,1]),indices:new Uint32Array([0,1,2]),bounds:{min:[0,0,0],max:[1,0,1]}};
 const w={terrainSourceId:t.sourceId,positions:new Float32Array([0,1,0,2,1,0,0,1,2]),indices:new Uint32Array([0,1,2]),triangleCount:1};
 assert.throws(()=>certifyHydroTriangles(t,w),/COVERAGE/);
});
