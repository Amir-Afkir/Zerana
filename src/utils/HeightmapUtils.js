import * as THREE from 'three';

const HeightmapUtils = {
  // Calcule la clé du chunk à partir de la position
  getChunkInfo: function (globe, position) {
    const chunkSize = globe.chunkSize;
    const chunkX = Math.floor((position.x + chunkSize / 2) / chunkSize);
    const chunkZ = Math.floor((position.z + chunkSize / 2) / chunkSize);
    const chunkKey = `${chunkX}_${chunkZ}`;
    const chunkPos = new THREE.Vector3(chunkX * chunkSize, 0, chunkZ * chunkSize);
    return { key: chunkKey, position: chunkPos };
  },

  // Trouver la hauteur y à partir de x, z et du globe
  getHeightAt: function (position, globe) {
    const { key: chunkKey, position: chunkPos } = this.getChunkInfo(globe, position);
    const chunkState = globe.chunkStates[chunkKey];
    if (chunkState?.dataLoaded && chunkState.entity?.heightmap) {
      const heightmap = chunkState.entity.heightmap;
      const chunkSize = globe.chunkSize;
      const gridSize = Math.sqrt(heightmap.length);
      const subdivisions = gridSize - 1;
      // Position relative dans le chunk
      const localX = position.x - chunkPos.x;
      const localZ = position.z - chunkPos.z;
      // Normaliser pour indexer la heightmap
      const normalizedX = Math.min(Math.max(0, Math.floor((localX / chunkSize + 0.5) * subdivisions)), subdivisions);
      const normalizedZ = Math.min(Math.max(0, Math.floor((localZ / chunkSize + 0.5) * subdivisions)), subdivisions);
      return heightmap[normalizedZ * gridSize + normalizedX];
    }
    return NaN;
  }
};

export default HeightmapUtils;