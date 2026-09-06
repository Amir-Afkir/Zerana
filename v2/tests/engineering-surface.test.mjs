import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINEERING_FIXTURE as F, fixtureEngineeringSample } from '../dist/generation/roads/engineering-fixture.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { MercatorCellScheme } from '../dist/geo/mercator-cell-scheme.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { geodeticRadians } from '../dist/geo/geodetic.js';
import { geodeticToEcef, ecefToGeodetic } from '../dist/geo/ecef.js';
import { ecefToThreeLocal, threeLocalToEcef } from '../dist/geo/three-frame.js';
import { radians, meters } from '../dist/geo/units.js';
import { TerrainPhysics } from '../dist/physics/terrain-physics.js';

// Check physical discretisation, not merely continuity of analytic polynomials.
test('level-19 collider approximates the engineered surface over the full 1.2 km track', t => {
  const origin = createGeoAnchor(geodeticRadians(radians(F.longitudeDegrees*Math.PI/180),
    radians(F.latitudeDegrees*Math.PI/180),meters(0)));
  const scheme = new MercatorCellScheme(), sampler = new TerrainSampler(syntheticElevation('engineering'));
  let currentKey = '', physics = null, packet, count = 0, maxErrorMeters = 0, sumSquares = 0;
  try {
    for (let s = 0; s <= F.lengthMeters; s += 4) {
      const angle = (s-F.lengthMeters/2)/F.radiusMeters;
      for (const lateral of [-21.5,-12,-3.5,0,3.5,12,21.5]) {
        const x = (F.radiusMeters-lateral)*Math.sin(angle);
        const north = F.radiusMeters*(1-Math.cos(angle))+lateral*Math.cos(angle);
        const geo = ecefToGeodetic(threeLocalToEcef([x,0,-north],origin));
        const point = geodeticRadians(geo.longitudeRad,geo.latitudeRad,meters(0));
        const height = fixtureEngineeringSample(point).heightMeters;
        const id = scheme.getCellAt(point,19), key = `${id.level}/${id.x}/${id.y}`;
        if (key !== currentKey) {
          physics?.dispose(); sampler.clear();
          packet = buildTerrainCell(id,sampler,32);
          physics = new TerrainPhysics([packet],packet.anchor);
          currentKey = key;
        }
        const localAt = h => ecefToThreeLocal(geodeticToEcef(geodeticRadians(point.longitudeRad,point.latitudeRad,meters(h))),packet.anchor);
        const high = localAt(height+5), low = localAt(height);
        const hit = physics.raycast(high,low.map((v,i)=>v-high[i]),10);
        assert.ok(hit,`missing support at ${s}/${lateral}`);
        const error = Math.abs(hit.distance-5);
        maxErrorMeters = Math.max(maxErrorMeters,error); sumSquares += error*error; count++;
        // Fixture discretisation bound only; existing 1 mm seams are unchanged.
        assert.ok(error < .10,`grid/profile error ${error} m at ${s}/${lateral}`);
      }
    }
  } finally { physics?.dispose(); sampler.clear(); }
  t.diagnostic(JSON.stringify({samples:count,trackLengthMeters:F.lengthMeters,level:19,subdivisions:32,
    maxErrorMeters,rmsErrorMeters:Math.sqrt(sumSquares/count)}));
});
