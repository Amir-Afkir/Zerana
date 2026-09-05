import type { WorldCellId } from '../geo/cell-scheme.js';
import type { EcefPosition } from '../geo/geodetic.js';
import { geodeticRadians } from '../geo/geodetic.js';
import { ecefToGeodetic, geodeticToEcef } from '../geo/ecef.js';
import { MercatorCellScheme, cellId } from '../geo/mercator-cell-scheme.js';
import type { Vec3 } from '../geo/linear.js';
import { meters } from '../geo/units.js';
import { cellFootprintVolume, streamCellKey } from './selection.js';
import type { CellInterest, StreamPlan } from './selection.js';

const scheme = new MercatorCellScheme();
export interface SlidingWindowPlan extends StreamPlan {
  readonly activeKeys: ReadonlySet<string>;
  readonly prefetchKeys: ReadonlySet<string>;
}
/** Canonical 3x3 neighbourhood. Longitude wraps; coverage edges never wrap latitude. */
export function cellWindow(center: WorldCellId, dx = 0, dy = 0): readonly WorldCellId[] {
  scheme.getStableKey(center);
  if (![dx, dy].every(v => Number.isInteger(v) && Math.abs(v) <= 1)) throw new RangeError('INVALID_WINDOW_SHIFT');
  const n = 2 ** center.level, cells = new Map<string, WorldCellId>();
  for (let y = center.y + dy - 1; y <= center.y + dy + 1; y++) {
    if (y < 0 || y >= n) continue;
    for (let x = center.x + dx - 1; x <= center.x + dx + 1; x++) {
      const id = cellId(center.level, ((x % n) + n) % n, y);
      cells.set(streamCellKey(id), id);
    }
  }
  return [...cells.values()];
}
/** A topological window is NOT a metre radius. Priorities use WGS84 footprint
 * chord distances; direction uses ECEF velocity rotated to local East/South.
 * No player scale, mesh vertices or global coordinates are modified. */
export function selectSlidingWindow(position: EcefPosition, velocity: Vec3, level: number): SlidingWindowPlan {
  if (!Number.isInteger(level) || level < 15 || level > 21) throw new RangeError('INVALID_WINDOW_LEVEL');
  if (velocity.length !== 3 || !velocity.every(Number.isFinite) || Math.hypot(...velocity) > 100)
    throw new RangeError('INVALID_STREAM_VELOCITY');
  const p = ecefToGeodetic(position), center = scheme.getCellAt(p, level);
  const base = geodeticToEcef(geodeticRadians(p.longitudeRad, p.latitudeRad, meters(0)));
  const sinLon = Math.sin(p.longitudeRad), cosLon = Math.cos(p.longitudeRad);
  const sinLat = Math.sin(p.latitudeRad), cosLat = Math.cos(p.latitudeRad);
  const east = -sinLon * velocity[0] + cosLon * velocity[1];
  const south = sinLat * cosLon * velocity[0] + sinLat * sinLon * velocity[1] - cosLat * velocity[2];
  // Ignore near-rest jitter. Eight direction sectors; at most one extra row/column.
  const moving = Math.hypot(east, south) >= .25, ratio = Math.SQRT2 - 1;
  const dx = moving && Math.abs(east) >= Math.abs(south) * ratio ? Math.sign(east) : 0;
  const dy = moving && Math.abs(south) >= Math.abs(east) * ratio ? Math.sign(south) : 0;
  const active = cellWindow(center), activeKeys = new Set(active.map(streamCellKey));
  const extra = moving ? cellWindow(center, dx, dy).filter(id => !activeKeys.has(streamCellKey(id))) : [];
  const prefetchKeys = new Set(extra.map(streamCellKey)), centerKey = streamCellKey(center);
  const wanted: CellInterest[] = [...active, ...extra].map(id => {
    const key = streamCellKey(id), visible = activeKeys.has(key), volume = cellFootprintVolume(id);
    const distanceMeters = Math.max(0, Math.hypot(base.xMeters - volume.center.xMeters,
      base.yMeters - volume.center.yMeters, base.zMeters - volume.center.zMeters) - volume.radiusMeters);
    return { id, key, visible, physics: visible, priority: key === centerKey ? 0 : visible ? 1 : 4, distanceMeters };
  });
  wanted.sort((a, b) => a.priority - b.priority || a.distanceMeters - b.distanceMeters || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { wanted, activeKeys, prefetchKeys, retained: new Set(wanted.map(i => i.key)), centerKey, candidates: wanted.length };
}
