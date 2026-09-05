import test from 'node:test';
import assert from 'node:assert/strict';
import Pbf from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {decodeRoadMvt,MAX_MVT_BYTES} from '../../demo/roads/mvt-roads.mjs';
import {RoadSource,planRoadTiles,parseRoadMetadata} from '../../demo/roads/road-source.mjs';
import {buildRoadGraph} from '../../src/generation/roads/kernel.ts';
const id={z:16,x:32768,y:32768};
const meta={providerId:'fixture',version:'1',digest:'0'.repeat(64)};
const cells=[{scheme:'web-mercator',level:17,x:65536,y:65536}];
function encode({lines=[[[0,1024],[2048,1024],[4096,1024]]],type=2,extent=4096,geometry=null,layer='road',fid=0,extra={}}={}){
 const props={class:'street',type:'residential',structure:'none',layer:0,oneway:'true',surface:'paved',...extra},entries=Object.entries(props);
 const geom=[];let x=0,y=0;
 for(const line of lines){geom.push(9);line.forEach(([xx,yy],i)=>{if(i===1)geom.push((line.length-1)*8+2);const dx=xx-x,dy=yy-y;geom.push(dx<0?-2*dx-1:2*dx,dy<0?-2*dy-1:2*dy);x=xx;y=yy;});}
 const pbf=new Pbf();pbf.writeMessage(3,(_,p)=>{
  p.writeStringField(1,layer);p.writeVarintField(15,2);p.writeVarintField(5,extent);
  for(const [key] of entries)p.writeStringField(3,key);
  for(const [,value] of entries)p.writeMessage(4,(value,q)=>typeof value==='number'?q.writeVarintField(5,value):q.writeStringField(1,value),value);
  p.writeMessage(2,(_,q)=>{q.writeVarintField(1,fid);q.writePackedVarint(2,entries.flatMap((_,i)=>[i,i]));q.writeVarintField(3,type);q.writePackedVarint(4,geometry??geom);},null);
 },null);return pbf.finish();
}
const json={scheme:'xyz',maxzoom:16,modified:123,attribution:'© Mapbox · OpenStreetMap',vector_layers:[{id:'road'}]};
test('bounded adapter agrees with existing library on valid multiline MVT',()=>{
 const bytes=encode({lines:[[[0,0],[10,20],[300,400]],[[600,800],[500,900]]]});
 const expected=new VectorTile(new Pbf(bytes)).layers.road.feature(0).loadGeometry().map(l=>l.map(p=>[p.x,p.y]));
 const t=decodeRoadMvt(bytes,id,meta);assert.deepEqual(t.features[0].lines,expected);assert.equal(t.features[0].attributes.oneway,'forward');
});
test('MVT ID zero, changed ID, and unsafe integer ID do not determine road identity',()=>{
 const gs=[0,32,Number.MAX_SAFE_INTEGER+1].map(fid=>buildRoadGraph([decodeRoadMvt(encode({fid}),id,meta)]));
 assert.deepEqual(gs.map(g=>g.edges[0].key),Array(3).fill(gs[0].edges[0].key));
});
test('actual layer extent is used; never assumes 4096',()=>{assert.equal(decodeRoadMvt(encode({extent:8192}),id,meta).extent,8192);});
test('empty tile and absent road layer are valid empty datasets',()=>{
 assert.equal(decodeRoadMvt(new Uint8Array(),id,meta).features.length,0);
 assert.equal(decodeRoadMvt(encode({layer:'water'}),id,meta).features.length,0);
});
test('point/polygon geometries do not become road centerlines',()=>{for(const type of [1,3])assert.equal(decodeRoadMvt(encode({type}),id,meta).features.length,0);});
test('unknown future category stays unknown; tags are not guessed',()=>{assert.equal(decodeRoadMvt(encode({extra:{class:'future'}}),id,meta).features[0].attributes.category,'UNKNOWN');});
test('malformed geometry commands, counts and truncation fail closed',()=>{
 for(const geometry of [[1],[9,0,0,7],[9,0,0,0],[2],[9,0,0,0xffffffff]])assert.throws(()=>decodeRoadMvt(encode({geometry}),id,meta));
 const bytes=encode();assert.throws(()=>decodeRoadMvt(bytes.subarray(0,bytes.length-1),id,meta));
});
test('large command count rejected before allocating its points',()=>{assert.throws(()=>decodeRoadMvt(encode({geometry:[9,0,0,120001*8+2]}),id,meta),/POINT_BUDGET/);});
test('response byte budget enforced before protobuf decoding',()=>{assert.throws(()=>decodeRoadMvt(new Uint8Array(MAX_MVT_BYTES+1),id,meta),/RESPONSE_BUDGET/);});
test('TileJSON contract requires source zoom and road layer; no following untrusted URLs',()=>{
 assert.equal(parseRoadMetadata({...json,tiles:['https://evil.invalid/?token=steal']}).maxzoom,16);
 for(const bad of [{...json,maxzoom:99},{...json,scheme:'tms'},{...json,attribution:''},{...json,vector_layers:[]}])assert.throws(()=>parseRoadMetadata(bad));
});
test('tile plan uses provider maxzoom and wraps anti-meridian',()=>{
 const a=planRoadTiles(cells,15);assert.ok(a.every(t=>t.z===15));
 const b=planRoadTiles([{...cells[0],x:0}],16);assert.ok(b.some(t=>t.x===65535));assert.ok(b.every(t=>t.y>=0));
 assert.throws(()=>planRoadTiles([{...cells[0],x:1},{...cells[0],x:100000}],16),/TILE_BUDGET/);
});
test('identical source tiles reused without another download or decode',async()=>{
 const requests=[];
 const source=new RoadSource(async url=>{requests.push(url);return url.includes('.json?')?new Response(JSON.stringify(json)):new Response(encode());});
 const first=await source.load(cells,'pk.fixture',new AbortController().signal,32);assert.equal(first.attempts,10);
 const second=await source.load(cells,'pk.fixture',new AbortController().signal,22);assert.equal(second.attempts,0);assert.ok(second.cacheHits>=9);
 assert.equal(requests.length,10);assert.strictEqual(first.tiles[0],second.tiles[0]);
});
test('real attempt grant is checked before network and retained on failure',async()=>{
 let count=0;const source=new RoadSource(async()=>{count++;return new Response(JSON.stringify(json));});
 await assert.rejects(source.load(cells,'pk.fixture',new AbortController().signal,1),e=>e.message==='ROAD_HTTP_BUDGET'&&e.attempts===1);assert.equal(count,1);
});
test('auth and 404 errors are not reinterpreted as empty roads',async()=>{
 for(const status of [401,403,404,429]){let n=0;const source=new RoadSource(async()=>{n++;return new Response('{}',{status});});await assert.rejects(source.load(cells,'pk.fixture',new AbortController().signal,32));assert.equal(n,1);}
});
test('aborted calls do not touch the network',async()=>{
 let n=0;const c=new AbortController();c.abort();const source=new RoadSource(async()=>{n++;return new Response('{}');});
 await assert.rejects(source.load(cells,'pk.fixture',c.signal,32));assert.equal(n,0);
});
test('token is validated and source cache reset across credentials',async()=>{
 const source=new RoadSource(async url=>url.includes('.json?')?new Response(JSON.stringify(json)):new Response(encode()));
 await assert.rejects(source.load(cells,'sk.secret',new AbortController().signal,32));
 await source.load(cells,'pk.first',new AbortController().signal,32);
 const result=await source.load(cells,'pk.second',new AbortController().signal,32);assert.equal(result.attempts,10);
});

test('default fetch transport preserves the global Web API receiver',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=function(url){assert.strictEqual(this,globalThis);calls++;return Promise.resolve(url.includes('.json?')?new Response(JSON.stringify(json)):new Response(encode()));};
 try{const result=await new RoadSource().load(cells,'pk.fixture',new AbortController().signal,32);assert.equal(result.attempts,10);assert.equal(calls,10);}
 finally{globalThis.fetch=original;}
});
test('network transport failures are sanitized and charged, not mislabeled as decoding',async()=>{
 const source=new RoadSource(async()=>{throw new TypeError('sensitive URL is never surfaced');});
 await assert.rejects(source.load(cells,'pk.fixture',new AbortController().signal,32),e=>e.message==='ROAD_NETWORK_OR_CORS'&&e.attempts===1);
});
