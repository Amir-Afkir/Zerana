import { normalizeLongitude, radians, assertFinite } from './units.js';
import type { Radians } from './units.js';

export const MERCATOR_MAX_LATITUDE_RAD = radians(Math.atan(Math.sinh(Math.PI)));
export interface MercatorPoint { readonly u: number; readonly v: number; }

/** No silent clamping: an unsupported point is NOT moved to another latitude. */
export function projectMercator(longitudeRad: Radians, latitudeRad: Radians): MercatorPoint {
  assertFinite(latitudeRad, 'latitudeRad');
  if (Math.abs(latitudeRad) > MERCATOR_MAX_LATITUDE_RAD) {
    throw new RangeError('Position outside Web Mercator coverage');
  }
  const longitude = normalizeLongitude(longitudeRad);
  const u = (longitude + Math.PI) / (2 * Math.PI);
  const v = (1 - Math.asinh(Math.tan(latitudeRad)) / Math.PI) / 2;
  // Protect exact +/- coverage limits from floating-point round-off only.
  return Object.freeze({ u: u === 1 ? 0 : u, v: Math.max(0, Math.min(1, v)) });
}
export function unprojectMercator(point: MercatorPoint): { readonly longitudeRad: Radians; readonly latitudeRad: Radians } {
  assertFinite(point.u, 'u'); assertFinite(point.v, 'v');
  if (point.v < 0 || point.v > 1) throw new RangeError('Mercator v outside [0,1]');
  const u = ((point.u % 1) + 1) % 1;
  return Object.freeze({
    longitudeRad: radians(2 * Math.PI * u - Math.PI),
    latitudeRad: radians(Math.atan(Math.sinh(Math.PI * (1 - 2 * point.v)))),
  });
}
