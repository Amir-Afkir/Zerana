import * as THREE from 'three';
import { createHeightSampler } from '../engine/utils/HeightSampler.js';

function hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed % 2147483647;
  if (value <= 0) value += 2147483646;
  return () => (value = (value * 16807) % 2147483647) / 2147483647;
}

export default class TreeRenderer {
  constructor({ chunkSize, maxTrees = 300 }) {
    this.chunkSize = chunkSize;
    this.maxTrees = maxTrees;
    // Unit geometry: scaled per-instance (in world units) for perf + correctness.
    this.geometry = new THREE.ConeGeometry(0.5, 1, 6);
    this.geometry.translate(0, 0.5, 0); // base sits at y=0
    this.material = new THREE.MeshLambertMaterial({ color: 0x2f7d32 });
  }

  build(chunk, neighborMaps = {}) {
    const trees = chunk.trees;
    if (!Array.isArray(trees) || trees.length === 0) return;
    if (!chunk.heightmap) return;

    const sampler = createHeightSampler(chunk.heightmap, this.chunkSize, neighborMaps);
    const unitsPerMeter = Number.isFinite(chunk.unitsPerMeter) ? chunk.unitsPerMeter : 1;
    const count = Math.min(trees.length, this.maxTrees);
    const instanced = new THREE.InstancedMesh(this.geometry, this.material, count);
    instanced.name = `trees_${chunk.x}_${chunk.z}`;
    instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      const tree = trees[i];
      const seed = hashString(tree.id || `${i}`);
      const rand = seededRandom(seed);
      const height = sampler.sampleLocal(tree.position.x, tree.position.z);

      position.set(tree.position.x, height, tree.position.z);
      rotation.setFromEuler(new THREE.Euler(0, rand() * Math.PI * 2, 0));

      // Physical-ish sizing (meters -> world units).
      const heightMeters = 6 + rand() * 10; // 6..16m
      const radiusMeters = 1.2 + rand() * 1.6; // 1.2..2.8m
      const heightUnits = heightMeters * unitsPerMeter;
      const radiusUnits = radiusMeters * unitsPerMeter;

      // Geometry is (radius=0.5, height=1). Convert to desired world units.
      const sx = radiusUnits / 0.5;
      const sy = heightUnits;
      scale.set(sx, sy, sx);

      matrix.compose(position, rotation, scale);
      instanced.setMatrixAt(i, matrix);
    }

    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    chunk.group.add(instanced);
    chunk.treeMesh = instanced;
  }

  disposeChunk(chunk) {
    if (chunk.treeMesh) chunk.treeMesh.removeFromParent();
    chunk.treeMesh = null;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
