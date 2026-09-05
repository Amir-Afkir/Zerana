import test from 'node:test';
import assert from 'node:assert/strict';
import { degrees, radians, meters, toRadians, toDegrees, normalizeLongitude,
  geodeticRadians, ecefPosition, geodeticToEcef, ecefToGeodetic, GEO_LIMITS } from '../dist/geo/index.js';
import { fixtures, position, ecef, xyz, near, nearVector } from './helpers.mjs';

for (const [i, row] of fixtures.ecef.entries()) {
  test(`PROJ reference ${i}: forward/inverse geodesy within 1 mm`, () => {
    const p = position(row.geodeticDegMeters);
    nearVector(xyz(geodeticToEcef(p)), row.ecefMeters, 0.001, 'Independent PROJ forward');
    const reconstructed = ecefToGeodetic(ecef(row.ecefMeters));
    nearVector(xyz(geodeticToEcef(reconstructed)), row.ecefMeters, 0.001, 'inverse metric error');
    near(reconstructed.ellipsoidHeightMeters, row.geodeticDegMeters[2], 0.001, 'height');
    near(reconstructed.latitudeRad, p.latitudeRad, 1e-11, 'latitude');
    // Longitude has no physical meaning exactly on the polar axis.
    if (Math.abs(row.geodeticDegMeters[1]) !== 90) {
      near(normalizeLongitude(radians(reconstructed.longitudeRad-p.longitudeRad)), 0, 1e-11, 'longitude');
    }
  });
}

test('Units conversions and longitude normalization', () => {
  near(toRadians(degrees(180)), Math.PI, 1e-15);
  near(toDegrees(radians(Math.PI)), 180, 1e-12);
  assert.equal(normalizeLongitude(radians(Math.PI)), -Math.PI);
  assert.equal(normalizeLongitude(radians(-Math.PI)), -Math.PI);
  near(normalizeLongitude(toRadians(degrees(-540))), -Math.PI, 1e-14);
  near(normalizeLongitude(toRadians(degrees(720))), 0, 1e-14);
  assert.equal(Object.is(normalizeLongitude(radians(-0)), -0), false);
});

test('Reject NaN, Infinity, invalid latitude and unsupported height', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const unit of [degrees, radians, meters]) assert.throws(() => unit(value), RangeError);
    assert.throws(() => ecefToGeodetic({ xMeters:value, yMeters:0, zMeters:0 }), RangeError);
  }
  assert.throws(() => position([0,91,0]), RangeError);
  assert.throws(() => position([0,-91,0]), RangeError);
  assert.throws(() => position([0,0,-12001]), RangeError);
  assert.throws(() => position([0,0,100000001]), RangeError);
  assert.throws(() => geodeticToEcef({longitudeRad:0, latitudeRad:2, ellipsoidHeightMeters:0}), RangeError);
});

test('Reject centre of Earth, deeply internal points, huge vectors and invalid iteration count', () => {
  for (const p of [[0,0,0],[1,1,1],[1000,0,1000],[1e200,0,0]]) assert.throws(() => ecefToGeodetic(ecef(p)), RangeError);
  for (const maxIterations of [0,-1,1.5,101,NaN]) {
    assert.throws(() => ecefToGeodetic(ecef(fixtures.ecef[6].ecefMeters), {maxIterations}), RangeError);
  }
});

test('No unconverged inverse returned as success', () => {
  const p = geodeticToEcef(position([42,43,40000000]));
  assert.throws(() => ecefToGeodetic(p, { maxIterations:1 }), /did not converge/);
});

test('Geodetic/ECEF boundary values and immutable records', () => {
  const p = geodeticRadians(radians(0), radians(0), meters(GEO_LIMITS.minEllipsoidHeightMeters));
  assert.ok(Object.isFrozen(p));
  const c = ecefPosition(meters(6378137),meters(0),meters(0));
  assert.ok(Object.isFrozen(c));
  assert.equal(ecefToGeodetic(geodeticToEcef(p)).ellipsoidHeightMeters, -12000);
});
