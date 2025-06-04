// src/core/MapboxManager.js
import {
  CHUNK_SIZE,
  ZOOM_LEVEL,
  MAPBOX_API_KEY, 
} from '../utils/constants.js';
import EventBus from './EventBus.js';

export default class MapboxManager {
  constructor({
    apiKey = MAPBOX_API_KEY,
    zoom = ZOOM_LEVEL,
    chunkSize = CHUNK_SIZE
  } = {}) {
    this.apiKey = apiKey;
    this.zoom = zoom;
    this.chunkSize = chunkSize;
    this.worker = this.createGlobalWorker();
    this.cache = new Map();
  }

  // Génère l’URL d’une tuile selon le type
  getTileUrl(lon, lat, zoom = this.zoom, type = 'satellite') {
    const { x, y } = this.latLonToTile(lon, lat, zoom);

    const tileConfigs = {
      'satellite': {
        baseUrl: 'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles',
        extension: ''
      },
      'terrain-rgb': {
        baseUrl: 'https://api.mapbox.com/v4/mapbox.terrain-rgb',
        extension: '.pngraw'
      }
      // Ajoute ici d’autres types si besoin
    };

    const config = tileConfigs[type];
    if (!config) throw new Error(`Type de tuile inconnu : ${type}`);

    return `${config.baseUrl}/${zoom}/${x}/${y}${config.extension}?access_token=${this.apiKey}`;
  }
// Geocoder une adresse Mapbox → [lon, lat]
async fetchCoords(address) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${this.apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  const coords = data.features?.[0]?.geometry?.coordinates || null;

  return coords;

}

  // ---- Worker pour décoder/interpoler la heightmap terrain-rgb ----
  createGlobalWorker() {
    const workerCode = `
      self.onmessage = async function(event) {
        const { requestId, tileUrl, type, options } = event.data;
        try {
          const response = await fetch(tileUrl);
          if (!response.ok) throw new Error("Erreur de téléchargement : " + response.statusText);

          if (type === 'image') {
            // Renvoie un blob de l’image satellite
            const blob = await response.blob();
            const ImageBitmap = await createImageBitmap(blob);
            self.postMessage({ requestId, ImageBitmap }, [ImageBitmap]);
          } else if (type === 'heightmap') {
            // Traitement heightmap (terrain-rgb)
            const blob = await response.blob();
            const ImageBitmap = await createImageBitmap(blob);

            const originalSize = 64;
            const targetSize = 512;
            const facteurEchelle = options.facteurEchelle || 1;

            // Utiliser OffscreenCanvas
            const canvas = new OffscreenCanvas(originalSize, originalSize);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(ImageBitmap, 0, 0, originalSize, originalSize);

            const imageData = ctx.getImageData(0, 0, originalSize, originalSize);
            const pixels = imageData.data;

            // Décodage RGB vers Float32Array (heightmap)
            const heightmap = new Float32Array(originalSize * originalSize);
            for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
              const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
              heightmap[j] = (-10000 + (r * 256 * 256 + g * 256 + b) * 0.1) / facteurEchelle;
            }

            // Interpolation 64x64 -> 512x512 (bilinéaire)
            const interp = new Float32Array(targetSize * targetSize);
            const scale = (originalSize - 1) / (targetSize - 1);
            for (let y = 0; y < targetSize; y++) {
              const yOrig = y * scale;
              const y0 = Math.floor(yOrig), y1 = Math.min(y0 + 1, originalSize - 1);
              const dy = yOrig - y0;
              for (let x = 0; x < targetSize; x++) {
                const xOrig = x * scale;
                const x0 = Math.floor(xOrig), x1 = Math.min(x0 + 1, originalSize - 1);
                const dx = xOrig - x0;

                const i00 = y0 * originalSize + x0;
                const i10 = y0 * originalSize + x1;
                const i01 = y1 * originalSize + x0;
                const i11 = y1 * originalSize + x1;

                const h00 = heightmap[i00], h10 = heightmap[i10], h01 = heightmap[i01], h11 = heightmap[i11];
                const h0 = h00 + dx * (h10 - h00);
                const h1 = h01 + dx * (h11 - h01);
                interp[y * targetSize + x] = h0 + dy * (h1 - h0);
              }
            }
            self.postMessage({ requestId, heightmap: interp }, [interp.buffer]);
          }
        } catch (error) {
          self.postMessage({ requestId, error: error.message });
        }
      };
    `;
    return new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));
  }

  // Utilitaire pour utiliser le worker (image ou heightmap)
  sendToWorker(tileUrl, type, options = {}) {
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2);
      const handler = (e) => {
        if (e.data.requestId === requestId) {
          this.worker.removeEventListener('message', handler);
          if (e.data.error) reject(new Error(e.data.error));
          else if (e.data.ImageBitmap) resolve(e.data.ImageBitmap);
          else if (e.data.heightmap) resolve(e.data.heightmap);
        }
      };
      this.worker.addEventListener('message', handler);
      this.worker.postMessage({ requestId, tileUrl, type, options });
    });
  }

  // Méthode pour obtenir la texture satellite (HTMLImageElement ou ImageBitmap)
  async fetchSatelliteTexture(lon, lat) {
    const url = this.getTileUrl(lon, lat, this.zoom, 'satellite');
    return await this.sendToWorker(url, 'image');
  }

  // Méthode pour obtenir la heightmap interpolée (Float32Array)
  async fetchHeightmap(lon, lat) {
    const url = this.getTileUrl(lon, lat, this.zoom, 'terrain-rgb');
    const facteurEchelle = this.calcScaleFactor(lat, this.zoom, this.chunkSize);
    return await this.sendToWorker(url, 'heightmap', { facteurEchelle });
  }

  // -- Utilitaires coordonnées (comme dans ton code PlayCanvas) --
  latLonToTile(lon, lat, zoom = this.zoom) {
    const x = Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
    const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    return { x, y };
  }

  tileToLatLon(x, y, zoom = this.zoom) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
    const lon = (x / Math.pow(2, zoom)) * 360 - 180;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lon, lat };
  }

  calcScaleFactor(lat, zoom, chunkSize) {
    const earthCircum = 40075017;
    const tileWidthMeters = earthCircum * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return tileWidthMeters / chunkSize;
  }
} 