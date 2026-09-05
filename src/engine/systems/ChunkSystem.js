import * as THREE from 'three';
import Semaphore from '../utils/Semaphore.js';
import { calcScaleFactor } from '../utils/GeoUtils.js';

function scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => fn(), { timeout: 250 });
    return;
  }
  setTimeout(fn, 0);
}

function getHeightmapTargetSize(distSq) {
  // Big win: lower res heightmaps for far chunks (memory + worker time).
  if (distSq <= 1) return 512;
  if (distSq <= 4) return 256;
  return 128;
}

function getSatelliteMaxSize(distSq) {
  // Texture downscale happens in the worker (no network win, big VRAM win).
  if (distSq <= 1) return null; // keep original size
  if (distSq <= 4) return 256;
  return 128;
}

export default class ChunkSystem {
  constructor({
    mapbox,
    overpass,
    scene,
    player,
    gridSize,
    chunkSize,
    terrainBuilder,
    buildingRenderer,
    treeRenderer,
    maxConcurrentTerrain = 5,
    maxConcurrentDetails = 2,
    buildingsRadius = 2,
    treesRadius = 1,
    overpassRadius = 1,
    disposeOnHide = true
  }) {
    this.mapbox = mapbox;
    this.overpass = overpass;
    this.scene = scene;
    this.player = player;
    this.gridSize = gridSize;
    this.chunkSize = chunkSize;
    this.terrainBuilder = terrainBuilder;
    this.buildingRenderer = buildingRenderer;
    this.treeRenderer = treeRenderer;

    this.maxRecyclage = (this.gridSize + 2) ** 2;
    this.chunkStates = {};
    this.currentChunkPos = this.getChunkInfo(this.player.position).position;
    this.terrainSemaphore = new Semaphore(maxConcurrentTerrain);
    this.detailsSemaphore = new Semaphore(maxConcurrentDetails);
    this.buildingsRadiusSq = buildingsRadius * buildingsRadius;
    this.treesRadiusSq = treesRadius * treesRadius;
    this.overpassRadiusSq = overpassRadius * overpassRadius;
    this.disposeOnHide = disposeOnHide;
    this.isInit = false;
  }

  async initFromCoords(lon, lat) {
    const centralTile = this.mapbox.latLonToTile(lon, lat);
    this.globalTileX = centralTile.x;
    this.globalTileY = centralTile.y;

    const playerChunkPos = this.getChunkInfo(this.player.position).position;
    this.startPlayerChunkX = playerChunkPos.x;
    this.startPlayerChunkZ = playerChunkPos.z;

    this.isInit = true;
    // Fast time-to-first-pixel: load the center chunk first, then stream the ring.
    await this.createChunk(playerChunkPos.x, playerChunkPos.z, 0, 0, 0);
    this.generateChunksAroundPlayer();
  }

  getChunkInfo(position) {
    const chunkX = Math.floor((position.x + this.chunkSize / 2) / this.chunkSize);
    const chunkZ = Math.floor((position.z + this.chunkSize / 2) / this.chunkSize);
    const key = `${chunkX}_${chunkZ}`;
    return { position: { x: chunkX, z: chunkZ }, key };
  }

  getChunkNeighbors(chunkX, chunkZ) {
    const directions = [
      { name: 'top', dx: 0, dz: 1 },
      { name: 'bottom', dx: 0, dz: -1 },
      { name: 'left', dx: -1, dz: 0 },
      { name: 'right', dx: 1, dz: 0 }
    ];

    const neighbors = {};
    directions.forEach(({ name, dx, dz }) => {
      const key = `${chunkX + dx}_${chunkZ + dz}`;
      const state = this.chunkStates[key];
      neighbors[name] = state?.terrainLoaded ? state.entity.heightmap : null;
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
      group,
      heightmap: null,
      satelliteBitmap: null,
      buildings: null,
      trees: null
    };

    this.chunkStates[chunkKey] = {
      entity: chunk,
      isVisible: true,
      isRecycled: false,
      terrainLoaded: false,
      detailsLoaded: false,
      terrainAbort: null,
      detailsAbort: null,
      terrainPromise: null,
      detailsPromise: null,
      detailsLod: null,
      lastTouched: Date.now()
    };

    return chunk;
  }

  reactivateChunk(state) {
    state.entity.group.visible = true;
    state.isVisible = true;
    state.isRecycled = false;
  }

  hideChunk(chunkX, chunkZ) {
    const key = this.getChunkInfo({ x: chunkX * this.chunkSize, z: chunkZ * this.chunkSize }).key;
    const state = this.chunkStates[key];
    if (!state) return;

    state.isRecycled = true;
    state.isVisible = false;
    state.entity.group.visible = false;
    if (state.terrainAbort) state.terrainAbort.abort();
    if (state.detailsAbort) state.detailsAbort.abort();

    if (this.disposeOnHide) {
      // Keep the state entry (so we can reactivate the same key),
      // but aggressively free GPU/CPU memory on mobile.
      this.terrainBuilder.disposeChunk(state.entity);
      this.buildingRenderer.disposeChunk(state.entity);
      this.treeRenderer.disposeChunk(state.entity);
      state.entity.heightmap = null;
      state.entity.satelliteBitmap = null;
      state.entity.buildings = null;
      state.entity.trees = null;
      state.terrainLoaded = false;
      state.detailsLoaded = false;
    }

    const recycled = Object.keys(this.chunkStates).filter((k) => this.chunkStates[k].isRecycled);
    if (recycled.length > this.maxRecyclage) {
      // Delete least-recently-touched to keep memory stable while moving.
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const k of recycled) {
        const t = this.chunkStates[k]?.lastTouched ?? 0;
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = k;
        }
      }
      if (oldestKey) this.deleteChunkByKey(oldestKey);
    }
  }

  deleteChunkByKey(key) {
    const state = this.chunkStates[key];
    if (!state) return;
    if (state.terrainAbort) state.terrainAbort.abort();
    if (state.detailsAbort) state.detailsAbort.abort();

    this.terrainBuilder.disposeChunk(state.entity);
    this.buildingRenderer.disposeChunk(state.entity);
    this.treeRenderer.disposeChunk(state.entity);

    this.scene.remove(state.entity.group);
    delete this.chunkStates[key];
  }

  async createChunk(chunkX, chunkZ, offsetX, offsetZ, distSq = 0) {
    const key = `${chunkX}_${chunkZ}`;
    let state = this.chunkStates[key];
    let chunk;

    if (state) {
      if (state.isRecycled) this.reactivateChunk(state);
      chunk = state.entity;
    } else {
      chunk = this.createNewChunk(chunkX, chunkZ, key);
      state = this.chunkStates[key];
    }

    state.lastTouched = Date.now();
    chunk.distSq = distSq;

    const playerChunk = this.getChunkInfo(this.player.position).position;
    const tileX = this.globalTileX + (playerChunk.x - this.startPlayerChunkX) + offsetX;
    const tileY = this.globalTileY + (playerChunk.z - this.startPlayerChunkZ) + offsetZ;
    const { lat } = this.mapbox.tileToLatLon(tileX + 0.5, tileY + 0.5);
    const scaleFactor = calcScaleFactor(lat, this.mapbox.zoom, this.chunkSize) || 1;
    chunk.scaleFactor = scaleFactor;
    chunk.unitsPerMeter = 1 / scaleFactor;

    // Terrain phase (heightmap + satellite), with LOD based on distance to player.
    const desiredHeightSize = getHeightmapTargetSize(distSq);
    const desiredSatMax = getSatelliteMaxSize(distSq);

    const shouldReloadTerrain =
      !state.terrainLoaded ||
      !chunk.heightmap ||
      desiredHeightSize > (state.heightmapSize || 0) ||
      (desiredSatMax === null && state.satMaxSize !== null);

    if (shouldReloadTerrain) {
      if (!state.terrainPromise) {
        state.heightmapSize = desiredHeightSize;
        state.satMaxSize = desiredSatMax;
        state.terrainPromise = this.loadTerrain(state, chunk, tileX, tileY, lat, {
          heightTargetSize: desiredHeightSize,
          satelliteMaxSize: desiredSatMax
        }).finally(() => {
          state.terrainPromise = null;
        });
      }
      await state.terrainPromise;
    }

    // Details phase (buildings/trees). Fire-and-forget, but cancellation-safe.
    const shouldHaveBuildings = distSq <= this.buildingsRadiusSq;
    const shouldHaveTrees = distSq <= this.treesRadiusSq;

    if ((!shouldHaveBuildings && !shouldHaveTrees) && state.detailsLoaded) {
      this.buildingRenderer.disposeChunk(chunk);
      this.treeRenderer.disposeChunk(chunk);
      state.detailsLoaded = false;
      state.detailsLod = null;
      return;
    }

    if ((shouldHaveBuildings || shouldHaveTrees) && state.terrainLoaded) {
      const desiredLod =
        distSq <= this.buildingRenderer.lodNearSq
          ? 'near'
          : distSq <= this.buildingRenderer.lodMidSq
            ? 'mid'
            : 'far';

      if (state.detailsLoaded && state.detailsLod !== desiredLod) {
        this.buildingRenderer.disposeChunk(chunk);
        this.treeRenderer.disposeChunk(chunk);
        state.detailsLoaded = false;
      }

      if (!state.detailsLoaded && !state.detailsPromise) {
        state.detailsPromise = this.loadDetails(state, chunk, tileX, tileY, lat, distSq)
          .finally(() => {
            state.detailsPromise = null;
          });
      }
    }
  }

  async loadTerrain(state, chunk, tileX, tileY, latitudeForScale, { heightTargetSize, satelliteMaxSize }) {
    await this.terrainSemaphore.acquire();
    try {
      if (state.terrainAbort) state.terrainAbort.abort();
      state.terrainAbort = new AbortController();
      const signal = state.terrainAbort.signal;

      // Start both requests early, but build terrain as soon as heightmap lands.
      const heightPromise = this.mapbox.fetchHeightmapTile(
        tileX,
        tileY,
        latitudeForScale,
        signal,
        { targetSize: heightTargetSize }
      );
      const satPromise = this.mapbox.fetchSatelliteTile(
        tileX,
        tileY,
        signal,
        { maxSize: satelliteMaxSize }
      ).catch(() => null);

      const heightmap = await heightPromise;
      if (!heightmap || state.isRecycled || !state.isVisible) return;

      // Drop old visuals (in case we are upgrading LOD).
      this.terrainBuilder.disposeChunk(chunk);

      chunk.heightmap = heightmap;
      state.terrainLoaded = true;

      // Build immediately (satellite can arrive later).
      this.terrainBuilder.build(chunk);

      satPromise
        .then((sat) => {
          if (!sat || state.isRecycled || !state.isVisible) return;
          chunk.satelliteBitmap = sat;
          scheduleIdle(() => {
            if (!chunk.terrainMesh || state.isRecycled || !state.isVisible) return;
            const oldMat = chunk.terrainMesh.material;
            if (chunk.satelliteTexture) {
              chunk.satelliteTexture.dispose?.();
              chunk.satelliteTexture = null;
            }
            chunk.terrainMesh.material = this.terrainBuilder.createMaterial(chunk);
            oldMat?.dispose?.();
          });
        })
        .catch(() => {});
    } catch {
      state.terrainLoaded = false;
    } finally {
      this.terrainSemaphore.release();
    }
  }

  async loadDetails(state, chunk, tileX, tileY, latitudeForScale, distSq) {
    await this.detailsSemaphore.acquire();
    try {
      if (state.detailsAbort) state.detailsAbort.abort();
      state.detailsAbort = new AbortController();
      const signal = state.detailsAbort.signal;

      const wantBuildings = distSq <= this.buildingsRadiusSq;
      const wantTrees = distSq <= this.treesRadiusSq;
      const wantOverpass = distSq <= this.overpassRadiusSq;
      const lod =
        distSq <= this.buildingRenderer.lodNearSq
          ? 'near'
          : distSq <= this.buildingRenderer.lodMidSq
            ? 'mid'
            : 'far';

      const [buildings, trees] = await Promise.all([
        wantBuildings ? this.mapbox.fetchBuildingsTile(tileX, tileY, latitudeForScale, signal) : Promise.resolve([]),
        wantTrees
          ? (wantOverpass ? this.overpass.fetchTrees(tileX, tileY, this.mapbox.zoom, signal) : Promise.resolve([]))
          : Promise.resolve([])
      ]);

      if (state.isRecycled || !state.isVisible) return;

      chunk.buildings = buildings;
      chunk.trees = trees;
      state.detailsLoaded = true;
      state.detailsLod = lod;

      // Build on idle to avoid long main-thread frames.
      scheduleIdle(() => {
        if (state.isRecycled || !state.isVisible) return;
        const neighbors = this.getChunkNeighbors(chunk.x, chunk.z);
        this.buildingRenderer.disposeChunk(chunk);
        this.treeRenderer.disposeChunk(chunk);
        if (wantBuildings) this.buildingRenderer.build(chunk, neighbors);
        if (wantTrees) this.treeRenderer.build(chunk, neighbors);
      });
    } catch {
      state.detailsLoaded = false;
    } finally {
      this.detailsSemaphore.release();
    }
  }

  async generateChunksAroundPlayer() {
    const halfGrid = Math.floor(this.gridSize / 2);
    const playerChunk = this.getChunkInfo(this.player.position).position;
    const chunksToGenerate = [];

    for (let x = -halfGrid; x <= halfGrid; x++) {
      for (let z = -halfGrid; z <= halfGrid; z++) {
        const cx = playerChunk.x + x;
        const cz = playerChunk.z + z;
        chunksToGenerate.push({
          cx,
          cz,
          offsetX: x,
          offsetZ: z,
          distSq: x * x + z * z
        });
      }
    }

    chunksToGenerate.sort((a, b) => a.distSq - b.distSq);

    await Promise.all(
      chunksToGenerate.map(({ cx, cz, offsetX, offsetZ, distSq }) =>
        this.createChunk(cx, cz, offsetX, offsetZ, distSq)
      )
    );
  }

  updateChunks() {
    if (!this.isInit) return;
    const info = this.getChunkInfo(this.player.position).position;
    const half = Math.floor(this.gridSize / 2);

    if (info.x !== this.currentChunkPos.x || info.z !== this.currentChunkPos.z) {
      const minX = info.x - half;
      const maxX = info.x + half;
      const minZ = info.z - half;
      const maxZ = info.z + half;

      Object.keys(this.chunkStates).forEach((key) => {
        const [x, z] = key.split('_').map(Number);
        if (x < minX || x > maxX || z < minZ || z > maxZ) this.hideChunk(x, z);
      });

      this.generateChunksAroundPlayer();
      this.currentChunkPos = info;
    }
  }

  getHeightAt(position) {
    const { key, position: chunkPos } = this.getChunkInfo(position);
    const state = this.chunkStates[key];
    if (!state?.terrainLoaded || !state.entity?.heightmap) return NaN;

    const heightmap = state.entity.heightmap;
    const gridSize = Math.sqrt(heightmap.length) | 0;
    const subdivisions = gridSize - 1;
    const localX = position.x - chunkPos.x * this.chunkSize;
    const localZ = position.z - chunkPos.z * this.chunkSize;
    const normX = Math.min(Math.max(((localX / this.chunkSize + 0.5) * subdivisions) | 0, 0), subdivisions);
    const normZ = Math.min(Math.max(((localZ / this.chunkSize + 0.5) * subdivisions) | 0, 0), subdivisions);
    return heightmap[normZ * gridSize + normX];
  }

  dispose() {
    Object.keys(this.chunkStates).forEach((key) => this.deleteChunkByKey(key));
  }

  reset() {
    this.dispose();
    this.chunkStates = {};
    this.currentChunkPos = this.getChunkInfo(this.player.position).position;
    this.isInit = false;
  }
}
