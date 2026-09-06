import { RoadSource } from './road-source.mjs';
import { loadMapboxPatch } from '../providers/mapbox-raster.mjs';
import { WeightedLru } from '../../src/streaming/weighted-lru.ts';
import { buildRoadGraph } from '../../src/generation/roads/kernel.ts';
import { buildRoadSurface } from '../../src/generation/roads/surface.ts';
import { buildRealEngineeringRegion, engineeringRegionAt, engineeringRegionsForCell, REAL_ENGINEERING_VERSION } from '../../src/generation/roads/real-engineering.ts';
import { canonicalReadSet, assertReadSetsCompatible } from '../../src/generation/roads/snapshot-readset.ts';
import { buildTerrainCell } from '../../src/generation/terrain/terrain-builder.ts';
import { TerrainSampler } from '../../src/generation/terrain/terrain-sampler.ts';
import { cellId } from '../../src/geo/mercator-cell-scheme.ts';
import { meters } from '../../src/geo/units.ts';
const key=id=>`${id.level}/${id.x}/${id.y}`;
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const aborted=signal=>{if(signal.aborted)throw new DOMException('Cancelled','AbortError');};

/** Worker-local recipe LRU. No disk storage and no history growing with travel.
 * Cache bytes are conservative accounting estimates, not a JavaScript heap probe.
 * Packet readsets are checked again against retained ground on the main thread. */
export class RealRoadSource {
  constructor(byteCache){this.bytes=byteCache;this.roads=new RoadSource();this.regions=new WeightedLru(32*1048576,4);this.token=null;}
  async region(id,token,signal,consume){
    aborted(signal);const k=key(id),cached=this.regions.get(k);if(cached)return cached;
    const roads=await this.roads.load([id],token,signal,32,consume);
    if(roads.sourceZoom!==16)throw new Error('ROAD_ENGINEERING_SOURCE_ZOOM');
    // Full immutable context, not just elevation samples in the current cell.
    // 8 subdivisions provide the raw DEM halo for the <=17.25 m strip up to 75N/S.
    const raw=await loadMapboxPatch({cells:roads.tiles.map(t=>cellId(t.z,t.x,t.y)),subdivisions:8,
      token,allowPreview:true,signal,byteCache:this.bytes,onHttpAttempt:consume,layers:'terrain'});
    const graph=buildRoadGraph(roads.tiles);
    const readSet=canonicalReadSet([...raw.evidence.map(r=>({layer:'elevation',tile:r.tile,sha256:r.sha256})),
      ...roads.tiles.map(t=>({layer:'road',tile:`${t.z}/${t.x}/${t.y}`,sha256:t.digest}))]);
    const revision=await digest([REAL_ENGINEERING_VERSION,k,roads.tiles[0].version,raw.snapshotId,readSet]);
    aborted(signal);
    const field=buildRealEngineeringRegion(id,graph,raw.source,revision);
    const result={field,graph,readSet,attributions:[...raw.attributions,roads.attribution]};
    // Decoded elevation storage + bounded graph/profile/index bookkeeping.
    const estimate=raw.decodedHeightBytes+graph.edges.length*1200+graph.nodes.length*256+
      field.diagnostics.segments*256+field.diagnostics.indexReferences*16+262144;
    if(!this.regions.set(k,result,estimate))throw new Error('ROAD_ENGINEERING_CACHE_BUDGET');
    return result;
  }
  async build(job,signal,consume){
    aborted(signal);
    if(job.source!=='mapbox'||job.allowPreview!==true||job.engineering!==true)throw new Error('ROAD_ENGINEERING_PREVIEW_CONSENT');
    if(this.token!==job.token){this.regions.clear();this.bytes.clear();this.token=job.token;}
    const ids=engineeringRegionsForCell(job.id,job.subdivisions),regions=new Map();
    for(const id of ids){const r=await this.region(id,job.token,signal,consume);
      assertReadSetsCompatible(r.readSet,[...regions.values()].map(x=>x.readSet));regions.set(key(id),r);}
    const readSet=canonicalReadSet([...regions.values()].flatMap(r=>r.readSet));
    const snapshotId=await digest([REAL_ENGINEERING_VERSION,[...regions].map(([k,r])=>[k,r.field.diagnostics.sourceRevision]),readSet]);
    let maxDeltaMeters=0,modifiedSamples=0;
    const source={id:`mapbox.terrain-rgb/${REAL_ENGINEERING_VERSION}/${snapshotId}`,evidenceId:snapshotId,
      verticalReference:'UNRESOLVED_DATUM_PREVIEW',provenance:'estimated',heightAt:p=>{
        const region=regions.get(key(engineeringRegionAt(p)));
        if(!region)throw new Error('ROAD_ENGINEERING_CONTEXT_MISSING');
        const value=region.field.sample(p);
        if(Math.abs(value.deltaMeters)>1e-6)modifiedSamples++;
        maxDeltaMeters=Math.max(maxDeltaMeters,Math.abs(value.deltaMeters));
        return meters(value.heightMeters);
      }};
    const sampler=new TerrainSampler(source,undefined,{allowUnresolvedDatumPreview:true});
    let packet;try{packet=buildTerrainCell(job.id,sampler,job.subdivisions);}finally{sampler.clear();}
    const center=regions.get(key(cellId(16,Math.floor(job.id.x/2**(job.id.level-16)),Math.floor(job.id.y/2**(job.id.level-16)))));
    if(!center)throw new Error('ROAD_ENGINEERING_CONTEXT_MISSING');
    const roadSurface=buildRoadSurface(center.graph,packet);
    const probeHeight=job.probe?source.heightAt(job.probe):null;
    aborted(signal);
    return {packet,roadSurface,texture:null,snapshotId,probeHeight,
      attributions:[...new Set([...regions.values()].flatMap(r=>r.attributions))],evidence:readSet,
      engineering:{version:REAL_ENGINEERING_VERSION,readSet,regions:[...regions.values()].map(r=>r.field.diagnostics),
        maxDeltaMeters,modifiedSamples,qualifiedForDriving:false,boundaryMode:'fixed-raw-collar'}};
  }
  get accountedBytes(){return this.regions.bytes+this.roads.cache.bytes+this.bytes.bytes;}
}
