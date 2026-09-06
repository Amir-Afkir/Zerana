import { WeightedLru } from '../../src/streaming/weighted-lru.ts';
import { cellId } from '../../src/geo/mercator-cell-scheme.ts';
import { box } from '../../src/generation/roads/exact.ts';
import { overlaps } from '../../src/generation/water/geometry.ts';
import { WATER_LIMITS as L,WATER_VERSION } from '../../src/generation/water/model.ts';
import { buildHydroRegion } from '../../src/generation/water/hydro.ts';
import { buildWaterSurface,assertWaterReadSets } from '../../src/generation/water/surface.ts';
import { syntheticElevation } from '../../src/generation/terrain/synthetic-elevation.ts';
import { loadMapboxPatch } from '../providers/mapbox-raster.mjs';
import { elevationReads } from './readset.mjs';
import { prepareWaterGeometry } from './prepare.mjs';

export { elevationReads } from './readset.mjs';
const geometryBytes=g=>g.primitives.reduce((n,p)=>n+p.polygon.length*192+256,0)+g.basins.reduce((n,b)=>n+b.samples.length*192+b.rings.reduce((s,r)=>s+r.length*192,0),0)+2048;
/** One passive consumer in the existing vector worker. Fixed geographic DEM
 * context, one bounded region LRU and session-only PNG cache. No imagery fetch,
 * no independent streaming loop, no hidden retry, no persistent Mapbox data. */
export class WaterSource {
  constructor(loader=loadMapboxPatch){this.loader=loader;this.regions=new WeightedLru(L.regionBytes,L.regionEntries);this.raw=new WeightedLru(4194304,32);this.geometries=new WeightedLru(4194304,8);this.token=null;this.built=0;}
  get bytes(){return this.regions.bytes+this.raw.bytes+this.geometries.bytes;}
  async build({tiles,terrain,source,profile,token,evidence=[],signal,onAttempt=()=>{}}){
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const credential=`${source}/${profile}/${token||''}`;
    if(this.token!==credential){this.regions.clear();this.raw.clear();this.geometries.clear();this.token=credential;this.built=0;}
    const z=tiles[0]?.z;
    if(!Number.isInteger(z)||z<15||z>16||terrain.id.level<z||terrain.id.level>21)throw new Error('WATER_CELL_LEVEL');
    const x=Math.floor(terrain.id.x/2**(terrain.id.level-z)),y=Math.floor(terrain.id.y/2**(terrain.id.level-z)),n=2**z;
    const owner=tiles.find(t=>t.x===x&&t.y===y);
    if(!owner||tiles.some(t=>t.z!==z||t.providerId!==owner.providerId||t.version!==owner.version))throw new Error('WATER_CONTEXT_INCOMPLETE');
    const key=`${WATER_VERSION}/${source}/${profile}/${tiles.map(t=>t.sourceKey).sort().join('|')}/${x}/${y}`;
    let stored=this.regions.get(key);
    if(!stored){
      let geometry=this.geometries.get(owner.sourceKey);
      if(!geometry){geometry=prepareWaterGeometry(owner);const bytes=geometryBytes(geometry);
        if(bytes<=4194304)this.geometries.set(owner.sourceKey,geometry,bytes);}
      if(!geometry.primitives.some(p=>overlaps(p.bounds,box(terrain.id.level,terrain.id.x,terrain.id.y)))){
        // A valid empty cell requires no elevation query. No fictitious level is
        // published: the packet has no vertices and both height bounds are null.
        const region={key:`${WATER_VERSION}/empty/${owner.sourceKey}`,z,x,y,geometry,sourceTiles:[owner.sourceKey],
          levels:new Float64Array((L.gridDivisions+1)**2),basinLevels:new Map(),verticalReference:terrain.verticalReference,heightAuthority:'estimated-not-hydraulically-qualified'};
        return {packet:buildWaterSurface(region,terrain,[{layer:'vector',tile:owner.sourceKey.split('@')[0],sha256:owner.digest}]),attributions:[],cacheBytes:this.bytes,built:this.built};
      }
      const cells=[];
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(y+dy>=0&&y+dy<n)cells.push(cellId(z,(x+dx+n)%n,y+dy));
      const patch=source==='mapbox'?await this.loader({cells,subdivisions:32,token,allowPreview:true,signal,byteCache:this.raw,layers:'terrain',onHttpAttempt:onAttempt}):null;
      const heights=patch?.source||syntheticElevation(profile),region=buildHydroRegion(geometry,tiles,heights);
      const readSet=[...tiles.map(t=>({layer:'vector',tile:t.sourceKey.split('@')[0],sha256:t.digest})),...elevationReads(patch?.evidence)];
      if(signal.aborted)throw new DOMException('Cancelled','AbortError');
      stored={region,readSet,attributions:patch?.attributions||[]};
      // Accounts retained arrays and exact-geometry bookkeeping conservatively;
      // neither this nor the packet counter is a full browser heap measurement.
      const bytes=region.levels.byteLength+geometryBytes(geometry)+readSet.length*256+8192;
      if(bytes>L.regionBytes)throw new Error('WATER_REGION_BUDGET');
      this.regions.set(key,stored,bytes);this.built++;
    }
    assertWaterReadSets(stored.readSet,[elevationReads(evidence)]);
    return {packet:buildWaterSurface(stored.region,terrain,stored.readSet),attributions:stored.attributions,cacheBytes:this.bytes,built:this.built};
  }
}
