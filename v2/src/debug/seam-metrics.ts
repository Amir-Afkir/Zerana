import type { GeoAnchor } from '../geo/enu.js';
import { frameTransform, transformPoint, transformDirection } from '../geo/floating-origin.js';
import type { LocalFrameTransform } from '../geo/floating-origin.js';
import { vector } from '../geo/linear.js';
import type { Vec3 } from '../geo/linear.js';
import { readVertex } from '../generation/terrain/terrain-builder.js';
import type { TerrainCellPacket } from '../generation/terrain/terrain-builder.js';

export interface SeamMetrics {
  readonly edgePairs: number;
  readonly comparedVertices: number;
  readonly mismatchedKeys: number;
  readonly maxGapMeters: number;
  readonly maxNormalDelta: number;
  readonly estimatedFloat32GapMeters: number;
}
function distance(a: Vec3, b: Vec3): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/** Illustrative diagnostic model of rounded uniforms / arithmetic, not a measurement
 * of a GPU: driver FMA, camera transform and rasterization are not modelled here.
 */
export function estimatedFloat32Point(p: Vec3, t: LocalFrameTransform): Vec3 {
  const f = Math.fround;
  const row = (i: number): number => f(f(f(f(t.rotation[i]!) * f(p[0])) +
    f(f(t.rotation[i + 1]!) * f(p[1]))) +
    f(f(f(t.rotation[i + 2]!) * f(p[2])) + f(t.translationMeters[i / 3]!)));
  return vector(row(0), row(3), row(6));
}

export function measureTerrainSeams(cells: readonly TerrainCellPacket[], world: GeoAnchor, options: {allowSourceSnapshots?:boolean} = {}): SeamMetrics {
  const keys = new Map(cells.map(c => [`${c.id.level}/${c.id.x}/${c.id.y}`, c]));
  if (keys.size !== cells.length) throw new RangeError('Duplicate cells in patch');
  if (cells.some(c => c.id.level !== cells[0]?.id.level || c.subdivisions !== cells[0]?.subdivisions ||
      (!options.allowSourceSnapshots && c.sourceId !== cells[0]?.sourceId) ||
      c.altitudeAuthority !== cells[0]?.altitudeAuthority || c.verticalReference !== cells[0]?.verticalReference)) throw new RangeError('Seam diagnostic requires one source and equal LOD');
  let edgePairs = 0, comparedVertices = 0, mismatchedKeys = 0;
  let maxGapMeters = 0, maxNormalDelta = 0, estimatedFloat32GapMeters = 0;
  for (const a of cells) {
    const n = 2 ** a.id.level, s = a.subdivisions, width = s + 1;
    for (const direction of ['east', 'south'] as const) {
      const x = direction === 'east' ? (a.id.x + 1) % n : a.id.x;
      const y = direction === 'south' ? a.id.y + 1 : a.id.y;
      const b = keys.get(`${a.id.level}/${x}/${y}`);
      if (!b || b === a) continue;
      edgePairs++;
      const ta = frameTransform(a.anchor, world), tb = frameTransform(b.anchor, world);
      for (let i = 0; i <= s; i++) {
        const ia = direction === 'east' ? i * width + s : s * width + i;
        const ib = direction === 'east' ? i * width : i;
        if (a.sampleKeys[ia] !== b.sampleKeys[ib]) mismatchedKeys++;
        const pa = readVertex(a.positions, ia), pb = readVertex(b.positions, ib);
        maxGapMeters = Math.max(maxGapMeters, distance(transformPoint(pa, ta), transformPoint(pb, tb)));
        estimatedFloat32GapMeters = Math.max(estimatedFloat32GapMeters,
          distance(estimatedFloat32Point(pa, ta), estimatedFloat32Point(pb, tb)));
        maxNormalDelta = Math.max(maxNormalDelta, distance(
          transformDirection(readVertex(a.normals, ia), ta), transformDirection(readVertex(b.normals, ib), tb)));
        comparedVertices++;
      }
    }
  }
  return Object.freeze({ edgePairs, comparedVertices, mismatchedKeys, maxGapMeters, maxNormalDelta, estimatedFloat32GapMeters });
}
