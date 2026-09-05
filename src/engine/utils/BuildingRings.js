export function ringArea(ring) {
  let area = 0;
  for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
    const p1 = ring[j];
    const p2 = ring[i];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return area * 0.5;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersect = ((pi.y > point.y) !== (pj.y > point.y)) &&
      (point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y + Number.EPSILON) + pi.x);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Group rings into [{ outer, holes[] }] using winding + point-in-polygon inclusion.
export function groupRings(rings) {
  if (!rings || rings.length === 0) return [];

  const withArea = rings.map((ring) => ({ ring, area: ringArea(ring) }));
  let outers = withArea.filter((r) => r.area >= 0).map((r) => r.ring);
  let inners = withArea.filter((r) => r.area < 0).map((r) => r.ring);

  // Fallback if winding is inconsistent: treat largest ring(s) as outers.
  if (outers.length === 0) {
    const sorted = [...withArea].sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    outers = sorted.slice(0, 1).map((r) => r.ring);
    inners = sorted.slice(1).map((r) => r.ring);
  }

  const polys = outers.map((outer) => ({ outer, holes: [] }));
  for (const hole of inners) {
    const host = polys.find((poly) => pointInPolygon(hole[0], poly.outer));
    if (host) host.holes.push(hole);
    else polys.push({ outer: hole, holes: [] });
  }

  return polys;
}
