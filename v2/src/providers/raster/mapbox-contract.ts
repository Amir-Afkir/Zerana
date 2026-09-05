import { tileId, tileKey } from './raster-grid.js';
import type { RasterTileId } from './raster-grid.js';
export type MapboxLayer = 'elevation' | 'imagery';
export const MAPBOX_RASTER = Object.freeze({
  elevation: Object.freeze({ tileset: 'mapbox.terrain-rgb', format: 'pngraw', maxZoom: 15 }),
  imagery: Object.freeze({ tileset: 'mapbox.satellite', format: 'jpg90', maxZoom: 18 }),
  tileSize: 256,
});
export function mapboxTileUrl(layer: MapboxLayer, id: RasterTileId, token: string): string {
  const canonical = tileId(id.zoom, id.x, id.y), config = MAPBOX_RASTER[layer];
  if (!config || id.zoom > config.maxZoom) throw new RangeError('Unsupported provider layer or source zoom');
  if (typeof token !== 'string' || !/^pk\.[A-Za-z0-9._-]+$/.test(token)) throw new RangeError('A public Mapbox token (pk.) is required');
  return `https://api.mapbox.com/v4/${config.tileset}/${tileKey(canonical)}.${config.format}?access_token=${encodeURIComponent(token)}`;
}
export function providerFailure(status: number): { readonly code: string; readonly retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH_OR_URL_RESTRICTION', retryable: false };
  if (status === 404) return { code: 'PROVIDER_TILE_MISSING', retryable: false };
  if (status === 429 || status >= 500) return { code: 'PROVIDER_TEMPORARILY_UNAVAILABLE', retryable: true };
  return { code: 'PROVIDER_HTTP_ERROR', retryable: false };
}
