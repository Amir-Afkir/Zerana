import { assertFinite } from '../../geo/units.js';

export const RASTER_LIMITS = Object.freeze({ maxTileSize: 512, maxTiles: 64, maxBytes: 64 * 1024 * 1024 });
export interface RasterTileId { readonly zoom: number; readonly x: number; readonly y: number; }
export interface RgbaTile extends RasterTileId { readonly size: number; readonly rgba: Uint8Array | Uint8ClampedArray; }
export interface HeightTile extends RasterTileId { readonly size: number; readonly heights: Float64Array; }
export type RasterTile = RgbaTile | HeightTile;
export interface PixelTap { readonly tile: RasterTileId; readonly column: number; readonly row: number; readonly weight: number; }

export function tileKey(id: RasterTileId): string { return `${id.zoom}/${id.x}/${id.y}`; }
export function tileId(zoom: number, x: number, y: number): RasterTileId {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 24) throw new RangeError('Unsupported raster zoom');
  const n = 2 ** zoom;
  if (!Number.isSafeInteger(x) || !Number.isInteger(y) || y < 0 || y >= n) throw new RangeError('Invalid XYZ tile');
  return Object.freeze({ zoom, x: ((x % n) + n) % n, y });
}
export function validateTileSize(size: number): void {
  if (!Number.isInteger(size) || size < 2 || size > RASTER_LIMITS.maxTileSize || !Number.isInteger(Math.log2(size))) {
    throw new RangeError('Raster size must be a power of two in [2,512]');
  }
}
/** Decode original byte values first. Alpha other than 255 is nodata, not sea level. */
export function decodeTerrainRgb(tile: RgbaTile): HeightTile {
  validateTileSize(tile.size); const id = tileId(tile.zoom, tile.x, tile.y);
  if (tile.rgba.length !== tile.size * tile.size * 4) throw new RangeError('Invalid RGBA buffer length');
  const heights = new Float64Array(tile.size * tile.size);
  for (let i = 0; i < heights.length; i++) {
    const o = i * 4;
    heights[i] = tile.rgba[o + 3] === 255 ?
      -10000 + 0.1 * (tile.rgba[o]! * 65536 + tile.rgba[o + 1]! * 256 + tile.rgba[o + 2]!) : NaN;
  }
  return Object.freeze({ ...id, size: tile.size, heights });
}
/** Global pixel-centre convention: p = uv * (size * 2^z) - 0.5.
 * Border samples require neighbouring tiles. Only the outer Mercator row is clamped.
 * x wraps at the antimeridian. Zero-weight taps are never requested.
 */
export function pixelTaps(u: number, v: number, zoom: number, size: number): readonly PixelTap[] {
  assertFinite(u, 'u'); assertFinite(v, 'v'); tileId(zoom, 0, 0); validateTileSize(size);
  if (v < 0 || v > 1) throw new RangeError('Outside raster coverage');
  const period = size * 2 ** zoom;
  const wrappedU = u >= 0 && u < 1 ? u : ((u % 1) + 1) % 1;
  const px = wrappedU * period - 0.5, py = Math.max(0, Math.min(period - 1, v * period - 0.5));
  const left = Math.floor(px), top = Math.floor(py), a = px - left, b = py - top;
  const taps: PixelTap[] = [];
  for (const [dx, dy, weight] of [[0,0,(1-a)*(1-b)], [1,0,a*(1-b)], [0,1,(1-a)*b], [1,1,a*b]] as const) {
    if (weight === 0) continue;
    const x = ((left + dx) % period + period) % period, y = Math.min(period - 1, top + dy);
    taps.push(Object.freeze({ tile: tileId(zoom, Math.floor(x / size), Math.floor(y / size)),
      column: x % size, row: y % size, weight }));
  }
  return Object.freeze(taps);
}

/** One snapshot owns copies of its tiles. No hidden fetch, mutable provider cache or zero-fill. */
export class RasterMosaic {
  readonly zoom: number;
  readonly size: number;
  readonly kind: 'height' | 'rgba';
  private readonly tiles = new Map<string, RasterTile>();
  constructor(input: readonly RasterTile[]) {
    const first = input[0];
    if (!first || input.length > RASTER_LIMITS.maxTiles) throw new RangeError('Raster tile budget exceeded');
    this.zoom = first.zoom; this.size = first.size; this.kind = 'heights' in first ? 'height' : 'rgba';
    let bytes = 0;
    for (const tile of input) {
      const id = tileId(tile.zoom, tile.x, tile.y); validateTileSize(tile.size);
      const kind = 'heights' in tile ? 'height' : 'rgba';
      const data = 'heights' in tile ? tile.heights : tile.rgba;
      if (kind !== this.kind || tile.zoom !== this.zoom || tile.size !== this.size ||
          data.length !== tile.size ** 2 * (kind === 'height' ? 1 : 4) || this.tiles.has(tileKey(id))) {
        throw new RangeError('Incompatible or duplicate raster tile');
      }
      bytes += data.byteLength;
      if (bytes > RASTER_LIMITS.maxBytes) throw new RangeError('Raster byte budget exceeded');
      const copy = 'heights' in tile ? { ...id, size: tile.size, heights: tile.heights.slice() } :
        { ...id, size: tile.size, rgba: tile.rgba.slice() };
      this.tiles.set(tileKey(id), Object.freeze(copy));
    }
  }
  private get(tap: PixelTap): RasterTile {
    const tile = this.tiles.get(tileKey(tap.tile));
    if (!tile) throw new RangeError(`Missing raster coverage: ${tileKey(tap.tile)}`);
    return tile;
  }
  heightAt(u: number, v: number): number {
    if (this.kind !== 'height') throw new TypeError('Not an elevation mosaic');
    let value = 0;
    for (const tap of pixelTaps(u, v, this.zoom, this.size)) {
      const tile = this.get(tap) as HeightTile, h = tile.heights[tap.row * this.size + tap.column]!;
      if (!Number.isFinite(h)) throw new RangeError('Elevation nodata in active interpolation footprint');
      value += tap.weight * h;
    }
    return value;
  }
  /** Bounds every bilinear interpolation in a rectangle, including the texels
   * just outside it that contribute to interpolation. Convex weights imply the
   * result lies in [min,max]. No nodata skipping, fetching or tile mutation.
   * The operation is bounded independently of source resolution. */
  heightBounds(west: number, north: number, east: number, south: number): {minimumMeters:number;maximumMeters:number} {
    if(this.kind !== 'height') throw new TypeError('Not an elevation mosaic');
    if(![west,north,east,south].every(Number.isFinite) || east < west || east-west > 1 || north < 0 || south > 1 || south < north)
      throw new RangeError('Invalid elevation bounds');
    const period=this.size*2**this.zoom;
    const x0=Math.floor(west*period-.5),x1=Math.ceil(east*period-.5);
    const y0=Math.max(0,Math.floor(north*period-.5)),y1=Math.min(period-1,Math.ceil(south*period-.5));
    if((x1-x0+1)*(y1-y0+1)>65536)throw new RangeError('ELEVATION_BOUNDS_BUDGET');
    let min=Infinity,max=-Infinity;
    for(let y=y0;y<=y1;y++)for(let gx=x0;gx<=x1;gx++){
      const x=((gx%period)+period)%period;
      const t=this.tiles.get(`${this.zoom}/${Math.floor(x/this.size)}/${Math.floor(y/this.size)}`) as HeightTile | undefined;
      if(!t)throw new RangeError('Missing raster coverage for elevation bounds');
      const h=t.heights[(y%this.size)*this.size+x%this.size]!;
      if(!Number.isFinite(h))throw new RangeError('Elevation nodata in bounds footprint');
      min=Math.min(min,h);max=Math.max(max,h);
    }
    if(!Number.isFinite(min)||!Number.isFinite(max))throw new RangeError('Empty elevation bounds');
    return {minimumMeters:min,maximumMeters:max};
  }
  rgbaAt(u: number, v: number): readonly [number, number, number, number] {
    if (this.kind !== 'rgba') throw new TypeError('Not an imagery mosaic');
    const linear = [0, 0, 0];
    for (const tap of pixelTaps(u, v, this.zoom, this.size)) {
      const tile = this.get(tap) as RgbaTile, offset = (tap.row * this.size + tap.column) * 4;
      if (tile.rgba[offset + 3] !== 255) throw new RangeError('Imagery nodata');
      for (let channel = 0; channel < 3; channel++) {
        const c = tile.rgba[offset + channel]! / 255;
        linear[channel] = linear[channel]! + tap.weight * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      }
    }
    const encode = (c: number): number => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
    return [encode(linear[0]!), encode(linear[1]!), encode(linear[2]!), 255];
  }
}
