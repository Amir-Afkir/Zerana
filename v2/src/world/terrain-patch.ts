import type { GeodeticPosition } from '../geo/geodetic.js';
import type { WorldCellId } from '../geo/cell-scheme.js';
import { cellId, MercatorCellScheme } from '../geo/mercator-cell-scheme.js';

/** Static diagnostic patches, NOT a world streamer. Shift inward at coverage limits. */
export function terrainPatchCells(position: GeodeticPosition, level: number, side: 1 | 2 | 3): readonly WorldCellId[] {
  if (side !== 1 && side !== 2 && side !== 3) throw new RangeError('Patch side must be 1, 2 or 3');
  const center = new MercatorCellScheme().getCellAt(position, level);
  const n = 2 ** level;
  if (n < side) throw new RangeError('Patch exceeds cell scheme at this level');
  const startX = center.x - Math.floor((side - 1) / 2);
  const startY = Math.max(0, Math.min(n - side, center.y - Math.floor((side - 1) / 2)));
  const cells: WorldCellId[] = [];
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      cells.push(cellId(level, ((startX + column) % n + n) % n, startY + row));
    }
  }
  return Object.freeze(cells);
}
