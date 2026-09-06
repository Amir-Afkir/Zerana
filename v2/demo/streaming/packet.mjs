import { validateHydroCohort } from '../hydro/cohort.mjs';
import { waterPacketBytes } from '../../src/generation/water/surface.ts';
import { environmentPacketBytes } from '../../src/generation/environment/debug-packet.ts';
import { validateRoadSurface, roadSurfaceBytes } from '../../src/generation/roads/surface.ts';
import { canonicalReadSet } from '../../src/generation/roads/snapshot-readset.ts';
import { REAL_ENGINEERING_VERSION } from '../../src/generation/roads/real-engineering.ts';
import { streamCellKey, STREAM_LIMITS } from '../../src/streaming/selection.ts';

export function packetCacheKey(job) {
  // Every change of formula/format/source/LOD creates a separate namespace.
  return `stream-packet-v2-bvh/WGS84-ECEF/terrain-v1/${job.source}/${job.profile}/` +
    `${job.source === 'mapbox' ? 'unresolved-preview' : 'ellipsoidal'}/${job.hydro?'hydro-conditioned-v1/':''}${job.engineering?'real-engineering-v1/':''}${streamCellKey(job.id)}/N${job.subdivisions}`;
}
export function packetBytes(bundle) {
  const p = bundle.packet;
  return p.positions.byteLength + p.normals.byteLength + p.uvs.byteLength + p.indices.byteLength +
    p.heightsMeters.byteLength + (bundle.texture?.rgba.byteLength || 0) +
    (bundle.roadSurface ? roadSurfaceBytes(bundle.roadSurface) : 0) +
    (bundle.water ? waterPacketBytes(bundle.water) : 0) +
    (bundle.environment ? environmentPacketBytes(bundle.environment) : 0) +
    (bundle.rawHeightsMeters?.byteLength || 0) +
    (bundle.hydro ? JSON.stringify(bundle.hydro).length*2+4096 : 0) +
    (bundle.engineering ? JSON.stringify(bundle.engineering).length*2+4096 : 0) +
    (bundle.collider ? [bundle.collider.boxes,bundle.collider.links,bundle.collider.triangles,bundle.collider.sourceIds].reduce((n,a)=>n+a.byteLength,0) : 0) +
    p.sampleKeys.reduce((n,k) => n + 48 + k.length * 2, 0) + 8192;
}
export function validatePacket(bundle, job) {
  const p = bundle?.packet, n = job.subdivisions, count = (n + 1) ** 2;
  if (!p || streamCellKey(p.id) !== streamCellKey(job.id) || p.subdivisions !== n ||
      !(p.positions instanceof Float32Array) || p.positions.length !== count * 3 ||
      !(p.normals instanceof Float32Array) || p.normals.length !== count * 3 ||
      !(p.uvs instanceof Float32Array) || p.uvs.length !== count * 2 ||
      !(p.indices instanceof Uint16Array) || p.indices.length !== n * n * 6 ||
      !(p.heightsMeters instanceof Float64Array) || p.heightsMeters.length !== count ||
      !Array.isArray(p.sampleKeys) || p.sampleKeys.length !== count ||
      p.sampleKeys.some(k => typeof k !== 'string' || k.length > 100) ||
      p.indices.some(i => i >= count) || ![p.positions,p.normals,p.uvs,p.heightsMeters].every(a => a.every(Number.isFinite)))
    throw new Error('INVALID_STREAM_PACKET');
  if (job.source === 'synthetic' && (p.sourceId !== `synthetic-${job.profile}-v1` ||
      p.altitudeAuthority !== 'ellipsoidal' || p.verticalReference !== 'ELLIPSOIDAL_WGS84')) throw new Error('INVALID_STREAM_AUTHORITY');
  if (job.source === 'mapbox' && (job.allowPreview !== true || p.altitudeAuthority !== 'preview-only' ||
      p.verticalReference !== 'UNRESOLVED_DATUM_PREVIEW' || !p.sourceId.startsWith('mapbox.terrain-rgb/'))) throw new Error('INVALID_STREAM_AUTHORITY');
  if(job.hydro===true){
    if(job.source!=='mapbox'||job.engineering)throw new Error('HYDRO_COHORT_CONTRACT');
    validateHydroCohort(bundle);
  } else if(job.engineering===true){
    const e=bundle.engineering;
    if(job.source!=='mapbox'||!e||e.version!==REAL_ENGINEERING_VERSION||e.qualifiedForDriving!==false||
      e.boundaryMode!=='fixed-raw-collar'||!Array.isArray(e.regions)||e.regions.length<1||e.regions.length>4||
      !Number.isFinite(e.maxDeltaMeters)||e.maxDeltaMeters<0||e.maxDeltaMeters>3+1e-9||
      !Number.isSafeInteger(e.modifiedSamples)||e.modifiedSamples<0||
      !p.sourceId.startsWith(`mapbox.terrain-rgb/${REAL_ENGINEERING_VERSION}/`))throw new Error('ROAD_ENGINEERING_PACKET_CONTRACT');
    canonicalReadSet(e.readSet);validateRoadSurface(bundle.roadSurface,p);
  } else if(bundle.engineering||bundle.roadSurface||bundle.hydro||bundle.water||bundle.environment||bundle.rawHeightsMeters)throw new Error('ROAD_ENGINEERING_UNEXPECTED_PACKET');
  if (bundle.texture) {
    const t = bundle.texture;
    if (!(t.rgba instanceof Uint8Array) || !Number.isInteger(t.width) || t.width < 2 || t.width > 512 ||
      t.rgba.length !== t.width ** 2 * 4 || !Number.isFinite(t.uvScale) || !Number.isFinite(t.uvOffset) ||
      t.cellKey !== `${p.id.level}/${p.id.x}/${p.id.y}`) throw new Error('INVALID_STREAM_TEXTURE');
  }
  if (packetBytes(bundle) > STREAM_LIMITS.reservedCellBytes) throw new Error('STREAM_PACKET_BUDGET');
  return bundle;
}
export function transferBuffers(bundle) {
  const p = bundle.packet;
  return [p.positions.buffer,p.normals.buffer,p.uvs.buffer,p.indices.buffer,p.heightsMeters.buffer,
    ...(bundle.texture ? [bundle.texture.rgba.buffer] : []),
    ...(bundle.roadSurface ? [bundle.roadSurface.positions.buffer,bundle.roadSurface.normals.buffer,bundle.roadSurface.colors.buffer,bundle.roadSurface.uvs.buffer,bundle.roadSurface.indices.buffer] : []),
    ...(bundle.water ? [bundle.water.positions.buffer,bundle.water.normals.buffer,bundle.water.uvs.buffer,bundle.water.indices.buffer] : []),
    ...(bundle.environment ? [bundle.environment.positions.buffer,bundle.environment.colors.buffer] : []),
    ...(bundle.rawHeightsMeters ? [bundle.rawHeightsMeters.buffer] : []),
    ...(bundle.collider ? [bundle.collider.boxes.buffer,bundle.collider.links.buffer,bundle.collider.triangles.buffer,bundle.collider.sourceIds.buffer] : [])];
}
export async function packetDigest(bundle) {
  const p = bundle.packet;
  const header = new TextEncoder().encode(JSON.stringify({ id:p.id, source:p.sourceId,
    vertical:p.verticalReference, authority:p.altitudeAuthority, anchor:p.anchor,
    engineering:bundle.engineering||null,hydro:bundle.hydro||null,
    subdivisions:p.subdivisions, keys:p.sampleKeys, bounds:p.bounds,
    texture:bundle.texture ? {width:bundle.texture.width,cellKey:bundle.texture.cellKey,
      uvScale:bundle.texture.uvScale,uvOffset:bundle.texture.uvOffset} : null }));
  const bytes = await new Blob([header,...transferBuffers(bundle)]).arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2,'0')).join('');
}
