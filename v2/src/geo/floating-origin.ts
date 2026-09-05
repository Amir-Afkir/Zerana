import type { GeoAnchor } from './enu.js';
import { ecefToThreeLocal, ENU_TO_THREE } from './three-frame.js';
import { multiply, rotate, transpose, vector } from './linear.js';
import type { Mat3, Vec3 } from './linear.js';
import { assertFinite } from './units.js';
import { GEO_LIMITS } from './wgs84.js';

export interface LocalFrameTransform {
  readonly rotation: Mat3;
  readonly translationMeters: Vec3;
}
/** Pure math only: runtime must later apply this atomically to ALL poses and colliders. */
export function frameTransform(from: GeoAnchor, to: GeoAnchor): LocalFrameTransform {
  return Object.freeze({
    rotation: multiply(multiply(multiply(ENU_TO_THREE, to.ecefToEnu),
      transpose(from.ecefToEnu)), transpose(ENU_TO_THREE)),
    translationMeters: ecefToThreeLocal(from.ecef, to),
  });
}
export function transformPoint(point: Vec3, transform: LocalFrameTransform): Vec3 {
  const p = rotate(transform.rotation, point), t = transform.translationMeters;
  return vector(p[0] + t[0], p[1] + t[1], p[2] + t[2]);
}
/** Vectors such as velocity get rotation ONLY, never a translation. */
export function transformDirection(direction: Vec3, transform: LocalFrameTransform): Vec3 {
  return rotate(transform.rotation, direction);
}
export function shouldRebase(position: Vec3, thresholdMeters: number = GEO_LIMITS.rebaseDistanceMeters): boolean {
  vector(...position);
  assertFinite(thresholdMeters, 'thresholdMeters');
  if (thresholdMeters <= 0) throw new RangeError('Rebase threshold must be positive');
  return Math.hypot(position[0], position[2]) > thresholdMeters;
}
