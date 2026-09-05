import { geodeticRadians } from '../../geo/geodetic.js';
import type { EcefPosition, GeodeticPosition } from '../../geo/geodetic.js';
import { geodeticToEcef } from '../../geo/ecef.js';
import { unprojectMercator } from '../../geo/mercator.js';
import { meters } from '../../geo/units.js';
import { vector } from '../../geo/linear.js';
import type { Vec3 } from '../../geo/linear.js';
import { latticeAddress, TERRAIN_LIMITS } from './lattice.js';
import type { LatticeAddress } from './lattice.js';
import type { EllipsoidElevationSource } from './synthetic-elevation.js';

export interface TerrainSample {
  readonly address: LatticeAddress;
  readonly geodetic: GeodeticPosition;
  readonly ecef: EcefPosition;
}

/** Cache lifetime = one immutable source. Eviction never changes sample values. */
export class TerrainSampler {
  readonly source: EllipsoidElevationSource;
  readonly maxEntries: number;
  private readonly cache = new Map<string, TerrainSample>();

  constructor(source: EllipsoidElevationSource, maxEntries: number = TERRAIN_LIMITS.maxSampleEntries) {
    if (source.verticalReference !== 'ELLIPSOIDAL_WGS84' || source.provenance !== 'synthetic' ||
        !source.id || typeof source.heightAt !== 'function') {
      throw new RangeError('This stage accepts only explicit synthetic ellipsoid heights');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > TERRAIN_LIMITS.maxSampleEntries) {
      throw new RangeError('Sample cache capacity outside supported budget');
    }
    this.source = Object.freeze({ ...source });
    this.maxEntries = maxEntries;
  }
  get size(): number { return this.cache.size; }
  clear(): void { this.cache.clear(); }

  sample(exponent: number, globalX: number, globalY: number): TerrainSample {
    const address = latticeAddress(exponent, globalX, globalY);
    const hit = this.cache.get(address.key);
    if (hit) {
      this.cache.delete(address.key); this.cache.set(address.key, hit);
      return hit;
    }
    const p = unprojectMercator(address);
    const surface = geodeticRadians(p.longitudeRad, p.latitudeRad, meters(0));
    const geodetic = geodeticRadians(p.longitudeRad, p.latitudeRad, meters(this.source.heightAt(surface)));
    const value = Object.freeze({ address, geodetic, ecef: geodeticToEcef(geodetic) });
    this.cache.set(address.key, value);
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return value;
  }

  /** ECEF normal = unit(dSouth cross dEast). Halo positions are globally shared.
   * At Mercator coverage edges, use a one-sided derivative; do not invent polar data.
   * Equal normals are guaranteed here only for the same sampling step / LOD.
   */
  normal(exponent: number, globalX: number, globalY: number): Vec3 {
    latticeAddress(exponent, globalX, globalY);
    const period = 2 ** exponent;
    const west = this.sample(exponent, globalX - 1, globalY).ecef;
    const east = this.sample(exponent, globalX + 1, globalY).ecef;
    const north = this.sample(exponent, globalX, Math.max(0, globalY - 1)).ecef;
    const south = this.sample(exponent, globalX, Math.min(period, globalY + 1)).ecef;
    const ex = east.xMeters - west.xMeters, ey = east.yMeters - west.yMeters, ez = east.zMeters - west.zMeters;
    const sx = south.xMeters - north.xMeters, sy = south.yMeters - north.yMeters, sz = south.zMeters - north.zMeters;
    const nx = sy * ez - sz * ey, ny = sz * ex - sx * ez, nz = sx * ey - sy * ex;
    const length = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(length) || length === 0) throw new RangeError('Degenerate terrain normal');
    return vector(nx / length, ny / length, nz / length);
  }
}
