function prepMap(map) {
  const gridSize = Math.sqrt(map.length) | 0;
  return {
    map,
    gridSize,
    gridSizeMinus1: Math.max(0, gridSize - 1)
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function samplePrepared(prep, u, v) {
  const x = Math.round(clamp01(u) * prep.gridSizeMinus1);
  const y = Math.round(clamp01(v) * prep.gridSizeMinus1);
  return prep.map[y * prep.gridSize + x];
}

// Height sampling in chunk-local space (x,z in [-half..+half]) with optional neighbor fallback.
// Uses normalized UV-style lookup so neighbors can be different resolutions (LOD).
export function createHeightSampler(heightmap, chunkSize, neighbors = {}) {
  const half = chunkSize / 2;
  const invChunkSize = 1 / chunkSize;

  const self = prepMap(heightmap);
  const top = neighbors.top ? prepMap(neighbors.top) : null;
  const bottom = neighbors.bottom ? prepMap(neighbors.bottom) : null;
  const left = neighbors.left ? prepMap(neighbors.left) : null;
  const right = neighbors.right ? prepMap(neighbors.right) : null;

  function sampleLocal(x, z) {
    const u = (x + half) * invChunkSize;
    const v = (z + half) * invChunkSize;

    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      return samplePrepared(self, u, v);
    }

    // Naming convention: neighbors.top is +Z (south), bottom is -Z (north).
    if (v < 0 && bottom) return samplePrepared(bottom, u, 1);
    if (v > 1 && top) return samplePrepared(top, u, 0);
    if (u < 0 && left) return samplePrepared(left, 1, v);
    if (u > 1 && right) return samplePrepared(right, 0, v);
    return 0;
  }

  return {
    sampleLocal,
    gridSize: self.gridSize,
    subdivisions: self.gridSizeMinus1
  };
}
