import test from 'node:test';
import assert from 'node:assert/strict';
import Pbf from 'pbf';
import {RealRoadSource} from '../../demo/roads/real-road-source.mjs';
import {validatePacket,packetBytes} from '../../demo/streaming/packet.mjs';
import {WeightedLru} from '../../src/streaming/weighted-lru.ts';
import {TriangleIndex} from '../../src/physics/geometry.ts';
import {cellId} from '../../src/geo/mercator-cell-scheme.ts';
import {engineeringRegionAt} from '../../src/generation/roads/real-engineering.ts';
import {geodeticDegrees} from '../../src/geo/geodetic.ts';
import {degrees,meters} from '../../src/geo/units.ts';
const region=engineeringRegionAt(geodeticDegrees(degrees(2.35),degrees(48.86),meters(0)));
const id=cellId(19,region.x*8+3,region.y*8+3);
const config={id,source:'mapbox',token:'pk.fixture',engineering:true,allowPreview:true,subdivisions:32,profile:'flat'};
function mvt(){
 const p=new Pbf(),props={class:'street',type:'residential',structure:'none',layer:0,oneway:'false',surface:'paved'},entries=Object.entries(props);
 p.writeMessage(3,(_,q)=>{
  q.writeStringField(1,'road');q.writeVarintField(15,2);q.writeVarintField(5,4096);
  for(const [k] of entries)q.writeStringField(3,k);
  for(const [,v] of entries)q.writeMessage(4,(v,r)=>typeof v==='number'?r.writeVarintField(5,v):r.writeStringField(1,v),v);
  q.writeMessage(2,(_,r)=>{r.writeVarintField(3,2);r.writePackedVarint(2,entries.flatMap((_,i)=>[i,i]));r.writePackedVarint(4,[9,0,4096,18,4096,0,4096,0]);},null);
 },null);return p.finish();
}
// This adapter test mocks the browser canvas codec, NOT the CPU road/terrain
// algorithms. The separate Playwright test decodes actual PNG bytes in Chromium.
async function fixture(fn){
 const saved={fetch:globalThis.fetch,bitmap:globalThis.createImageBitmap,canvas:globalThis.OffscreenCanvas};
 const calls=[],state={deny:false,changed:false};
 globalThis.fetch=async url=>{
  const p=new URL(url).pathname;calls.push(p);
  if(state.deny)return new Response('{}',{status:401});
  if(p.endsWith('.json'))return new Response(JSON.stringify({maxzoom:16,scheme:'xyz',modified:123,vector_layers:[{id:'road'}],attribution:'© Mapbox · OpenStreetMap'}));
  if(p.endsWith('.vector.pbf'))return new Response(mvt());
  const m=p.match(/\/15\/(\d+)\/(\d+)\.pngraw$/);assert.ok(m,p);
  const bytes=new Uint8Array(32);bytes[0]=137;bytes[1]=80;const dv=new DataView(bytes.buffer);
  dv.setUint32(16,256);dv.setUint32(20,256);dv.setUint32(24,Number(m[1]));dv.setUint32(28,Number(m[2]));
  if(state.changed)bytes[3]=1;
  return new Response(bytes,{headers:{'content-type':'image/png'}});
 };
 globalThis.createImageBitmap=async blob=>{
  const d=new DataView(await blob.arrayBuffer()),x=d.getUint32(24),y=d.getUint32(28),rgba=new Uint8ClampedArray(256*256*4);
  for(let j=0;j<256;j++)for(let i=0;i<256;i++){
   const h=30+.35*Math.sin((x*256+i+.5)*.31)+.2*Math.sin((y*256+j+.5)*.17),v=Math.round((10000+h)*10),k=(j*256+i)*4;
   rgba.set([v>>16,(v>>8)&255,v&255,255],k);
  }
  return {width:256,height:256,rgba,close(){}};
 };
 globalThis.OffscreenCanvas=class{getContext(){let image;return {drawImage:i=>{image=i;},getImageData:()=>({data:image.rgba})};}};
 try{await fn({calls,state});}finally{globalThis.fetch=saved.fetch;globalThis.createImageBitmap=saved.bitmap;globalThis.OffscreenCanvas=saved.canvas;}
}
const signal=()=>new AbortController().signal;
test('real source builds one immutable nonzero earthwork and road packet before the worker collider',()=>fixture(async({calls})=>{
 let attempts=0;const source=new RealRoadSource(new WeightedLru(16*1048576,128));
 const b=await source.build(config,signal(),()=>attempts++);
 b.collider=new TriangleIndex(b.packet.positions,b.packet.indices).snapshot();validatePacket(b,config);
 assert.equal(calls.length,attempts);assert.ok(attempts<=32);assert.ok(b.engineering.modifiedSamples>0);assert.ok(b.engineering.maxDeltaMeters>.01);
 assert.ok(b.roadSurface.triangleCount>0);assert.ok(packetBytes(b)<=1048576);
 assert.equal(b.packet.verticalReference,'UNRESOLVED_DATUM_PREVIEW');assert.equal(b.engineering.qualifiedForDriving,false);
 assert.ok(b.engineering.readSet.some(r=>r.layer==='elevation'));assert.ok(b.engineering.readSet.some(r=>r.layer==='road'));
}));
test('same geographic recipe serves adjacent WorldCells without another provider request',()=>fixture(async({calls})=>{
 const source=new RealRoadSource(new WeightedLru(16*1048576,128));
 const a=await source.build(config,signal(),()=>{}),count=calls.length;
 const b=await source.build({...config,id:cellId(19,id.x+1,id.y)},signal(),()=>{});
 assert.equal(calls.length,count);assert.deepEqual(a.engineering.readSet,b.engineering.readSet);
 assert.equal(a.engineering.regions[0].sourceRevision,b.engineering.regions[0].sourceRevision);
 assert.ok(source.accountedBytes<=64*1048576);
}));
test('real preparation refuses missing consent or coarse resolution before network',()=>fixture(async({calls})=>{
 const source=new RealRoadSource(new WeightedLru(16*1048576,128));
 await assert.rejects(source.build({...config,allowPreview:false},signal(),()=>{}),/CONSENT/);
 await assert.rejects(source.build({...config,id:cellId(17,0,0)},signal(),()=>{}),/RESOLUTION/);
 assert.equal(calls.length,0);
}));
test('global caller quota applies BEFORE every vector or elevation HTTP attempt',()=>fixture(async({calls})=>{
 let charged=0;const source=new RealRoadSource(new WeightedLru(16*1048576,128));
 await assert.rejects(source.build(config,signal(),()=>{if(charged===3)throw Error('STREAM_HTTP_BUDGET');charged++;}),/HTTP_BUDGET/);
 assert.equal(charged,3);assert.equal(calls.length,3);assert.equal(source.regions.size,0);
}));
test('provider denial and pre-aborted work never produce partial engineered ground',()=>fixture(async({calls,state})=>{
 const source=new RealRoadSource(new WeightedLru(16*1048576,128));state.deny=true;
 await assert.rejects(source.build(config,signal(),()=>{}),/AUTH/);assert.equal(source.regions.size,0);
 const c=new AbortController();c.abort();const before=calls.length;
 await assert.rejects(source.build(config,c.signal,()=>{}),e=>e.name==='AbortError');assert.equal(calls.length,before);
}));
test('token replacement discards session caches without persisting provider data',()=>fixture(async({calls})=>{
 const source=new RealRoadSource(new WeightedLru(16*1048576,128));
 await source.build(config,signal(),()=>{});const before=calls.length;
 await source.build({...config,token:'pk.other-fixture'},signal(),()=>{});assert.equal(calls.length,2*before);
}));
