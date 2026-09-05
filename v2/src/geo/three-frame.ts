import { ecefToEnu, enuToEcef } from './enu.js';
import type { GeoAnchor } from './enu.js';
import type { EcefPosition } from './geodetic.js';
import { matrix, vector } from './linear.js';
import type { Vec3 } from './linear.js';

/** Axis convention only. No import from Three.js and no scale compensation. */
export const ENU_TO_THREE = matrix([1, 0, 0, 0, 0, 1, 0, -1, 0]);
export function enuToThree(point: Vec3): Vec3 { return vector(point[0], point[2], -point[1]); }
export function threeToEnu(point: Vec3): Vec3 { return vector(point[0], -point[2], point[1]); }
export function ecefToThreeLocal(point: EcefPosition, anchor: GeoAnchor): Vec3 {
  return enuToThree(ecefToEnu(point, anchor));
}
export function threeLocalToEcef(point: Vec3, anchor: GeoAnchor): EcefPosition {
  return enuToEcef(threeToEnu(point), anchor);
}
