import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { decodeRoadLayer, MAX_MVT_BYTES } from '../roads/mvt-roads.mjs';
import { canonicalizeEnvironmentTile } from '../../src/generation/environment/kernel.ts';
import { ENV_LAYERS, ENV_LIMITS as L } from '../../src/generation/environment/model.ts';
import { normalizeMapboxEnvironment } from '../../src/providers/vectors/mapbox-environment.ts';

/** Bounded command decoder. ClosePath is consumed, not materialized as an extra
 * point. No unbounded loadGeometry(), global prototype patch or raw-byte cache. */
export function environmentPaths(feature,remaining){
  const p=feature._pbf;if(!p||!Number.isInteger(feature._geometry)||feature._geometry<0)throw new Error('ENV_MVT_GEOMETRY');
  p.pos=feature._geometry;const end=p.readVarint()+p.pos;
  if(!Number.isSafeInteger(end)||end>p.length)throw new Error('ENV_MVT_TRUNCATED');
  let path=null,x=0,y=0,points=0,closed=true;const paths=[],polygon=feature.type===3;
  while(p.pos<end){
    const cmd=p.readVarint(),id=cmd%8,count=Math.floor(cmd/8);
    if(!Number.isSafeInteger(cmd)||cmd<0||cmd>0xffffffff||count<1)throw new Error('ENV_MVT_COMMAND');
    if(id===7){
      if(!polygon||count!==1||closed||!path||path.length<3)throw new Error('ENV_MVT_CLOSE');
      closed=true;continue;
    }
    if(![1,2].includes(id)||(id===1&&count!==1)||(id===2&&(!path||closed)))throw new Error('ENV_MVT_COMMAND');
    if(id===1){
      if(path&&((polygon&&!closed)||path.length<(polygon?3:2)))throw new Error('ENV_MVT_PATH');
      if(paths.length>=L.maxPaths)throw new Error('ENV_PATH_BUDGET');
      path=[];paths.push(path);closed=false;
    }
    if(points+count>remaining)throw new Error('ENV_POINT_BUDGET');
    for(let i=0;i<count;i++){
      x+=p.readSVarint();y+=p.readSVarint();points++;
      if(p.pos>end||![x,y].every(Number.isSafeInteger)||[x,y].some(v=>v < -feature.extent||v>2*feature.extent))throw new Error('ENV_MVT_COORDINATE');
      path.push([x,y]);
    }
  }
  if(p.pos!==end||!path||path.length<(polygon?3:2)||(polygon&&!closed))throw new Error('ENV_MVT_PATH');
  return {paths,points};
}
/** ONE protobuf tile and one shared immutable source snapshot for all layers.
 * Environmental corruption is isolated: a valid road tile remains usable. */
export function decodeVectorSnapshot(bytes,id,metadata){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_MVT_BYTES)throw new Error('ROAD_RESPONSE_BUDGET');
  const tile=new VectorTile(new Pbf(bytes)),road=decodeRoadLayer(tile,id,metadata);
  try{
    let points=0,features=0,ignored=0;const layers=[];
    for(const name of ENV_LAYERS){
      const layer=tile.layers[name],decoded=[];
      if(!layer){layers.push({name,extent:4096,features:decoded,state:'absent'});continue;}
      if(![1,2].includes(layer.version)||!Number.isInteger(layer.extent)||layer.extent<1||layer.extent>L.maxTileExtent)throw new Error('ENV_MVT_LAYER');
      features+=layer.length;if(features>L.maxFeatures)throw new Error('ENV_FEATURE_BUDGET');
      for(let i=0;i<layer.length;i++){
        const f=layer.feature(i),expected=name==='waterway'?2:3;
        if(f.type!==expected){ignored++;continue;}
        const geometry=environmentPaths(f,L.maxPoints-points);points+=geometry.points;
        decoded.push({sourceIndex:i,attributes:normalizeMapboxEnvironment(name,f.properties),geometry:expected===3?'polygon':'line',paths:geometry.paths});
      }
      layers.push({name,extent:layer.extent,features:decoded,state:'present'});
    }
    const decodedBytes=road.decodedBytes+points*192+features*1024+1024;
    if(decodedBytes>16*1048576)throw new Error('ENV_SOURCE_CACHE_BUDGET');
    return {...road,roadDecodedBytes:road.decodedBytes,environment:canonicalizeEnvironmentTile({...metadata,...id,layers}),environmentError:null,ignoredEnvironmentGeometries:ignored,
      decodedBytes};
  }catch(error){
    return {...road,roadDecodedBytes:road.decodedBytes,environment:null,environmentError:/^ENV_[A-Z_]+$/.test(error.message)?error.message:'ENV_DECODE_FAILED'};
  }
}
