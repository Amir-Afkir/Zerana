import { WGS84 } from '../../geo/wgs84.js';
import { unprojectMercator } from '../../geo/mercator.js';
import type { WorldCellId } from '../../geo/cell-scheme.js';
import type { RoadGraph, RoadEdge } from './model.js';
import { value } from './exact.js';
import type { RoadPoint } from './exact.js';
import { resolveRoadSurfaceStyle, MAX_ROAD_WIDTH_METERS } from './surface-style.js';
import type { RoadSurfaceStyle } from './surface-style.js';
import type { Point2, ConvexPolygon } from './convex.js';
import { signedArea } from './convex.js';

export const FOOTPRINT_LIMITS = Object.freeze({ maxPrimitives: 4096,
  maxSegmentMeters: 32, roundErrorMeters: .025, maxRoundSides: 40 });
export interface RoadFootprint {
  readonly key: string;
  /** Normalized unwrapped Mercator coordinates; never projected metres used as ground metres. */
  readonly polygon: ConvexPolygon;
  readonly style: RoadSurfaceStyle;
}
const point = (p: RoadPoint): Point2 => [value(p.u), value(p.v)];
/** Differential WGS84 horizontal metric. N and M are prime-vertical and
 * meridional radii. du -> East, dv -> South. All widths are horizontal widths
 * on the reference ellipsoid, not transverse slope lengths after draping. */
export function metricAt(p: Point2): Point2 {
  const phi = unprojectMercator({ u: p[0], v: Math.max(0, Math.min(1, p[1])) }).latitudeRad;
  const k = 1 - WGS84.eccentricitySquared * Math.sin(phi) ** 2;
  const east = WGS84.semiMajorMeters / Math.sqrt(k);
  const south = WGS84.semiMajorMeters * (1 - WGS84.eccentricitySquared) / k ** 1.5;
  return [2 * Math.PI * east * Math.cos(phi), 2 * Math.PI * south * Math.cos(phi)];
}
function offset(p: Point2, dxMeters: number, dyMeters: number): Point2 {
  const m = metricAt(p);
  return [p[0] + dxMeters / m[0], p[1] + dyMeters / m[1]];
}
function side(p: Point2, delta: Point2, radius: number): Point2 {
  const m = metricAt(p), x = delta[0] * m[0], y = delta[1] * m[1], length = Math.hypot(x, y);
  if (length < 1e-9) throw new Error('ROAD_SURFACE_ZERO_SEGMENT');
  return [-y / length * radius, x / length * radius];
}
/** Primitives are generated BEFORE WorldCell clipping. Adjacent cells evaluate
 * the same source segment and shared vertex, independent of their anchors. */
export function roadFootprints(graph: RoadGraph, cell: WorldCellId): readonly RoadFootprint[] {
  const n = 2 ** cell.level, center: Point2 = [(cell.x + .5) / n, (cell.y + .5) / n];
  const m = metricAt([center[0], center[1] > .5 ? (cell.y + 1) / n : cell.y / n]);
  // All primitives are contained inside the source corridor half-width.
  const marginX = (MAX_ROAD_WIDTH_METERS / 2 + 1) / m[0];
  const marginY = (MAX_ROAD_WIDTH_METERS / 2 + 1) / m[1];
  const xmin = cell.x / n - marginX, xmax = (cell.x + 1) / n + marginX;
  const ymin = cell.y / n - marginY, ymax = (cell.y + 1) / n + marginY;
  const near = (p: Point2): Point2 => [p[0] + Math.round(center[0] - p[0]), p[1]];
  const overlaps = (a: Point2, b: Point2): boolean =>
    Math.max(a[0], b[0]) >= xmin && Math.min(a[0], b[0]) <= xmax &&
    Math.max(a[1], b[1]) >= ymin && Math.min(a[1], b[1]) <= ymax;
  const result: RoadFootprint[] = [], eligible = new Map<string, { edge: RoadEdge; style: RoadSurfaceStyle }>();
  const append = (key: string, polygon: ConvexPolygon, style: RoadSurfaceStyle): void => {
    if (result.length >= FOOTPRINT_LIMITS.maxPrimitives) throw new Error('ROAD_SURFACE_PRIMITIVE_BUDGET');
    result.push({ key, polygon: signedArea(polygon) < 0 ? [...polygon].reverse() : polygon, style });
  };
  for (const edge of graph.edges) {
    const style = resolveRoadSurfaceStyle(edge.attributes);
    if (!style) continue;
    eligible.set(edge.key, { edge, style });
    const a = near(point(edge.a)), b = near(point(edge.b));
    if (!overlaps(a, b)) continue;
    const delta: Point2 = [b[0] - a[0], b[1] - a[1]];
    const mm = metricAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    const length = Math.hypot(delta[0] * mm[0], delta[1] * mm[1]);
    const count = Math.max(1, Math.ceil(length / FOOTPRINT_LIMITS.maxSegmentMeters));
    if (count > FOOTPRINT_LIMITS.maxPrimitives) throw new Error('ROAD_SURFACE_LENGTH_BUDGET');
    for (let i = 0; i < count; i++) {
      const p: Point2 = [a[0] + delta[0] * i / count, a[1] + delta[1] * i / count];
      const q: Point2 = [a[0] + delta[0] * (i + 1) / count, a[1] + delta[1] * (i + 1) / count];
      if (!overlaps(p, q)) continue;
      const v = side(p, delta, style.widthMeters / 2), w = side(q, delta, style.widthMeters / 2);
      append(`${edge.key}/${i}`, [offset(p, v[0], v[1]), offset(q, w[0], w[1]),
        offset(q, -w[0], -w[1]), offset(p, -v[0], -v[1])], style);
    }
  }
  for (const node of graph.nodes) {
    const p = near(point(node.point));
    if (!overlaps(p, p)) continue;
    const roads = node.edges.map(k => eligible.get(k)).filter((v): v is NonNullable<typeof v> => !!v);
    if (!roads.length || (node.sourceBoundary && roads.length < 2)) continue;
    // A cartographic round joint is not a lane/routing connection. The graph is
    // untouched. No cap is invented at an unresolved source tile cut.
    roads.sort((a, b) => b.style.widthMeters - a.style.widthMeters || a.edge.key.localeCompare(b.edge.key));
    const style = roads[0]!.style, radius = style.widthMeters / 2;
    const sides = Math.max(12, Math.min(FOOTPRINT_LIMITS.maxRoundSides,
      Math.ceil(Math.PI / Math.acos(1 - Math.min(.5, FOOTPRINT_LIMITS.roundErrorMeters / radius)))));
    const polygon: Point2[] = [];
    for (let i = 0; i < sides; i++) polygon.push(offset(p,
      radius * Math.cos(i / sides * 2 * Math.PI), radius * Math.sin(i / sides * 2 * Math.PI)));
    append(`node/${node.key}`, polygon, style);
  }
  // Explicit material priority and stable geometric tie-break. Provider arrival
  // order must never change which pavement owns overlapping ground coverage.
  return result.sort((a, b) => b.style.priority - a.style.priority || a.key.localeCompare(b.key));
}
