import { engineeringFixtureSource } from '../roads/engineering-fixture.js';
import type { GeodeticPosition } from '../../geo/geodetic.js';
import { geodeticRadians } from '../../geo/geodetic.js';
import { geodeticToEcef } from '../../geo/ecef.js';
import { meters } from '../../geo/units.js';
import type { Meters } from '../../geo/units.js';

/** Synchronous, immutable, pure source contract for this synthetic milestone. */
export interface EllipsoidElevationSource {
  readonly id: string;
  readonly verticalReference: 'ELLIPSOIDAL_WGS84';
  readonly provenance: 'synthetic';
  heightAt(position: GeodeticPosition): Meters;
}
export type SyntheticProfile = 'flat' | 'waves' | 'engineering' | 'engineering-raw';

export function syntheticElevation(profile: SyntheticProfile): EllipsoidElevationSource {
  if (profile === 'engineering' || profile === 'engineering-raw') return engineeringFixtureSource(profile === 'engineering-raw');
  if (profile !== 'flat' && profile !== 'waves') throw new RangeError('Unknown synthetic profile');
  return Object.freeze({
    id: `synthetic-${profile}-v1`,
    verticalReference: 'ELLIPSOIDAL_WGS84' as const,
    provenance: 'synthetic' as const,
    heightAt(position: GeodeticPosition): Meters {
      if (profile === 'flat') return meters(0);
      const base = geodeticToEcef(geodeticRadians(position.longitudeRad, position.latitudeRad, meters(0)));
      // Fixed global field in metres, not per-cell noise. No random state or network.
      return meters(35 + 12 * Math.sin(base.xMeters / 180) +
        8 * Math.sin(base.yMeters / 240) * Math.cos(base.zMeters / 300));
    },
  });
}
