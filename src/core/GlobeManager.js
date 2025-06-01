// src/core/GlobeManager.js

import * as THREE from 'three';
import MapboxManager from './MapboxManager.js';
import {
  CHUNK_SIZE,
  GRID_SIZE,
} from '../utils/constants.js';
import { generateMeshFromHeightmap } from './Modelisation.js';

export default class GlobeManager {
  constructor({
    mapbox,           // instance de MapboxManager
    scene,
    player,
    gridSize = GRID_SIZE,
    chunkSize = CHUNK_SIZE,
    material = null
  }) {
    this.mapbox = mapbox;
    this.scene = scene;
    this.player = player;
    this.gridSize = gridSize;
    this.chunkSize = chunkSize;
    this.material = material;

    this.maxRecyclage = (this.gridSize + 2) ** 2;
    this.chunkStates = {};
    this.currentChunkPos = this.getChunkInfo(this.player.position).position;
    this.isInit = false;

    // Setup event listeners si besoin, sinon appelle init() manuellement
    // Exemple : this.init({lon, lat, ...})
  }

async initFromCoords(lon, lat) {

  const centralTile = this.mapbox.latLonToTile(lon, lat, this.mapbox.zoom);
  this.globalTileX = centralTile.x;
  this.globalTileY = centralTile.y;

  const playerChunkPos = this.getChunkInfo(this.player.position).position;
  this.startPlayerChunkX = playerChunkPos.x;
  this.startPlayerChunkZ = playerChunkPos.z;

  this.isInit = true;

  await this.generateChunksAroundPlayer();
}

  getChunkInfo(position) {
    const chunkSize = this.chunkSize;
    const chunkX = Math.floor((position.x + chunkSize / 2) / chunkSize);
    const chunkZ = Math.floor((position.z + chunkSize / 2) / chunkSize);
    const chunkKey = `${chunkX}_${chunkZ}`;
    return { position: { x: chunkX, z: chunkZ }, key: chunkKey };
  }

    async fetchChunkData(chunkKey, chunkState, chunk, offsetX, offsetZ) {

    const playerChunkInfo = this.getChunkInfo(this.player.position).position;
    const globalTileX = this.globalTileX + (playerChunkInfo.x - this.startPlayerChunkX) + offsetX + 0.5;
    const globalTileY = this.globalTileY + (playerChunkInfo.z - this.startPlayerChunkZ) + offsetZ + 0.5;
    const { lon, lat } = this.mapbox.tileToLatLon(globalTileX, globalTileY, this.mapbox.zoom);


    try {
        const [heightmap, satellite] = await Promise.all([
        this.mapbox.fetchHeightmap(lon, lat),
        this.mapbox.fetchSatelliteTexture(lon, lat)
        ]);

        chunk.heightmap = heightmap;
        chunk.satelliteTexture = satellite;

        chunkState.dataLoaded = !!(heightmap && satellite);
        if (!chunkState.dataLoaded) {
        // console.warn(`[GlobeManager] Certaines données du chunk ${chunkKey} n'ont pas pu être chargées.`);
        }
    } catch (error) {
        chunkState.dataLoaded = false;
    }
    }

  getChunkNeighbors(chunkX, chunkZ) {
    const neighbors = {};
    [
      { name: 'top', dx: 0, dz: 1 },
      { name: 'bottom', dx: 0, dz: -1 },
      { name: 'left', dx: -1, dz: 0 },
      { name: 'right', dx: 1, dz: 0 }
    ].forEach(({ name, dx, dz }) => {
      const key = `${chunkX + dx}_${chunkZ + dz}`;
      const state = this.chunkStates[key];
      neighbors[name] = state && state.dataLoaded ? state : null;
    });
    return neighbors;
  }

    createNewChunk(chunkX, chunkZ, chunkKey) {
    const group = new THREE.Group();
    group.position.set(chunkX * this.chunkSize, 0, chunkZ * this.chunkSize);
    group.name = `chunk_${chunkX}_${chunkZ}`;
    this.scene.add(group);

    const chunk = {
        x: chunkX,
        z: chunkZ,
        mesh: null,
        satelliteTexture: null,
        heightmap: null,
        group: group
    };

    this.chunkStates[chunkKey] = {
        entity: chunk,
        isVisible: true,
        isRecycled: false,
        dataLoaded: false
    };

    return chunk;
    }

async createChunk(chunkX, chunkZ, offsetX, offsetZ) {
  const chunkKey = this.getChunkInfo({ x: chunkX * this.chunkSize, z: chunkZ * this.chunkSize }).key;
  let chunkState = this.chunkStates[chunkKey];
  let chunk;

  if (chunkState) {
    if (chunkState.isRecycled) this.reactivateChunk(chunkState);
    if (chunkState.dataLoaded) {
      return;
    }
    chunk = chunkState.entity;
  } else {
    // console.log(`[GlobeManager] Création nouveau chunk : ${chunkKey}`);
    chunk = this.createNewChunk(chunkX, chunkZ, chunkKey);
    chunkState = this.chunkStates[chunkKey];
  }

  const neighbors = this.getChunkNeighbors(chunkX, chunkZ);

  try {
    await this.fetchChunkData(chunkKey, chunkState, chunk, offsetX, offsetZ);
    if (chunkState.dataLoaded) {
      if (chunk.heightmap) {
        generateMeshFromHeightmap(chunk, neighbors, this.material);
      }
      } else {
      // console.warn(`[GlobeManager] Données non chargées pour chunk : ${chunkKey}`);
      }
    } catch (e) {
    // console.error(`[GlobeManager] Erreur lors du traitement chunk ${chunkKey}:`, e);
    }
}
  reactivateChunk(chunkState) {
    if (chunkState.entity.group) chunkState.entity.group.visible = true;
    chunkState.isVisible = true;
    chunkState.isRecycled = false;
  }

  hideChunk(chunkX, chunkZ) {
    const chunkKey = this.getChunkInfo({ x: chunkX * this.chunkSize, z: chunkZ * this.chunkSize }).key;
    const chunkState = this.chunkStates[chunkKey];
    if (!chunkState) return;
    if (chunkState.entity.group) chunkState.entity.group.visible = false;
    chunkState.isRecycled = true;
    chunkState.isVisible = false;

    // Nettoyage si trop de chunks recyclés
    const recycled = Object.keys(this.chunkStates).filter(k => this.chunkStates[k].isRecycled);
    if (recycled.length > this.maxRecyclage) this.deleteChunkByKey(recycled[0]);
  }

  deleteChunkByKey(chunkKey) {
    const chunkState = this.chunkStates[chunkKey];
    if (!chunkState) return;
    const chunk = chunkState.entity;

    // Nettoie les ressources
    if (chunk.satelliteTexture?.dispose) chunk.satelliteTexture.dispose();
    if (chunk.mesh?.geometry) chunk.mesh.geometry.dispose();
    if (chunk.mesh?.material) chunk.mesh.material.dispose();
    this.scene.remove(chunk.group);
    delete this.chunkStates[chunkKey];
  }

  async generateChunksAroundPlayer() {
    const halfGrid = Math.floor(this.gridSize / 2);
    const playerChunkPos = this.getChunkInfo(this.player.position).position;
    const chunksToGen = [];
    const semaphore = new Semaphore(5);

    for (let x = -halfGrid; x <= halfGrid; x++) {
      for (let z = -halfGrid; z <= halfGrid; z++) {
        const chunkPosX = playerChunkPos.x + x;
        const chunkPosZ = playerChunkPos.z + z;
        const chunkKey = `${chunkPosX}_${chunkPosZ}`;
        if (!this.chunkStates[chunkKey]?.isVisible) {
          chunksToGen.push({ chunkPosX, chunkPosZ, distSq: x * x + z * z });
        }
      }
    }

    chunksToGen.sort((a, b) => a.distSq - b.distSq);
    await Promise.all(chunksToGen.map(async (cd) => {
      await semaphore.acquire();
      try {
        await this.createChunk(
          cd.chunkPosX,
          cd.chunkPosZ,
          cd.chunkPosX - playerChunkPos.x,
          cd.chunkPosZ - playerChunkPos.z
        );
      } finally {
        semaphore.release();
      }
    }));
  }

  updateChunks() {
    if (!this.isInit) return;
    const newChunkInfo = this.getChunkInfo(this.player.position).position;
    const halfGrid = Math.floor(this.gridSize / 2);

    if (!this.currentChunkPos || newChunkInfo.x !== this.currentChunkPos.x || newChunkInfo.z !== this.currentChunkPos.z) {
      const minX = newChunkInfo.x - halfGrid;
      const maxX = newChunkInfo.x + halfGrid;
      const minZ = newChunkInfo.z - halfGrid;
      const maxZ = newChunkInfo.z + halfGrid;

      Object.keys(this.chunkStates).forEach(chunkKey => {
        const [chunkX, chunkZ] = chunkKey.split('_').map(Number);
        if (chunkX < minX || chunkX > maxX || chunkZ < minZ || chunkZ > maxZ) {
          this.hideChunk(chunkX, chunkZ);
        }
      });

      this.generateChunksAroundPlayer();
      this.currentChunkPos = newChunkInfo;
    }
  }

  // Utilitaire pour obtenir la clé du chunk où est le joueur
  getPlayerChunkKey() {
    const pos = this.player.position;
    const info = this.getChunkInfo(pos);
    const state = this.chunkStates[info.key];
    return state?.dataLoaded ? info.key : null;
  }
}

class Semaphore {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.currentCount = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.currentCount < this.maxConcurrency) {
      this.currentCount++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.currentCount--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this.currentCount++;
      next();
    }
  }
}