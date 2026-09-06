import type { GeodeticPosition } from '../../geo/geodetic.js';
import type { Meters } from '../../geo/units.js';

/** A rendering approximation must never acquire canonical altitude authority. */
export type HeightReference = 'ELLIPSOIDAL_WGS84' | 'UNRESOLVED_DATUM_PREVIEW';
/** Conservative bounds of the SAME elevation surface on an unwrapped Mercator
 * rectangle [west,north,east,south]. Optional: an arbitrary geoid conversion
 * cannot advertise this capability without its own error/coverage bounds. */
export interface ElevationBounds {
  readonly minimumMeters: number;
  readonly maximumMeters: number;
}
export interface TerrainHeightSource {
  readonly id: string;
  readonly verticalReference: HeightReference;
  readonly provenance: 'synthetic' | 'observed' | 'converted' | 'estimated';
  readonly evidenceId?: string;
  heightAt(position: GeodeticPosition): Meters;
  heightBounds?(west: number, north: number, east: number, south: number): ElevationBounds;
}
