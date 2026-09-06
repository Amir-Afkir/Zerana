import type { TerrainCellPacket } from '../terrain/terrain-builder.js';
import { validateTerrainGrid } from '../terrain/lattice.js';
import type { RoadGraph } from './model.js';
import { roadCellKey } from './kernel.js';
import { ROAD_STYLE_VERSION } from './surface-style.js';
import { roadFootprints } from './footprint.js';
import type { RoadSurfaceStyle } from './surface-style.js';
import { signedArea, partitionConvex, intersectConvex } from './convex.js';
import type { Point2, ConvexPolygon } from './convex.js';

export const ROAD_SURFACE_LIMITS = Object.freeze({ maxVertices: 24000, maxTrianglePieces: 192,
  maxOperations: 150000, maxBytes: 2 * 1024 * 1024, residentBytes: 8 * 1024 * 1024 });
export interface RoadSurfacePacket {
  readonly schema: 'zerana-road-surface-v1';
  readonly styleVersion: typeof ROAD_STYLE_VERSION;
  readonly cellKey: string;
  readonly terrainSourceId: string;
  readonly surfaceAuthority: 'visual-on-terrain';
  readonly widthAuthority: 'estimated-horizontal-meters';
  readonly positions: Float32Array; readonly normals: Float32Array;
  readonly colors: Float32Array; readonly uvs: Float32Array;
  readonly triangleCount: number; readonly primitiveCount: number;
  readonly junctionCount: number; readonly estimatedWidthCount: number;
  readonly sourceTiles: readonly string[];
}
export function roadSurfaceBytes(p: RoadSurfacePacket): number {
  return p.positions.byteLength + p.normals.byteLength + p.colors.byteLength + p.uvs.byteLength +
    p.sourceTiles.reduce((n, s) => n + 48 + s.length * 2, 0) + 1024;
}
/** Build a disjoint planar arrangement INSIDE each terrain triangle. Interpolate
 * actual position/normal buffers using barycentric weights, not a second DEM.
 * Thus every resulting road triangle lies in a committed ground triangle, even
 * over a ridge. No offset, new collider or terrain mutation is introduced. */
export function buildRoadSurface(graph: RoadGraph, t: TerrainCellPacket): RoadSurfacePacket {
  validateTerrainGrid(t.id, t.subdivisions);
  const n = t.subdivisions, scale = n * 2 ** t.id.level;
  const primitives = roadFootprints(graph, t.id).map(f => ({ ...f,
    polygon: f.polygon.map(p => [p[0] * scale - t.id.x * n, p[1] * scale - t.id.y * n] as Point2) }));
  const bins: number[][] = Array.from({ length: n * n }, () => []);
  for (let k = 0; k < primitives.length; k++) {
    const p = primitives[k]!.polygon;
    const minX = Math.max(0, Math.floor(Math.min(...p.map(v => v[0]))));
    const maxX = Math.min(n - 1, Math.floor(Math.max(...p.map(v => v[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...p.map(v => v[1]))));
    const maxY = Math.min(n - 1, Math.floor(Math.max(...p.map(v => v[1]))));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) bins[y * n + x]!.push(k);
  }
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], uvs: number[] = [];
  let operations = 0;
  const emit = (polygon: ConvexPolygon, x: number, y: number, half: number, style: RoadSurfaceStyle): void => {
    if (signedArea(polygon) <= 1e-18) return;
    const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
    const ids = half === 0 ? [a, c, b] : [b, c, d];
    const vertex = (p: Point2): void => {
      if (positions.length / 3 >= ROAD_SURFACE_LIMITS.maxVertices) throw new Error('ROAD_SURFACE_VERTEX_BUDGET');
      const dx = p[0] - x, dy = p[1] - y;
      const weights = half === 0 ? [1 - dx - dy, dy, dx] : [1 - dy, 1 - dx, dx + dy - 1];
      if (weights.some(w => w < -1e-8 || w > 1 + 1e-8)) throw new Error('ROAD_SURFACE_OUTSIDE_TRIANGLE');
      const pos = [0, 0, 0], normal = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) for (let i = 0; i < 3; i++) {
        pos[axis]! += t.positions[ids[i]! * 3 + axis]! * weights[i]!;
        normal[axis]! += t.normals[ids[i]! * 3 + axis]! * weights[i]!;
      }
      const length = Math.hypot(...normal);
      positions.push(...pos); normals.push(...normal.map(v => v / length));
      colors.push(...style.color); uvs.push(p[0] / n, 1 - p[1] / n);
    };
    for (let i = 1; i + 1 < polygon.length; i++) {
      // CCW east/south parameter space -> reverse for +Up Three normals.
      if (Math.abs(signedArea([polygon[0]!, polygon[i]!, polygon[i + 1]!])) <= 1e-18) continue;
      vertex(polygon[0]!); vertex(polygon[i + 1]!); vertex(polygon[i]!);
    }
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const candidates = bins[y * n + x]!;
    if (!candidates.length) continue;
    for (let half = 0; half < 2; half++) {
      const triangle: ConvexPolygon = half === 0 ? [[x, y], [x + 1, y], [x, y + 1]]
        : [[x + 1, y], [x + 1, y + 1], [x, y + 1]];
      let uncovered: ConvexPolygon[] = [triangle];
      for (const index of candidates) {
        const primitive = primitives[index]!;
        const clip = intersectConvex(primitive.polygon, triangle);
        if (!clip.length) continue;
        const next: ConvexPolygon[] = [];
        for (const piece of uncovered) {
          if (++operations > ROAD_SURFACE_LIMITS.maxOperations) throw new Error('ROAD_SURFACE_OPERATION_BUDGET');
          const part = partitionConvex(piece, clip);
          if (part.inside.length) emit(part.inside, x, y, half, primitive.style);
          next.push(...part.outside);
          if (next.length > ROAD_SURFACE_LIMITS.maxTrianglePieces) throw new Error('ROAD_SURFACE_COMPLEXITY_BUDGET');
        }
        uncovered = next;
        if (!uncovered.length) break;
      }
    }
  }
  const packet: RoadSurfacePacket = { schema: 'zerana-road-surface-v1', styleVersion: ROAD_STYLE_VERSION,
    cellKey: roadCellKey(t.id), terrainSourceId: t.sourceId, surfaceAuthority: 'visual-on-terrain',
    widthAuthority: 'estimated-horizontal-meters', positions: new Float32Array(positions),
    normals: new Float32Array(normals), colors: new Float32Array(colors), uvs: new Float32Array(uvs),
    triangleCount: positions.length / 9, primitiveCount: primitives.length,
    junctionCount: primitives.filter(p => p.key.startsWith('node/')).length,
    estimatedWidthCount: primitives.length, sourceTiles: [...graph.sourceTiles] };
  validateRoadSurface(packet, t);
  return packet;
}
export function validateRoadSurface(p: RoadSurfacePacket, t: TerrainCellPacket): void {
  if (!p || p.schema !== 'zerana-road-surface-v1' || p.styleVersion !== ROAD_STYLE_VERSION ||
      p.cellKey !== roadCellKey(t.id) || p.terrainSourceId !== t.sourceId ||
      p.surfaceAuthority !== 'visual-on-terrain' || p.widthAuthority !== 'estimated-horizontal-meters' ||
      ![p.positions, p.normals, p.colors, p.uvs].every(a => a instanceof Float32Array) ||
      p.positions.length % 9 !== 0 || p.positions.length / 3 > ROAD_SURFACE_LIMITS.maxVertices ||
      p.normals.length !== p.positions.length || p.colors.length !== p.positions.length ||
      p.uvs.length * 3 !== p.positions.length * 2 || p.triangleCount !== p.positions.length / 9 ||
      !Array.isArray(p.sourceTiles) || p.sourceTiles.length > 16 || p.sourceTiles.some(s => typeof s !== 'string' || s.length > 128) ||
      ![p.positions, p.normals, p.colors, p.uvs].every(a => a.every(Number.isFinite)) ||
      p.uvs.some(v => v < -1e-7 || v > 1 + 1e-7) || roadSurfaceBytes(p) > ROAD_SURFACE_LIMITS.maxBytes)
    throw new Error('ROAD_SURFACE_PACKET_CONTRACT');
}
