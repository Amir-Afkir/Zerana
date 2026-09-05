import LRUCache from '../engine/utils/LRUCache.js';
import Semaphore from '../engine/utils/Semaphore.js';
import { getTileBounds, latLonToTileFloat } from '../engine/utils/GeoUtils.js';

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

export default class OverpassService {
  constructor({
    chunkSize,
    cacheSize = 96,
    minDelayMs = 900,
    maxConcurrency = 1,
    endpoint = DEFAULT_ENDPOINT
  }) {
    this.chunkSize = chunkSize;
    this.endpoint = endpoint;
    this.cache = new LRUCache(cacheSize);
    this.semaphore = new Semaphore(maxConcurrency);
    this.minDelayMs = minDelayMs;
    this.lastRequestTime = 0;
  }

  async fetchTrees(tileX, tileY, zoom, signal) {
    const key = `${tileX}_${tileY}_${zoom}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const { query, bounds } = this.buildQuery(tileX, tileY, zoom);

    try {
      const data = await this.rateLimitedFetch(query, signal);
      const trees = this.parseTrees(data, bounds);
      this.cache.set(key, trees);
      return trees;
    } catch (error) {
      if (error?.name === 'AbortError') return [];
      return [];
    }
  }

  buildQuery(tileX, tileY, zoom) {
    const bounds = { ...getTileBounds(tileX, tileY, zoom), tileX, tileY, zoom };
    const widthLon = bounds.seLon - bounds.nwLon;
    const heightLat = bounds.nwLat - bounds.seLat;

    const padLon = widthLon * 0.1;
    const padLat = heightLat * 0.1;

    const minLat = bounds.seLat - padLat;
    const maxLat = bounds.nwLat + padLat;
    const minLon = bounds.nwLon - padLon;
    const maxLon = bounds.seLon + padLon;

    const query = `
      [out:json][timeout:25];
      (
        node["natural"="tree"](${minLat},${minLon},${maxLat},${maxLon});
        way["natural"="tree_row"](${minLat},${minLon},${maxLat},${maxLon});
      );
      out body;
      >;
      out skel qt;
    `.trim();

    return { query, bounds };
  }

  async rateLimitedFetch(query, signal) {
    await this.semaphore.acquire();
    try {
      const now = Date.now();
      const wait = Math.max(0, this.lastRequestTime + this.minDelayMs - now);
      if (wait) await sleep(wait);
      this.lastRequestTime = Date.now();

      return await this.fetchWithBackoff(query, signal);
    } finally {
      this.semaphore.release();
    }
  }

  async fetchWithBackoff(query, signal) {
    const maxAttempts = 3;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const params = new URLSearchParams();
        params.append('data', query);

        const response = await fetch(this.endpoint, {
          method: 'POST',
          body: params,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal
        });

        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
            const backoff = retryAfter || (300 * Math.pow(2, attempt));
            await sleep(backoff + Math.random() * 250);
            continue;
          }
          throw new Error(`Overpass error: ${response.statusText}`);
        }

        return await response.json();
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (attempt >= maxAttempts) throw error;
        await sleep(200 * Math.pow(2, attempt));
      }
    }

    return { elements: [] };
  }

  parseTrees(data, bounds) {
    const elements = data?.elements || [];
    if (!elements.length) return [];

    const nodeMap = new Map();
    for (const element of elements) {
      if (element.type === 'node') nodeMap.set(element.id, element);
    }

    const half = this.chunkSize / 2;
    const zoom = bounds.zoom;
    const tileX = bounds.tileX;
    const tileY = bounds.tileY;

    const trees = [];

    for (const element of elements) {
      if (element.type === 'node') {
        const tilePos = latLonToTileFloat(element.lon, element.lat, zoom);
        const localX = (tilePos.x - tileX) * this.chunkSize - half;
        const localZ = (tilePos.y - tileY) * this.chunkSize - half;
        if (localX < -half || localX > half || localZ < -half || localZ > half) continue;
        trees.push({
          id: `tree_${element.id}`,
          position: {
            x: localX,
            z: localZ
          }
        });
      }
    }

    for (const element of elements) {
      if (element.type !== 'way' || !Array.isArray(element.nodes)) continue;
      for (const nodeId of element.nodes) {
        const node = nodeMap.get(nodeId);
        if (!node) continue;
        const tilePos = latLonToTileFloat(node.lon, node.lat, zoom);
        const localX = (tilePos.x - tileX) * this.chunkSize - half;
        const localZ = (tilePos.y - tileY) * this.chunkSize - half;
        if (localX < -half || localX > half || localZ < -half || localZ > half) continue;
        trees.push({
          id: `tree_row_${nodeId}`,
          position: {
            x: localX,
            z: localZ
          }
        });
      }
    }

    return trees;
  }
}
