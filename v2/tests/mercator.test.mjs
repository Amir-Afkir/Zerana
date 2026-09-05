import test from 'node:test';
import assert from 'node:assert/strict';
import { MercatorCellScheme, cellId, projectMercator, unprojectMercator,
  radians, geodeticRadians, meters, MERCATOR_MAX_LATITUDE_RAD, GEO_LIMITS } from '../dist/geo/index.js';
import { position, near } from './helpers.mjs';
const scheme=new MercatorCellScheme();

for (const p of [[0,0,0],[2.35,48.86,40],[-5.81,35.76,0],[139.69,35.68,0],[179.999,80,0],[-179.999,-80,0]]) {
  test(`Mercator exact interior position retained: ${p.join(',')}`, () => {
    const geo=position(p), uv=projectMercator(geo.longitudeRad,geo.latitudeRad);
    const back=unprojectMercator(uv);
    near(back.longitudeRad,geo.longitudeRad,1e-14); near(back.latitudeRad,geo.latitudeRad,1e-14);
    const located=scheme.locate(geo,19), n=2**19;
    near((located.id.x+located.fractionX)/n,uv.u,1e-15);
    near((located.id.y+located.fractionY)/n,uv.v,1e-15);
    assert.ok(located.fractionX>=0 && located.fractionX<1);
    assert.ok(located.fractionY>=0 && located.fractionY<=1);
  });
}

test('Exact poles fail rather than silently teleporting to coverage boundary', () => {
  assert.throws(()=>scheme.locate(position([0,90,0]),17),/coverage/);
  assert.throws(()=>scheme.locate(position([0,-90,0]),17),/coverage/);
});

test('Both coverage edges remain valid, especially the south edge at v=1', () => {
  for (const sign of [-1,1]) {
    const p=geodeticRadians(radians(0),radians(sign*MERCATOR_MAX_LATITUDE_RAD),meters(0));
    const result=scheme.locate(p,24);
    assert.equal(result.id.y,sign===1?0:2**24-1);
    near(result.fractionY,sign===1?0:1,1e-7);
  }
});

test('Antimeridian wraps longitude and neighbors, never north/south', () => {
  assert.deepEqual(scheme.getCellAt(position([180,0,0]),5),scheme.getCellAt(position([-180,0,0]),5));
  const neighbors=scheme.getNeighbors(cellId(5,0,0));
  assert.equal(neighbors.length,3);
  assert.ok(neighbors.some(n=>n.x===31 && n.y===0));
  assert.ok(!neighbors.some(n=>n.y===31));
  assert.equal(scheme.getBounds(cellId(5,31,12)).eastRad,Math.PI);
});

test('Center, parent, children, stable IDs and root', () => {
  const id=cellId(17,66321,45122);
  assert.deepEqual(scheme.getCellAt(scheme.getCenter(id),17),id);
  assert.equal(scheme.getStableKey(id),'web-mercator/17/66321/45122');
  for(const child of scheme.getChildren(id)) assert.deepEqual(scheme.getParent(child),id);
  assert.equal(scheme.getParent(cellId(0,0,0)),null);
  assert.deepEqual(scheme.getNeighbors(cellId(0,0,0)),[]);
  assert.equal(scheme.getNeighbors(cellId(1,0,0)).length,2);
});

test('Adjacent cell bounds match exactly, without any half-chunk convention', () => {
  for (const level of [1,5,17,24]) {
    const a=scheme.getBounds(cellId(level,0,0));
    const right=scheme.getBounds(cellId(level,1,0));
    const bottom=scheme.getBounds(cellId(level,0,1));
    assert.equal(a.eastRad,right.westRad);
    assert.equal(a.southRad,bottom.northRad);
  }
});

test('Reject invalid cell IDs, levels and projection coordinates', () => {
  for (const values of [[-1,0,0],[25,0,0],[3.5,0,0],[3,-1,0],[3,0,8],[3,1.1,0]]) {
    assert.throws(()=>cellId(...values),RangeError);
  }
  assert.throws(()=>scheme.getStableKey({scheme:'unknown',level:0,x:0,y:0}),RangeError);
  assert.throws(()=>scheme.getChildren(cellId(GEO_LIMITS.maxCellLevel,0,0)),RangeError);
  for (const uv of [{u:NaN,v:0},{u:0,v:NaN},{u:0,v:-0.1},{u:0,v:1.1}]) assert.throws(()=>unprojectMercator(uv),RangeError);
  assert.throws(()=>projectMercator(radians(0),NaN),RangeError);
});
