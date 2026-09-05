import type { EcefPosition, GeodeticPosition } from '../geo/geodetic.js';
import { geodeticRadians, ecefPosition } from '../geo/geodetic.js';
import { ecefToGeodetic, geodeticToEcef } from '../geo/ecef.js';
import { MercatorCellScheme, cellId } from '../geo/mercator-cell-scheme.js';
import type { WorldCellId } from '../geo/cell-scheme.js';
import { projectMercator } from '../geo/mercator.js';
import { meters, radians } from '../geo/units.js';
import type { Vec3 } from '../geo/linear.js';
import { WGS84 } from '../geo/wgs84.js';

// The selection metric is the ECEF chord between h=0 WGS84 footprints (metres),
// not Mercator metres and not a change of player/world scale. See ADR-006.
const A = WGS84.semiMajorMeters, E2 = WGS84.eccentricitySquared;
const MIN_CURVATURE = A * (1 - E2), MAX_CURVATURE = A / Math.sqrt(1 - E2);
const MAX_LAT = Math.atan(Math.sinh(Math.PI));
const scheme = new MercatorCellScheme();
export interface StreamConfig {
  readonly level: number;
  readonly physicsRadiusMeters: number;
  readonly visibleRadiusMeters: number;
  readonly retentionRadiusMeters: number;
  readonly predictionSeconds: number;
}
export const STREAM_LIMITS = Object.freeze({ maxCandidates: 512, maxCells: 64,
  maxInFlight: 2, maxQueuedBytes: 4 * 1024 * 1024, reservedCellBytes: 1024 * 1024,
  cacheBytes: 16 * 1024 * 1024, cacheEntries: 32, maxUploadsPerFrame: 1,
  uploadBudgetMs: 4, maxAttempts: 3 });
export const DEFAULT_STREAM: StreamConfig = Object.freeze({ level: 17,
  physicsRadiusMeters: 20, visibleRadiusMeters: 120, retentionRadiusMeters: 200, predictionSeconds: 2 });
export interface CellInterest {
  readonly id: WorldCellId; readonly key: string; readonly priority: number;
  readonly distanceMeters: number; readonly visible: boolean; readonly physics: boolean;
}
export interface StreamPlan {
  readonly wanted: readonly CellInterest[];
  readonly retained: ReadonlySet<string>;
  readonly centerKey: string;
  readonly candidates: number;
}
export const streamCellKey = (id: WorldCellId): string => scheme.getStableKey(id);
export function validateStreamConfig(c: StreamConfig): void {
  if (!Number.isInteger(c.level) || c.level < 15 || c.level > 21 ||
    ![c.physicsRadiusMeters, c.visibleRadiusMeters, c.retentionRadiusMeters, c.predictionSeconds].every(Number.isFinite) ||
    c.physicsRadiusMeters < 2 || c.physicsRadiusMeters >= c.visibleRadiusMeters ||
    c.visibleRadiusMeters >= c.retentionRadiusMeters || c.retentionRadiusMeters > 1000 ||
    c.predictionSeconds < 0 || c.predictionSeconds > 3) throw new RangeError('INVALID_STREAM_CONFIG');
}
function surface(p: GeodeticPosition): EcefPosition {
  return geodeticToEcef(geodeticRadians(p.longitudeRad, p.latitudeRad, meters(0)));
}
function distance(a: EcefPosition, b: EcefPosition): number {
  return Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters, a.zMeters - b.zMeters);
}
/** Conservative bounding sphere for a cell footprint: meridian + parallel paths
 * from its centre have length <= this radius; the ECEF chord is no longer. */
export function cellFootprintVolume(id: WorldCellId): { center: EcefPosition; radiusMeters: number } {
  const b = scheme.getBounds(id);
  const closestEquator = Math.max(0, Math.min(Math.abs(b.southRad), Math.abs(b.northRad))) *
    (b.southRad * b.northRad <= 0 ? 0 : 1);
  // The inverse-Mercator centre is NOT the arithmetic latitude midpoint.
  const center = scheme.getCenter(id);
  const latitudeSpan = Math.max(b.northRad - center.latitudeRad, center.latitudeRad - b.southRad);
  return { center: surface(center), radiusMeters: MAX_CURVATURE *
    (latitudeSpan + .5 * Math.cos(closestEquator) * (b.eastRad - b.westRad)) + 1e-5 };
}
/** Bounding box of the ECEF chord disk on the ellipsoid, expanded outward.
 * d >= 2 M_min sin(|delta_phi|/2); horizontal chords bound delta_lambda.
 * The resulting rectangle is a broad phase, NOT a projected-metre radius. */
function candidates(p: GeodeticPosition, radius: number, level: number): readonly WorldCellId[] {
  if (Math.abs(p.latitudeRad) > MAX_LAT) throw new RangeError('STREAM_OUTSIDE_MERCATOR');
  const deltaPhi = 2 * Math.asin(radius / (2 * MIN_CURVATURE)) + 1e-11;
  const south = Math.max(-MAX_LAT, p.latitudeRad - deltaPhi), north = Math.min(MAX_LAT, p.latitudeRad + deltaPhi);
  const rhoMin = A * Math.cos(Math.max(Math.abs(south), Math.abs(north)));
  const rho = A / Math.sqrt(1 - E2 * Math.sin(p.latitudeRad) ** 2) * Math.cos(p.latitudeRad);
  const deltaLon = 2 * Math.asin(Math.min(1, radius / (2 * Math.sqrt(rhoMin * rho)))) + 1e-11;
  const n = 2 ** level;
  const west = Math.floor(((p.longitudeRad - deltaLon) / (2 * Math.PI) + .5) * n);
  const east = Math.floor(((p.longitudeRad + deltaLon) / (2 * Math.PI) + .5) * n);
  const y0 = Math.max(0, Math.floor(projectMercator(radians(0), radians(north)).v * n));
  const y1 = Math.min(n - 1, Math.floor(projectMercator(radians(0), radians(south)).v * n));
  if ((east - west + 1) * (y1 - y0 + 1) > STREAM_LIMITS.maxCandidates) throw new RangeError('STREAM_SELECTION_BUDGET');
  const found = new Map<string, WorldCellId>();
  for (let y = y0; y <= y1; y++) for (let x = west; x <= east; x++) {
    const id = cellId(level, ((x % n) + n) % n, y); found.set(streamCellKey(id), id);
  }
  return [...found.values()];
}
export function selectStreamCells(position: EcefPosition, velocity: Vec3, config: StreamConfig): StreamPlan {
  validateStreamConfig(config);
  if (!velocity.every(Number.isFinite) || Math.hypot(...velocity) > 100) throw new RangeError('INVALID_STREAM_VELOCITY');
  const p = ecefToGeodetic(position), base = surface(p);
  const future = ecefToGeodetic(ecefPosition(meters(position.xMeters + velocity[0] * config.predictionSeconds),
    meters(position.yMeters + velocity[1] * config.predictionSeconds), meters(position.zMeters + velocity[2] * config.predictionSeconds)));
  // A prediction never wraps over the Mercator coverage edge.
  const predicted = Math.abs(future.latitudeRad) <= MAX_LAT ? surface(future) : base;
  const ids = new Map<string, WorldCellId>();
  for (const id of candidates(p, config.retentionRadiusMeters, config.level)) ids.set(streamCellKey(id), id);
  if (Math.abs(future.latitudeRad) <= MAX_LAT) for (const id of candidates(future, config.visibleRadiusMeters, config.level)) ids.set(streamCellKey(id), id);
  if (ids.size > STREAM_LIMITS.maxCandidates) throw new RangeError('STREAM_SELECTION_BUDGET');
  const wanted: CellInterest[] = [], retained = new Set<string>();
  const centerKey = streamCellKey(scheme.getCellAt(p, config.level));
  for (const [key, id] of ids) {
    const volume = cellFootprintVolume(id);
    const d = Math.max(0, distance(base, volume.center) - volume.radiusMeters);
    const predictedDistance = Math.max(0, distance(predicted, volume.center) - volume.radiusMeters);
    const physics = d <= config.physicsRadiusMeters, visible = d <= config.visibleRadiusMeters;
    if (d <= config.retentionRadiusMeters) retained.add(key);
    if (visible || predictedDistance <= config.visibleRadiusMeters) {
      wanted.push({ id, key, physics, visible, priority: key === centerKey ? 0 : physics ? 1 : visible ? 3 : 4,
        distanceMeters: Math.min(d, predictedDistance) }); retained.add(key);
    }
  }
  if (wanted.length > STREAM_LIMITS.maxCells) throw new RangeError('STREAM_RESIDENCY_BUDGET');
  wanted.sort((a, b) => a.priority - b.priority || a.distanceMeters - b.distanceMeters || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { wanted, retained, centerKey, candidates: ids.size };
}
