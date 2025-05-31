// Fonctions communes (lerp, clamp...)
export function lerp(start, end, t) {
  return start + (end - start) * t;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function degreesToRadians(deg) {
  return (deg * Math.PI) / 180;
}

export function radiansToDegrees(rad) {
  return (rad * 180) / Math.PI;
}

// Calcul de la distance au carré entre deux points 2D (x,z)
export function distanceSquared(x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return dx * dx + dz * dz;
}