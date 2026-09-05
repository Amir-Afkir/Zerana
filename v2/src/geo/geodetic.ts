import { meters, normalizeLongitude, radians, toRadians } from './units.js';
import type { Degrees, Meters, Radians } from './units.js';
import { GEO_LIMITS } from './wgs84.js';

export interface GeodeticPosition {
  readonly longitudeRad: Radians;
  readonly latitudeRad: Radians;
  readonly ellipsoidHeightMeters: Meters;
}
export interface EcefPosition {
  readonly xMeters: Meters;
  readonly yMeters: Meters;
  readonly zMeters: Meters;
}

export function geodeticRadians(
  longitudeRad: Radians, latitudeRad: Radians, ellipsoidHeightMeters: Meters,
): GeodeticPosition {
  radians(latitudeRad);
  meters(ellipsoidHeightMeters);
  if (Math.abs(latitudeRad) > Math.PI / 2) throw new RangeError('Latitude outside [-PI/2, PI/2]');
  if (ellipsoidHeightMeters < GEO_LIMITS.minEllipsoidHeightMeters ||
      ellipsoidHeightMeters > GEO_LIMITS.maxEllipsoidHeightMeters) {
    throw new RangeError('Ellipsoid height outside the supported domain');
  }
  return Object.freeze({
    longitudeRad: normalizeLongitude(longitudeRad), latitudeRad, ellipsoidHeightMeters,
  });
}
export function geodeticDegrees(
  longitudeDeg: Degrees, latitudeDeg: Degrees, ellipsoidHeightMeters: Meters,
): GeodeticPosition {
  return geodeticRadians(toRadians(longitudeDeg), toRadians(latitudeDeg), ellipsoidHeightMeters);
}
export function ecefPosition(xMeters: Meters, yMeters: Meters, zMeters: Meters): EcefPosition {
  meters(xMeters); meters(yMeters); meters(zMeters);
  return Object.freeze({ xMeters, yMeters, zMeters });
}
