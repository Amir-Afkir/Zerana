import EventBus from '../core/EventBus.js';
import { MAPBOX_API_KEY } from '../utils/constants.js';
import CoordinateUtils from '../data/CoordinateUtils.js';

export default class TileFetcher {
  constructor(baseUrl) {
    this.baseUrl = baseUrl; // Ex: https://api.tonbackend.com/chunks
    this.cache = new Map();

    this.apiKey = MAPBOX_API_KEY;
    this.zoom = 17; // Configurable si besoin
    this.chunkSize = 100;

    console.log('[TileFetcher] Initialisation avec baseUrl:', this.baseUrl);
    console.log('[TileFetcher] API Key Mapbox:', this.apiKey ? 'OK' : 'NON définie');

    // Écoute l'événement 'addressSaved' global
    window.addEventListener('addressSaved', async () => {
      const address = window.savedAddress;
      console.log('[TileFetcher] Event addressSaved reçu avec adresse:', address);

      if (!address || address.trim() === '') {
        console.error('[TileFetcher] Aucune adresse valide.');
        return;
      }
      if (!this.apiKey) {
        console.error('[TileFetcher] Clé API Mapbox non définie.');
        return;
      }

      // Géocode adresse → coords
      const coords = await this.geocodeAddress(address);
      if (!coords) {
        console.error('[TileFetcher] Impossible de récupérer les coordonnées.');
        return;
      }

      console.log('[TileFetcher] Coordonnées obtenues:', coords);

      // Émet l'événement global avec coordonnées et adresse
      EventBus.emit('mapbox:coordsReceived', { coords, address });
      console.log('[TileFetcher] Événement mapbox:coordsReceived émis');

      // Convertir coords en tuile via CoordinateUtils
      const [lon, lat] = coords;
      const tile = CoordinateUtils.latLonToTile(lon, lat, this.zoom);
      console.log(`[TileFetcher] Conversion coords en tuile : x=${tile.x}, y=${tile.y}, zoom=${this.zoom}`);

      // Charger chunk correspondant à la tuile centrale
      const chunkData = await this.fetchChunk(tile.x, tile.y);
      if (chunkData) {
        console.log('[TileFetcher] Chunk chargé:', chunkData);
        EventBus.emit('chunk:loaded', chunkData);
        console.log('[TileFetcher] Événement chunk:loaded émis');
      } else {
        console.error('[TileFetcher] Échec chargement chunk');
      }
    });
  }

  async fetchChunk(x, z) {
    const key = `${x}_${z}`;
    console.log(`[TileFetcher] fetchChunk appelé pour clé: ${key}`);

    if (this.cache.has(key)) {
      console.log(`[TileFetcher] Chunk trouvé dans cache pour clé: ${key}`);
      return this.cache.get(key);
    }

    const url = `${this.baseUrl}/${x}/${z}.json`;
    console.log(`[TileFetcher] Fetch du chunk via URL: ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Erreur HTTP ${response.status} lors du chargement chunk ${key}`);
      }
      const data = await response.json();
      this.cache.set(key, data);
      console.log(`[TileFetcher] Chunk mis en cache pour clé: ${key}`);
      return data;
    } catch (err) {
      console.error('[TileFetcher] Erreur fetchChunk:', err);
      return null;
    }
  }

  async geocodeAddress(address) {
    console.log('[TileFetcher] Geocodage de l’adresse:', address);

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${this.apiKey}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Erreur géocodage: ${response.statusText}`);
      }
      const data = await response.json();
      if (!data.features || !data.features.length) {
        console.error('[TileFetcher] Aucune coordonnée trouvée pour l’adresse:', address);
        return null;
      }
      console.log('[TileFetcher] Données reçues du géocodeur:', data.features[0].geometry.coordinates);
      return data.features[0].geometry.coordinates; // [lon, lat]
    } catch (e) {
      console.error('[TileFetcher] Erreur réseau lors du géocodage:', e);
      return null;
    }
  }
}