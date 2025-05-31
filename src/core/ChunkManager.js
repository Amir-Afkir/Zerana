// Gestion dynamique des chunks (load/unload)
import * as THREE from 'three';

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
    const chunk = new THREE.Group();
    chunk.position.set(chunkX * this.chunkSize, 0, chunkZ * this.chunkSize);

    const geometry = new THREE.BoxGeometry(this.chunkSize, 5, this.chunkSize);
    const material = new THREE.MeshStandardMaterial({ color: 0x88cc88, wireframe: true });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 2.5;

    chunk.add(mesh);
    this.scene.add(chunk);

    this.chunks.set(`${chunkX}_${chunkZ}`, chunk);
  }

  disposeChunk(chunkKey) {
    const chunk = this.chunks.get(chunkKey);
    if (!chunk) return;

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

    // Charger les chunks dans la zone définie
    for (let x = playerChunkX - this.gridRadius; x <= playerChunkX + this.gridRadius; x++) {
      for (let z = playerChunkZ - this.gridRadius; z <= playerChunkZ + this.gridRadius; z++) {
        const key = `${x}_${z}`;
        neededChunks.add(key);
        if (!this.chunks.has(key)) {
          this.createChunk(x, z);
        }
      }
    }

    // Décharger les chunks hors zone
    for (const key of this.chunks.keys()) {
      if (!neededChunks.has(key)) {
        this.disposeChunk(key);
      }
    }
  }
}