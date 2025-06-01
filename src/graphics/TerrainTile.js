// src/core/TerrainTile.js
import * as THREE from 'three';

export default class TerrainTile {
  constructor(chunkX, chunkY, chunkSize, heightmap, satelliteTexture) {
    if (!heightmap || heightmap.length === 0) throw new Error('Heightmap data invalide ou vide');

    this.chunkX = chunkX;
    this.chunkY = chunkY;
    this.chunkSize = chunkSize;
    this.heightmap = heightmap;
    this.satelliteTexture = satelliteTexture;
    this.mesh = this.createMesh();
  }

  createMesh() {
    const gridSize = Math.sqrt(this.heightmap.length);
    const segmentSize = this.chunkSize / (gridSize - 1);

    const geometry = new THREE.PlaneGeometry(this.chunkSize, this.chunkSize, gridSize - 1, gridSize - 1);
    // Place le mesh "debout" (XZ plane)
    geometry.rotateX(-Math.PI / 2);

    // Set les hauteurs depuis la heightmap
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.heightmap[i]);
    }
    geometry.computeVertexNormals();

    // Matériau
    const material = new THREE.MeshStandardMaterial({
      map: this.satelliteTexture || null,
      flatShading: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(this.chunkX * this.chunkSize, 0, this.chunkY * this.chunkSize);

    return mesh;
  }

  getMesh() {
    return this.mesh;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.satelliteTexture) this.satelliteTexture.dispose();
  }
}