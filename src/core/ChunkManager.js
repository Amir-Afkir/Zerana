// Gestion dynamique des chunks (load/unload)
import * as THREE from 'three';
import EventBus from './EventBus.js';

export default class ChunkManager {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map(); // Map des chunks chargés, clé = "x_z"
    this.chunkSize = 100;
    this.gridRadius = 2;

    this.playerPosition = new THREE.Vector3(0, 0, 0);
  }

  getChunkKey(x, z) {
    const chunkX = Math.floor(x / this.chunkSize);
    const chunkZ = Math.floor(z / this.chunkSize);
    return `${chunkX}_${chunkZ}`;
  }

  createChunk(chunkX, chunkZ) {
    const key = this.getChunkKey(chunkX * this.chunkSize, chunkZ * this.chunkSize);
    console.log(`[ChunkManager] Création chunk ${key}`);

    const chunk = new THREE.Group();
    chunk.position.set(chunkX * this.chunkSize, 0, chunkZ * this.chunkSize);
    chunk.chunkX = chunkX;
    chunk.chunkZ = chunkZ;

    this.scene.add(chunk);
    this.chunks.set(key, chunk);

    return chunk;
  }

  loadChunk(chunkData) {
    const chunkX = chunkData.x;
    const chunkZ = chunkData.y;
    const key = this.getChunkKey(chunkX * this.chunkSize, chunkZ * this.chunkSize);

    if (this.chunks.has(key)) {
      console.log(`[ChunkManager] Chunk ${key} déjà chargé`);
      return;
    }

    const chunk = this.createChunk(chunkX, chunkZ);

    this.updateChunkContent(chunk, chunkData);
  }

  updateChunkContent(chunk, chunkData) {
    console.log(`[ChunkManager] Mise à jour contenu chunk ${chunk.chunkX}_${chunk.chunkZ}`);

    if (chunkData.heightmap) {
      console.log(`  Heightmap avec ${chunkData.heightmap.length} points reçue.`);
      this.generateTerrain(chunk, chunkData.heightmap);
    }
    if (chunkData.buildings) {
      console.log(`  ${chunkData.buildings.length} bâtiments reçus.`);
      this.generateBuildings(chunk, chunkData.buildings);
    }
    if (chunkData.trees) {
      console.log(`  ${chunkData.trees.length} arbres reçus.`);
      this.generateTrees(chunk, chunkData.trees);
    }
  }

  // TODO: Implémenter ces méthodes pour générer le contenu réel du chunk
  generateTerrain(chunk, heightmap) {
    // Exemple simple : tu peux générer une géométrie plane avec des hauteurs
    console.log(`[ChunkManager] Génération terrain pour chunk ${chunk.chunkX}_${chunk.chunkZ} (placeholder)`);
  }

  generateBuildings(chunk, buildings) {
    console.log(`[ChunkManager] Génération bâtiments pour chunk ${chunk.chunkX}_${chunk.chunkZ} (placeholder)`);
  }

  generateTrees(chunk, trees) {
    console.log(`[ChunkManager] Génération arbres pour chunk ${chunk.chunkX}_${chunk.chunkZ} (placeholder)`);
  }

  disposeChunk(chunkKey) {
    const chunk = this.chunks.get(chunkKey);
    if (!chunk) return;

    console.log(`[ChunkManager] Suppression chunk ${chunkKey}`);

    this.scene.remove(chunk);

    chunk.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });

    this.chunks.delete(chunkKey);
  }

  update(playerPosition) {
    this.playerPosition.copy(playerPosition);

    const playerChunkX = Math.floor(this.playerPosition.x / this.chunkSize);
    const playerChunkZ = Math.floor(this.playerPosition.z / this.chunkSize);

    const neededChunks = new Set();

    for (let x = playerChunkX - this.gridRadius; x <= playerChunkX + this.gridRadius; x++) {
      for (let z = playerChunkZ - this.gridRadius; z <= playerChunkZ + this.gridRadius; z++) {
        const key = this.getChunkKey(x * this.chunkSize, z * this.chunkSize);
        neededChunks.add(key);

        if (!this.chunks.has(key)) {
          // Demande la création via un événement pour que TileFetcher charge les données
          console.log(`[ChunkManager] Demande chargement chunk ${key}`);
          EventBus.emit('requestChunk', { x, z });
        }
      }
    }

    for (const key of this.chunks.keys()) {
      if (!neededChunks.has(key)) {
        this.disposeChunk(key);
      }
    }
  }
}