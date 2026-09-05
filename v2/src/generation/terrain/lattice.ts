import type { WorldCellId } from '../../geo/cell-scheme.js';
import { cellId } from '../../geo/mercator-cell-scheme.js';

/** Small, metric patches only; coarser visual LODs need a separate precision budget. */
export const TERRAIN_LIMITS = Object.freeze({
  minCellLevel: 15,
  maxCellLevel: 24,
  minSubdivisions: 4,
  maxSubdivisions: 256,
  defaultSubdivisions: 32,
  maxSampleEntries: 150000,
  maxVertexRadiusMeters: 2048,
  seamToleranceMeters: 0.001,
});

export interface LatticeAddress {
  readonly exponent: number;
  readonly x: number;
  readonly y: number;
  readonly u: number;
  readonly v: number;
  readonly key: string;
}

export function validateTerrainGrid(id: WorldCellId, subdivisions: number): void {
  if (id.scheme !== 'web-mercator') throw new RangeError('Unsupported terrain cell scheme');
  cellId(id.level, id.x, id.y);
  if (id.level < TERRAIN_LIMITS.minCellLevel || id.level > TERRAIN_LIMITS.maxCellLevel) {
    throw new RangeError('Terrain patch level must be in [15, 24]');
  }
  if (!Number.isInteger(subdivisions) || subdivisions < TERRAIN_LIMITS.minSubdivisions ||
      subdivisions > TERRAIN_LIMITS.maxSubdivisions || !Number.isInteger(Math.log2(subdivisions))) {
    throw new RangeError('Subdivisions must be a power of two in [4, 256]');
  }
}

/** A reduced dyadic address. East/west wraps; north/south never wraps. */
export function latticeAddress(exponent: number, globalX: number, globalY: number): LatticeAddress {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 32) {
    throw new RangeError('Lattice exponent outside [0, 32]');
  }
  const period = 2 ** exponent;
  if (!Number.isSafeInteger(globalX) || !Number.isSafeInteger(globalY) || globalY < 0 || globalY > period) {
    throw new RangeError('Invalid lattice coordinate');
  }
  let x = ((globalX % period) + period) % period;
  let y = globalY;
  let reducedExponent = exponent;
  // Only integer arithmetic before conversion to a geographic point.
  while (reducedExponent > 0 && x % 2 === 0 && y % 2 === 0) {
    x /= 2; y /= 2; reducedExponent--;
  }
  const denominator = 2 ** reducedExponent;
  return Object.freeze({
    exponent: reducedExponent, x, y, u: x / denominator, v: y / denominator,
    key: `web-mercator/sample/${reducedExponent}/${x}/${y}`,
  });
}

export function cellSampleAddress(
  id: WorldCellId, subdivisions: number, column: number, row: number,
): LatticeAddress {
  validateTerrainGrid(id, subdivisions);
  if (!Number.isInteger(column) || !Number.isInteger(row) ||
      column < 0 || row < 0 || column > subdivisions || row > subdivisions) {
    throw new RangeError('Vertex must belong to the inclusive cell grid');
  }
  return latticeAddress(id.level + Math.log2(subdivisions), id.x * subdivisions + column, id.y * subdivisions + row);
}
