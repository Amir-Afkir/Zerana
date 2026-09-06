import type { GeodeticPosition } from '../../geo/geodetic.js';
import { projectMercator } from '../../geo/mercator.js';
import { WGS84 } from '../../geo/wgs84.js';
import { meters } from '../../geo/units.js';
import type { TerrainHeightSource, HeightReference } from '../terrain/elevation-source.js';

export const HYDRO_VERSION = 'hydro-conditioned-v1';
export type HydroKind = 'CLOSED_STANDING_WATER' | 'FLOWING_WATER' | 'LINEAR_WATERWAY' | 'COASTAL_OPEN_WATER' | 'UNRESOLVED';
export type Point2 = readonly [number, number];
export interface HydroFootprint {
  readonly key: string;
  readonly kind: HydroKind;
  readonly rings: readonly (readonly Point2[])[];
  /** Source core ownership, NOT a shoreline. Coordinates may be unwrapped. */
  readonly core: readonly [number, number, number, number];
  readonly level: number | null;
}
export interface WaterSurfaceProfile {
  readonly revision: string;
  readonly verticalReference: HeightReference;
  readonly authority: 'estimated-not-hydraulically-qualified';
  readonly footprints: readonly HydroFootprint[];
  /** Same function supplies water vertices and conditioned elevation. */
  levelAt(u: number, v: number): number;
}
export const HYDRO_POLICY = Object.freeze({
  version: HYDRO_VERSION,
  shoreFalloffMeters: 6,
  // Conservative support for the regular mesh; no promise of exact breaklines.
  gridSupportMeters: 4,
  standingClearanceMeters: 0.5,
  flowingClearanceMeters: 0.5,
  linearClearanceMeters: 0.25,
  openClearanceMeters: 0.5,
  maxLoweringMeters: 12,
  maxFootprints: 16384,
  maxPoints: 131072,
  maxSampleTests: 150000,
  numericalToleranceMeters: 0.00001,
});
export type HydroPolicy = typeof HYDRO_POLICY;
export interface HydroSample {
  readonly rawHeightMeters: number;
  readonly heightMeters: number;
  readonly waterHeightMeters: number | null;
  readonly clearanceMeters: number;
  readonly distanceToShoreMeters: number | null;
  readonly alpha: number;
  readonly island: boolean;
  readonly kind: HydroKind;
}
export function smoothQuintic(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (10 + t * (-15 + 6 * t));
}
export function metricFactors(v: number): Point2 {
  const phi = Math.atan(Math.sinh(Math.PI * (1 - 2 * v))), s = Math.sin(phi);
  const d = 1 - WGS84.eccentricitySquared * s * s, c = Math.cos(phi);
  return [2 * Math.PI * WGS84.semiMajorMeters * c / Math.sqrt(d),
    2 * Math.PI * WGS84.semiMajorMeters * (1 - WGS84.eccentricitySquared) * c / d ** 1.5];
}
export function inRing(p: Point2, ring: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (cross === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
      p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function distanceToSegment(p: Point2, a: Point2, b: Point2, metric: Point2): number {
  const x = (p[0] - a[0]) * metric[0], y = (p[1] - a[1]) * metric[1];
  const dx = (b[0] - a[0]) * metric[0], dy = (b[1] - a[1]) * metric[1];
  const t = Math.max(0, Math.min(1, (x * dx + y * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - t * dx, y - t * dy);
}
function clearance(kind: HydroKind, policy: HydroPolicy): number {
  if (kind === 'UNRESOLVED') return 0;
  if (kind === 'LINEAR_WATERWAY') return policy.linearClearanceMeters;
  if (kind === 'CLOSED_STANDING_WATER') return policy.standingClearanceMeters;
  if (kind === 'FLOWING_WATER') return policy.flowingClearanceMeters;
  return policy.openClearanceMeters;
}
interface IndexedFootprint { footprint: HydroFootprint; bounds: readonly [number, number, number, number] }
/** Immutable derived view. Never writes the DEM, existing terrain vertices or
 * collision buffers. In particular, holes override the lateral bank falloff.
 * A grid can still bridge an island/shore: the FINAL triangle proof is mandatory.
 */
export class HydroConditionedElevationSource implements TerrainHeightSource {
  readonly id: string;
  readonly evidenceId: string;
  readonly verticalReference: HeightReference;
  readonly provenance: 'synthetic' | 'converted' | 'estimated';
  readonly raw: TerrainHeightSource;
  readonly profile: WaterSurfaceProfile;
  private readonly entries: readonly IndexedFootprint[];
  readonly policy: HydroPolicy;
  constructor(raw: TerrainHeightSource, profile: WaterSurfaceProfile, policy: HydroPolicy = HYDRO_POLICY) {
    if (profile.verticalReference !== raw.verticalReference || !profile.revision || profile.authority !== 'estimated-not-hydraulically-qualified') throw new Error('HYDRO_DATUM_CONTRACT');
    if (policy.version !== HYDRO_VERSION || policy !== HYDRO_POLICY) throw new Error('HYDRO_POLICY_CONTRACT');
    if (profile.footprints.length > policy.maxFootprints) throw new Error('HYDRO_GEOMETRY_BUDGET');
    let points = 0;
    this.entries = profile.footprints.map(footprint => {
      const all = footprint.rings.flat(); points += all.length;
      if (!all.length || all.some(p => !p.every(Number.isFinite)) || points > policy.maxPoints) throw new Error('HYDRO_GEOMETRY_BUDGET');
      return { footprint, bounds: [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))] as const };
    });
    this.raw = raw; this.profile = profile; this.policy = policy;
    this.id = `${raw.id}/${HYDRO_VERSION}/${profile.revision}`; this.evidenceId = profile.revision;
    this.verticalReference = raw.verticalReference;
    this.provenance = raw.verticalReference === 'ELLIPSOIDAL_WGS84' ? (raw.provenance === 'synthetic' ? 'synthetic' : 'converted') : 'estimated';
  }
  // Own enumerable arrow member: TerrainSampler copies a source with {...source}.
  readonly heightAt = (p: GeodeticPosition) => meters(this.sample(p).heightMeters);
  sample(p: GeodeticPosition): HydroSample {
    const m = projectMercator(p.longitudeRad, p.latitudeRad);
    return this.sampleUV(m.u, m.v, Number(this.raw.heightAt(p)));
  }
  sampleUV(u: number, v: number, rawHeight: number): HydroSample {
    if (!Number.isFinite(rawHeight) || Math.abs(rawHeight) > 100000) throw new Error('HYDRO_RAW_HEIGHT_INVALID');
    const metric = metricFactors(v), influence = this.policy.shoreFalloffMeters + this.policy.gridSupportMeters;
    let selected: HydroFootprint | null = null, distance = Infinity, occupied = false, island = false, tests = 0;
    for (const e of this.entries) {
      const f = e.footprint;
      // Select the same wrapped image of a source footprint on either side of 180°.
      const x = u + Math.round((f.core[0] + f.core[2]) / 2 - u), q: Point2 = [x, v];
      if (x < e.bounds[0] - influence / metric[0] || x > e.bounds[2] + influence / metric[0] ||
        v < e.bounds[1] - influence / metric[1] || v > e.bounds[3] + influence / metric[1]) continue;
      if (inRing(q, f.rings[0]!) && f.rings.slice(1).some(r => inRing(q, r))) { island = true; continue; }
      const owned = x >= f.core[0] && x < f.core[2] && v >= f.core[1] && (v < f.core[3] || v === 1);
      const inside = owned && inRing(q, f.rings[0]!) && !f.rings.slice(1).some(r => inRing(q, r));
      let d = Infinity;
      for (const ring of f.rings) for (let i = 0; i < ring.length; i++) {
        if (++tests > this.policy.maxSampleTests) throw new Error('HYDRO_SAMPLE_BUDGET');
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        // A clipping edge of the source tile is NOT a bank. Keep real edges in
        // the source core only; the adjacent core supplies their continuation.
        if ((a[0] === b[0] && (a[0] === f.core[0] || a[0] === f.core[2])) ||
          (a[1] === b[1] && (a[1] === f.core[1] || a[1] === f.core[3]))) continue;
        if (Math.max(a[0], b[0]) < f.core[0] || Math.min(a[0], b[0]) > f.core[2] ||
          Math.max(a[1], b[1]) < f.core[1] || Math.min(a[1], b[1]) > f.core[3]) continue;
        d = Math.min(d, distanceToSegment(q, a, b, metric));
      }
      if (inside) { if (!occupied || f.key < selected!.key) selected = f; occupied = true; distance = Math.min(distance, d); }
      else if (!occupied && (d < distance || d === distance && selected && f.key < selected.key)) { distance = d; selected = f; }
    }
    const unchanged = (kind: HydroKind): HydroSample => ({rawHeightMeters: rawHeight, heightMeters: rawHeight,
      waterHeightMeters: null, clearanceMeters: 0, distanceToShoreMeters: Number.isFinite(distance) ? distance : null, alpha: 0, island, kind});
    if (island || !selected || !occupied && distance >= influence || selected.kind === 'UNRESOLVED') return unchanged(selected?.kind || 'UNRESOLVED');
    const c = clearance(selected.kind, this.policy), h = selected.level ?? this.profile.levelAt(u, v);
    if (!Number.isFinite(h)) throw new Error('HYDRO_PROFILE_UNRESOLVED');
    const alpha = occupied ? 1 : 1 - smoothQuintic((distance - this.policy.gridSupportMeters) / this.policy.shoreFalloffMeters);
    const target = Math.min(rawHeight, h - c);
    if (alpha * (rawHeight - target) > this.policy.maxLoweringMeters) throw new Error('HYDRO_CLEARANCE_LIMIT');
    return {rawHeightMeters: rawHeight, heightMeters: rawHeight + alpha * (target - rawHeight), waterHeightMeters: h,
      clearanceMeters: c, distanceToShoreMeters: Number.isFinite(distance) ? (occupied ? distance : -distance) : null,
      alpha, island: false, kind: selected.kind};
  }
}
