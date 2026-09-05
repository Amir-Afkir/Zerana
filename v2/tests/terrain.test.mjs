import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { degrees, meters } from '../dist/geo/units.js';
import { geodeticDegrees } from '../dist/geo/geodetic.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { ecefToGeodetic } from '../dist/geo/ecef.js';
import { cellId, MercatorCellScheme } from '../dist/geo/mercator-cell-scheme.js';
import { MERCATOR_MAX_LATITUDE_RAD } from '../dist/geo/mercator.js';
import { threeLocalToEcef, ecefToThreeLocal } from '../dist/geo/three-frame.js';
import { frameTransform, transformPoint } from '../dist/geo/floating-origin.js';
import { latticeAddress, cellSampleAddress, validateTerrainGrid } from '../dist/generation/terrain/lattice.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { buildTerrainCell, readVertex } from '../dist/generation/terrain/terrain-builder.js';
import { terrainPatchCells } from '../dist/world/terrain-patch.js';
import { measureTerrainSeams } from '../dist/debug/seam-metrics.js';

const geo = (lon, lat, h = 0) => geodeticDegrees(degrees(lon), degrees(lat), meters(h));
const distance = (a, b) => Math.hypot(...a.map((v,i)=>v-b[i]));
const xyz = p => [p.xMeters,p.yMeters,p.zMeters];
const scheme = new MercatorCellScheme();

for (const level of [15,17,24]) test(`canonical lattice level ${level}, corners and antimeridian`,()=>{
  const n = 2**level, s = 32, a = cellId(level,n-1,Math.floor(n/2)), b = cellId(level,0,a.y);
  for(let i=0;i<=s;i++) assert.deepEqual(cellSampleAddress(a,s,s,i),cellSampleAddress(b,s,0,i));
  assert.deepEqual(latticeAddress(level+5,n*s,0),latticeAddress(level+5,0,0));
  const parent = cellId(level-1,10,10);
  if(level>15) assert.equal(cellSampleAddress(parent,s,s/2,s/2).key,
    cellSampleAddress(cellId(level,20,20),s,s,s).key);
});

test('input budgets fail before allocation',()=>{
  const id=cellId(17,200,200);
  for(const n of [0,1,3,31,257,NaN,Infinity]) assert.throws(()=>validateTerrainGrid(id,n));
  assert.throws(()=>validateTerrainGrid(cellId(14,0,0),32));
  assert.throws(()=>cellSampleAddress(id,32,-1,0));
  assert.throws(()=>latticeAddress(32,1,-1));
  assert.throws(()=>latticeAddress(33,0,0));
  assert.throws(()=>latticeAddress(32,Number.MAX_SAFE_INTEGER+1,0));
  assert.throws(()=>new TerrainSampler({...syntheticElevation('flat'),verticalReference:'UNKNOWN'}));
  assert.throws(()=>new TerrainSampler(syntheticElevation('flat'),0));
  assert.throws(()=>syntheticElevation('unknown'));
});

test('cache is source-bound, bounded, and deterministic after eviction',()=>{
  const sampler=new TerrainSampler(syntheticElevation('waves'),3);
  const first=sampler.sample(22,2100000,1400000);
  for(let x=0;x<100;x++) sampler.sample(22,2100000+x,1400000);
  assert.equal(sampler.size,3);
  assert.deepEqual(first,sampler.sample(22,2100000,1400000));
  assert(Object.isFrozen(first)); assert(Object.isFrozen(sampler.source));
  sampler.clear(); assert.equal(sampler.size,0);
});

test('bad heights and oversize cells are rejected',()=>{
  const source=syntheticElevation('flat'), id=cellId(17,200,200);
  for(const height of [NaN,Infinity,100000001]) {
    assert.throws(()=>buildTerrainCell(id,new TerrainSampler({...source,heightAt:()=>height}),4));
  }
  assert.throws(()=>buildTerrainCell(id,new TerrainSampler({...source,
    heightAt:p=>p.longitudeRad < scheme.getCenter(id).longitudeRad ? 0 : 10000}),4),/precision budget/);
});

test('packet topology, finite buffers, exact UV orientation and upward winding',()=>{
  const cell=buildTerrainCell(scheme.getCellAt(geo(2.35,48.86),17),new TerrainSampler(syntheticElevation('waves')),32);
  assert.equal(cell.positions.length,33*33*3); assert.equal(cell.indices.length,32*32*6);
  assert(cell.indices instanceof Uint16Array);
  assert.deepEqual([...cell.uvs.slice(0,2)],[0,1]);
  assert.deepEqual([...cell.uvs.slice(-2)],[1,0]);
  for(const b of [cell.positions,cell.normals,cell.uvs,cell.heightsMeters]) for(const v of b) assert(Number.isFinite(v));
  for(let i=0;i<cell.positions.length/3;i++) {
    const p=readVertex(cell.positions,i), normal=readVertex(cell.normals,i);
    assert(Math.abs(Math.hypot(...normal)-1)<1e-6);
    for(let j=0;j<3;j++) assert(p[j]>=cell.bounds.min[j] && p[j]<=cell.bounds.max[j]);
  }
  for(let i=0;i<cell.indices.length;i+=3) {
    const [a,b,c]=[0,1,2].map(k=>readVertex(cell.positions,cell.indices[i+k]));
    const u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]);
    const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const normal=readVertex(cell.normals,cell.indices[i]);
    assert(cross.reduce((sum,x,k)=>sum+x*normal[k],0)>0,'triangle faces upward');
  }
  assert.throws(()=>readVertex(cell.positions,-1));
});

test('256 subdivisions require Uint32 indices, no index truncation',()=>{
  const cell=buildTerrainCell(cellId(17,65536,65536),new TerrainSampler(syntheticElevation('flat')),256);
  assert(cell.indices instanceof Uint32Array);
  assert.equal(cell.positions.length/3,66049);
  assert.equal(cell.indices.at(-1),66048);
});

const fixture=JSON.parse(readFileSync(new URL('./fixtures/proj-terrain.json',import.meta.url)));
for(const [i,reference] of fixture.vertices.entries()) test(`PROJ terrain vertex ${i+1}`,()=>{
  const id=cellId(...reference.cell), sampler=new TerrainSampler(syntheticElevation('flat'));
  const cell=buildTerrainCell(id,sampler,32), index=reference.row*33+reference.column;
  const ecef=threeLocalToEcef(readVertex(cell.positions,index),cell.anchor);
  assert(distance(xyz(ecef),reference.ecefMeters)<0.001,'Float32 vertex agrees with independent PROJ reference');
  assert(Math.abs(ecefToGeodetic(ecef).ellipsoidHeightMeters)<0.001);
});

const sites=[['equator',0,0],['Paris',2.35,48.86],['Tanger',-5.81,35.76],['Tokyo',139.69,35.68],
  ['antimeridian east',179.99999,35],['antimeridian west',-179.99999,-35],
  ['north coverage',0,MERCATOR_MAX_LATITUDE_RAD*180/Math.PI],['south coverage',0,-MERCATOR_MAX_LATITUDE_RAD*180/Math.PI]];
for(const [name,lon,lat] of sites) for(const level of [15,17,24]) test(`9-cell seams at ${name}, L${level}`,()=>{
  const origin=geo(lon,lat), sampler=new TerrainSampler(syntheticElevation('waves'));
  const ids=terrainPatchCells(origin,level,3);
  assert.equal(ids.length,9); assert.equal(new Set(ids.map(id=>scheme.getStableKey(id))).size,9);
  const cells=ids.map(id=>buildTerrainCell(id,sampler,8));
  const report=measureTerrainSeams(cells,createGeoAnchor(origin));
  assert.equal(report.edgePairs,12); assert.equal(report.comparedVertices,12*9);
  assert.equal(report.mismatchedKeys,0);
  assert(report.maxGapMeters<0.001,JSON.stringify(report));
  assert(report.estimatedFloat32GapMeters<0.001,JSON.stringify(report));
  assert(report.maxNormalDelta<2e-7,JSON.stringify(report));
});

test('1/4/9 cells and equal-LOD diagnostics reject invalid mixed inputs',()=>{
  const origin=geo(2.35,48.86), sampler=new TerrainSampler(syntheticElevation('flat'));
  for(const side of [1,2,3]) {
    const cells=terrainPatchCells(origin,17,side).map(id=>buildTerrainCell(id,sampler,4));
    assert.equal(cells.length,side*side);
    assert.equal(measureTerrainSeams(cells,createGeoAnchor(origin)).edgePairs,2*side*(side-1));
  }
  const a=buildTerrainCell(scheme.getCellAt(origin,17),sampler,4);
  assert.throws(()=>measureTerrainSeams([a,a],createGeoAnchor(origin)));
  assert.throws(()=>terrainPatchCells(origin,17,4));
  assert.throws(()=>terrainPatchCells(geo(0,90),17,1));
});

test('loading order and fresh caches do not change geometry or normals',()=>{
  const ids=terrainPatchCells(geo(179.99999,45),17,3);
  const forward=new TerrainSampler(syntheticElevation('waves')), reverse=new TerrainSampler(syntheticElevation('waves'),5);
  const built=new Map(ids.map(id=>[scheme.getStableKey(id),buildTerrainCell(id,forward,8)]));
  for(const id of [...ids].reverse()) {
    const old=built.get(scheme.getStableKey(id)), next=buildTerrainCell(id,reverse,8);
    assert.deepEqual(next.positions,old.positions); assert.deepEqual(next.normals,old.normals);
    assert.deepEqual(next.sampleKeys,old.sampleKeys);
  }
});

test('render-frame rebases preserve fixed buffers and world vertices',()=>{
  const origin=geo(2.35,48.86), sampler=new TerrainSampler(syntheticElevation('waves'));
  const cells=terrainPatchCells(origin,17,3).map(id=>buildTerrainCell(id,sampler,8));
  const reference=cells.map(c=>c.positions.slice());
  const world=createGeoAnchor(origin);
  let maxError=0;
  for(let iteration=0;iteration<100;iteration++) {
    const shifted=threeLocalToEcef([Math.sin(iteration)*500,0,Math.cos(iteration)*500],world);
    const next=createGeoAnchor(ecefToGeodetic(shifted));
    for(const [i,c] of cells.entries()) {
      assert.deepEqual(c.positions,reference[i]);
      const p=readVertex(c.positions,0), actual=transformPoint(p,frameTransform(c.anchor,next));
      const expected=ecefToThreeLocal(threeLocalToEcef(p,c.anchor),next);
      maxError=Math.max(maxError,distance(actual,expected));
    }
    assert(measureTerrainSeams(cells,next).maxGapMeters<0.001);
  }
  assert(maxError<1e-6);
});
