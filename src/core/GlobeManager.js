import * as THREE from 'three';
import { CHUNK_SIZE, GRID_SIZE } from '../utils/constants.js';
import { generateMeshFromHeightmap } from './Modelisation.js';

export default class GlobeManager {
  constructor({ mapbox, scene, player, gridSize = GRID_SIZE, chunkSize = CHUNK_SIZE, material = null }) {
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

  getChunkInfo({ x, z }) {
    const chunkX = Math.floor(x / this.chunkSize);
    const chunkZ = Math.floor(z / this.chunkSize);
    const key = `${chunkX}_${chunkZ}`;
    return { position: { x: chunkX, z: chunkZ }, key };
  }

  async fetchChunkData(chunkKey, chunkState, chunk, offsetX, offsetZ) {
    const playerChunk = this.getChunkInfo(this.player.position).position;
    const globalTileX = this.globalTileX + (playerChunk.x - this.startPlayerChunkX) + offsetX + 0.5;
    const globalTileY = this.globalTileY + (playerChunk.z - this.startPlayerChunkZ) + offsetZ + 0.5;
    const { lon, lat } = this.mapbox.tileToLatLon(globalTileX, globalTileY, this.mapbox.zoom);

    try {
      const [heightmap, satellite] = await Promise.all([
        this.mapbox.fetchHeightmap(lon, lat),
        this.mapbox.fetchSatelliteTexture(lon, lat)
      ]);
      chunk.heightmap = heightmap;
      chunk.satelliteTexture = satellite;
      chunkState.dataLoaded = !!(heightmap && satellite);
    } catch {
      chunkState.dataLoaded = false;
    }
  }

  getChunkNeighbors(chunkX, chunkZ) {
    const dirs = [
      { name: 'top', dx: 0, dz: 1 },
      { name: 'bottom', dx: 0, dz: -1 },
      { name: 'left', dx: -1, dz: 0 },
      { name: 'right', dx: 1, dz: 0 }
    ];
    return Object.fromEntries(
      dirs.map(({ name, dx, dz }) => {
        const key = `${chunkX + dx}_${chunkZ + dz}`;
        const state = this.chunkStates[key];
        return [name, state && state.dataLoaded ? state : null];
      })
    );
  }

  createNewChunk(chunkX, chunkZ, chunkKey) {
    const group = new THREE.Group();
    group.position.set(chunkX * this.chunkSize, 0, chunkZ * this.chunkSize);
    group.name = `chunk_${chunkX}_${chunkZ}`;
    this.scene.add(group);

    const chunk = { x: chunkX, z: chunkZ, mesh: null, satelliteTexture: null, heightmap: null, group };
    this.chunkStates[chunkKey] = { entity: chunk, isVisible: true, isRecycled: false, dataLoaded: false };
    return chunk;
  }

  async createChunk(chunkX, chunkZ, offsetX, offsetZ) {
    const key = `${chunkX}_${chunkZ}`;
    let state = this.chunkStates[key], chunk;

    if (state) {
      if (state.isRecycled) this.reactivateChunk(state);
      if (state.dataLoaded) return;
      chunk = state.entity;
    } else {
      chunk = this.createNewChunk(chunkX, chunkZ, key);
      state = this.chunkStates[key];
    }

    const neighbors = this.getChunkNeighbors(chunkX, chunkZ);

    try {
      await this.fetchChunkData(key, state, chunk, offsetX, offsetZ);
      if (state.dataLoaded && chunk.heightmap) {
        generateMeshFromHeightmap(chunk, neighbors, this.material);
      }
    } catch {}
  }

  reactivateChunk(state) {
    if (state.entity.group) state.entity.group.visible = true;
    state.isVisible = true;
    state.isRecycled = false;
  }

  hideChunk(chunkX, chunkZ) {
    const key = this.getChunkInfo({ x: chunkX * this.chunkSize, z: chunkZ * this.chunkSize }).key;
    const state = this.chunkStates[key];
    if (!state) return;
    if (state.entity.group) state.entity.group.visible = false;
    state.isRecycled = true;
    state.isVisible = false;

    // Clean up if too many
    const recycled = Object.keys(this.chunkStates).filter(k => this.chunkStates[k].isRecycled);
    if (recycled.length > this.maxRecyclage) this.deleteChunkByKey(recycled[0]);
  }

  deleteChunkByKey(key) {
    const state = this.chunkStates[key];
    if (!state) return;
    const chunk = state.entity;
    if (chunk.satelliteTexture?.dispose) chunk.satelliteTexture.dispose();
    if (chunk.mesh?.geometry) chunk.mesh.geometry.dispose();
    if (chunk.mesh?.material) chunk.mesh.material.dispose();
    this.scene.remove(chunk.group);
    delete this.chunkStates[key];
  }

  async generateChunksAroundPlayer() {
    const halfGrid = Math.floor(this.gridSize / 2);
    const playerChunk = this.getChunkInfo(this.player.position).position;
    const semaphore = new Semaphore(5);

    const chunksToGen = [];
    for (let x = -halfGrid; x <= halfGrid; x++)
      for (let z = -halfGrid; z <= halfGrid; z++) {
        const cx = playerChunk.x + x, cz = playerChunk.z + z, key = `${cx}_${cz}`;
        if (!this.chunkStates[key]?.isVisible) chunksToGen.push({ cx, cz, distSq: x * x + z * z });
      }

    chunksToGen.sort((a, b) => a.distSq - b.distSq);
    await Promise.all(chunksToGen.map(async ({ cx, cz }) => {
      await semaphore.acquire();
      try { await this.createChunk(cx, cz, cx - playerChunk.x, cz - playerChunk.z); }
      finally { semaphore.release(); }
    }));
  }

  updateChunks() {
    if (!this.isInit) return;
    const info = this.getChunkInfo(this.player.position).position;
    const half = Math.floor(this.gridSize / 2);

    if (!this.currentChunkPos || info.x !== this.currentChunkPos.x || info.z !== this.currentChunkPos.z) {
      const [minX, maxX] = [info.x - half, info.x + half];
      const [minZ, maxZ] = [info.z - half, info.z + half];

      Object.keys(this.chunkStates).forEach(k => {
        const [x, z] = k.split('_').map(Number);
        if (x < minX || x > maxX || z < minZ || z > maxZ) this.hideChunk(x, z);
      });

      this.generateChunksAroundPlayer();
      this.currentChunkPos = info;
    }
  }

  getPlayerChunkKey() {
    const info = this.getChunkInfo(this.player.position);
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
    if (this.currentCount < this.maxConcurrency) { this.currentCount++; return; }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.currentCount--;
    if (this.queue.length) { const next = this.queue.shift(); this.currentCount++; next(); }
  }
}