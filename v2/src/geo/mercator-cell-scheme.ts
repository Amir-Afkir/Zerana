import type { CellLocation, GeodeticBounds, WorldCellId, WorldCellScheme } from './cell-scheme.js';
import { geodeticRadians } from './geodetic.js';
import type { GeodeticPosition } from './geodetic.js';
import { projectMercator, unprojectMercator } from './mercator.js';
import { GEO_LIMITS } from './wgs84.js';
import { meters, radians } from './units.js';

export function cellId(level: number, x: number, y: number): WorldCellId {
  if (!Number.isInteger(level) || level < 0 || level > GEO_LIMITS.maxCellLevel) {
    throw new RangeError('Unsupported cell level');
  }
  const n = 2 ** level;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
    throw new RangeError('Cell indexes must be canonical integers in [0, 2^level)');
  }
  return Object.freeze({ scheme: 'web-mercator', level, x, y });
}
function checked(id: WorldCellId): WorldCellId {
  if (id.scheme !== 'web-mercator') throw new RangeError('Unsupported cell scheme');
  return cellId(id.level, id.x, id.y);
}

export class MercatorCellScheme implements WorldCellScheme {
  locate(position: GeodeticPosition, level: number): CellLocation {
    cellId(level, 0, 0);
    const p = geodeticRadians(position.longitudeRad, position.latitudeRad, position.ellipsoidHeightMeters);
    const uv = projectMercator(p.longitudeRad, p.latitudeRad);
    const n = 2 ** level, tx = uv.u * n, ty = uv.v * n;
    const x = Math.floor(tx), y = Math.min(n - 1, Math.floor(ty));
    return Object.freeze({ id: cellId(level, x, y), fractionX: tx - x, fractionY: ty - y });
  }
  getCellAt(position: GeodeticPosition, level: number): WorldCellId { return this.locate(position, level).id; }
  getStableKey(id: WorldCellId): string {
    checked(id);
    return `${id.scheme}/${id.level}/${id.x}/${id.y}`;
  }
  getBounds(id: WorldCellId): GeodeticBounds {
    checked(id);
    const n = 2 ** id.level;
    return Object.freeze({
      westRad: radians(2 * Math.PI * (id.x / n) - Math.PI),
      // Keep +PI here: a geographic interval endpoint is not a normalized point.
      eastRad: radians(2 * Math.PI * ((id.x + 1) / n) - Math.PI),
      northRad: unprojectMercator({ u: 0, v: id.y / n }).latitudeRad,
      southRad: unprojectMercator({ u: 0, v: (id.y + 1) / n }).latitudeRad,
      crossesAntimeridian: false,
    });
  }
  getCenter(id: WorldCellId): GeodeticPosition {
    checked(id);
    const n = 2 ** id.level;
    const p = unprojectMercator({ u: (id.x + 0.5) / n, v: (id.y + 0.5) / n });
    return geodeticRadians(p.longitudeRad, p.latitudeRad, meters(0));
  }
  /** Cardinal neighbors only; x wraps, y never wraps. Root has no distinct neighbor. */
  getNeighbors(id: WorldCellId): readonly WorldCellId[] {
    checked(id);
    const n = 2 ** id.level, found = new Map<string, WorldCellId>();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const x = ((id.x + dx) % n + n) % n, y = id.y + dy;
      if (y < 0 || y >= n || (x === id.x && y === id.y)) continue;
      const neighbor = cellId(id.level, x, y);
      found.set(this.getStableKey(neighbor), neighbor);
    }
    return Object.freeze([...found.values()]);
  }
  getParent(id: WorldCellId): WorldCellId | null {
    checked(id);
    return id.level === 0 ? null : cellId(id.level - 1, Math.floor(id.x / 2), Math.floor(id.y / 2));
  }
  getChildren(id: WorldCellId): readonly WorldCellId[] {
    checked(id);
    if (id.level === GEO_LIMITS.maxCellLevel) throw new RangeError('Cell has reached maximum supported level');
    return Object.freeze([
      cellId(id.level + 1, id.x * 2, id.y * 2),
      cellId(id.level + 1, id.x * 2 + 1, id.y * 2),
      cellId(id.level + 1, id.x * 2, id.y * 2 + 1),
      cellId(id.level + 1, id.x * 2 + 1, id.y * 2 + 1),
    ]);
  }
}
