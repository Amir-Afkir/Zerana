import type { WorldCellId } from '../../geo/cell-scheme.js';
import { validateTerrainGrid } from '../../generation/terrain/lattice.js';
import { RasterMosaic } from './raster-grid.js';

export interface ImageryPacket {
  readonly cellKey: string;
  readonly width: number;
  readonly rgba: Uint8Array;
  readonly uvScale: number;
  readonly uvOffset: number;
  readonly colorSpace: 'srgb';
}
/** Cell endpoints are interior texel centres, with one gutter sample on each side.
 * Sampling at the same geographic edge gives the same colour, even across source tiles.
 * Rows are bottom-up for a Three.js DataTexture with flipY=false. No mipmaps in this stage.
 */
export function buildCellImagery(id: WorldCellId, mosaic: RasterMosaic, intervals = 256): ImageryPacket {
  validateTerrainGrid(id, 4);
  if (![64,128,256].includes(intervals)) throw new RangeError('Unsupported imagery resolution');
  const width = intervals + 3, rgba = new Uint8Array(width * width * 4), n = 2 ** id.level;
  for (let row = 0; row < width; row++) for (let col = 0; col < width; col++) {
    const u = (id.x + (col - 1) / intervals) / n;
    const v = Math.max(0, Math.min(1, (id.y + 1 - (row - 1) / intervals) / n));
    rgba.set(mosaic.rgbaAt(u, v), (row * width + col) * 4);
  }
  return Object.freeze({ cellKey: `${id.level}/${id.x}/${id.y}`, width, rgba,
    uvScale: intervals / width, uvOffset: 1.5 / width, colorSpace: 'srgb' });
}
