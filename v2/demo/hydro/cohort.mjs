import { HYDRO_POLICY, HYDRO_VERSION } from '../../src/generation/hydro/conditioned-elevation.ts';
import { assertWaterReadSets,validateWaterPacket,waterPacketBytes } from '../../src/generation/water/surface.ts';
import { WATER_LIMITS } from '../../src/generation/water/model.ts';
import { validateRoadSurface,roadSurfaceBytes,ROAD_SURFACE_LIMITS } from '../../src/generation/roads/surface.ts';
import { ENV_LIMITS } from '../../src/generation/environment/model.ts';
import { environmentPacketBytes,validateEnvironmentPacket } from '../../src/generation/environment/debug-packet.ts';
export function validateHydroCohort(bundle){
  const h=bundle?.hydro,p=bundle?.packet;
  if(!h||h.version!==HYDRO_VERSION||!/^[0-9a-f]{64}$/.test(h.revision)||!p||!p.sourceId.endsWith(h.revision)||
    JSON.stringify(h.policy)!==JSON.stringify(HYDRO_POLICY)||!h.certificate?.passed||
    h.certificate.toleranceMeters!==HYDRO_POLICY.numericalToleranceMeters||
    (h.certificate.maxTerrainAboveWaterMeters!==null&&(!Number.isFinite(h.certificate.maxTerrainAboveWaterMeters)||h.certificate.maxTerrainAboveWaterMeters>HYDRO_POLICY.numericalToleranceMeters))||
    !Number.isFinite(h.maxLoweringMeters)||h.maxLoweringMeters<0||h.maxLoweringMeters>HYDRO_POLICY.maxLoweringMeters+1e-7||
    !(bundle.rawHeightsMeters instanceof Float64Array)||bundle.rawHeightsMeters.length!==p.heightsMeters.length||!bundle.rawHeightsMeters.every(Number.isFinite)||
    h.depthAuthority!=='preview-artificial-hydro-clearance'||bundle.water?.hydroRevision!==h.revision||bundle.water?.terrainModified!==true||
    JSON.stringify(h.readSet)!==JSON.stringify(bundle.water.readSet)||JSON.stringify(h.readSet)!==JSON.stringify(bundle.evidence))throw new Error('HYDRO_COHORT_CONTRACT');
  validateWaterPacket(bundle.water,p);validateRoadSurface(bundle.roadSurface,p);validateEnvironmentPacket(bundle.environment,p);
  assertWaterReadSets(h.readSet,[]);
  if(bundle.water.triangleCount>0&&(!h.certificate.testedIntersections||!h.certificate.testedVertices))throw new Error('HYDRO_PROOF_EMPTY');
  return bundle;
}
export function admitHydroCohort(bundle,resident){
  validateHydroCohort(bundle);
  assertWaterReadSets(bundle.hydro.readSet,resident.map(b=>b.hydro?.readSet||b.evidence?.filter(r=>r.layer==='elevation')||[]));
  const revisions=new Map(resident.filter(b=>b.hydro).map(b=>[b.hydro.region,b.hydro.revision]));
  if(revisions.has(bundle.hydro.region)&&revisions.get(bundle.hydro.region)!==bundle.hydro.revision)throw new Error('HYDRO_REGION_REVISION_CONFLICT');
  if(resident.reduce((s,b)=>s+(b.water?waterPacketBytes(b.water):0),waterPacketBytes(bundle.water))>WATER_LIMITS.residentBytes)throw new Error('HYDRO_WATER_RESIDENCY_BUDGET');
  if(resident.reduce((s,b)=>s+(b.environment?environmentPacketBytes(b.environment):0),environmentPacketBytes(bundle.environment))>ENV_LIMITS.residentBytes)throw new Error('HYDRO_ENV_RESIDENCY_BUDGET');
  if(resident.reduce((s,b)=>s+(b.roadSurface?roadSurfaceBytes(b.roadSurface):0),roadSurfaceBytes(bundle.roadSurface))>ROAD_SURFACE_LIMITS.residentBytes)throw new Error('HYDRO_ROAD_RESIDENCY_BUDGET');
}
