import test from 'node:test';
import assert from 'node:assert/strict';
import { RasterMosaic } from '../dist/providers/raster/raster-grid.js';
import { rasterElevationSource } from '../dist/providers/raster/vertical-datum.js';
import { certifyHydroTriangles } from '../dist/generation/hydro/certificate.js';

const mosaic=()=>new RasterMosaic(Array.from({length:4},(_,i)=>({zoom:1,x:i%2,y:Math.floor(i/2),size:4,
 heights:Float64Array.from({length:16},(_,j)=>j===5&&i===0?-7:10+i+j/16)})));
test('elevation bounds include every bilinear point, not just the rectangle corners',()=>{
 const m=mosaic(),b=m.heightBounds(.1,.1,.49,.49);assert.equal(b.minimumMeters,-7);
 for(let y=0;y<=40;y++)for(let x=0;x<=40;x++){
  const h=m.heightAt(.1+x*.39/40,.1+y*.39/40);assert.ok(h>=b.minimumMeters&&h<=b.maximumMeters);
 }
});
test('elevation bounds are independent of tile/antimeridian image and input order',()=>{
 const m=mosaic();assert.deepEqual(m.heightBounds(-.08,.1,.08,.3),m.heightBounds(.92,.1,1.08,.3));
 const b=m.heightBounds(-.08,.1,.08,.3);
 for(let i=0;i<=40;i++){const h=m.heightAt(-.08+.16*i/40,.2);assert.ok(h>=b.minimumMeters&&h<=b.maximumMeters);}
});
test('elevation envelope rejects nodata, missing coverage and oversized bounds',()=>{
 const h=new Float64Array(16).fill(10);h[5]=NaN;
 assert.throws(()=>new RasterMosaic([{zoom:1,x:0,y:0,size:4,heights:h}]).heightBounds(.1,.1,.3,.3),/nodata/);
 assert.throws(()=>new RasterMosaic([{zoom:1,x:0,y:0,size:4,heights:new Float64Array(16)}]).heightBounds(.4,.1,.6,.3),/coverage/);
 const m=new RasterMosaic([{zoom:15,x:0,y:0,size:256,heights:new Float64Array(65536)}]);
 assert.throws(()=>m.heightBounds(0,0,1,1),/BUDGET/);
});
test('raster bounds stay in the declared datum; arbitrary geoid conversion has no bounds capability',()=>{
 const m=mosaic(),metadata={sourceId:'fixture',snapshotId:'one',verticalDatum:{kind:'MIXED_OR_UNKNOWN',description:'fixture'}};
 const preview=rasterElevationSource(m,metadata,{allowUnresolvedDatumPreview:true});
 assert.deepEqual(preview.heightBounds(.1,.1,.3,.3),m.heightBounds(.1,.1,.3,.3));
 const converted=rasterElevationSource(m,{...metadata,verticalDatum:{kind:'ORTHOMETRIC',model:'test'}},
  {correction:{model:'test',evidenceId:'correction',undulationMeters:()=>3}});
 assert.equal(converted.heightBounds,undefined);
});
test('floating-water regression: old one-sided certificate passes, new opposite gap exposes the canopy',()=>{
 const t={sourceId:'canopy',positions:new Float32Array([0,0,0,1,0,0,0,0,1]),indices:new Uint16Array([0,1,2]),bounds:{min:[0,0,0],max:[1,0,1]}};
 const w={terrainSourceId:'canopy',positions:new Float32Array([0,20,0,1,20,0,0,20,1]),indices:new Uint16Array([0,1,2]),triangleCount:1};
 const c=certifyHydroTriangles(t,w);assert.equal(c.passed,true);assert.equal(c.maxTerrainAboveWaterMeters,-20);assert.equal(c.maxWaterAboveTerrainMeters,20);
});
test('maximum depth certificate sees the deepest interior, not only water vertices or minimum clearance',()=>{
 const t={sourceId:'bowl',positions:new Float32Array([0,0,0,10,0,0,10,0,10,0,0,10,5,-10,5]),indices:new Uint16Array([0,1,4,1,2,4,2,3,4,3,0,4]),bounds:{min:[0,-10,0],max:[10,0,10]}};
 const w={terrainSourceId:'bowl',positions:new Float32Array([0,1,0,10,1,0,10,1,10,0,1,10]),indices:new Uint16Array([0,1,2,0,2,3]),triangleCount:2};
 const c=certifyHydroTriangles(t,w);assert.equal(c.minClearanceMeters,1);assert.equal(c.maxWaterAboveTerrainMeters,11);
});


test('human-view diagnostic distinguishes a dry bank, a submerged camera and a camera above water',async()=>{
 const {probeWaterView}=await import('../dist/generation/hydro/view-probe.js');
 const {geodeticDegrees}=await import('../dist/geo/geodetic.js');
 const {createGeoAnchor}=await import('../dist/geo/enu.js');
 const {threeLocalToEcef}=await import('../dist/geo/three-frame.js');
 const anchor=createGeoAnchor(geodeticDegrees(0,0,0));
 const surfaces=[{anchor,water:{positions:new Float32Array([0,3,0,10,3,0,0,3,10]),indices:new Uint16Array([0,1,2])}}];
 const under=probeWaterView(threeLocalToEcef([1,1,1],anchor),surfaces);
 assert.equal(under.overWater,true);assert.ok(Math.abs(under.clearanceMeters+2)<1e-8);
 const above=probeWaterView(threeLocalToEcef([1,5,1],anchor),surfaces);assert.ok(above.clearanceMeters>1.99);
 const bank=probeWaterView(threeLocalToEcef([-1,1,1],anchor),surfaces);assert.equal(bank.overWater,false);assert.equal(bank.clearanceMeters,null);
 assert.ok(bank.nearbyMaxWaterAbovePointMeters>1.99);
});
