import test from 'node:test';
import assert from 'node:assert/strict';
import Pbf from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {decodeVectorSnapshot,environmentPaths} from '../../demo/environment/vector-snapshot.mjs';
import {RoadSource} from '../../demo/roads/road-source.mjs';
import {buildRoadGraph} from '../../src/generation/roads/kernel.ts';
const id={z:16,x:32768,y:32768},meta={providerId:'fixture',version:'1',digest:'0'.repeat(64)};
const cell={scheme:'web-mercator',level:19,x:262147,y:262147};
const ring=[[100,100],[3900,100],[3900,3900],[100,3900]],hole=[[1000,1000],[1000,2000],[2000,2000],[2000,1000]];
function encode({bad=null,noEnvironment=false,extra=false}={}){
 const pbf=new Pbf();
 const layers=[['road',2,[[[0,1024],[4096,1024]]],{class:'street',type:'residential',structure:'none',layer:0,oneway:'false'}]];
 if(!noEnvironment)layers.push(['water',3,[ring,hole],{}],['waterway',2,[[[0,2048],[4096,2048]]],{class:'stream'}],['landuse',3,[ring],{class:'wood'}],['landuse_overlay',3,[ring],{class:'wetland'}]);
 if(extra)layers.push(['poi_label',1,[[[100,100]]],{}]);
 for(const [name,type,paths,props] of layers)pbf.writeMessage(3,(_,p)=>{
  p.writeStringField(1,name);p.writeVarintField(15,2);p.writeVarintField(5,4096);
  const entries=Object.entries(props);for(const [k,v] of entries){p.writeStringField(3,k);p.writeMessage(4,(_,q)=>typeof v==='number'?q.writeVarintField(5,v):q.writeStringField(1,v),null);}
  const geom=[];let x=0,y=0;
  for(const path of paths){geom.push(9);for(let i=0;i<path.length;i++){if(i===1)geom.push((path.length-1)*8+2);const [xx,yy]=path[i],dx=xx-x,dy=yy-y;geom.push(dx<0?-2*dx-1:2*dx,dy<0?-2*dy-1:2*dy);x=xx;y=yy;}if(type===3)geom.push(15);}
  p.writeMessage(2,(_,q)=>{q.writeVarintField(1,0);q.writePackedVarint(2,entries.flatMap((_,i)=>[i,i]));q.writeVarintField(3,type);q.writePackedVarint(4,name==='water'&&bad?bad:geom);},null);
 },null);return pbf.finish();
}
const metadata={scheme:'xyz',maxzoom:16,modified:123,attribution:'© Mapbox · OpenStreetMap',vector_layers:['road','water','waterway','landuse','landuse_overlay'].map(id=>({id}))};
test('environment MVT: one snapshot exposes road, polygon holes, waterway and independent land meanings',()=>{
 const t=decodeVectorSnapshot(encode(),id,meta);assert.equal(t.environmentError,null);assert.ok(buildRoadGraph([t]).edges.length);
 assert.equal(t.environment.features.length,4);assert.equal(t.environment.features.find(f=>f.attributes.layer==='water').polygons[0].length,2);
});
test('environment MVT: bounded paths agree with the locked decoder without allocating closing duplicates',()=>{
 const bytes=encode(),tile=new VectorTile(new Pbf(bytes)),f=tile.layers.water.feature(0);
 const expected=f.loadGeometry().map(path=>path.slice(0,-1).map(p=>[p.x,p.y]));assert.deepEqual(environmentPaths(f,100).paths,expected);
});
test('environment MVT: malformed ClosePath is isolated, valid roads are not disabled',()=>{
 for(const bad of [[9,0,0,10,2,2],[15],[9,0,0,18,2,0,0,2,23]]){const t=decodeVectorSnapshot(encode({bad}),id,meta);assert.equal(t.environment,null);assert.match(t.environmentError,/^ENV_/);assert.ok(t.features.length);}
});
test('environment MVT: point budgets are enforced before huge command allocation',()=>{
 const t=decodeVectorSnapshot(encode({bad:[9,0,0,8000002]}),id,meta);assert.equal(t.environmentError,'ENV_POINT_BUDGET');
});
test('environment MVT: missing layers are explicit and unrelated layers are ignored',()=>{
 const t=decodeVectorSnapshot(encode({noEnvironment:true,extra:true}),id,meta);assert.equal(t.environment.features.length,0);assert.equal(t.environment.absentLayers.length,4);
});
test('environment shared source: nine tiles are requested and decoded once for both road and environment',async()=>{
 const paths=[];const source=new RoadSource(async url=>{paths.push(url.split('?')[0]);return new Response(url.includes('.json?')?JSON.stringify(metadata):encode());});
 const a=await source.load([cell],'pk.fixture',new AbortController().signal,32);
 assert.equal(paths.length,10);assert.equal(a.decodedSnapshots,9);assert.ok(a.tiles.every(t=>t.environment.features.length===4));
 const b=await source.load([cell],'pk.fixture',new AbortController().signal,0);assert.equal(paths.length,10);assert.equal(b.attempts,0);assert.equal(b.decodedSnapshots,9);assert.strictEqual(a.tiles[0].environment,b.tiles[0].environment);
});
test('environment shared source: reused source snapshots also serve neighbouring WorldCells without new HTTP',async()=>{
 let calls=0;const source=new RoadSource(async url=>{calls++;return new Response(url.includes('.json?')?JSON.stringify(metadata):encode());});
 await source.load([cell],'pk.fixture',new AbortController().signal,32);const result=await source.load([{...cell,x:cell.x+1}],'pk.fixture',new AbortController().signal,0);
 assert.equal(calls,10);assert.equal(result.decodedSnapshots,9);assert.equal(result.sourceZoom,16);
});
test('environment shared source: credential changes reset every decoded layer together',async()=>{
 const source=new RoadSource(async url=>new Response(url.includes('.json?')?JSON.stringify(metadata):encode()));
 const a=await source.load([cell],'pk.a',new AbortController().signal,32);const b=await source.load([cell],'pk.b',new AbortController().signal,32);
 assert.equal(b.attempts,10);assert.notStrictEqual(a.tiles[0].environment,b.tiles[0].environment);assert.equal(b.decodedSnapshots,9);
});
test('environment shared source: batch pressure drops optional environmental views, not valid road data',async()=>{
 const source=new RoadSource(()=>{throw Error('unexpected HTTP');});source.token='pk.fixture';source.metadata={maxzoom:16,attribution:'fixture',version:'1'};
 source.cache.get=key=>({decodedBytes:12*1048576,roadDecodedBytes:128,environment:{key},features:[],digest:'0'.repeat(64)});
 const r=await source.load([cell],'pk.fixture',new AbortController().signal,0);
 assert.equal(r.attempts,0);assert.equal(r.tiles.length,9);assert.ok(r.tiles.every(t=>t.environment===null&&t.environmentError==='ENV_BATCH_BUDGET'));
});
