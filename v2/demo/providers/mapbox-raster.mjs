import { decodeTerrainRgb, RasterMosaic, RASTER_LIMITS, tileKey } from '../../src/providers/raster/raster-grid.ts';
import { planRasterTiles } from '../../src/providers/raster/request-plan.ts';
import { mapboxTileUrl, MAPBOX_RASTER, providerFailure } from '../../src/providers/raster/mapbox-contract.ts';
import { MAPBOX_ELEVATION_DATUM, rasterElevationSource } from '../../src/providers/raster/vertical-datum.ts';
import { buildCellImagery } from '../../src/providers/raster/imagery.ts';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 2;
function aborted(signal) { if (signal?.aborted) throw new DOMException('Chargement annulé', 'AbortError'); }
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    aborted(signal);
    const stop = () => { clearTimeout(timer); reject(new DOMException('Chargement annulé', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
async function limitedBytes(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Réponse fournisseur trop volumineuse');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    while (true) {
      aborted(signal); const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Budget de réponse dépassé');
      parts.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const part of parts) { all.set(part, offset); offset += part.length; }
  return all;
}
async function requestBytes(url, signal, elevation = false, onAttempt = () => {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    aborted(signal);
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    let retryDelay = 0;
    try {
      onAttempt();
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
      const bytes = await limitedBytes(response, controller.signal); aborted(signal);
      const mime = (response.headers.get('content-type') || '').split(';')[0];
      if (!response.ok) {
        // Only Mapbox's documented all-water message is a sea-level fallback, never an arbitrary 404.
        if (elevation && response.status === 404 && mime === 'application/json') {
          let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* malformed != water */ }
          if (body?.message === 'Tile does not exist') return { bytes, mime, water: true };
        }
        const failure = providerFailure(response.status);
        if (!failure.retryable || attempt + 1 === MAX_ATTEMPTS) throw new Error(`${failure.code} (HTTP ${response.status})`);
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryAfter || '') - Date.now());
        // Do not retry earlier than the provider asks; large waits abort this bounded preview.
        if (wait > 5000) throw new Error('PROVIDER_RETRY_LATER');
        retryDelay = Number.isFinite(wait) && wait > 0 ? wait : 500 * 2 ** attempt;
      } else return { bytes, mime, water: false };
    } catch (error) {
      if (signal.aborted) throw new DOMException('Chargement annulé', 'AbortError');
      if (timedOut) throw new Error('PROVIDER_TIMEOUT');
      // Never surface a fetch URL / token in the status, log, or evidence.
      if (error instanceof TypeError) throw new Error('PROVIDER_NETWORK_OR_CORS_ERROR');
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    await pause(retryDelay, signal);
  }
  throw new Error('PROVIDER_RETRIES_EXHAUSTED');
}
/** PNG byte-preserving path: no resize, color conversion, premultiplication or filtering. */
async function decodePixels(payload, id, layer) {
  const { bytes, mime, water } = payload, size = MAPBOX_RASTER.tileSize;
  if (water) return { ...id, size, heights: new Float64Array(size * size) };
  if (layer === 'elevation' && (mime !== 'image/png' || bytes[0] !== 137 || bytes[1] !== 80)) throw new Error('Expected Terrain-RGB PNG');
  if (layer === 'elevation' && (bytes.length < 24 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16) !== size || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20) !== size)) throw new Error('Unexpected PNG dimensions');
  if (layer === 'imagery' && !['image/jpeg','image/png','image/webp'].includes(mime)) throw new Error('Expected satellite image');
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), {
      colorSpaceConversion: layer === 'elevation' ? 'none' : 'default', premultiplyAlpha: 'none', imageOrientation: 'none',
    });
    if (bitmap.width !== size || bitmap.height !== size) throw new Error('Unexpected tile dimensions');
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) throw new Error('Canvas decoding unavailable');
    context.imageSmoothingEnabled = false; context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, size, size).data;
    return layer === 'elevation' ? decodeTerrainRgb({ ...id, size, rgba }) : { ...id, size, rgba };
  } finally { bitmap?.close(); }
}
async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
}
/** Session-scoped, bounded parallel loading. No persistence, token storage or background prefetch. */
export async function loadMapboxPatch({ cells, subdivisions, token, allowPreview, signal, onProgress = () => {} }) {
  if (allowPreview !== true) throw new Error('VERTICAL_DATUM_UNRESOLVED — active explicitement l’aperçu approximatif.');
  aborted(signal);
  if (!cells.length || cells.some(cell => cell.level !== cells[0].level)) throw new Error('One patch level required');
  token = token.trim();
  const elevationZoom = Math.min(cells[0].level, 15), imageryZoom = Math.min(cells[0].level, 18);
  const dem = planRasterTiles(cells, elevationZoom, 256, subdivisions, 1);
  const imagery = planRasterTiles(cells, imageryZoom, 256, 256, 1);
  const tasks = [...dem.map(id => ({ layer: 'elevation', id })), ...imagery.map(id => ({ layer: 'imagery', id }))];
  if (tasks.length > RASTER_LIMITS.maxTiles) throw new Error('Budget de requêtes dépassé');
  // Validate public token before starting any request.
  mapboxTileUrl('elevation', dem[0], token);
  const session = new AbortController(), stop = () => session.abort();
  signal.addEventListener('abort', stop, { once: true }); aborted(signal);
  const heights = [], colours = [], evidence = [], attributions = []; let cursor = 0, completed = 0, failure, httpAttempts = 0;
  const onAttempt = () => { httpAttempts++; };
  try {
    // Attribution is part of each provider response contract. It is never inserted as raw HTML.
    for (const layer of ['elevation', 'imagery']) {
      const config = MAPBOX_RASTER[layer];
      const metadata = await requestBytes(`https://api.mapbox.com/v4/${config.tileset}.json?access_token=${encodeURIComponent(token)}`, session.signal, false, onAttempt);
      let json; try { json = JSON.parse(new TextDecoder().decode(metadata.bytes)); } catch { throw new Error('Invalid provider metadata'); }
      if (typeof json.attribution !== 'string' || !json.attribution.trim()) throw new Error('Provider attribution unavailable');
      attributions.push(json.attribution);
    }
    const worker = async () => {
      try {
        while (cursor < tasks.length) {
          aborted(session.signal); const task = tasks[cursor++];
          const payload = await requestBytes(mapboxTileUrl(task.layer, task.id, token), session.signal, task.layer === 'elevation', onAttempt);
          const data = await decodePixels(payload, task.id, task.layer); aborted(session.signal);
          (task.layer === 'elevation' ? heights : colours).push(data);
          evidence.push({ layer: task.layer, tile: tileKey(task.id), sha256: await sha256(payload.bytes), waterFallback: payload.water });
          onProgress(++completed, tasks.length);
        }
      } catch (error) { if (!failure) failure = error; session.abort(); }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
    if (failure) throw failure; aborted(signal);
    evidence.sort((a,b) => a.layer.localeCompare(b.layer) || a.tile.localeCompare(b.tile));
    const snapshotId = await sha256(new TextEncoder().encode(JSON.stringify(evidence)));
    const heightMosaic = new RasterMosaic(heights), colourMosaic = new RasterMosaic(colours);
    const source = rasterElevationSource(heightMosaic, { sourceId: 'mapbox.terrain-rgb', snapshotId,
      verticalDatum: MAPBOX_ELEVATION_DATUM }, { allowUnresolvedDatumPreview: true });
    const textures = new Map();
    for (const cell of cells) { aborted(signal); const texture = buildCellImagery(cell, colourMosaic); textures.set(texture.cellKey, texture); }
    return { source, textures, evidence, snapshotId, attributions, elevationZoom, imageryZoom,
      requestCount: httpAttempts, plannedRequestCount: tasks.length + 2, waterFallbackCount: evidence.filter(item => item.waterFallback).length };
  } finally { signal.removeEventListener('abort', stop); session.abort(); }
}
