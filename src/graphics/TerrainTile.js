import * as THREE from 'three';

export default class TerrainTile {
  constructor(chunkX, chunkZ, chunkSize, heightmapData, satelliteTexture) {
    if (!heightmapData || !heightmapData.length) {
      throw new Error('Heightmap data invalide ou vide');
    }
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

    // Création des buffers
    const positions = new Float32Array(verticesCount * 3);
    const normals = new Float32Array(verticesCount * 3); // initialisées à 0 par défaut
    const uvs = new Float32Array(verticesCount * 2);

    let posIndex = 0, uvIndex = 0;
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        positions[posIndex] = x * segmentSize;
        positions[posIndex + 1] = this.heightmapData[z * gridSize + x];
        positions[posIndex + 2] = z * segmentSize;

        // Normales initialisées à zéro, seront calculées après
        normals[posIndex] = 0;
        normals[posIndex + 1] = 0;
        normals[posIndex + 2] = 0;

        uvs[uvIndex] = x / (gridSize - 1);
        uvs[uvIndex + 1] = 1 - z / (gridSize - 1);

        posIndex += 3;
        uvIndex += 2;
      }
    }

    // Indices pour triangles (2 triangles par carré)
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

    // Création de la géométrie Three.js
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);
    this.geometry.computeVertexNormals(); // calcule les normales automatiquement

    // Création du matériau avec texture satellite si disponible
    this.material = new THREE.MeshStandardMaterial({
      map: this.satelliteTexture || null,
      flatShading: false,
    });

    // Création du mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);

    // Positionnement dans la scène (à ajuster selon besoin)
    this.mesh.position.set(this.chunkX * this.chunkSize, 0, this.chunkZ * this.chunkSize);
  }

  getMesh() {
    return this.mesh;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    // Attention : ne détruire la texture que si tu es sûr qu'elle n'est plus utilisée ailleurs
    if (this.satelliteTexture) {
      this.satelliteTexture.dispose();
    }
  }
}