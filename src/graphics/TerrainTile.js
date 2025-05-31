// Terrain 3D (heightmap RGB + satellite)
import * as THREE from 'three';

export default class TerrainTile {
  constructor(chunkX, chunkZ, chunkSize, heightmapData, satelliteTexture) {
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
    this.chunkSize = chunkSize;
    this.heightmapData = heightmapData; // Float32Array ou tableau des hauteurs
    this.satelliteTexture = satelliteTexture; // THREE.Texture

    this.mesh = null;
    this.geometry = null;
    this.material = null;

    this.initMesh();
  }

  initMesh() {
    const gridSize = Math.sqrt(this.heightmapData.length);
    const verticesCount = gridSize * gridSize;
    const segmentSize = this.chunkSize / (gridSize - 1);

    // Positions, normals et UVs
    const positions = new Float32Array(verticesCount * 3);
    const normals = new Float32Array(verticesCount * 3);
    const uvs = new Float32Array(verticesCount * 2);

    // Générer la grille de sommets
    let posIndex = 0, uvIndex = 0;
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        positions[posIndex] = x * segmentSize;
        positions[posIndex + 1] = this.heightmapData[z * gridSize + x];
        positions[posIndex + 2] = z * segmentSize;

        normals[posIndex] = 0;
        normals[posIndex + 1] = 1;
        normals[posIndex + 2] = 0;

        uvs[uvIndex] = x / (gridSize - 1);
        uvs[uvIndex + 1] = 1 - z / (gridSize - 1);

        posIndex += 3;
        uvIndex += 2;
      }
    }

    // Indices triangles
    const indices = [];
    for (let z = 0; z < gridSize - 1; z++) {
      for (let x = 0; x < gridSize - 1; x++) {
        const topLeft = z * gridSize + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * gridSize + x;
        const bottomRight = bottomLeft + 1;

        indices.push(topLeft, bottomLeft, topRight);
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }

    // Créer la géométrie
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);
    this.geometry.computeVertexNormals();

    // Matériau avec texture satellite si disponible
    this.material = new THREE.MeshStandardMaterial({
      map: this.satelliteTexture || null,
      flatShading: false,
    });

    // Mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);

    // Positionner le mesh dans la scène
    this.mesh.position.set(this.chunkX * this.chunkSize, 0, this.chunkZ * this.chunkSize);
  }

  getMesh() {
    return this.mesh;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    if (this.satelliteTexture) {
      this.satelliteTexture.dispose();
    }
  }
}