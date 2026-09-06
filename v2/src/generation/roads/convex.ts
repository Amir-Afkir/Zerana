/** Small bounded convex partition operations. A polygon is CCW in (east,south)
 * parameter space. No tolerance-welding of geographic source vertices. */
export type Point2 = readonly [number, number];
export type ConvexPolygon = readonly Point2[];
export const POLYGON_EPSILON = 1e-12; // local terrain grid units, NOT metres
export function cross2(a: Point2, b: Point2, p: Point2): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}
export function signedArea(p: ConvexPolygon): number {
  if (p.length < 3) return 0;
  // Translation invariant accumulation avoids large absolute-coordinate terms.
  let area = 0;
  for (let i = 1; i + 1 < p.length; i++) area += cross2(p[0]!, p[i]!, p[i + 1]!);
  return area / 2;
}
function clean(p: Point2[]): Point2[] {
  const result: Point2[] = [];
  for (const v of p) {
    const old = result[result.length - 1];
    if (!old || Math.hypot(v[0] - old[0], v[1] - old[1]) > POLYGON_EPSILON) result.push(v);
  }
  if (result.length > 1 && Math.hypot(result[0]![0] - result[result.length - 1]![0],
    result[0]![1] - result[result.length - 1]![1]) <= POLYGON_EPSILON) result.pop();
  return result.length >= 3 && Math.abs(signedArea(result)) > 1e-18 ? result : [];
}
/** Complementary half-planes share exactly the SAME computed crossing point. */
export function splitHalfPlane(p: ConvexPolygon, a: Point2, b: Point2): { inside: Point2[]; outside: Point2[] } {
  const inside: Point2[] = [], outside: Point2[] = [];
  for (let i = 0; i < p.length; i++) {
    const v = p[i]!, next = p[(i + 1) % p.length]!;
    const d = cross2(a, b, v), e = cross2(a, b, next);
    if (d >= 0) inside.push(v);
    if (d <= 0) outside.push(v);
    if ((d < 0 && e > 0) || (d > 0 && e < 0)) {
      const t = d / (d - e);
      const intersection: Point2 = [v[0] + t * (next[0] - v[0]), v[1] + t * (next[1] - v[1])];
      inside.push(intersection); outside.push(intersection);
    }
  }
  return { inside: clean(inside), outside: clean(outside) };
}
/** Partitions subject into its convex intersection with clip and disjoint convex
 * outside pieces. Repeating this builds a union without overlapping triangles,
 * including holes, with no general-purpose polygon/earcut dependency. */
export function partitionConvex(subject: ConvexPolygon, clip: ConvexPolygon): { inside: ConvexPolygon; outside: ConvexPolygon[] } {
  let inside = subject;
  const outside: ConvexPolygon[] = [];
  for (let i = 0; i < clip.length && inside.length; i++) {
    const split = splitHalfPlane(inside, clip[i]!, clip[(i + 1) % clip.length]!);
    if (split.outside.length) outside.push(split.outside);
    inside = split.inside;
  }
  return { inside, outside };
}
export function intersectConvex(subject: ConvexPolygon, clip: ConvexPolygon): ConvexPolygon {
  let p = subject;
  for (let i = 0; i < clip.length && p.length; i++) p = splitHalfPlane(p, clip[i]!, clip[(i + 1) % clip.length]!).inside;
  return p;
}
