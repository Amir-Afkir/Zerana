import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionConvex, splitHalfPlane, intersectConvex, signedArea } from '../dist/generation/roads/convex.js';
import { ROAD_SURFACE_LIMITS } from '../dist/generation/roads/surface.js';

// Reference algorithm from the published PR10/PR11, without disjoint rejection.
function legacyPartition(subject, clip) {
  let inside = subject;
  const outside = [];
  for (let i = 0; i < clip.length && inside.length; i++) {
    const part = splitHalfPlane(inside, clip[i], clip[(i + 1) % clip.length]);
    if (part.outside.length) outside.push(part.outside);
    inside = part.inside;
  }
  return { inside, outside };
}
const area = polygons => polygons.reduce((sum, p) => sum + signedArea(p), 0);
const triangle = [[0, 0], [1, 0], [0, 1]];

test('disjoint convex polygons with intersecting bounding boxes do not fragment the subject', () => {
  const clip = [[.65, .65], [.9, .65], [.9, .9], [.65, .9]];
  const previous = legacyPartition(triangle, clip);
  assert.ok(previous.outside.length > 1);
  const current = partitionConvex(triangle, clip);
  assert.deepEqual(current.inside, []);
  assert.equal(current.outside.length, 1);
  assert.equal(current.outside[0], triangle);
  assert.equal(area(current.outside), .5);
});

test('covered junction clips no longer exhaust the unchanged triangle-piece budget', t => {
  const terrain = [[0, 0], [2, 0], [0, 2]];
  const covered = [[0, 1], [1, 0], [2, 0], [0, 2]];
  let old = legacyPartition(terrain, covered).outside;
  let next = partitionConvex(terrain, covered).outside;
  assert.equal(area(old), .5);
  let oldOperations = 1, newOperations = 1;
  for (let i = 0; i < 128; i++) {
    const x = .05 + .9 * i / 128, y = 1.0001 - x, width = .05;
    const polygon = [[x, y], [x + width, y], [x + width, y + width], [x, y + width]];
    // Every candidate intersects the TERRAIN triangle: the surface broad phase
    // cannot discard it. It is disjoint only from the remaining uncovered piece.
    const clip = intersectConvex(polygon, terrain);
    assert.ok(signedArea(clip) > 0);
    old = old.flatMap(p => { oldOperations++; return legacyPartition(p, clip).outside; });
    next = next.flatMap(p => {
      newOperations++;
      const part = partitionConvex(p, clip);
      assert.equal(part.inside.length, 0);
      return part.outside;
    });
  }
  assert.equal(ROAD_SURFACE_LIMITS.maxTrianglePieces, 192);
  assert.equal(ROAD_SURFACE_LIMITS.maxOperations, 150000);
  assert.ok(old.length > ROAD_SURFACE_LIMITS.maxTrianglePieces);
  assert.equal(next.length, 1);
  assert.ok(Math.abs(area(old) - area(next)) < 1e-12);
  t.diagnostic(JSON.stringify({oldPieces:old.length,newPieces:next.length,oldOperations,newOperations}));
});

test('edge and point contact have zero coverage without deleting the uncovered polygon', () => {
  for (const clip of [
    [[1, 0], [2, 0], [1, 1]],
    [[0, 1], [1, 0], [1, 1]],
    [[0, -1], [1, -1], [1, 0], [0, 0]],
  ]) {
    const result = partitionConvex(triangle, clip);
    assert.equal(result.inside.length, 0);
    assert.deepEqual(result.outside, [triangle]);
  }
});

test('a narrow positive intersection is retained without a new epsilon', () => {
  const subject = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const clip = [[1 - 1e-8, .2], [2, .2], [2, .8], [1 - 1e-8, .8]];
  const current = partitionConvex(subject, clip);
  const reference = legacyPartition(subject, clip);
  assert.ok(signedArea(current.inside) > 5.9e-9);
  assert.deepEqual(current, reference);
  assert.ok(Math.abs(signedArea(current.inside) + area(current.outside) - 1) < 1e-12);
});

test('contained coverage and holes preserve complementary area', () => {
  const subject = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
  const clip = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const result = partitionConvex(subject, clip);
  assert.deepEqual(result, legacyPartition(subject, clip));
  assert.equal(signedArea(result.inside), 4);
  assert.equal(area(result.outside), 12);
  assert.equal(signedArea(partitionConvex(clip, subject).inside), 4);
  assert.deepEqual(partitionConvex(clip, subject).outside, []);
});

test('500 deterministic convex pairs preserve the legacy intersection and complement areas', () => {
  let seed = 0x5a17c3;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2**32; };
  const rectangle = () => {
    const x = 4 * random() - 2, y = 4 * random() - 2;
    const w = .01 + random(), h = .01 + random(), angle = random() * Math.PI * 2;
    return [[-w,-h],[w,-h],[w,h],[-w,h]].map(([a,b]) =>
      [x + a * Math.cos(angle) - b * Math.sin(angle), y + a * Math.sin(angle) + b * Math.cos(angle)]);
  };
  for (let i = 0; i < 500; i++) {
    const subject = rectangle(), clip = rectangle();
    const reference = legacyPartition(subject, clip), result = partitionConvex(subject, clip);
    assert.ok(Math.abs(signedArea(result.inside) - signedArea(reference.inside)) < 1e-11, `inside ${i}`);
    assert.ok(Math.abs(area(result.outside) - area(reference.outside)) < 1e-11, `outside ${i}`);
    assert.ok(Math.abs(signedArea(result.inside) + area(result.outside) - signedArea(subject)) < 1e-11, `total ${i}`);
    assert.ok(result.outside.every(p => signedArea(p) > 0));
    // Nonempty intersections take the existing clipping path, byte-for-byte.
    if (result.inside.length) assert.deepEqual(result, reference);
  }
});
