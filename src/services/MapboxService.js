import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import LRUCache from '../engine/utils/LRUCache.js';
import { latLonToTile, tileToLatLon, calcScaleFactor } from '../engine/utils/GeoUtils.js';
import { groupRings } from '../engine/utils/BuildingRings.js';

export default class MapboxService {
  constructor({
    apiKey,
    zoom,
    chunkSize,
    cacheSize = 96,
    satelliteStyle = 'mapbox/satellite-v9'
  }) {
    this.apiKey = apiKey;
    this.zoom = zoom;
    this.chunkSize = chunkSize;
    this.satelliteStyle = satelliteStyle;

    this.worker = new Worker(new URL('../workers/terrain.worker.js', import.meta.url), {
      type: 'module'
    });

    this.heightCache = new LRUCache(cacheSize);
    this.textureCache = new LRUCache(cacheSize, (bitmap) => bitmap?.close?.());
    this.buildingCache = new LRUCache(cacheSize);
    this.inflight = new Map();
  }

  dispose() {
    this.worker?.terminate();
  }

  getTileUrlFromTileXY(tileX, tileY, type = 'satellite') {
    const token = `access_token=${this.apiKey}`;

    const tileConfigs = {
      satellite: {
        baseUrl: `https://api.mapbox.com/styles/v1/${this.satelliteStyle}/tiles`,
        extension: ''
      },
      'terrain-rgb': {
        baseUrl: 'https://api.mapbox.com/v4/mapbox.terrain-rgb',
        extension: '.pngraw'
      },
      building: {
        baseUrl: 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8',
        extension: '.mvt'
      }
    };

    const config = tileConfigs[type];
    if (!config) throw new Error(`Unknown tile type: ${type}`);
    return `${config.baseUrl}/${this.zoom}/${tileX}/${tileY}${config.extension}?${token}`;
  }

  getTileUrl(lon, lat, type = 'satellite') {
    const { x, y } = latLonToTile(lon, lat, this.zoom);
    return this.getTileUrlFromTileXY(x, y, type);
  }

  latLonToTile(lon, lat) {
    return latLonToTile(lon, lat, this.zoom);
  }

  tileToLatLon(x, y) {
    return tileToLatLon(x, y, this.zoom);
  }

  getTileKeyFromTileXY(tileX, tileY) {
    return `${this.zoom}_${tileX}_${tileY}`;
  }

  getTileKey(lon, lat) {
    const { x, y } = latLonToTile(lon, lat, this.zoom);
    return this.getTileKeyFromTileXY(x, y);
  }

  async fetchCoords(address, signal) {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${this.apiKey}`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.features?.[0]?.geometry?.coordinates || null;
  }

  async fetchHeightmapTile(tileX, tileY, latitudeForScale, signal, { targetSize = 512 } = {}) {
    const key = `height:${this.getTileKeyFromTileXY(tileX, tileY)}:${targetSize}`;
    const cached = this.heightCache.get(key);
    if (cached) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const tileUrl = this.getTileUrlFromTileXY(tileX, tileY, 'terrain-rgb');
    const scaleFactor = calcScaleFactor(latitudeForScale, this.zoom, this.chunkSize) || 1;

    const promise = this.sendToWorker(tileUrl, 'heightmap', { scaleFactor, targetSize }, signal)
      .then((heightmap) => {
        if (heightmap) this.heightCache.set(key, heightmap);
        return heightmap;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  async fetchHeightmap(lon, lat, signal) {
    const { x, y } = latLonToTile(lon, lat, this.zoom);
    const centerLat = this.tileToLatLon(x + 0.5, y + 0.5).lat;
    return this.fetchHeightmapTile(x, y, centerLat, signal);
  }

  async fetchSatelliteTile(tileX, tileY, signal, { maxSize = null } = {}) {
    const key = `sat:${this.getTileKeyFromTileXY(tileX, tileY)}:${maxSize || 'full'}`;
    const cached = this.textureCache.get(key);
    if (cached) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const tileUrl = this.getTileUrlFromTileXY(tileX, tileY, 'satellite');
    const promise = this.sendToWorker(tileUrl, 'image', { maxSize }, signal)
      .then((imageBitmap) => {
        if (imageBitmap) this.textureCache.set(key, imageBitmap);
        return imageBitmap;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  async fetchSatellite(lon, lat, signal) {
    const { x, y } = latLonToTile(lon, lat, this.zoom);
    return this.fetchSatelliteTile(x, y, signal);
  }

  async fetchBuildingsTile(tileX, tileY, latitudeForScale, signal) {
    const key = `bld:${this.getTileKeyFromTileXY(tileX, tileY)}`;
    const cached = this.buildingCache.get(key);
    if (cached) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const tileUrl = this.getTileUrlFromTileXY(tileX, tileY, 'building');
    const scaleFactor = calcScaleFactor(latitudeForScale, this.zoom, this.chunkSize) || 1;

    const promise = fetch(tileUrl, { signal })
      .then((res) => {
        if (!res.ok) throw new Error(`MVT download failed: ${res.statusText}`);
        return res.arrayBuffer();
      })
      .then((buffer) => this.parseBuildingTile(buffer, scaleFactor))
      .then((buildings) => {
        this.buildingCache.set(key, buildings);
        return buildings;
      })
      .catch(() => [])
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  async fetchBuildings(lon, lat, signal) {
    const { x, y } = latLonToTile(lon, lat, this.zoom);
    const centerLat = this.tileToLatLon(x + 0.5, y + 0.5).lat;
    return this.fetchBuildingsTile(x, y, centerLat, signal);
  }

  parseBuildingTile(buffer, scaleFactor) {
    const pbf = new Pbf(buffer);
    const tile = new VectorTile(pbf);
    const layer = tile.layers?.building;
    if (!layer) return [];

    const buildings = [];
    const half = this.chunkSize / 2;

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const lines = feature.loadGeometry();
      if (!lines?.length) continue;

      const rings = lines.map((ring) =>
        ring.map((pt) => ({
          x: (pt.x / 4096) * this.chunkSize - half,
          y: (pt.y / 4096) * this.chunkSize - half
        }))
      );

      const props = feature.properties || {};
      const height = (Number(props.height) || 0) / scaleFactor;
      const minHeight = (Number(props.min_height) || 0) / scaleFactor;
      const buildingType = props.type || 'unknown';
      const extrude = props.extrude !== undefined ? props.extrude : true;
      const underground = props.underground === true;
      const layerValue = props.layer || 0;

      const polys = groupRings(rings);
      for (let p = 0; p < polys.length; p++) {
        const poly = polys[p];
        const outer = poly.outer;
        if (!outer || outer.length < 3) continue;

        let minX = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxZ = -Infinity;
        for (let r = 0; r < outer.length; r++) {
          const pt = outer[r];
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minZ) minZ = pt.y;
          if (pt.y > maxZ) maxZ = pt.y;
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minZ) || !Number.isFinite(maxX) || !Number.isFinite(maxZ)) {
          continue;
        }

        const centerX = (minX + maxX) * 0.5;
        const centerZ = (minZ + maxZ) * 0.5;
        if (centerX < -half || centerX > half || centerZ < -half || centerZ > half) continue;

        buildings.push({
          id: feature.id != null ? `${feature.id}_${p}` : null,
          outer,
          holes: poly.holes || [],
          bounds: { minX, maxX, minZ, maxZ },
          height,
          minHeight,
          type: buildingType,
          extrude,
          underground,
          layer: layerValue,
          hasHoles: (poly.holes?.length || 0) > 0
        });
      }
    }

    return buildings;
  }

  sendToWorker(tileUrl, type, options = {}, signal) {
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2);

      const onMessage = (event) => {
        if (event.data.requestId !== requestId) return;
        cleanup();
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else if (event.data.imageBitmap) {
          resolve(event.data.imageBitmap);
        } else if (event.data.heightmap) {
          resolve(event.data.heightmap);
        } else {
          resolve(null);
        }
      };

      const onAbort = () => {
        cleanup();
        this.worker.postMessage({ requestId, type: 'abort' });
        reject(new DOMException('Aborted', 'AbortError'));
      };

      const cleanup = () => {
        this.worker.removeEventListener('message', onMessage);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      this.worker.addEventListener('message', onMessage);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this.worker.postMessage({ requestId, tileUrl, type, options });
    });
  }
}
