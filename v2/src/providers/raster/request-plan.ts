import type { WorldCellId } from '../../geo/cell-scheme.js';
import { validateTerrainGrid } from '../../generation/terrain/lattice.js';
import { pixelTaps, RASTER_LIMITS, tileId, tileKey } from './raster-grid.js';
import type { RasterTileId } from './raster-grid.js';

/** Covers the entire cell rectangle plus the normals halo and bilinear pixel footprint.
 * No assumption that a simulation cell is a provider tile. Reject before network I/O.
 */
export function planRasterTiles(cells: readonly WorldCellId[], zoom: number, size: number,
  subdivisions: number, haloSamples = 0): readonly RasterTileId[] {
  if (!cells.length || cells.length > 9 || ![0,1].includes(haloSamples)) throw new RangeError('Invalid bounded patch');
  const required = new Map<string, RasterTileId>();
  for (const cell of cells) {
    validateTerrainGrid(cell, subdivisions);
    const n = 2 ** cell.level, margin = haloSamples / subdivisions;
    const u0 = (cell.x - margin) / n, u1 = (cell.x + 1 + margin) / n;
    const v0 = Math.max(0, (cell.y - margin) / n), v1 = Math.min(1, (cell.y + 1 + margin) / n);
    // Use unwrapped x interval for the bounds; each resulting tile is canonicalized later.
    pixelTaps(u0, v0, zoom, size);
    const period = size * 2 ** zoom;
    const x0 = Math.floor((u0 * period - 0.5) / size);
    const x1 = Math.floor((Math.floor(u1 * period - 0.5) + 1) / size);
    const y0 = Math.floor(Math.max(0, v0 * period - 0.5) / size);
    const y1 = Math.floor(Math.min(period - 1, Math.floor(v1 * period - 0.5) + 1) / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > RASTER_LIMITS.maxTiles) throw new RangeError('Raster request budget exceeded');
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const id = tileId(zoom, x, y); required.set(tileKey(id), id);
      if (required.size > RASTER_LIMITS.maxTiles) throw new RangeError('Raster request budget exceeded');
    }
  }
  return Object.freeze([...required.values()].sort((a,b) => a.y - b.y || a.x - b.x));
}
