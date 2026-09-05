/** WGS84 ellipsoid. EPSG:4979 geographic 3D / EPSG:4978 geocentric. */
export const WGS84 = Object.freeze({
  semiMajorMeters: 6378137,
  flattening: 1 / 298.257223563,
  semiMinorMeters: 6378137 * (1 - 1 / 298.257223563),
  eccentricitySquared: (1 / 298.257223563) * (2 - 1 / 298.257223563),
});

/** Explicit supported domain of this first kernel; see ADR-001. */
export const GEO_LIMITS = Object.freeze({
  minEllipsoidHeightMeters: -12000,
  maxEllipsoidHeightMeters: 100000000,
  inverseToleranceRad: 1e-12,
  inverseMaxIterations: 16,
  poleAxisToleranceMeters: 1e-9,
  boundaryRoundingMeters: 1e-6,
  maxCellLevel: 24,
  rebaseDistanceMeters: 2048,
});
