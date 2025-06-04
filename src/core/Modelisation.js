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
  mesh.name = `terrain_${chunk.x}_${chunk.z}`;

  if (chunk.group) chunk.group.add(mesh);
  chunk.mesh = mesh;

  // === Génération et ajout d'une jupe (skirt) autour du chunk ===
  // Params de jupe
  const skirtDepth = CHUNK_SIZE * 0.6; // (ou 0.5, ou 0.7 selon le look)
  const skirtColor = 0xff0000; // Couleur flashy pour debug

  const skirtGeometry = new THREE.BufferGeometry();
  const skirtVertices = [];
  const skirtIndices = [];

  const width = originalGridSize;
  const height = originalGridSize;

  // Utilitaire pour récupérer la position d'un vertex sur le bord
  function getVertexPos(idx) {
    const x = pos.getX(idx);
    const y = pos.getY(idx);
    const z = pos.getZ(idx);
    return [x, y, z];
  }

  let skirtVertexIndex = 0;

  // Crée la jupe pour chaque bord du terrain
  const edgeLoops = [
    { name: 'top',    indices: Array.from({length: width}, (_, i) => i) },
    { name: 'right',  indices: Array.from({length: height}, (_, i) => (i+1)*width - 1) },
    { name: 'bottom', indices: Array.from({length: width}, (_, i) => width * (height - 1) + i).reverse() },
    { name: 'left',   indices: Array.from({length: height}, (_, i) => i*width).reverse() }
  ];

  edgeLoops.forEach(loop => {
    const loopStart = skirtVertexIndex;
    // Pour chaque point du bord, crée un vertex "skirt" (descendu sur Y)
    loop.indices.forEach(idx => {
      const [x, y, z] = getVertexPos(idx);
      // Vertex haut (bord du mesh)
      skirtVertices.push(x, y, z);
      // Vertex bas (jupe)
      skirtVertices.push(x, y - skirtDepth, z);
    });
    // Crée les faces entre le bord et la jupe
    for (let i = 0; i < loop.indices.length - 1; i++) {
      const topA = loopStart + i*2;
      const botA = loopStart + i*2 + 1;
      const topB = loopStart + (i+1)*2;
      const botB = loopStart + (i+1)*2 + 1;
      // Premier triangle
      skirtIndices.push(topA, botA, topB);
      // Deuxième triangle
      skirtIndices.push(topB, botA, botB);
    }
    skirtVertexIndex += loop.indices.length * 2;
  });

  skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtVertices, 3));
  skirtGeometry.setIndex(skirtIndices);
  skirtGeometry.computeVertexNormals();

  const skirtMaterial = new THREE.MeshStandardMaterial({
    color: 0x463c2b,          // Terre/roche sombre
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.65,
    flatShading: false,
    metalness: 0,
    roughness: 1,
    depthWrite: true,
  });

  const skirtMesh = new THREE.Mesh(skirtGeometry, skirtMaterial);
  skirtMesh.name = `skirt_${chunk.x}_${chunk.z}`;

  // Ajoute la jupe dans le même groupe que le mesh terrain
  if (chunk.group) chunk.group.add(skirtMesh);

  return mesh;
}