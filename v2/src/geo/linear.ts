import { assertFinite } from './units.js';

/** Immutable row-major matrices / vectors. JS numbers retain Float64 precision. */
export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export function vector(x: number, y: number, z: number): Vec3 {
  assertFinite(x, 'vector.x'); assertFinite(y, 'vector.y'); assertFinite(z, 'vector.z');
  return Object.freeze([x, y, z]);
}
export function matrix(values: Mat3): Mat3 {
  if (values.length !== 9) throw new RangeError('Matrix must have 9 row-major values');
  for (const value of values) assertFinite(value, 'matrix coefficient');
  return Object.freeze([...values]) as Mat3;
}
export function rotate(m: Mat3, v: Vec3): Vec3 {
  return vector(
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  );
}
export function transpose(m: Mat3): Mat3 {
  return matrix([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}
export function multiply(a: Mat3, b: Mat3): Mat3 {
  const column0 = rotate(a, [b[0], b[3], b[6]]);
  const column1 = rotate(a, [b[1], b[4], b[7]]);
  const column2 = rotate(a, [b[2], b[5], b[8]]);
  return matrix([
    column0[0], column1[0], column2[0],
    column0[1], column1[1], column2[1],
    column0[2], column1[2], column2[2],
  ]);
}
