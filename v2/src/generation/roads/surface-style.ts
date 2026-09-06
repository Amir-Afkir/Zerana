import type { RoadAttributes, RoadCategory } from './model.js';

/** Versioned visual defaults, not observations and not lane-count inference. */
export const ROAD_STYLE_VERSION = 'road-surface-style-v1';
export type SurfaceMaterial = 'asphalt' | 'paved-path' | 'earth';
export interface RoadSurfaceStyle {
  readonly widthMeters: number;
  readonly widthProvenance: 'estimated';
  readonly material: SurfaceMaterial;
  readonly materialProvenance: 'source-classification' | 'estimated';
  readonly priority: number;
  /** Linear RGB, consumed by a vertex-color material. */
  readonly color: readonly [number, number, number];
}
const WIDTHS: Partial<Record<RoadCategory, number>> = Object.freeze({
  MOTORWAY: 10.5, TRUNK: 9, PRIMARY: 7, SECONDARY: 6.5, TERTIARY: 6,
  STREET: 5.5, SERVICE: 3.5, TRACK: 3, PEDESTRIAN: 3,
  CYCLEWAY: 2.5, FOOTWAY: 1.8, TRAIL: 1.2,
});
export const MAX_ROAD_WIDTH_METERS = 10.5;
/** Structure is an independent eligibility check. Unknown/deferred structures
 * never become flat ground infrastructure. Layer is drawing order, not height. */
export function resolveRoadSurfaceStyle(a: RoadAttributes): RoadSurfaceStyle | null {
  if (!['ground', 'ford'].includes(a.structure) || (a.layer !== null && a.layer !== 0)) return null;
  let widthMeters = WIDTHS[a.category];
  if (widthMeters === undefined) return null;
  if (a.sourceClass.endsWith('_link')) widthMeters = 4;
  if (a.category === 'STREET' && a.oneway === 'forward') widthMeters = 3.5;
  const path = ['FOOTWAY', 'CYCLEWAY', 'TRAIL', 'PEDESTRIAN'].includes(a.category);
  const earth = a.surface === 'unpaved' || (a.surface === 'unknown' && ['TRACK', 'TRAIL'].includes(a.category));
  const material: SurfaceMaterial = earth ? 'earth' : path ? 'paved-path' : 'asphalt';
  return Object.freeze({ widthMeters, widthProvenance: 'estimated', material,
    materialProvenance: a.surface === 'unknown' ? 'estimated' : 'source-classification',
    priority: path ? 1 : 2,
    color: material === 'asphalt' ? [.065, .074, .085] as const
      : material === 'earth' ? [.29, .20, .105] as const : [.34, .32, .28] as const,
  });
}
