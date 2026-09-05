import * as THREE from 'three';

export default class TerrainBuilder {
  constructor({ chunkSize, gridSize = 64 }) {
    this.chunkSize = chunkSize;
    this.gridSize = gridSize;
  }

  build(chunk, materialOverride = null) {
    if (!chunk.heightmap) return null;

    const geometry = new THREE.PlaneGeometry(
      this.chunkSize,
      this.chunkSize,
      this.gridSize - 1,
      this.gridSize - 1
    );
    geometry.rotateX(-Math.PI / 2);

    const positions = geometry.attributes.position;
    const uvs = new Float32Array(positions.count * 2);
    const half = this.chunkSize / 2;
    const hmGrid = Math.sqrt(chunk.heightmap.length) | 0;
    const hmSize = Math.max(0, hmGrid - 1);

    // Assign height + UVs based on world-space position to guarantee orientation.
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      const u = (x + half) / this.chunkSize;
      const v = (z + half) / this.chunkSize;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;

      const hmX = Math.round(u * hmSize);
      const hmY = Math.round(v * hmSize);
      const idx = hmY * hmGrid + hmX;
      positions.setY(i, chunk.heightmap[idx] ?? 0);
    }

    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

    const material = materialOverride || this.createMaterial(chunk);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `terrain_${chunk.x}_${chunk.z}`;
    mesh.receiveShadow = true;

    const skirt = this.createSkirt(geometry);
    skirt.name = `skirt_${chunk.x}_${chunk.z}`;

    chunk.group.add(mesh);
    chunk.group.add(skirt);

    chunk.terrainMesh = mesh;
    chunk.skirtMesh = skirt;
    return mesh;
  }

  createMaterial(chunk) {
    if (chunk.satelliteBitmap) {
      const texture = new THREE.Texture(chunk.satelliteBitmap);
      texture.needsUpdate = true;
      // ImageBitmap tiles come in "top-left origin". With our rotated plane UVs,
      // keeping flipY=true mirrors tiles vertically and breaks seam alignment.
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      chunk.satelliteTexture = texture;
      // Satellite imagery already includes baked lighting; MeshBasicMaterial is cheaper on mobile.
      return new THREE.MeshBasicMaterial({ map: texture });
    }
    return new THREE.MeshBasicMaterial({ color: 0x8db255 });
  }

  createSkirt(terrainGeometry) {
    const skirtDepth = this.chunkSize * 0.6;

    const skirtGeometry = new THREE.BufferGeometry();
    const skirtVertices = [];
    const skirtIndices = [];
    const positions = terrainGeometry.attributes.position;

    const width = Math.round(Math.sqrt(positions.count));
    const height = width;

    const getVertexPos = (idx) => {
      return [positions.getX(idx), positions.getY(idx), positions.getZ(idx)];
    };

    let skirtVertexIndex = 0;
    const edgeLoops = [
      { indices: Array.from({ length: width }, (_, i) => i) },
      { indices: Array.from({ length: height }, (_, i) => (i + 1) * width - 1) },
      { indices: Array.from({ length: width }, (_, i) => width * (height - 1) + i).reverse() },
      { indices: Array.from({ length: height }, (_, i) => i * width).reverse() }
    ];

    edgeLoops.forEach((loop) => {
      const loopStart = skirtVertexIndex;
      loop.indices.forEach((idx) => {
        const [x, y, z] = getVertexPos(idx);
        skirtVertices.push(x, y, z);
        skirtVertices.push(x, y - skirtDepth, z);
      });

      for (let i = 0; i < loop.indices.length - 1; i++) {
        const topA = loopStart + i * 2;
        const botA = loopStart + i * 2 + 1;
        const topB = loopStart + (i + 1) * 2;
        const botB = loopStart + (i + 1) * 2 + 1;
        skirtIndices.push(topA, botA, topB);
        skirtIndices.push(topB, botA, botB);
      }

      skirtVertexIndex += loop.indices.length * 2;
    });

    skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtVertices, 3));
    skirtGeometry.setIndex(skirtIndices);

    return new THREE.Mesh(
      skirtGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x463c2b,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
      })
    );
  }

  disposeChunk(chunk) {
    if (chunk.terrainMesh) {
      chunk.terrainMesh.removeFromParent();
      chunk.terrainMesh.geometry?.dispose?.();
      chunk.terrainMesh.material?.dispose?.();
      chunk.terrainMesh = null;
    }
    if (chunk.skirtMesh) {
      chunk.skirtMesh.removeFromParent();
      chunk.skirtMesh.geometry?.dispose?.();
      chunk.skirtMesh.material?.dispose?.();
      chunk.skirtMesh = null;
    }
    if (chunk.satelliteTexture?.dispose) {
      chunk.satelliteTexture.dispose();
      chunk.satelliteTexture = null;
    }
  }
}
