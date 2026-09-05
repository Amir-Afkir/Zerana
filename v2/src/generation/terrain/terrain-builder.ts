import type { WorldCellId } from '../../geo/cell-scheme.js';
import { createGeoAnchor } from '../../geo/enu.js';
import type { GeoAnchor } from '../../geo/enu.js';
import { rotate, vector } from '../../geo/linear.js';
import type { Vec3 } from '../../geo/linear.js';
import { ecefToThreeLocal, enuToThree } from '../../geo/three-frame.js';
import { TERRAIN_LIMITS, validateTerrainGrid } from './lattice.js';
import { TerrainSampler } from './terrain-sampler.js';

/** Plain data; CPU ownership passes to the renderer. No Three.js, DOM or I/O. */
export interface TerrainCellPacket {
  readonly id: WorldCellId;
  readonly sourceId: string;
  readonly verticalReference: 'ELLIPSOIDAL_WGS84';
  readonly anchor: GeoAnchor;
  readonly subdivisions: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly heightsMeters: Float64Array;
  readonly sampleKeys: readonly string[];
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
}

export function buildTerrainCell(
  id: WorldCellId, sampler: TerrainSampler, subdivisions: number = TERRAIN_LIMITS.defaultSubdivisions,
): TerrainCellPacket {
  validateTerrainGrid(id, subdivisions);
  const exponent = id.level + Math.log2(subdivisions);
  const gx = id.x * subdivisions, gy = id.y * subdivisions;
  const anchor = createGeoAnchor(sampler.sample(exponent, gx + subdivisions / 2, gy + subdivisions / 2).geodetic);
  const width = subdivisions + 1, count = width * width;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2), heightsMeters = new Float64Array(count);
  const sampleKeys: string[] = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let row = 0; row <= subdivisions; row++) {
    for (let column = 0; column <= subdivisions; column++) {
      const index = row * width + column;
      const sample = sampler.sample(exponent, gx + column, gy + row);
      const local = ecefToThreeLocal(sample.ecef, anchor);
      if (Math.hypot(...local) > TERRAIN_LIMITS.maxVertexRadiusMeters) {
        throw new RangeError('Cell exceeds the declared local Float32 precision budget');
      }
      const normal = enuToThree(rotate(anchor.ecefToEnu, sampler.normal(exponent, gx + column, gy + row)));
      positions.set(local, index * 3); normals.set(normal, index * 3);
      uvs[index * 2] = column / subdivisions;
      // Texture v=1 is north; XYZ row=0 is north. No extra flip in the mesh.
      uvs[index * 2 + 1] = 1 - row / subdivisions;
      heightsMeters[index] = sample.geodetic.ellipsoidHeightMeters;
      sampleKeys.push(sample.address.key);
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[index * 3 + axis]!;
        min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value);
      }
    }
  }
  const IndexArray = count <= 65536 ? Uint16Array : Uint32Array;
  const indices = new IndexArray(subdivisions * subdivisions * 6);
  let offset = 0;
  for (let row = 0; row < subdivisions; row++) {
    for (let column = 0; column < subdivisions; column++) {
      const a = row * width + column, b = a + 1, c = a + width, d = c + 1;
      // East +X, South +Z: (south cross east) faces Up.
      indices.set([a, c, b, b, c, d], offset); offset += 6;
    }
  }
  return Object.freeze({
    id: Object.freeze({ ...id }), sourceId: sampler.source.id, verticalReference: 'ELLIPSOIDAL_WGS84',
    anchor, subdivisions, positions, normals, uvs, indices, heightsMeters,
    sampleKeys: Object.freeze(sampleKeys),
    bounds: Object.freeze({ min: vector(min[0]!, min[1]!, min[2]!), max: vector(max[0]!, max[1]!, max[2]!) }),
  });
}

export function readVertex(buffer: Float32Array, index: number): Vec3 {
  if (!Number.isInteger(index) || index < 0 || index * 3 + 2 >= buffer.length) {
    throw new RangeError('Vertex index outside buffer');
  }
  return vector(buffer[index * 3]!, buffer[index * 3 + 1]!, buffer[index * 3 + 2]!);
}
