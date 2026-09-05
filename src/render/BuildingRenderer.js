import * as THREE from 'three';
import earcut from 'earcut';
import { createHeightSampler } from '../engine/utils/HeightSampler.js';
import { ringArea } from '../engine/utils/BuildingRings.js';

const BUILDING_CATEGORIES = [
  { types: ['apartments', 'house', 'detached', 'residential', 'dormitory', 'terrace', 'bungalow', 'cabin', 'houseboat', 'farm'], color: 0xf5deb2 },
  { types: ['commercial', 'office', 'retail', 'supermarket', 'kiosk', 'market', 'mall'], color: 0x0072bf },
  { types: ['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'storage_tank', 'depot'], color: 0x808080 },
  { types: ['religious', 'cathedral', 'temple', 'chapel', 'church', 'mosque', 'synagogue', 'shrine'], color: 0x9400d4 },
  { types: ['school', 'university', 'college', 'kindergarten', 'library'], color: 0x2e8c57 },
  { types: ['hospital', 'clinic', 'dentist', 'doctors', 'pharmacy'], color: 0xcc0000 },
  { types: ['government', 'courthouse', 'townhall', 'public', 'civic', 'fire_station', 'police', 'post_office'], color: 0x000080 },
  { types: ['transportation', 'train_station', 'bus_station', 'airport_terminal', 'ferry_terminal', 'parking', 'garage', 'carport'], color: 0xff8c00 },
  { types: ['stadium', 'sports_hall', 'gym', 'swimming_pool', 'theatre', 'cinema', 'clubhouse', 'community_centre', 'grandstand', 'pavilion'], color: 0x00bfbf },
  { types: ['barn', 'farm_auxiliary', 'stable', 'greenhouse'], color: 0x8a4512 },
  { types: ['museum', 'gallery', 'attraction', 'zoo', 'aquarium', 'ruins'], color: 0xffbfcc },
  { types: ['shed', 'boathouse', 'storage', 'roof', 'construction', 'bunker', 'hut', 'garbage_shed', 'transformer_tower', 'water_tower', 'conservatory', 'bridge', 'service'], color: 0x666666 },
  { types: ['building', 'yes', 'unclassified', 'garages'], color: 0x999999 }
];

export default class BuildingRenderer {
  constructor({
    chunkSize,
    maxBuildings = 600,
    minFootprint = 0.75,
    lodNearSq = 1,
    lodMidSq = 4,
    debug = false
  }) {
    this.chunkSize = chunkSize;
    this.maxBuildings = maxBuildings;
    this.minFootprint = minFootprint;
    this.lodNearSq = lodNearSq;
    this.lodMidSq = lodMidSq;
    this.debug = debug;

    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.boxGeometry.translate(0, 0.5, 0);
    this.boxMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.colorCache = new Map();
    this.materialCache = new Map();
    this.geometryCache = new Map();
  }

  build(chunk, neighborMaps = {}) {
    const buildings = chunk.buildings;
    if (!Array.isArray(buildings) || buildings.length === 0) return;
    if (!chunk.heightmap) return;

    const distSq = Number.isFinite(chunk.distSq) ? chunk.distSq : 0;
    const lod = distSq <= this.lodNearSq ? 'near' : distSq <= this.lodMidSq ? 'mid' : 'far';

    const sampler = createHeightSampler(chunk.heightmap, this.chunkSize, neighborMaps);

    const holesCount = buildings.reduce((acc, b) => acc + ((b?.holes?.length || 0) > 0 ? 1 : 0), 0);
    if (import.meta.env.DEV && this.debug) {
      console.debug(`[buildings] chunk ${chunk.x},${chunk.z} lod=${lod} holes=${holesCount}/${buildings.length}`);
    }
    const debugRings = import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      Boolean(window.__ZERANA_BUILDING_DEBUG_RINGS__);
    const debugWireframe = import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      Boolean(window.__ZERANA_BUILDING_WIREFRAME__);
    const debugDoubleSide = import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      Boolean(window.__ZERANA_BUILDING_DOUBLE_SIDE__);
    const debugHolesColor = import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      Boolean(window.__ZERANA_BUILDING_HOLES_COLOR__);
    if (debugWireframe) this.boxMaterial.wireframe = true;
    if (debugDoubleSide) this.boxMaterial.side = THREE.DoubleSide;

    if (lod === 'far') {
      this.buildInstancedBoxes(chunk, buildings, sampler);
      return;
    }

    const group = new THREE.Group();
    group.name = `buildings_${chunk.x}_${chunk.z}_${lod}`;

    let created = 0;
    for (let i = 0; i < buildings.length && created < this.maxBuildings; i++) {
      const building = buildings[i];
      if (!building?.extrude || building.underground) continue;
      const adjustedHeight = Math.max(0, (building.height || 0) - (building.minHeight || 0));
      if (adjustedHeight <= 0) continue;

      const outer = building.outer;
      if (!outer || outer.length < 3) continue;
      const holes = lod === 'near' ? (building.holes || []) : [];

      let material = this.getMaterialForType(building.type);
      if (debugHolesColor && building.hasHoles) {
        material = material.clone();
        material.color.setHex(0xff3b91);
      }
      if (debugWireframe) material.wireframe = true;
      if (debugDoubleSide) material.side = THREE.DoubleSide;
      const geom = this.getOrCreateGeometry(building, outer, holes, lod);
      if (!geom) continue;

      const cx = (building.bounds.minX + building.bounds.maxX) * 0.5;
      const cz = (building.bounds.minZ + building.bounds.maxZ) * 0.5;
      const ground = sampler.sampleLocal(cx, cz);
      const baseHeight = ground + (building.minHeight || 0) + 0.02;

      const mesh = new THREE.Mesh(geom, material);
      mesh.position.set(0, baseHeight, 0);
      mesh.scale.set(1, adjustedHeight, 1);
      mesh.renderOrder = building.layer || 0;

      group.add(mesh);
      created++;

      if (debugRings && building.hasHoles && lod === 'near') {
        this.addRingDebug(group, outer, holes);
      }
    }

    chunk.group.add(group);
    chunk.buildingGroup = group;
  }

  buildInstancedBoxes(chunk, buildings, sampler) {
    const count = Math.min(buildings.length, this.maxBuildings);
    const instanced = new THREE.InstancedMesh(this.boxGeometry, this.boxMaterial, count);
    instanced.name = `buildings_${chunk.x}_${chunk.z}_far`;
    instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();

    let written = 0;
    for (let i = 0; i < buildings.length && written < count; i++) {
      const building = buildings[i];
      if (!building?.extrude || building.underground) continue;

      const adjustedHeight = Math.max(0, (building.height || 0) - (building.minHeight || 0));
      if (adjustedHeight <= 0) continue;

      const b = building.bounds;
      if (!b) continue;

      const width = Math.max(this.minFootprint, (b.maxX - b.minX) || 0);
      const depth = Math.max(this.minFootprint, (b.maxZ - b.minZ) || 0);
      const cx = (b.minX + b.maxX) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;

      const ground = sampler.sampleLocal(cx, cz);
      const baseHeight = ground + (building.minHeight || 0);

      position.set(cx, baseHeight + 0.02, cz);
      rotation.identity();
      scale.set(width, adjustedHeight, depth);
      matrix.compose(position, rotation, scale);
      instanced.setMatrixAt(written, matrix);

      color.setHex(this.getColorForType(building.type));
      instanced.setColorAt(written, color);

      written++;
    }

    instanced.count = written;
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    instanced.computeBoundingSphere();

    chunk.group.add(instanced);
    chunk.buildingMesh = instanced;
  }

  getColorForType(type) {
    if (this.colorCache.has(type)) return this.colorCache.get(type);
    for (const category of BUILDING_CATEGORIES) {
      if (category.types.includes(type)) {
        this.colorCache.set(type, category.color);
        return category.color;
      }
    }
    this.colorCache.set(type, 0x999999);
    return 0x999999;
  }

  getMaterialForType(type) {
    if (this.materialCache.has(type)) return this.materialCache.get(type);
    const color = this.getColorForType(type);
    const material = new THREE.MeshLambertMaterial({ color });
    this.materialCache.set(type, material);
    return material;
  }

  normalizeRing(ring, clockwise) {
    if (!ring || ring.length < 3) return ring;
    let cleaned = ring;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first && last && first.x === last.x && first.y === last.y) {
      cleaned = ring.slice(0, -1);
    }
    if (cleaned.length < 3) return cleaned;
    const isClockwise = ringArea(cleaned) < 0;
    if (clockwise === isClockwise) return cleaned;
    return [...cleaned].reverse();
  }

  buildEarcutInput(outer, holes) {
    const vertices = [];
    const holeIndices = [];

    const outerRing = this.normalizeRing(outer, true);
    for (const p of outerRing) vertices.push(p.x, p.y);

    for (const hole of holes) {
      holeIndices.push(vertices.length / 2);
      const holeRing = this.normalizeRing(hole, false);
      for (const p of holeRing) vertices.push(p.x, p.y);
    }

    return { vertices, holes: holeIndices };
  }

  buildExtrudedGeometry(outer, holes) {
    const outerRing = this.normalizeRing(outer, true);
    const holeRings = holes.map((h) => this.normalizeRing(h, false)).filter((h) => h && h.length >= 3);
    const { vertices, holes: holeIndices } = this.buildEarcutInput(outerRing, holeRings);
    const tri = earcut(vertices, holeIndices);

    const positions = [];
    const normals = [];
    const indices = [];

    // Roof at y=1 (scale.y will set actual height)
    for (let i = 0; i < vertices.length; i += 2) {
      positions.push(vertices[i], 1, vertices[i + 1]);
      normals.push(0, 1, 0);
    }
    for (let i = 0; i < tri.length; i += 3) {
      // We project 2D (x,y) into 3D (x,z). In a right-handed X/Y/Z system,
      // triangles must be wound clockwise in XZ to face +Y (visible from above).
      // Earcut returns CCW triangles in 2D, so we flip them.
      indices.push(tri[i], tri[i + 2], tri[i + 1]);
    }

    const addWall = (ring, isHole) => {
      const isClockwise = ringArea(ring) < 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const base = positions.length / 3;

        positions.push(a.x, 0, a.y, a.x, 1, a.y, b.x, 1, b.y, b.x, 0, b.y);

        const dx = b.x - a.x;
        const dz = b.y - a.y;
        // For an edge A->B:
        // - right normal = (dz, -dx)
        // - left normal  = (-dz, dx)
        // CCW polygon interior is on the left; CW interior is on the right.
        // Outer walls must face the polygon exterior.
        // Hole walls must face the polygon interior (courtyard).
        const wantLeft = isHole ? !isClockwise : isClockwise;
        let nx = wantLeft ? -dz : dz;
        let nz = wantLeft ? dx : -dx;
        const len = Math.hypot(nx, nz) || 1;
        nx /= len;
        nz /= len;
        for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);

        if (wantLeft) {
          indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
        } else {
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    };

    addWall(outerRing, false);
    for (const hole of holeRings) addWall(hole, true);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  getOrCreateGeometry(building, outer, holes, lod) {
    const id = building.id;
    if (!id) return this.buildExtrudedGeometry(outer, holes);
    const key = `${id}_${lod}`;
    if (this.geometryCache.has(key)) return this.geometryCache.get(key);
    const geom = this.buildExtrudedGeometry(outer, holes);
    this.geometryCache.set(key, geom);
    return geom;
  }

  addRingDebug(group, outer, holes) {
    const makeLine = (ring, color) => {
      const points = ring.map((p) => new THREE.Vector3(p.x, 1.02, p.y));
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({ color });
      const line = new THREE.LineLoop(geom, mat);
      group.add(line);
    };
    makeLine(outer, 0x22ff22);
    holes.forEach((h) => makeLine(h, 0xff2222));
  }

  disposeChunk(chunk) {
    if (chunk.buildingMesh) {
      chunk.buildingMesh.removeFromParent();
      chunk.buildingMesh = null;
    }
    if (chunk.buildingGroup) {
      chunk.buildingGroup.traverse((child) => {
        if (child.isMesh) {
          // Geometry is cached globally; do not dispose here.
        } else if (child.isLine) {
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        }
      });
      chunk.buildingGroup.removeFromParent();
      chunk.buildingGroup = null;
    }
  }

  dispose() {
    this.boxGeometry.dispose();
    this.boxMaterial.dispose();
    this.materialCache.forEach((mat) => mat.dispose());
    this.geometryCache.forEach((geom) => geom.dispose());
  }
}
