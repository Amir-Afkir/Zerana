import { streamCellKey, STREAM_LIMITS } from '../../src/streaming/selection.ts';

export function packetCacheKey(job) {
  // Every change of formula/format/source/LOD creates a separate namespace.
  return `stream-packet-v1/WGS84-ECEF/terrain-v1/${job.source}/${job.profile}/` +
    `${job.source === 'mapbox' ? 'unresolved-preview' : 'ellipsoidal'}/${streamCellKey(job.id)}/N${job.subdivisions}`;
}
export function packetBytes(bundle) {
  const p = bundle.packet;
  return p.positions.byteLength + p.normals.byteLength + p.uvs.byteLength + p.indices.byteLength +
    p.heightsMeters.byteLength + (bundle.texture?.rgba.byteLength || 0) +
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
    ...(bundle.texture ? [bundle.texture.rgba.buffer] : [])];
}
export async function packetDigest(bundle) {
  const p = bundle.packet;
  const header = new TextEncoder().encode(JSON.stringify({ id:p.id, source:p.sourceId,
    vertical:p.verticalReference, authority:p.altitudeAuthority, anchor:p.anchor,
    subdivisions:p.subdivisions, keys:p.sampleKeys, bounds:p.bounds,
    texture:bundle.texture ? {width:bundle.texture.width,cellKey:bundle.texture.cellKey,
      uvScale:bundle.texture.uvScale,uvOffset:bundle.texture.uvOffset} : null }));
  const bytes = await new Blob([header,...transferBuffers(bundle)]).arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2,'0')).join('');
}
