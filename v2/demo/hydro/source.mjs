import { geodeticToEcef } from '../../src/geo/ecef.ts';
import { ecefToThreeLocal } from '../../src/geo/three-frame.ts';
import { RoadSource } from '../roads/road-source.mjs';
import { loadMapboxPatch } from '../providers/mapbox-raster.mjs';
import { WeightedLru } from '../../src/streaming/weighted-lru.ts';
import { buildRoadGraph } from '../../src/generation/roads/kernel.ts';
import { buildRoadSurface } from '../../src/generation/roads/surface.ts';
import { buildEnvironmentPacket } from '../../src/generation/environment/debug-packet.ts';
import { buildTerrainCell } from '../../src/generation/terrain/terrain-builder.ts';
import { TerrainSampler } from '../../src/generation/terrain/terrain-sampler.ts';
import { HydroConditionedElevationSource, HYDRO_POLICY, HYDRO_VERSION } from '../../src/generation/hydro/conditioned-elevation.ts';
import { buildWaterSurfaceProfile, regionFromProfile } from '../../src/generation/hydro/profiles.ts';
import { certifyHydroTriangles } from '../../src/generation/hydro/certificate.ts';
import { buildWaterSurface, assertWaterReadSets } from '../../src/generation/water/surface.ts';
import { WATER_LIMITS } from '../../src/generation/water/model.ts';
import { prepareWaterGeometry } from '../water/prepare.mjs';
import { cellId } from '../../src/geo/mercator-cell-scheme.ts';
import { deferHydroCrossings } from '../../src/generation/hydro/crossings.ts';
import { unprojectMercator } from '../../src/geo/mercator.ts';
import { geodeticRadians } from '../../src/geo/geodetic.ts';
import { meters } from '../../src/geo/units.ts';
import { value } from '../../src/generation/roads/exact.ts';
import { metricAt } from '../../src/generation/roads/footprint.ts';
import { MAX_ROAD_WIDTH_METERS } from '../../src/generation/roads/surface-style.ts';

/** Keep full canonical edges and all incident joins capable of contributing to
 * this fixed REGION. This is not per-WorldCell clipping or a width reduction.
 * The halo matches the footprint generator's maximum geometric support. */
export function retainHydroRoadContext(graph,id){
  const n=2**id.level,c=[(id.x+.5)/n,(id.y+.5)/n];
  const m=metricAt([c[0],c[1]>.5?(id.y+1)/n:id.y/n]);
  const hx=(MAX_ROAD_WIDTH_METERS/2+1)/m[0],hy=(MAX_ROAD_WIDTH_METERS/2+1)/m[1];
  const near=p=>[value(p.u)+Math.round(c[0]-value(p.u)),value(p.v)];
  const edges=graph.edges.filter(e=>{const a=near(e.a),b=near(e.b);return Math.max(a[0],b[0])>=id.x/n-hx&&Math.min(a[0],b[0])<=(id.x+1)/n+hx&&Math.max(a[1],b[1])>=id.y/n-hy&&Math.min(a[1],b[1])<=(id.y+1)/n+hy;});
  const keys=new Set(edges.map(e=>e.key));
  const nodes=graph.nodes.map(v=>({...v,edges:v.edges.filter(k=>keys.has(k))})).filter(v=>v.edges.length);
  return {...graph,edges,nodes};
}

const abort = signal => { if (signal.aborted) throw new DOMException('Cancelled','AbortError'); };
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(v=>v.toString(16).padStart(2,'0')).join('');
const readset = rows => {
  assertWaterReadSets(rows,[]);
  return [...new Map(rows.map(r=>[`${r.layer}/${r.tile}`,r])).values()].sort((a,b)=>`${a.layer}/${a.tile}`.localeCompare(`${b.layer}/${b.tile}`));
};
/** One source coordinator INSIDE the existing terrain worker. Vector context is
 * reused for conditioned ground, water, roads and environmental diagnostics.
 * No post-mesh vertex edits, second streamer, on-disk provider cache or silent
 * raw-ground fallback. Revisions and the triangle proof travel with the cohort.
 */
export class HydroSource {
  constructor(byteCache, {roads=new RoadSource(), raster=loadMapboxPatch}={}) {
    this.bytes=byteCache;this.roads=roads;this.raster=raster;
    this.regions=new WeightedLru(WATER_LIMITS.regionBytes,WATER_LIMITS.regionEntries);
    this.token=null;this.built=0;
  }
  async region(id,token,signal,consume) {
    abort(signal);
    const z=16,x=Math.floor(id.x/2**(id.level-z)),y=Math.floor(id.y/2**(id.level-z)),key=`${z}/${x}/${y}`;
    const hit=this.regions.get(key);if(hit)return hit;
    const data=await this.roads.load([cellId(z,x,y)],token,signal,32,consume);
    if(data.sourceZoom!==z||data.tiles.some(t=>!t.environment||t.environmentError))throw new Error('HYDRO_VECTOR_CONTEXT_INVALID');
    const completeTiles=data.tiles.map(t=>t.environment).sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey));
    // Keep only hydro features in the large profile context. Landcover/use of
    // neighbouring source tiles remains in the shared LRU, not in every recipe.
    const tiles=completeTiles.map(t=>{const features=t.features.filter(f=>['water','waterway'].includes(f.attributes.layer));return {...t,features,pointCount:features.reduce((s,f)=>s+f.paths.reduce((n,p)=>n+p.length,0),0)};});
    const geometry=tiles.map(t=>prepareWaterGeometry(t));
    const ownerIndex=tiles.findIndex(t=>t.x===x&&t.y===y);
    if(ownerIndex<0)throw new Error('HYDRO_CONTEXT_INCOMPLETE');
    const raw=await this.raster({cells:tiles.map(t=>cellId(t.z,t.x,t.y)),subdivisions:32,token,
      allowPreview:true,signal,byteCache:this.bytes,layers:'terrain',onHttpAttempt:consume});
    const reads=readset([...tiles.map(t=>({layer:'vector',tile:`${t.z}/${t.x}/${t.y}`,sha256:t.digest})),
      ...raw.evidence.filter(e=>e.layer==='elevation').map(e=>({layer:'elevation',tile:e.tile,sha256:e.sha256}))]);
    const revision=await digest([HYDRO_POLICY,key,reads]);abort(signal);
    const profile=buildWaterSurfaceProfile(tiles,geometry,raw.source,revision);
    const source=new HydroConditionedElevationSource(raw.source,profile);
    const region=regionFromProfile(geometry[ownerIndex],profile,tiles.map(t=>t.sourceKey));
    const localGraph=retainHydroRoadContext(buildRoadGraph(data.tiles),cellId(z,x,y));
    const crossings=deferHydroCrossings(localGraph,geometry),graph=crossings.graph;
    // Geometry, numeric views, decoded DEM and nodal cache are all charged.
    const pointCount=geometry.reduce((s,g)=>s+g.primitives.reduce((n,p)=>n+p.polygon.length,0),0);
    const owner=completeTiles[ownerIndex];
    const estimate=(raw.decodedHeightBytes||0)+pointCount*256+tiles.reduce((s,t)=>s+t.pointCount*192,0)+owner.pointCount*192+graph.edges.length*1200+graph.nodes.length*256+786432;
    const result={key,revision,reads,source,raw:raw.source,region,profile,graph,tiles:[owner],deferredStructures:crossings.deferredStructures,
      attributions:[...raw.attributions,data.attribution],estimatedBytes:estimate};
    abort(signal);if(!this.regions.set(key,result,estimate))throw new Error('HYDRO_REGION_BUDGET');this.built++;
    return result;
  }
  async build(job,signal,consume) {
    abort(signal);
    if(job.source!=='mapbox'||job.allowPreview!==true||job.hydro!==true||job.engineering)throw new Error('HYDRO_PREVIEW_CONTRACT');
    if(![19,21].includes(job.id.level)||job.subdivisions!==32)throw new Error('HYDRO_RESOLUTION_REQUIRED');
    if(this.token!==job.token){this.regions.clear();this.bytes.clear();this.token=job.token;this.built=0;}
    const start=performance.now(),r=await this.region(job.id,job.token,signal,consume);
    const sampler=new TerrainSampler(r.source,undefined,{allowUnresolvedDatumPreview:true});
    let packet;try{packet=buildTerrainCell(job.id,sampler,32);}finally{sampler.clear();}
    abort(signal);
    const water=buildWaterSurface(r.region,packet,r.reads,{hydroRevision:r.revision});
    const certificate=certifyHydroTriangles(packet,water);
    if(!certificate.passed)throw new Error('HYDRO_TRIANGLE_CONFLICT');
    const rawPositions=new Float32Array(packet.positions.length),rawHeightsMeters=new Float64Array(packet.heightsMeters.length);let maxLoweringMeters=0,modifiedSamples=0;
    for(let y=0;y<=32;y++)for(let x=0;x<=32;x++){
      const g=unprojectMercator({u:(job.id.x*32+x)/2**(job.id.level+5),v:(job.id.y*32+y)/2**(job.id.level+5)}),i=y*33+x;
      rawHeightsMeters[i]=r.raw.heightAt(geodeticRadians(g.longitudeRad,g.latitudeRad,meters(0)));
      rawPositions.set(ecefToThreeLocal(geodeticToEcef(geodeticRadians(g.longitudeRad,g.latitudeRad,meters(rawHeightsMeters[i]))),packet.anchor),i*3);
      const d=rawHeightsMeters[i]-packet.heightsMeters[i];maxLoweringMeters=Math.max(maxLoweringMeters,d);if(d>1e-7)modifiedSamples++;
    }
    const rawCertificate=certifyHydroTriangles({...packet,positions:rawPositions},water);
    const maxWaterAboveRawTerrainMeters=rawCertificate.maxWaterAboveTerrainMeters;
    // Closed standing bodies may have a genuinely lower interior DEM. Their
    // bank envelope (not their bottom) constrains the level. Other bodies must
    // not introduce positive water-over-raw gaps; confirm the rendered result.
    if(!r.region.geometry.basins.length && maxWaterAboveRawTerrainMeters!==null && maxWaterAboveRawTerrainMeters>HYDRO_POLICY.numericalToleranceMeters)
      throw new Error('HYDRO_WATER_ABOVE_RAW_TERRAIN');
    // Keep known bridge/tunnel strata out of the ground renderer. A road whose
    // centreline enters water is not silently converted to a ford or sunken road.
    // Record the ambiguity; this PR creates neither decks nor tunnels.
    const deferredStructures=r.deferredStructures;
    const roadSurface=buildRoadSurface(r.graph,packet);
    const owner=r.tiles.find(t=>t.x===r.region.x&&t.y===r.region.y);
    const environment=buildEnvironmentPacket([owner],packet);
    const snapshotId=await digest([HYDRO_VERSION,r.revision,job.id,job.subdivisions]);abort(signal);
    // Probe is used only for spawn and always queried from the SAME derived view.
    const probeHeight=job.probe?Number(r.source.heightAt(job.probe)):null;
    return {packet,roadSurface,water,environment,rawHeightsMeters,texture:null,snapshotId,probeHeight,
      evidence:r.reads,attributions:r.attributions,
      hydro:{version:HYDRO_VERSION,revision:r.revision,region:r.key,readSet:r.reads,
        policy:HYDRO_POLICY,certificate,maxWaterAboveRawTerrainMeters,levelAuthority:'bank-constrained-lower-envelope-preview',maxLoweringMeters,modifiedSamples,deferredStructures,
        structureStatus:deferredStructures?'STRUCTURE_REQUIRED':'none',
        kinds:[...new Set(r.profile.footprints.map(f=>f.kind))].sort(),
        depthAuthority:'preview-artificial-hydro-clearance',generationMs:performance.now()-start}};
  }
  get accountedBytes(){return this.regions.bytes+this.roads.cache.bytes+this.bytes.bytes;}
}
