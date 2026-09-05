import type { GeodeticPosition } from '../../geo/geodetic.js';
import type { Meters } from '../../geo/units.js';

/** A rendering approximation must never acquire canonical altitude authority. */
export type HeightReference = 'ELLIPSOIDAL_WGS84' | 'UNRESOLVED_DATUM_PREVIEW';
export interface TerrainHeightSource {
  readonly id: string;
  readonly verticalReference: HeightReference;
  readonly provenance: 'synthetic' | 'observed' | 'converted' | 'estimated';
  readonly evidenceId?: string;
  heightAt(position: GeodeticPosition): Meters;
}
