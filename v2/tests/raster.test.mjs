import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTerrainRgb, RasterMosaic, pixelTaps, tileId, tileKey } from '../dist/providers/raster/raster-grid.js';
import { planRasterTiles } from '../dist/providers/raster/request-plan.js';
import { rasterElevationSource, MAPBOX_ELEVATION_DATUM } from '../dist/providers/raster/vertical-datum.js';
import { buildCellImagery } from '../dist/providers/raster/imagery.js';
import { mapboxTileUrl, providerFailure } from '../dist/providers/raster/mapbox-contract.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { terrainPatchCells } from '../dist/world/terrain-patch.js';
import { geodeticDegrees } from '../dist/geo/geodetic.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { degrees, meters } from '../dist/geo/units.js';
import { cellId } from '../dist/geo/mercator-cell-scheme.js';
import { measureTerrainSeams } from '../dist/debug/seam-metrics.js';
const geo=(lon,lat)=>geodeticDegrees(degrees(lon),degrees(lat),meters(0));
const near=(a,b,tol=1e-9)=>assert(Math.abs(a-b)<tol,`${a} != ${b}`);
const meta=verticalDatum=>({sourceId:'fixture-v1',snapshotId:'fixture-snapshot',verticalDatum});
function heightTiles(ids,size=256,fn=(x,y)=>100+x/1e6+y/1e6){
 return ids.map(id=>({...id,size,heights:Float64Array.from({length:size*size},(_,i)=>fn(id.x*size+i%size,id.y*size+Math.floor(i/size)))}));
}
function colourTiles(ids,size=256,fn=(x,y)=>[x%256,y%256,80,255]){
 return ids.map(id=>({...id,size,rgba:Uint8Array.from({length:size*size*4},(_,i)=>{
  const p=Math.floor(i/4);return fn(id.x*size+p%size,id.y*size+Math.floor(p/size))[i%4];
 })}));
}
for(const encoded of [0,1,255,256,65535,65536,100000,16777215])test(`Terrain-RGB decodes integer ${encoded} before interpolation`,()=>{
 const rgba=new Uint8Array(16);for(let i=0;i<4;i++)rgba.set([encoded>>16,(encoded>>8)&255,encoded&255,255],i*4);
 const decoded=decodeTerrainRgb({zoom:0,x:0,y:0,size:2,rgba});near(decoded.heights[0],-10000+encoded*0.1);
});
test('Published Mapbox example decodes to 407.2 m',()=>{
 const rgba=Uint8Array.from([1,150,136,255,1,150,136,255,1,150,136,255,1,150,136,255]);
 near(decodeTerrainRgb({zoom:0,x:0,y:0,size:2,rgba}).heights[0],407.2);
});
test('Byte carry boundary interpolates elevations, not quantized RGB channels',()=>{
 const rgba=Uint8Array.from([0,255,255,255,1,0,0,255,0,255,255,255,1,0,0,255]);
 const mosaic=new RasterMosaic([decodeTerrainRgb({zoom:0,x:0,y:0,size:2,rgba})]);near(mosaic.heightAt(.5,.5),-3446.45);
});
test('Alpha means nodata; a zero-weight nodata neighbour does not poison a valid centre',()=>{
 const rgba=Uint8Array.from([1,134,160,255,0,0,0,0,1,134,160,255,0,0,0,254]);
 const mosaic=new RasterMosaic([decodeTerrainRgb({zoom:0,x:0,y:0,size:2,rgba})]);
 near(mosaic.heightAt(.25,.25),0);assert.throws(()=>mosaic.heightAt(.5,.25),/nodata/);
});
test('Invalid dimensions, buffers, coordinates and limits rejected',()=>{
 for(const size of [0,3,1024,NaN])assert.throws(()=>decodeTerrainRgb({zoom:0,x:0,y:0,size,rgba:new Uint8Array(16)}));
 assert.throws(()=>decodeTerrainRgb({zoom:0,x:0,y:0,size:2,rgba:new Uint8Array(15)}));
 for(const coords of [[0,NaN,0],[25,0,0],[1,0,2]])assert.throws(()=>tileId(...coords));
 for(const uv of [[NaN,0],[0,Infinity],[0,-.1],[0,1.1]])assert.throws(()=>pixelTaps(...uv,1,256));
 assert.throws(()=>new RasterMosaic([]));
 assert.throws(()=>new RasterMosaic(heightTiles(Array.from({length:65},(_,x)=>({zoom:7,x,y:0})),2)));
 const tile=heightTiles([{zoom:1,x:0,y:0}],2)[0];assert.throws(()=>new RasterMosaic([tile,tile]));
 assert.throws(()=>new RasterMosaic([tile,...colourTiles([{zoom:1,x:1,y:0}],2)]));
});
test('Pixel-centre footprint blends the two sides of a source tile edge',()=>{
 const ids=[tileId(1,0,0),tileId(1,1,0),tileId(1,0,1),tileId(1,1,1)];
 const mosaic=new RasterMosaic(heightTiles(ids,2,(x,y)=>x+10*y));
 near(mosaic.heightAt(.5,.5),16.5);
 near(mosaic.heightAt(.375,.375),11);
 near(mosaic.heightAt(0,.375),11.5);
 near(mosaic.heightAt(1,.375),11.5);
 near(mosaic.heightAt(.375,0),1);near(mosaic.heightAt(.375,1),31);
});
test('Missing neighbouring coverage is an error, not tile-edge clamping or zero',()=>{
 const mosaic=new RasterMosaic(heightTiles([tileId(1,0,0)],2));
 assert.throws(()=>mosaic.heightAt(.5,.25),/Missing raster coverage/);
});
test('Mosaic snapshot does not change after caller mutates input data',()=>{
 const input=heightTiles([tileId(0,0,0)],2,()=>12),mosaic=new RasterMosaic(input);input[0].heights.fill(999);
 near(mosaic.heightAt(.5,.5),12);
});
test('Colour interpolation occurs in linear light and rejects transparent active samples',()=>{
 const tiles=colourTiles([tileId(0,0,0)],2,x=>x===0?[0,0,0,255]:[255,255,255,255]);
 assert.deepEqual(new RasterMosaic(tiles).rgbaAt(.5,.5),[188,188,188,255]);
 tiles[0].rgba[3]=0;assert.throws(()=>new RasterMosaic(tiles).rgbaAt(.25,.25),/nodata/);
 assert.throws(()=>new RasterMosaic(tiles).heightAt(.5,.5),/elevation/);
});
for(const [name,lon,lat] of [['Paris',2.35,48.86],['equator',0,0],['east-wrap',179.99999,35],['west-wrap',-179.99999,-35],['north',0,85]]){
 test(`DEM plan covers halo and exact vertex footprints at ${name}`,()=>{
  const cells=terrainPatchCells(geo(lon,lat),17,3),plan=planRasterTiles(cells,15,256,8,1),keys=new Set(plan.map(tileKey));
  for(const c of cells)for(let y=-1;y<=9;y++)for(let x=-1;x<=9;x++){
   const u=(c.x+x/8)/2**c.level,v=Math.max(0,Math.min(1,(c.y+y/8)/2**c.level));
   for(const tap of pixelTaps(u,v,15,256))assert(keys.has(tileKey(tap.tile)));
  }
 });
 test(`Raster-based 9-cell geometry and normals retain common edges at ${name}`,()=>{
  const origin=geo(lon,lat),cells=terrainPatchCells(origin,17,3),plan=planRasterTiles(cells,15,256,8,1);
  const mosaic=new RasterMosaic(heightTiles(plan,256,()=>45));
  const source=rasterElevationSource(mosaic,meta({kind:'ELLIPSOIDAL_WGS84'}));
  const sampler=new TerrainSampler(source),packets=cells.map(c=>buildTerrainCell(c,sampler,8));
  const report=measureTerrainSeams(packets,createGeoAnchor(origin));
  assert.equal(report.mismatchedKeys,0);assert(report.maxGapMeters<.001);assert(report.maxNormalDelta<2e-7);
 });
}
test('Oversized source zoom plan refused before allocating or fetching tiles',()=>{
 assert.throws(()=>planRasterTiles([cellId(15,0,0)],24,256,32,1),/budget/);
 assert.throws(()=>planRasterTiles([],15,256,32,1));
});
test('Vertical datum is fail-closed; no implicit EGM96 correction for mixed Mapbox',()=>{
 const mosaic=new RasterMosaic(heightTiles([tileId(0,0,0)],2,()=>80));
 assert.throws(()=>rasterElevationSource(mosaic,meta(MAPBOX_ELEVATION_DATUM)),/VERTICAL_DATUM_UNRESOLVED/);
 assert.throws(()=>rasterElevationSource(mosaic,meta(MAPBOX_ELEVATION_DATUM),{correction:{model:'EGM96',evidenceId:'grid',undulationMeters:()=>40}}),/does not match/);
 assert.throws(()=>rasterElevationSource(mosaic,meta({kind:'ORTHOMETRIC',model:'EGM96'})),/UNRESOLVED/);
});
test('Known orthometric heights use h=H+N with exact matching model and evidence',()=>{
 const mosaic=new RasterMosaic(heightTiles([tileId(0,0,0)],2,()=>80));
 const source=rasterElevationSource(mosaic,meta({kind:'ORTHOMETRIC',model:'fixture-geoid'}),{
  correction:{model:'fixture-geoid',evidenceId:'fixture-grid-hash',undulationMeters:()=>-12}});
 near(source.heightAt(geo(0,0)),68);assert.equal(source.provenance,'converted');
 assert.equal(source.verticalReference,'ELLIPSOIDAL_WGS84');
 const bad=rasterElevationSource(mosaic,meta({kind:'ORTHOMETRIC',model:'fixture-geoid'}),{
  correction:{model:'fixture-geoid',evidenceId:'fixture-grid-hash',undulationMeters:()=>NaN}});
 assert.throws(()=>bad.heightAt(geo(0,0)));
});
test('Preview opt-in is required at both conversion and mesh boundaries; flags survive in output',()=>{
 const cells=terrainPatchCells(geo(2.35,48.86),17,1),plan=planRasterTiles(cells,15,256,8,1);
 const source=rasterElevationSource(new RasterMosaic(heightTiles(plan)),meta(MAPBOX_ELEVATION_DATUM),{allowUnresolvedDatumPreview:true});
 assert.equal(source.verticalReference,'UNRESOLVED_DATUM_PREVIEW');assert.equal(source.provenance,'estimated');
 assert.throws(()=>new TerrainSampler(source));
 const packet=buildTerrainCell(cells[0],new TerrainSampler(source,undefined,{allowUnresolvedDatumPreview:true}),8);
 assert.equal(packet.altitudeAuthority,'preview-only');assert.equal(packet.verticalReference,'UNRESOLVED_DATUM_PREVIEW');
});
test('Imagery north/south convention, texel-centre UVs and equal-cell boundary colours',()=>{
 const cells=terrainPatchCells(geo(2.35,48.86),17,2),plan=planRasterTiles(cells,17,256,64,1);
 const mosaic=new RasterMosaic(colourTiles(plan));const packets=cells.map(c=>buildCellImagery(c,mosaic,64));
 const a=packets[0],b=packets[1],n=64,w=n+3;
 const pixel=(p,row,col)=>Array.from(p.rgba.slice((row*w+col)*4,(row*w+col)*4+4));
 for(let r=1;r<=n+1;r++)assert.deepEqual(pixel(a,r,n+1),pixel(b,r,1));
 for(let c=1;c<=n+1;c++)assert.deepEqual(pixel(packets[0],1,c),pixel(packets[2],n+1,c));
 near(a.uvOffset,1.5/w);near(a.uvScale,n/w);
 const first=cells[0], north=mosaic.rgbaAt(first.x/2**17,first.y/2**17);
 assert.deepEqual(pixel(a,n+1,1),Array.from(north));
 assert.throws(()=>buildCellImagery(first,mosaic,512));
});
test('Provider requests decouple zoom, require pk token and classify non-retryable auth',()=>{
 assert.match(mapboxTileUrl('elevation',tileId(15,0,0),'pk.test'),/15\/0\/0.pngraw/);
 assert.match(mapboxTileUrl('imagery',tileId(18,0,0),'pk.test'),/mapbox.satellite\/18/);
 assert.throws(()=>mapboxTileUrl('elevation',tileId(16,0,0),'pk.test'));
 for(const token of ['','sk.secret','pk.test&leak=1'])assert.throws(()=>mapboxTileUrl('elevation',tileId(15,0,0),token));
 for(const code of [401,403,404,422])assert.equal(providerFailure(code).retryable,false);
 for(const code of [429,500,503])assert.equal(providerFailure(code).retryable,true);
});
