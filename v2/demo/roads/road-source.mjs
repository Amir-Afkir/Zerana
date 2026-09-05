import { normalizeMapboxRoad } from '../../src/providers/vectors/mapbox-roads.ts';
import { WeightedLru } from '../../src/streaming/weighted-lru.ts';
import { ROAD_LIMITS } from '../../src/generation/roads/model.ts';
import { cellId } from '../../src/geo/mercator-cell-scheme.ts';
import { isPublicMapboxToken } from '../site-token.mjs';
import { decodeRoadMvt,MAX_MVT_BYTES } from './mvt-roads.mjs';

export const ROAD_HTTP_LIMIT=32;
const TILESET='mapbox.mapbox-streets-v8';
const aborted=signal=>{if(signal.aborted)throw new DOMException('Cancelled','AbortError');};
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
export function planRoadTiles(cells,maxzoom){
  if(!Number.isInteger(maxzoom)||maxzoom<0||maxzoom>24||!cells.length||cells.length>9)throw new Error('ROAD_PLAN_CONTRACT');
  const level=cells[0].level,z=Math.min(level,maxzoom),n=2**z,scale=2**(level-z),ids=new Map();
  for(const c of cells){
    if(c.scheme!=='web-mercator'||c.level!==level||c.level<15||c.level>24)throw new Error('ROAD_CELL_CONTRACT');
    cellId(c.level,c.x,c.y);
    const x=Math.floor(c.x/scale),y=Math.floor(c.y/scale);
    // One source-tile context ring, not a claimed metric road-width halo.
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(y+dy<0||y+dy>=n)continue;
      const xx=((x+dx)%n+n)%n,key=`${z}/${xx}/${y+dy}`;
      ids.set(key,{z,x:xx,y:y+dy});
      if(ids.size>ROAD_LIMITS.maxTiles)throw new Error('ROAD_TILE_BUDGET');
    }
  }
  return [...ids].sort(([a],[b])=>a.localeCompare(b)).map(([,id])=>id);
}
export function parseRoadMetadata(json){
  if(!json||!Number.isInteger(json.maxzoom)||json.maxzoom<0||json.maxzoom>24||
     (json.scheme&&json.scheme!=='xyz')||!Array.isArray(json.vector_layers)||!json.vector_layers.some(l=>l.id==='road')||
     typeof json.attribution!=='string'||!json.attribution.trim()||json.attribution.length>16384)throw new Error('ROAD_TILEJSON_CONTRACT');
  return {maxzoom:json.maxzoom,attribution:json.attribution,
    version:typeof json.modified==='number'&&Number.isFinite(json.modified)?String(json.modified):'live-unversioned'};
}
/** Fixed allowlisted endpoint. No arbitrary TileJSON URL/template is executed.
 * No persistence; one bounded worker-local decoded LRU, tied to this token. */
export class RoadSource {
  // Native WorkerGlobalScope.fetch requires its global receiver, unlike Node mocks.
  constructor(fetcher=(url,init)=>globalThis.fetch(url,init)){this.fetcher=fetcher;this.cache=new WeightedLru(16*1048576,16);this.token=null;this.metadata=null;}
  async load(cells,token,signal,grant){
    if(!isPublicMapboxToken(token)||!Number.isInteger(grant)||grant<0||grant>ROAD_HTTP_LIMIT)throw new Error('ROAD_REQUEST_CONTRACT');
    if(this.token!==token){this.cache.clear();this.metadata=null;this.token=token;}
    let attempts=0;
    const request=async path=>{
      aborted(signal);if(attempts>=grant)throw new Error('ROAD_HTTP_BUDGET');attempts++;
      const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
      let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},12000);
      try{
        const response=await this.fetcher(`https://api.mapbox.com/v4/${path}?access_token=${encodeURIComponent(token)}`,{signal:controller.signal,credentials:'omit',redirect:'error'});
        if(!response.ok)throw new Error(response.status===401||response.status===403?'ROAD_PROVIDER_AUTH':response.status===429?'ROAD_RATE_LIMIT':'ROAD_PROVIDER_HTTP');
        if(Number(response.headers.get('content-length'))>MAX_MVT_BYTES)throw new Error('ROAD_RESPONSE_BUDGET');
        const reader=response.body.getReader(),parts=[];let size=0;
        try{while(true){aborted(controller.signal);const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>MAX_MVT_BYTES)throw new Error('ROAD_RESPONSE_BUDGET');parts.push(value);}}
        catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
        const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
      }catch(error){if(signal.aborted)throw new DOMException('Cancelled','AbortError');if(timedOut)throw new Error('ROAD_TIMEOUT');if(error instanceof TypeError)throw new Error('ROAD_NETWORK_OR_CORS');throw error;}
      finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
    };
    try{
      if(!this.metadata){const bytes=await request(`${TILESET}.json`);this.metadata=parseRoadMetadata(JSON.parse(new TextDecoder().decode(bytes)));}
      const ids=planRoadTiles(cells,this.metadata.maxzoom),tiles=[];let payload=0;
      for(const id of ids){
        aborted(signal);const key=`${id.z}/${id.x}/${id.y}`;let tile=this.cache.get(key);
        if(!tile){
          const bytes=await request(`${TILESET}/${key}.vector.pbf`);
          tile=decodeRoadMvt(bytes,id,{providerId:TILESET,version:this.metadata.version,digest:await sha(bytes)});
          this.cache.set(key,tile,tile.decodedBytes);
        }
        payload+=tile.decodedBytes;if(payload>32*1048576)throw new Error('ROAD_DECODED_BUDGET');tiles.push(tile);
      }
      return {tiles,attribution:this.metadata.attribution,attempts,sourceZoom:ids[0].z,cacheBytes:this.cache.bytes,cacheHits:this.cache.hits};
    }catch(error){error.attempts=attempts;throw error;}
  }
}
/** Deterministic, explicitly fictitious centerlines for geometry regression. */
export function syntheticRoadTiles(cells){
  return planRoadTiles(cells,Math.min(16,cells[0].level)).map(id=>{
    const features=[],extent=4096;
    const append=(points,c='street',t='residential',structure='none',layer=0)=>features.push({attributes:normalizeMapboxRoad({class:c,type:t,structure,layer,oneway:'false',surface:'paved'}),lines:[points]});
    for(const q of [1024,2048,3072]){
      append([[-1024,q],[2048,q],[5120,q]]);
      append([[q,-1024],[q,2048],[q,5120]],'path','footway');
    }
    append([[0,0],[2048,2048],[4096,4096]],'street','residential','bridge',1);
    return {...id,extent,providerId:'zerana-synthetic-roads',version:'1',digest:'0'.repeat(64),features};
  });
}
