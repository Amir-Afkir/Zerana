import * as THREE from 'three';
import {
  CHUNK_SIZE,
} from '../utils/constants.js';

/**
 * Génère un mesh de terrain à partir d'une heightmap (float32array 512x512 ou 64x64 interpolé)
 * Correction : sampling avec Math.floor pour garantir l'alignement parfait des bords
 */
export function generateMeshFromHeightmap(chunk, neighbors = {}, material = null) {
  const originalGridSize = 64;  // Grid d'origine
  const enlargedGridSize = 512; // Grid interpolée
  const heightmap = chunk.heightmap;

  const chunkSize = CHUNK_SIZE ;

  const geometry = new THREE.PlaneGeometry(
    chunkSize,
    chunkSize,
    originalGridSize - 1,
    originalGridSize - 1
  );
  // Génération des UVs personnalisés
  const uv = [];
  for (let row = 0; row < originalGridSize; row++) {
    for (let col = 0; col < originalGridSize; col++) {
      uv.push(col / (originalGridSize - 1));
      uv.push(row / (originalGridSize - 1));
    }
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.rotateX(-Math.PI / 2); // Y = up

  const pos = geometry.attributes.position;
  const scale = (enlargedGridSize - 1) / (originalGridSize - 1);

  for (let row = 0; row < originalGridSize; row++) {
    for (let col = 0; col < originalGridSize; col++) {
      const vertexIdx = row * originalGridSize + col;
      // Correction : sampling avec Math.floor pour garantir l'alignement des bords
      const enlargedRow = Math.floor(row * scale);
      const enlargedCol = Math.floor(col * scale);
      const idx = enlargedRow * enlargedGridSize + enlargedCol;
      pos.setY(vertexIdx, heightmap[idx]);
    }
  }
  geometry.computeVertexNormals();

  let mat;
  if (chunk.satelliteTexture) {
    const texture = new THREE.Texture(chunk.satelliteTexture);
    texture.needsUpdate = true;
    mat = new THREE.MeshStandardMaterial({
      map: texture,
      flatShading: false,
    });
  } else if (material) {
    mat = material;
  } else {
    mat = new THREE.MeshStandardMaterial({ color: 0x8DB255, flatShading: true });
  }

  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(chunk.x * chunkSize, 0, chunk.z * chunkSize);
  mesh.name = `terrain_${chunk.x}_${chunk.z}`;

  if (chunk.group) chunk.group.add(mesh);
  chunk.mesh = mesh;

  return mesh;
}