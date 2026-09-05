import test from 'node:test';
import assert from 'node:assert/strict';
import {fraction,add,sub,mul,div,key,value,pointKey,clip,box} from '../dist/generation/roads/exact.js';
import {buildRoadGraph,clipRoadGraph,roadPointGeodetic} from '../dist/generation/roads/kernel.js';
import {buildRoadDebugPackets} from '../dist/generation/roads/debug-packet.js';
import {normalizeMapboxRoad} from '../dist/providers/vectors/mapbox-roads.js';
import {cellId} from '../dist/geo/mercator-cell-scheme.js';
import {createGeoAnchor} from '../dist/geo/enu.js';
import {geodeticDegrees} from '../dist/geo/geodetic.js';
import {degrees,meters} from '../dist/geo/units.js';
import {threeLocalToEcef,ecefToThreeLocal} from '../dist/geo/three-frame.js';
import {frameTransform,transformPoint} from '../dist/geo/floating-origin.js';
import {buildTerrainCell} from '../dist/generation/terrain/terrain-builder.js';
import {TerrainSampler} from '../dist/generation/terrain/terrain-sampler.js';
import {syntheticElevation} from '../dist/generation/terrain/synthetic-elevation.js';
const props=(extra={})=>normalizeMapboxRoad({class:'street',type:'residential',structure:'none',layer:0,oneway:'false',...extra});
const tile=(lines=[[[0,1024],[4096,1024]]],extra={})=>({providerId:'fixture',version:'1',digest:'0'.repeat(64),z:16,x:32768,y:32768,extent:4096,features:[{attributes:props(),lines}],...extra});
const cell=(x=65536,y=65536,level=17)=>cellId(level,x,y);
const point=(x,y)=>({u:fraction(x),v:fraction(y)});
const serial=v=>JSON.stringify(v,(_,v)=>typeof v==='bigint'?v.toString():v);
const patch=[cell(),cell(65537),cell(65536,65537),cell(65537,65537)];
function terrain(id,profile='flat'){return buildTerrainCell(id,new TerrainSampler(syntheticElevation(profile)),32);}

test('fraction reduction, sign and arithmetic are exact',()=>{
 assert.equal(key(fraction(18,-24)),'-3/4');assert.equal(key(fraction(0,90)),'0/1');
 assert.equal(key(add(fraction(1,3),fraction(1,6))),'1/2');
 assert.equal(key(div(mul(fraction(5,7),fraction(7,9)),fraction(1,3))),'5/3');
 assert.throws(()=>fraction(1,0));assert.throws(()=>fraction(.1));
});
test('rational clipping creates an exact non-dyadic border coordinate',()=>{
 const r={west:fraction(0),north:fraction(0),east:fraction(1),south:fraction(1)};
 const c=clip(point(-1,0),point(2,1),r);
 assert.equal(key(c[0].u),'0/1');assert.equal(key(c[0].v),'1/3');assert.equal(key(c[1].v),'2/3');
 const reverse=clip(point(2,1),point(-1,0),r);assert.equal(serial(c),serial(reverse.reverse()));
});
test('parallel/outside/point contacts and half-open owner edges',()=>{
 const r=box(1,0,0);
 assert.equal(clip(point(1,1),point(2,2),r),null);
 assert.equal(clip(point(-1,-1),point(0,0),r),null);
 const a={u:fraction(1,2),v:fraction(0)},b={u:fraction(1,2),v:fraction(1,2)};
 assert.equal(clip(a,b,r),null);assert.ok(clip(a,b,box(1,1,0)));
});
test('a road crossing all four WorldCells retains exact shared endpoints',()=>{
 const graph=buildRoadGraph([tile([[[0,1024],[3072,1024],[3072,3072],[1024,3072],[1024,0]]])]);
 const f=clipRoadGraph(graph,patch);assert.equal(new Set(f.map(x=>x.cellKey)).size,4);
 const endpointCounts=new Map();for(const x of f)for(const k of [x.startKey,x.endKey])endpointCounts.set(k,(endpointCounts.get(k)||0)+1);
 assert.ok([...endpointCounts.values()].filter(v=>v>1).length>=4);
 assert.equal(serial(f),serial(clipRoadGraph(graph,[...patch].reverse())));
});
test('reversed two-way exact duplicates produce one edge',()=>{
 const a=tile([[[0,1024],[4096,1024]],[[4096,1024],[0,1024]]]);const g=buildRoadGraph([a]);
 assert.equal(g.edges.length,1);assert.equal(g.duplicateSegments,1);
});
test('duplicate contexts are resolved deterministically',()=>{
 const a=tile([[[-10,1000],[4106,1000]],[[-20,1000],[4116,1000]]]);
 const b=tile([...a.features[0].lines].reverse());assert.equal(serial(buildRoadGraph([a])),serial(buildRoadGraph([b])));
});
test('one-way direction is preserved, not normalized away',()=>{
 const g=buildRoadGraph([tile(undefined,{features:[{attributes:props({oneway:'true'}),lines:[[[0,1024],[4096,1024]],[[4096,1024],[0,1024]]]}]})]);
 assert.equal(g.edges.length,2);assert.ok(g.edges.every(e=>e.attributes.oneway==='forward'));
});
test('buffers clipped to source cores never generate overlapping tile interiors',()=>{
 const a=tile([[[-50,1024],[4146,1024]]]),b=tile([[[-50,1024],[4146,1024]]],{x:32769});
 const g=buildRoadGraph([b,a]);assert.equal(g.edges.length,2);
 const n=g.nodes.filter(n=>n.edges.length===2);assert.equal(n.length,1);
 assert.equal(serial(g),serial(buildRoadGraph([a,b])));
});
test('line exactly on source boundary belongs to the east tile only',()=>{
 const g=buildRoadGraph([tile([[[4096,0],[4096,4096]]]),tile([[[0,0],[0,4096]]],{x:32769})]);assert.equal(g.edges.length,1);
});
test('line exactly on a WorldCell boundary has one owner',()=>{
 const g=buildRoadGraph([tile([[[2048,10],[2048,1800]]])]);
 const f=clipRoadGraph(g,[cell(),cell(65537)]);assert.equal(f.length,1);assert.equal(f[0].cellKey,'web-mercator/17/65537/65536');
});
test('known shared source vertex forms a T cartographic candidate',()=>{
 const g=buildRoadGraph([tile([[[0,1024],[2048,1024],[4096,1024]],[[2048,1024],[2048,4096]]])]);
 assert.equal(g.nodes.filter(n=>n.edges.length===3).length,1);assert.equal(g.topologyAuthority,'cartographic-not-routable');
});
test('X crossing without source vertex is NOT invented as an intersection',()=>{
 const g=buildRoadGraph([tile([[[0,2048],[4096,2048]],[[2048,0],[2048,4096]]])]);assert.equal(g.nodes.length,4);assert.ok(g.nodes.every(n=>n.edges.length===1));
});
test('X with explicit matching vertices forms four-way cartographic candidate',()=>{
 const g=buildRoadGraph([tile([[[0,2048],[2048,2048],[4096,2048]],[[2048,0],[2048,2048],[2048,4096]]])]);assert.equal(g.nodes.filter(n=>n.edges.length===4).length,1);
});
test('bridge/tunnel/ground strata never become the same graph node',()=>{
 const features=['none','bridge','tunnel'].map((structure,i)=>({attributes:props({structure,layer:i}),lines:[[[2048,2048],[3000+i,3000]]]}));
 const g=buildRoadGraph([tile(undefined,{features})]);assert.equal(g.nodes.length,6);
});
test('unknown layer or structure stays unknown and isolated',()=>{
 const features=[{attributes:props({layer:null,structure:null}),lines:[[[0,0],[2048,2048]],[[2048,2048],[4096,4096]]]}];
 const g=buildRoadGraph([tile(undefined,{features})]);assert.equal(g.nodes.length,4);assert.equal(g.edges[0].attributes.structure,'unknown');
});
test('closed roundabout has no fabricated central node',()=>{
 const g=buildRoadGraph([tile([[[1000,1000],[3000,1000],[3000,3000],[1000,3000],[1000,1000]]])]);assert.equal(g.nodes.length,4);assert.ok(g.nodes.every(n=>n.edges.length===2));
});
test('near but unequal source endpoints stay open, never tolerance-snapped',()=>{
 const g=buildRoadGraph([tile([[[0,1024],[4096,1024]]]),tile([[[0,1025],[4096,1025]]],{x:32769})]);
 assert.equal(g.nodes.length,4);assert.equal(g.unresolvedSourcePorts,4);
});
test('mixed extent same normalized endpoint can connect exactly',()=>{
 const g=buildRoadGraph([tile(),tile([[[0,2048],[8192,2048]]],{x:32769,extent:8192})]);assert.equal(g.nodes.filter(n=>n.edges.length===2).length,1);
});
test('anti-meridian stitches coordinate aliases without a globe-spanning line',()=>{
 const a=tile(undefined,{x:65535}),b=tile(undefined,{x:0});const g=buildRoadGraph([a,b]);
 assert.equal(g.nodes.filter(n=>n.edges.length===2).length,1);
 const f=clipRoadGraph(g,[cell(131071),cell(0)]);assert.equal(f.length,2);
 const common=[f[0].startKey,f[0].endKey].some(k=>[f[1].startKey,f[1].endKey].includes(k));assert.ok(common);
 assert.ok(f.every(f=>Math.abs(value(sub(f.a.u,f.b.u)))<1/10000));
});
test('source snapshot conflict and mixed zoom/version fail closed',()=>{
 assert.throws(()=>buildRoadGraph([tile(),tile(undefined,{digest:'1'.repeat(64)})]),/SNAPSHOT/);
 assert.throws(()=>buildRoadGraph([tile(),tile(undefined,{z:17})]),/MIXED/);
 assert.throws(()=>buildRoadGraph([tile(),tile(undefined,{version:'2'})]),/MIXED/);
});
test('invalid source coordinates, extent and tile count rejected',()=>{
 assert.throws(()=>buildRoadGraph([tile([[[NaN,0],[1,1]]])]),/COORDINATE/);
 assert.throws(()=>buildRoadGraph([tile([[[0,0],[999999999,0]]])]),/COORDINATE/);
 assert.throws(()=>buildRoadGraph([tile(undefined,{extent:0})]),/CONTRACT/);
 assert.throws(()=>buildRoadGraph(Array.from({length:17},()=>tile())),/TILE_BUDGET/);
});
test('empty tiles are valid, but malformed one-point lines are rejected',()=>{
 assert.equal(buildRoadGraph([tile(undefined,{features:[]})]).edges.length,0);
 assert.throws(()=>buildRoadGraph([tile([[[0,0]]])]),/INVALID_LINE/);
});
test('unsupported cell schemes and duplicate cells rejected',()=>{
 const g=buildRoadGraph([tile()]);assert.throws(()=>clipRoadGraph(g,[cell(),cell()]),/DUPLICATE/);
 assert.throws(()=>clipRoadGraph(g,[{...cell(),scheme:'cube'}]),/CONTRACT/);
});
for(const [sourceClass,sourceType,wanted] of [['path','cycleway','CYCLEWAY'],['path','steps','STEPS'],['path','sidewalk','FOOTWAY'],['path','hiking','TRAIL'],['service','service','SERVICE'],['future','future','UNKNOWN']]){
 test(`normalize ${sourceClass}/${sourceType} without fabricated width`,()=>{const p=props({class:sourceClass,type:sourceType});assert.equal(p.category,wanted);assert.equal(p.widthMeters,null);assert.equal(p.widthProvenance,'unknown');});
}
test('rail/ferry are not misclassified as roads',()=>{assert.equal(props({class:'major_rail'}),null);assert.equal(props({class:'ferry'}),null);});
test('absent access/surface/oneway tags never imply permission or asphalt',()=>{const p=normalizeMapboxRoad({});assert.equal(p.access,'unknown');assert.equal(p.surface,'unknown');assert.equal(p.oneway,'unknown');});
test('debug follows actual triangles and shares boundary coordinates within 1 mm',()=>{
 const g=buildRoadGraph([tile([[[0,1200],[4096,2800]],[[1000,0],[1000,4096]]])]);
 const terrains=patch.map(id=>terrain(id,'waves')),packets=buildRoadDebugPackets(g,terrains);
 assert.ok(packets.reduce((n,p)=>n+p.segmentCount,0)>32);assert.ok(packets.every(p=>p.positions.every(Number.isFinite)));
 // The same canonical clipping boundary must map to the same ECEF at both cells.
 const fs=clipRoadGraph(g,patch),byEndpoint=new Map();
 for(const f of fs)for(const [p,k] of [[f.a,f.startKey],[f.b,f.endKey]]){const list=byEndpoint.get(k)||[];list.push({p,cell:f.cellKey});byEndpoint.set(k,list);}
 assert.ok([...byEndpoint.values()].some(v=>v.length>1));
 const shared=[];
 for(let i=0;i<packets.length;i++){
  const p=packets[i],t=terrains[i];for(let j=0;j<p.positions.length;j+=3){
   const local=Array.from(p.positions.slice(j,j+3)),e=threeLocalToEcef(local,t.anchor);
   shared.push({cell:i,e});
  }
 }
 let found=0;for(let i=0;i<shared.length;i++)for(let j=i+1;j<shared.length;j++)if(shared[i].cell!==shared[j].cell){
  const a=shared[i].e,b=shared[j].e;if(Math.hypot(a.xMeters-b.xMeters,a.yMeters-b.yMeters,a.zMeters-b.zMeters)<.001)found++;
 }
 assert.ok(found>=2);
});
test('debug never drapes bridges, tunnels, unknown structures or steps',()=>{
 const features=[props({structure:'bridge'}),props({structure:'tunnel'}),props({structure:null}),props({class:'path',type:'steps'})].map(attributes=>({attributes,lines:[[[0,0],[4096,4096]]]}));
 const result=buildRoadDebugPackets(buildRoadGraph([tile(undefined,{features})]),[terrain(cell())]);assert.equal(result[0].positions.length,0);
});
test('200 rebases do not mutate any road debug geometry or ECEF position',()=>{
 const p=buildRoadDebugPackets(buildRoadGraph([tile()]),[terrain(cell())])[0];const original=Array.from(p.positions),anchor=terrain(cell()).anchor;
 const start=Array.from(p.positions.slice(0,3)),ecef=threeLocalToEcef(start,anchor);
 for(let i=0;i<200;i++){
   const frame=createGeoAnchor(geodeticDegrees(degrees((i%80)-40),degrees((i%70)-35),meters(0)));
   const local=transformPoint(start,frameTransform(anchor,frame)),back=threeLocalToEcef(local,frame);
   assert.ok(Math.hypot(back.xMeters-ecef.xMeters,back.yMeters-ecef.yMeters,back.zMeters-ecef.zMeters)<1e-6);
 }
 assert.deepEqual(Array.from(p.positions),original);
});
test('canonical projection finite at equator, high latitudes and anti-meridian',()=>{
 for(const u of [0,.1,.5,.999999])for(const v of [0,.25,.5,.75,1]){
  const p={u:fraction(Math.round(u*1000000),1000000),v:fraction(v*4,4)},g=roadPointGeodetic(p);
  const anchor=createGeoAnchor(g);assert.equal(Math.hypot(...ecefToThreeLocal(anchor.ecef,anchor)),0);
 }
});
