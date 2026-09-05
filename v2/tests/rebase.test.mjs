import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeoAnchor, geodeticToEcef, ecefToThreeLocal, threeLocalToEcef,
  frameTransform, transformPoint, transformDirection, shouldRebase, multiply, transpose } from '../dist/geo/index.js';
import { position, xyz, distance, near, nearVector } from './helpers.mjs';

test('Point, velocity and cell-anchor transforms agree with direct ECEF', () => {
  const from=createGeoAnchor(position([179.999,55,30]));
  const to=createGeoAnchor(position([-179.99,55.01,70]));
  const global=geodeticToEcef(position([180,55.005,45]));
  const change=frameTransform(from,to);
  nearVector(transformPoint(ecefToThreeLocal(global,from),change),ecefToThreeLocal(global,to),1e-6);
  const velocity=[5,2,-1];
  near(Math.hypot(...transformDirection(velocity,change)),Math.hypot(...velocity),1e-12);
  nearVector(transformDirection([0,0,0],change),[0,0,0],0);
  nearVector(multiply(change.rotation,transpose(change.rotation)),[1,0,0,0,1,0,0,0,1],1e-14);
  nearVector(transformPoint([0,0,0],change),ecefToThreeLocal(from.ecef,to),1e-9);
});

test('500 chained frame changes preserve global position and relative separation below 1 mm', () => {
  let anchor=createGeoAnchor(position([2,48,100]));
  const aGlobal=geodeticToEcef(position([2.005,48.006,110]));
  const bGlobal=geodeticToEcef(position([2.006,48.007,112]));
  let a=ecefToThreeLocal(aGlobal,anchor), b=ecefToThreeLocal(bGlobal,anchor);
  const expectedSeparation=distance(a,b);
  for (let i=1;i<=500;i++) {
    const next=createGeoAnchor(position([2+0.03*Math.sin(i/13),48+0.03*Math.cos(i/17),100+i%5]));
    const transform=frameTransform(anchor,next);
    a=transformPoint(a,transform); b=transformPoint(b,transform);
    nearVector(xyz(threeLocalToEcef(a,next)),xyz(aGlobal),0.001);
    near(distance(a,b),expectedSeparation,0.001);
    anchor=next;
  }
});

test('Same frame is identity; immutable outputs', () => {
  const a=createGeoAnchor(position([2,48,80])), t=frameTransform(a,a);
  nearVector(transformPoint([5,2,3],t),[5,2,3],1e-12);
  assert.ok(Object.isFrozen(t));
});

test('Rebase threshold uses horizontal metres only, rejects invalid thresholds', () => {
  assert.equal(shouldRebase([2048,0,0]),false);
  assert.equal(shouldRebase([2048.01,0,0]),true);
  assert.equal(shouldRebase([0,50000,0]),false);
  assert.equal(shouldRebase([0,0,-101],100),true);
  for (const t of [0,-1,NaN,Infinity]) assert.throws(()=>shouldRebase([0,0,0],t),RangeError);
  assert.throws(()=>shouldRebase([0,NaN,0]),RangeError);
});
