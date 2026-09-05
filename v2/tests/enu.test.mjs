import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeoAnchor, ecefToEnu, enuToEcef, geodeticToEcef,
  ecefToThreeLocal, threeLocalToEcef, enuToThree, threeToEnu,
  matrix, multiply, transpose, vector } from '../dist/geo/index.js';
import { fixtures, position, xyz, near, nearVector } from './helpers.mjs';

for (const [i,row] of fixtures.enu.entries()) {
  test(`ENU reference ${i}: independent PROJ topocentric conversion`, () => {
    const anchor=createGeoAnchor(position(row.originDegMeters));
    const p=geodeticToEcef(position(row.pointDegMeters));
    nearVector(ecefToEnu(p,anchor), row.enuMeters, 1e-6);
    nearVector(xyz(enuToEcef(row.enuMeters,anchor)), xyz(p), 1e-6);
    nearVector(ecefToThreeLocal(p,anchor), [row.enuMeters[0],row.enuMeters[2],-row.enuMeters[1]], 1e-6);
  });
}
for (const [i,row] of fixtures.oneMeterGeodesics.entries()) {
  test(`Geodesic metre ${i}: real ellipsoidal surface step, latitude ${row.originDegMeters[1]}`, () => {
    const anchor=createGeoAnchor(position(row.originDegMeters));
    const p=geodeticToEcef(position(row.pointDegMeters));
    const local=ecefToThreeLocal(p,anchor);
    near(Math.hypot(...local),1,1e-6);
    nearVector(local, row.bearingDeg===90?[1,0,0]:[0,0,-1], 1e-6);
  });
}
for (const p of [[0,0,0],[0,90,0],[140,-90,10],[180,50,100],[-5,35,0]]) {
  test(`Frame is right-handed, orthonormal and metre-preserving: ${p.join(',')}`, () => {
    const a=createGeoAnchor(position(p)), m=a.ecefToEnu;
    nearVector(multiply(m,transpose(m)), [1,0,0,0,1,0,0,0,1], 1e-14);
    const det=m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);
    near(det,1,1e-14);
    for (const v of [[1,0,0],[0,1,0],[0,0,1],[10,20,-30]]) {
      nearVector(ecefToThreeLocal(threeLocalToEcef(v,a),a),v,1e-8);
    }
    assert.ok(Object.isFrozen(a.ecefToEnu));
    assert.ok(Object.isFrozen(a));
  });
}

test('Axes: ENU East/North/Up maps to Three East/Up/South', () => {
  assert.deepEqual(enuToThree([3,5,7]),[3,7,-5]);
  assert.deepEqual(threeToEnu([3,7,-5]),[3,5,7]);
  const anchor=createGeoAnchor(position([0,0,0]));
  nearVector(ecefToEnu({xMeters:6378138,yMeters:0,zMeters:0},anchor),[0,0,1],1e-12);
});

test('Matrices and vectors reject non-finite values', () => {
  assert.throws(()=>vector(NaN,0,0),RangeError);
  assert.throws(()=>matrix([1,2]),RangeError);
  assert.throws(()=>matrix(new Array(9)),RangeError);
  assert.throws(()=>matrix([NaN,0,0,0,1,0,0,0,1]),RangeError);
});
