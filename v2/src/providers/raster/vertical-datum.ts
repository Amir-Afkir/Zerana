import { projectMercator } from '../../geo/mercator.js';
import { meters } from '../../geo/units.js';
import type { GeodeticPosition } from '../../geo/geodetic.js';
import type { TerrainHeightSource } from '../../generation/terrain/elevation-source.js';
import { RasterMosaic } from './raster-grid.js';

export type VerticalDatum =
  | { readonly kind: 'ELLIPSOIDAL_WGS84' }
  | { readonly kind: 'ORTHOMETRIC'; readonly model: string }
  | { readonly kind: 'MIXED_OR_UNKNOWN'; readonly description: string };
export interface ElevationMetadata {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly verticalDatum: VerticalDatum;
}
export interface GeoidCorrection {
  readonly model: string;
  readonly evidenceId: string;
  /** Must check its own spatial coverage. Undulation sign: h = H + N. */
  undulationMeters(position: GeodeticPosition): number;
}
export function rasterElevationSource(mosaic: RasterMosaic, metadata: ElevationMetadata,
  options: { readonly correction?: GeoidCorrection; readonly allowUnresolvedDatumPreview?: boolean } = {}): TerrainHeightSource {
  if (mosaic.kind !== 'height' || !metadata.sourceId || !metadata.snapshotId) throw new RangeError('Invalid elevation dataset');
  const datum = Object.freeze({ ...metadata.verticalDatum });
  const correction = options.correction ? Object.freeze({ ...options.correction }) : undefined;
  const orthometric = datum.kind === 'ORTHOMETRIC';
  const converted = orthometric && !!correction && correction.model === datum.model && !!correction.evidenceId && typeof correction.undulationMeters === 'function';
  if (correction && !converted) throw new RangeError('Correction does not match the known source datum');
  const canonical = datum.kind === 'ELLIPSOIDAL_WGS84' || converted;
  if (!canonical && options.allowUnresolvedDatumPreview !== true) throw new RangeError('VERTICAL_DATUM_UNRESOLVED');
  const id = `${metadata.sourceId}/${metadata.snapshotId}/${canonical ? correction?.evidenceId ?? 'ellipsoid' : 'unresolved-preview-v1'}`;
  return Object.freeze({
    id, evidenceId: correction?.evidenceId ?? metadata.snapshotId,
    verticalReference: canonical ? 'ELLIPSOIDAL_WGS84' as const : 'UNRESOLVED_DATUM_PREVIEW' as const,
    provenance: canonical ? (converted ? 'converted' as const : 'observed' as const) : 'estimated' as const,
    heightAt(position: GeodeticPosition) {
      const uv = projectMercator(position.longitudeRad, position.latitudeRad);
      const raw = mosaic.heightAt(uv.u, uv.v);
      // Preview ONLY: raw source heights placed on the ellipsoid without claiming a datum conversion.
      return meters(raw + (converted ? correction!.undulationMeters(position) : 0));
    },
  });
}
export const MAPBOX_ELEVATION_DATUM: VerticalDatum = Object.freeze({
  kind: 'MIXED_OR_UNKNOWN', description: 'Mapbox Terrain-RGB: mixed NAVD88/EGM96/ODN/etc; per-pixel datum unavailable',
});
