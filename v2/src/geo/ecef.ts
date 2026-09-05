import { ecefPosition, geodeticRadians } from './geodetic.js';
import type { EcefPosition, GeodeticPosition } from './geodetic.js';
import { assertFinite, meters, radians } from './units.js';
import { GEO_LIMITS, WGS84 } from './wgs84.js';

export function geodeticToEcef(input: GeodeticPosition): EcefPosition {
  const p = geodeticRadians(input.longitudeRad, input.latitudeRad, input.ellipsoidHeightMeters);
  const sinPhi = Math.sin(p.latitudeRad), cosPhi = Math.cos(p.latitudeRad);
  const n = WGS84.semiMajorMeters / Math.sqrt(1 - WGS84.eccentricitySquared * sinPhi * sinPhi);
  return ecefPosition(
    meters((n + p.ellipsoidHeightMeters) * cosPhi * Math.cos(p.longitudeRad)),
    meters((n + p.ellipsoidHeightMeters) * cosPhi * Math.sin(p.longitudeRad)),
    meters((n * (1 - WGS84.eccentricitySquared) + p.ellipsoidHeightMeters) * sinPhi),
  );
}

export interface InverseOptions { readonly maxIterations?: number; }

export function ecefToGeodetic(input: EcefPosition, options: InverseOptions = {}): GeodeticPosition {
  const { xMeters: x, yMeters: y, zMeters: z } = input;
  assertFinite(x, 'xMeters'); assertFinite(y, 'yMeters'); assertFinite(z, 'zMeters');
  const maxIterations = options.maxIterations ?? GEO_LIMITS.inverseMaxIterations;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) {
    throw new RangeError('maxIterations must be an integer in [1, 100]');
  }
  const { semiMajorMeters: a, semiMinorMeters: b, eccentricitySquared: e2 } = WGS84;
  const radius = Math.hypot(x, y, z);
  if (radius < b + GEO_LIMITS.minEllipsoidHeightMeters - GEO_LIMITS.boundaryRoundingMeters ||
      radius > a + GEO_LIMITS.maxEllipsoidHeightMeters + GEO_LIMITS.boundaryRoundingMeters) {
    throw new RangeError('ECEF point outside the supported near-Earth domain');
  }
  const horizontal = Math.hypot(x, y);
  let latitude: number;
  let longitude = Math.atan2(y, x);
  let height: number;
  if (horizontal <= GEO_LIMITS.poleAxisToleranceMeters) {
    // Longitude is undefined on the polar axis: deterministic convention, not a measurement.
    longitude = 0;
    latitude = z >= 0 ? Math.PI / 2 : -Math.PI / 2;
    height = Math.abs(z) - b;
  } else {
    const ePrime2 = (a * a - b * b) / (b * b);
    const theta = Math.atan2(z * a, horizontal * b);
    latitude = Math.atan2(
      z + ePrime2 * b * Math.sin(theta) ** 3,
      horizontal - e2 * a * Math.cos(theta) ** 3,
    );
    let converged = false;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const sinPhi = Math.sin(latitude), cosPhi = Math.cos(latitude);
      const n = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
      // Projection onto the ellipsoid normal avoids division by cos(phi) near poles.
      const h = horizontal * cosPhi + z * sinPhi - a * Math.sqrt(1 - e2 * sinPhi * sinPhi);
      const next = Math.atan2(z, horizontal * (1 - e2 * n / (n + h)));
      const error = Math.abs(next - latitude);
      latitude = next;
      if (error <= GEO_LIMITS.inverseToleranceRad) { converged = true; break; }
    }
    if (!converged) throw new RangeError('ECEF inverse did not converge');
    const sinPhi = Math.sin(latitude);
    height = horizontal * Math.cos(latitude) + z * sinPhi - a * Math.sqrt(1 - e2 * sinPhi * sinPhi);
  }
  // Only absorb sub-micrometre rounding at the declared domain boundaries.
  if (Math.abs(height - GEO_LIMITS.minEllipsoidHeightMeters) <= GEO_LIMITS.boundaryRoundingMeters) {
    height = GEO_LIMITS.minEllipsoidHeightMeters;
  }
  if (Math.abs(height - GEO_LIMITS.maxEllipsoidHeightMeters) <= GEO_LIMITS.boundaryRoundingMeters) {
    height = GEO_LIMITS.maxEllipsoidHeightMeters;
  }
  return geodeticRadians(radians(longitude), radians(latitude), meters(height));
}
