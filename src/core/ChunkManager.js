// src/core/ChunkManager.js
import * as THREE from 'three';
import TerrainTile from './../graphics/TerrainTile.js';
import EventBus from './EventBus.js';

export default class ChunkManager {
  constructor(scene, fetcher, opts = {}) {
    this.scene = scene;
    this.fetcher = fetcher;
    this.chunkSize = opts.chunkSize || 100;
    this.gridRadius = opts.gridRadius || 2;
    this.chunks = new Map();
    this.loading = new Set();
    this.playerPos = new THREE.Vector3();
    this.lastChunk = null;

    EventBus.on('requestChunksGrid', ({ tile, zoom }) => this.loadChunksGrid(tile, zoom));
    EventBus.on('chunk:loaded', (chunkData) => this.addChunk(chunkData));
  }

  getChunkKey(x, y) {
    return `${x}_${y}`;
  }

  async loadChunksGrid(centerTile, zoom) {
    // Appelé quand tu veux charger une grille autour du joueur (coord tile)
    const { x: cx, y: cy } = centerTile;
    for (let dx = -this.gridRadius; dx <= this.gridRadius; dx++) {
      for (let dy = -this.gridRadius; dy <= this.gridRadius; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        const key = this.getChunkKey(x, y);
        if (!this.chunks.has(key) && !this.loading.has(key)) {
          this.loading.add(key);
          this.fetcher.fetchChunk(x, y).then(chunkData => {
            this.loading.delete(key);
            if (chunkData) EventBus.emit('chunk:loaded', { ...chunkData, x, y });
          });
        }
      }
    }
    // Tu peux rajouter ici l’unload des chunks trop loin (optionnel pour commencer)
  }

  addChunk(chunkData) {
    const { x, y, heightmap, satelliteTexture, buildings = [], trees = [] } = chunkData;
    const key = this.getChunkKey(x, y);
    if (this.chunks.has(key)) return;

    try {
      const tile = new TerrainTile(x, y, this.chunkSize, heightmap, satelliteTexture);
      this.scene.add(tile.getMesh());
      this.chunks.set(key, { tile, mesh: tile.getMesh(), buildings, trees });
      // TODO: générer les objets buildings/trees ici
    } catch (e) {
      console.error(`[ChunkManager] Erreur ajout chunk ${key} :`, e);
    }
  }

  unloadChunk(x, y) {
    const key = this.getChunkKey(x, y);
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.scene.remove(chunk.mesh);
    chunk.tile.dispose();
    this.chunks.delete(key);
  }
  // Appelée à chaque frame pour mettre à jour la grille de chunks autour du joueur
  update(playerPosition) {
    const playerChunkX = Math.floor(playerPosition.x / this.chunkSize);
    const playerChunkY = Math.floor(playerPosition.z / this.chunkSize);
    this.loadChunksGrid({ x: playerChunkX, y: playerChunkY }, this.fetcher.zoom);
  }

  // 1. Trouver le chunk où se trouve le joueur
getHeightAt(x, z) {
  const chunkSize = this.chunkSize;
  const chunkX = Math.floor(x / chunkSize);
  const chunkZ = Math.floor(z / chunkSize);
  const key = `${chunkX}_${chunkZ}`;
  const chunk = this.chunks.get(key);
  if (!chunk) {
    console.log("[ChunkManager] Chunk ABSENT pour", key);
    return 0;
  }

  // 2. Récupérer la heightmap et la grille
  const { tile } = chunk;
  const heightmap = tile.heightmap;
  const gridSize = Math.sqrt(heightmap.length);
  const subdivisions = gridSize - 1;

  // 3. Position relative dans le chunk
  const localX = x - chunkX * chunkSize;
  const localZ = z - chunkZ * chunkSize;
  const normX = Math.min(Math.max(0, Math.floor((localX / chunkSize) * subdivisions)), subdivisions);
  const normZ = Math.min(Math.max(0, Math.floor((localZ / chunkSize) * subdivisions)), subdivisions);

  return heightmap[normZ * gridSize + normX];
}
}