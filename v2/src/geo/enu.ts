import { ecefPosition, geodeticRadians } from './geodetic.js';
import type { EcefPosition, GeodeticPosition } from './geodetic.js';
import { geodeticToEcef } from './ecef.js';
import { matrix, rotate, transpose, vector } from './linear.js';
import type { Mat3, Vec3 } from './linear.js';
import { meters } from './units.js';

export interface GeoAnchor {
  readonly geodetic: GeodeticPosition;
  readonly ecef: EcefPosition;
  readonly ecefToEnu: Mat3;
}
export function createGeoAnchor(input: GeodeticPosition): GeoAnchor {
  const geodetic = geodeticRadians(input.longitudeRad, input.latitudeRad, input.ellipsoidHeightMeters);
  const sl = Math.sin(geodetic.longitudeRad), cl = Math.cos(geodetic.longitudeRad);
  const sp = Math.sin(geodetic.latitudeRad), cp = Math.cos(geodetic.latitudeRad);
  return Object.freeze({
    geodetic,
    ecef: geodeticToEcef(geodetic),
    ecefToEnu: matrix([-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp]),
  });
}
export function ecefToEnu(point: EcefPosition, anchor: GeoAnchor): Vec3 {
  return rotate(anchor.ecefToEnu, vector(
    point.xMeters - anchor.ecef.xMeters,
    point.yMeters - anchor.ecef.yMeters,
    point.zMeters - anchor.ecef.zMeters,
  ));
}
export function enuToEcef(point: Vec3, anchor: GeoAnchor): EcefPosition {
  const delta = rotate(transpose(anchor.ecefToEnu), point);
  return ecefPosition(
    meters(anchor.ecef.xMeters + delta[0]), meters(anchor.ecef.yMeters + delta[1]),
    meters(anchor.ecef.zMeters + delta[2]),
  );
}
