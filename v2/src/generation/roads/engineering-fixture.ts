import { createGeoAnchor } from '../../geo/enu.js';
import { geodeticRadians } from '../../geo/geodetic.js';
import type { GeodeticPosition } from '../../geo/geodetic.js';
import { geodeticToEcef, ecefToGeodetic } from '../../geo/ecef.js';
import { ecefToThreeLocal, threeLocalToEcef } from '../../geo/three-frame.js';
import { radians, meters } from '../../geo/units.js';
import type { EllipsoidElevationSource } from '../terrain/synthetic-elevation.js';
import type { EngineeringProfile } from './engineering-profile.js';
import { buildEngineeringProfile, DEFAULT_ENGINEERING_POLICY, profileAt, transitionWeight } from './engineering-profile.js';
import { sampleEarthwork } from './earthwork.js';

/** Earth-fixed, explicitly fictitious acceptance track near the Paris preset.
 * The shared recipe does not depend on cells, LOD, player, time or origin rebase.
 * This adapter is deliberately NOT applied to live Mapbox data. */
export const ENGINEERING_FIXTURE = Object.freeze({
  id:'synthetic-engineering-v1', latitudeDegrees:48.86, longitudeDegrees:2.35,
  lengthMeters:1200, radiusMeters:650, widthMeters:7, blendMeters:18,
  endTransitionMeters:32, stepMeters:4,
});
const F=ENGINEERING_FIXTURE;
const anchor=createGeoAnchor(geodeticRadians(radians(F.longitudeDegrees*Math.PI/180),radians(F.latitudeDegrees*Math.PI/180),meters(0)));
function localGround(p:GeodeticPosition): readonly [number,number] {
  const v=ecefToThreeLocal(geodeticToEcef(geodeticRadians(p.longitudeRad,p.latitudeRad,meters(0))),anchor);
  return [v[0],-v[2]];
}
export function fixtureRawHeight(p:GeodeticPosition): number {
  const [east,north]=localGround(p);
  // Quiet entry/exit connectors around an intentionally bumpy central track.
  const station=F.lengthMeters/2+F.radiusMeters*Math.atan2(east,F.radiusMeters-north);
  const bumps=transitionWeight(station/96)*transitionWeight((F.lengthMeters-station)/96);
  return 35+10*Math.sin(east/600)+1.5*bumps*Math.sin(east/8)+5*Math.sin(north/150);
}
export function fixtureRoadPosition(stationMeters:number):GeodeticPosition {
  if(!Number.isFinite(stationMeters)||stationMeters<0||stationMeters>F.lengthMeters)throw new Error('ROAD_FIXTURE_STATION');
  const theta=(stationMeters-F.lengthMeters/2)/F.radiusMeters;
  const p=ecefToGeodetic(threeLocalToEcef([F.radiusMeters*Math.sin(theta),0,-F.radiusMeters*(1-Math.cos(theta))],anchor));
  return geodeticRadians(p.longitudeRad,p.latitudeRad,meters(0));
}
let cachedProfile:EngineeringProfile|null=null;
export function fixtureProfile():EngineeringProfile {
if(cachedProfile)return cachedProfile;
const ground=new Float64Array(F.lengthMeters/F.stepMeters+1);
for(let i=0;i<ground.length;i++)ground[i]=fixtureRawHeight(fixtureRoadPosition(i*F.stepMeters));
const solved=buildEngineeringProfile({corridorKey:'synthetic-paris-acceptance-arc',sourceRevision:F.id,
  startBoundaryKey:'fixture-west-connector',endBoundaryKey:'fixture-east-connector',verticalReference:'ELLIPSOIDAL_WGS84',
  startStationMeters:0,stepMeters:F.stepMeters,groundHeightsMeters:ground,
  curvaturePerMeter:new Float64Array(ground.length).fill(1/F.radiusMeters),startGrade:0,endGrade:0},DEFAULT_ENGINEERING_POLICY);
if(solved.kind!=='ready')throw new Error(`ROAD_FIXTURE_PROFILE_${solved.reasons.join('_')}`);
cachedProfile=solved.profile;
return cachedProfile;
}
export function fixtureEngineeringSample(p:GeodeticPosition): {rawHeightMeters:number;heightMeters:number;deltaMeters:number;stationMeters:number;lateralMeters:number} {
  const [east,north]=localGround(p),k=1/F.radiusMeters;
  const stationMeters=F.lengthMeters/2+Math.atan2(k*east,1-k*north)/k;
  const lateralMeters=(1-Math.hypot(k*east,1-k*north))/k;
  const rawHeightMeters=fixtureRawHeight(p);
  const sample=sampleEarthwork(fixtureProfile(),F,stationMeters,lateralMeters,rawHeightMeters);
  if(sample.kind==='structure-required')throw new Error(`ROAD_FIXTURE_EARTHWORK_${sample.reason}`);
  return {rawHeightMeters,heightMeters:sample.heightMeters,deltaMeters:sample.deltaMeters,stationMeters,lateralMeters};
}
export function engineeringFixtureSource(raw=false):EllipsoidElevationSource {
  return Object.freeze({id:raw?'synthetic-engineering-raw-v1':F.id,verticalReference:'ELLIPSOIDAL_WGS84',provenance:'synthetic',
    heightAt:(p:GeodeticPosition)=>meters(raw?fixtureRawHeight(p):fixtureEngineeringSample(p).heightMeters)});
}
export function fixtureEngineeringDiagnostics() {
  return {mode:'synthetic-acceptance-only',profileAuthority:'estimated-profile',terrainAuthority:'synthetic',
    profile:fixtureProfile().diagnostics,center:profileAt(fixtureProfile(),F.lengthMeters/2),
    widthMeters:F.widthMeters,blendMeters:F.blendMeters,lengthMeters:F.lengthMeters,
    bankConvention:'horizontal-t-left',defaultMapboxAltered:false};
}
