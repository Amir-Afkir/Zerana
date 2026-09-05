import { buildTerrainCell } from '../../src/generation/terrain/terrain-builder.ts';
import { TerrainSampler } from '../../src/generation/terrain/terrain-sampler.ts';
import { syntheticElevation } from '../../src/generation/terrain/synthetic-elevation.ts';
import { WeightedLru } from '../../src/streaming/weighted-lru.ts';
import { loadMapboxPatch } from '../providers/mapbox-raster.mjs';
import { IndexedPacketCache } from './indexed-cache.mjs';
import { validatePacket, transferBuffers } from './packet.mjs';

const byteCache = new WeightedLru(16 * 1024 * 1024,128);
let current = null, disk = null;
self.onmessage = async ({data}) => {
  if(data.kind==='cancel') { if(current?.revision===data.revision) current.controller.abort(); return; }
  if(data.kind!=='build' || current) return;
  const {ticket,job}=data,controller=new AbortController();
  current={revision:ticket.revision,controller};let attempts=0;
  const started=performance.now();
  try {
    if(!['synthetic','mapbox'].includes(job.source) || !['flat','waves'].includes(job.profile) ||
      ![16,32].includes(job.subdivisions)) throw new Error('INVALID_STREAM_JOB');
    if(job.source==='mapbox' && (!Number.isSafeInteger(job.httpGrant) || job.httpGrant<0 || job.httpGrant>256))
      throw new Error('STREAM_HTTP_BUDGET');
    disk ||= new IndexedPacketCache(job.persistent===true);
    let bundle=await disk.get(job),cacheHit=!!bundle;
    if(!bundle) {
      const result=job.source==='mapbox' ? await loadMapboxPatch({cells:[job.id],subdivisions:job.subdivisions,
        token:job.token,allowPreview:job.allowPreview,signal:controller.signal,byteCache,
        onHttpAttempt:()=>{if(attempts>=job.httpGrant)throw new Error('STREAM_HTTP_BUDGET');attempts++;}}) : null;
      const source=result?.source||syntheticElevation(job.profile);
      const sampler=new TerrainSampler(source,undefined,{allowUnresolvedDatumPreview:job.allowPreview===true});
      const packet=buildTerrainCell(job.id,sampler,job.subdivisions);sampler.clear();
      bundle={packet,texture:result?.textures.get(`${job.id.level}/${job.id.x}/${job.id.y}`)||null,
        evidence:result?.evidence||[],attributions:result?.attributions||[],snapshotId:result?.snapshotId||source.id};
      validatePacket(bundle,job);
      if(!controller.signal.aborted) await disk.put(job,bundle);
    }
    if(controller.signal.aborted) throw new DOMException('Cancelled','AbortError');
    validatePacket(bundle,job);
    self.postMessage({kind:'result',ticket,bundle,attempts,cacheHit,
      generationMs:performance.now()-started,sourceCacheBytes:byteCache.bytes},transferBuffers(bundle));
  } catch(error) {
    // Whitelisted diagnostics only: no URL, token or provider response text.
    const message=String(error?.message||'');
    const code=error?.name==='AbortError'?'ABORTED':message.includes('401')||message.includes('403')?'PROVIDER_AUTH':
      message.includes('STREAM_HTTP_BUDGET')?'STREAM_HTTP_BUDGET':message.includes('TIMEOUT')?'PROVIDER_TIMEOUT':
      message.includes('429')?'PROVIDER_RATE_LIMIT':message.includes('nodata')?'PROVIDER_NODATA':
      message.includes('404')?'PROVIDER_NOT_FOUND':'STREAM_GENERATION_ERROR';
    self.postMessage({kind:'error',ticket,code,attempts});
  } finally {current=null;}
};
