// Requêtes REST backend pour chunks
export default class TileFetcher {
  constructor(baseUrl) {
    this.baseUrl = baseUrl; // Ex: https://api.tonbackend.com/chunks
    this.cache = new Map(); // Cache simple en mémoire
  }

  async fetchChunk(x, z) {
    const key = `${x}_${z}`;
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    const url = `${this.baseUrl}/${x}/${z}.json`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Erreur HTTP ${response.status} lors du chargement chunk ${key}`);
      }
      const data = await response.json();
      this.cache.set(key, data);
      return data;
    } catch (err) {
      console.error('Erreur fetchChunk:', err);
      return null;
    }
  }
}