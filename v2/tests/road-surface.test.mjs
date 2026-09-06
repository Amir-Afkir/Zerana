import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadGraph } from '../dist/generation/roads/kernel.js';
import { buildRoadSurface, validateRoadSurface, roadSurfaceBytes, ROAD_SURFACE_LIMITS } from '../dist/generation/roads/surface.js';
import { roadFootprints, metricAt } from '../dist/generation/roads/footprint.js';
import { resolveRoadSurfaceStyle } from '../dist/generation/roads/surface-style.js';
import { intersectConvex, partitionConvex, signedArea } from '../dist/generation/roads/convex.js';
import { normalizeMapboxRoad } from '../dist/providers/vectors/mapbox-roads.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { cellId } from '../dist/geo/mercator-cell-scheme.js';
import { threeLocalToEcef } from '../dist/geo/three-frame.js';
const props = p => normalizeMapboxRoad({class:'street',type:'residential',structure:'none',layer:0,oneway:'false',surface:'paved',...p});
const tile=(lines,options={})=>({providerId:'fixture',version:'1',digest:'0'.repeat(64),z:16,x:32768,y:32768,extent:4096,
 features:[{attributes:props(options.props),lines}],...options});
const graph=lines=>buildRoadGraph([tile(lines)]);
const terrain=(x=65536,y=65536,level=17,n=16)=>buildTerrainCell(cellId(level,x,y),new TerrainSampler(syntheticElevation('flat')),n);
const uvTriangles=p=>Array.from({length:p.triangleCount},(_,i)=>Array.from({length:3},(_,j)=>[p.uvs[i*6+j*2],1-p.uvs[i*6+j*2+1]]).reverse());
const uvArea=p=>uvTriangles(p).reduce((s,t)=>s+Math.abs(signedArea(t)),0);
const mesh=(lines,t=terrain())=>buildRoadSurface(graph(lines),t);
for(const [category,width] of [['STREET',5.5],['FOOTWAY',1.8],['TRACK',3],['CYCLEWAY',2.5],['TRAIL',1.2]]) {
 test(`surface width ${category} is explicitly estimated`,()=>{
  const style=resolveRoadSurfaceStyle({...props({}),category});assert.equal(style.widthMeters,width);assert.equal(style.widthProvenance,'estimated');
 });
}
test('ramp width and one-way street do not infer a lane count',()=>{
 assert.equal(resolveRoadSurfaceStyle(props({class:'motorway_link'})).widthMeters,4);
 assert.equal(resolveRoadSurfaceStyle(props({oneway:'true'})).widthMeters,3.5);
 assert.equal(resolveRoadSurfaceStyle(props({surface:'unpaved'})).material,'earth');
});
for(const p of [{structure:'bridge'},{structure:'tunnel'},{structure:null},{layer:1},{class:'path',type:'steps'},{class:'future'},{class:'construction'}]) {
 test(`deferred road ${JSON.stringify(p)} is not draped`,()=>assert.equal(resolveRoadSurfaceStyle(props(p)),null));
}
test('convex partition preserves area, including an enclosed hole',()=>{
 const a=[[0,0],[10,0],[10,10],[0,10]],b=[[3,3],[7,3],[7,7],[3,7]];
 const parts=partitionConvex(a,b);assert.equal(signedArea(parts.inside),16);
 assert.equal(parts.outside.reduce((s,p)=>s+signedArea(p),0),84);
 for(let i=0;i<parts.outside.length;i++)for(let j=i+1;j<parts.outside.length;j++)assert.ok(Math.abs(signedArea(intersectConvex(parts.outside[i],parts.outside[j])))<1e-12);
});
test('complementary clipping uses shared crossing coordinates',()=>{
 const s=[[0,0],[2,0],[2,2],[0,2]],c=[[1,-1],[3,1],[1,3],[-1,1]],p=partitionConvex(s,c);
 assert.ok(Math.abs(signedArea(p.inside)+p.outside.reduce((n,a)=>n+signedArea(a),0)-4)<1e-12);
});
test('straight corridor has the correct horizontal metric width, not Mercator width',()=>{
 const t=terrain(),p=mesh([[[-100,1024],[4200,1024]]],t),m=metricAt([.5,.5]);
 const width=uvArea(p)*m[1]/2**17;
 assert.ok(Math.abs(width-5.5)<.002,`${width}`);assert.ok(p.triangleCount>0);validateRoadSurface(p,t);
});
test('ribbon whose centerline is exactly at the cell border covers BOTH cells',()=>{
 const g=graph([[[2048,-100],[2048,4200]]]);
 const a=buildRoadSurface(g,terrain()),b=buildRoadSurface(g,terrain(65537));
 assert.ok(a.triangleCount>0&&b.triangleCount>0);assert.ok(Math.abs(uvArea(a)-uvArea(b))<1e-7);
});
test('a centerline outside a cell can still contribute its road edge inside',()=>{
 const g=graph([[[2050,-100],[2050,4200]]]);assert.ok(buildRoadSurface(g,terrain()).triangleCount>0);
});
for(const [name,lines] of [
 ['right turn',[[[300,900],[1000,900],[1000,1600]]]],
 ['acute turn',[[[200,900],[1700,900],[210,915]]]],
 ['T junction',[[[-100,1024],[1024,1024],[4200,1024]],[[1024,1024],[1024,4200]]]],
 ['X junction',[[[-100,1024],[1024,1024],[4200,1024]],[[1024,-100],[1024,1024],[1024,4200]]]],
 ['roundabout',[[[700,700],[1400,700],[1400,1400],[700,1400],[700,700]]]],
 ]) {
 test(`${name}: finite, bounded, nonoverlapping surface triangles`,()=>{
  const p=mesh(lines),triangles=uvTriangles(p);assert.ok(p.triangleCount>0);
  for(let i=0;i<triangles.length;i++)for(let j=i+1;j<triangles.length;j++) {
   const area=Math.abs(signedArea(intersectConvex(triangles[i],triangles[j])));
   assert.ok(area<1e-8,`overlap ${i}/${j}: ${area}`);
  }
  assert.ok(roadSurfaceBytes(p)<ROAD_SURFACE_LIMITS.maxBytes);
  if(name==='roundabout')assert.ok(!triangles.some(t=>Math.abs(signedArea(intersectConvex(t,[[.24,.24],[.26,.24],[.26,.26],[.24,.26]])))>1e-12));
 });
}
test('ground crossings do not modify cartographic topology',()=>{
 const g=graph([[[0,1024],[4096,1024]],[[1024,0],[1024,4096]]]);
 const before=JSON.stringify(g,(_,v)=>typeof v==='bigint'?String(v):v);buildRoadSurface(g,terrain());
 assert.equal(JSON.stringify(g,(_,v)=>typeof v==='bigint'?String(v):v),before);assert.equal(g.nodes.length,4);
});
test('input arrival order does not change surface byte buffers',()=>{
 const t=terrain(),a=tile([[[0,1024],[1024,1024],[4096,1024]],[[1024,0],[1024,1024],[1024,4096]]]);
 const b={...a,features:[{...a.features[0],lines:[...a.features[0].lines].reverse()}]};
 const p=buildRoadSurface(buildRoadGraph([a]),t),q=buildRoadSurface(buildRoadGraph([b]),t);
 assert.deepEqual(p,q);
});
test('drape subdivides at EVERY terrain triangle, including a steep ridge',()=>{
 const t=terrain();for(let i=0;i<t.positions.length/3;i++)t.positions[i*3+1]=(i%17===8?20:0);
 const p=mesh([[[0,700],[4096,1800]]],t);
 for(let i=0;i<p.positions.length/3;i++){
  const x=p.uvs[i*2]*16,y=(1-p.uvs[i*2+1])*16,c=Math.min(15,Math.floor(x)),r=Math.min(15,Math.floor(y));
  const dx=x-c,dy=y-r,a=r*17+c,ids=dx+dy<=1?[a,a+17,a+1]:[a+1,a+17,a+18];
  const w=dx+dy<=1?[1-dx-dy,dy,dx]:[1-dy,1-dx,dx+dy-1];
  for(let k=0;k<3;k++)assert.ok(Math.abs(w.reduce((s,w,j)=>s+w*t.positions[ids[j]*3+k],0)-p.positions[i*3+k])<.0003);
 }
});
for(const y of [0,14000,32768,52000,65535]) {
 test(`metric footprint at source latitude row ${y} remains metre-sized`,()=>{
  const g=buildRoadGraph([tile([[[0,1024],[4096,1024]]],{y})]);
  const f=roadFootprints(g,cellId(17,65536,y*2)).find(p=>!p.key.startsWith('node/'));
  const a=f.polygon[0],b=f.polygon.at(-1),m=metricAt([(a[0]+b[0])/2,(a[1]+b[1])/2]);
  assert.ok(Math.abs(Math.hypot((b[0]-a[0])*m[0],(b[1]-a[1])*m[1])-5.5)<.0001);
 });
}
test('antimeridian surface pieces remain in their cell and match after ECEF transform',()=>{
 const g=buildRoadGraph([tile([[[0,1024],[4096,1024]]],{x:65535}),tile([[[0,1024],[4096,1024]]],{x:0})]);
 const a=terrain(131071),b=terrain(0),p=buildRoadSurface(g,a),q=buildRoadSurface(g,b);
 const boundary=(p,t,u)=>{const out=[];for(let i=0;i<p.positions.length/3;i++)if(Math.abs(p.uvs[i*2]-u)<1e-7)out.push(threeLocalToEcef([...p.positions.slice(i*3,i*3+3)],t.anchor));return out;};
 const aa=boundary(p,a,1),bb=boundary(q,b,0);assert.ok(aa.length&&bb.length);
 for(const v of aa)assert.ok(bb.some(w=>Math.hypot(v.xMeters-w.xMeters,v.yMeters-w.yMeters,v.zMeters-w.zMeters)<.001));
});
test('surface packet rejects wrong terrain, stale policy, NaNs and oversized data',()=>{
 const t=terrain(),p=mesh([[[0,1024],[4096,1024]]],t);
 for(const change of [{terrainSourceId:'other'},{styleVersion:'other'},{cellKey:'other'},{positions:new Float32Array([NaN])}])assert.throws(()=>validateRoadSurface({...p,...change},t),/CONTRACT/);
});
test('empty road coverage is a valid terminal ready packet',()=>{
 const p=buildRoadSurface(buildRoadGraph([]),terrain());assert.equal(p.triangleCount,0);assert.equal(p.widthAuthority,'estimated-horizontal-meters');
});

test('explicit ground with missing drawing layer can render without inventing a graph stratum',()=>assert.ok(resolveRoadSurfaceStyle(props({layer:null}))));
