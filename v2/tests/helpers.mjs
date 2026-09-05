import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { degrees, meters, geodeticDegrees, ecefPosition } from '../dist/geo/index.js';
export const fixtures = JSON.parse(readFileSync(new URL('./fixtures/proj-wgs84.json', import.meta.url)));
export const position = ([lon, lat, h]) => geodeticDegrees(degrees(lon), degrees(lat), meters(h));
export const ecef = ([x,y,z]) => ecefPosition(meters(x), meters(y), meters(z));
export const xyz = (p) => [p.xMeters, p.yMeters, p.zMeters];
export const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
export function near(actual, expected, tolerance, label = '') {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} vs ${expected}; tolerance ${tolerance}`);
}
export function nearVector(actual, expected, tolerance, label = '') {
  assert.ok(distance(actual, expected) <= tolerance, `${label}: distance ${distance(actual,expected)} > ${tolerance}`);
}
