import { normalizeMapboxRoad } from '../../src/providers/vectors/mapbox-roads.ts';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { ROAD_LIMITS } from '../../src/generation/roads/model.ts';

export const MAX_MVT_BYTES=4*1024*1024;
/** @mapbox/vector-tile 1.3.1 handles the protobuf tables. Geometry is read with
 * an explicit point budget BEFORE allocation, using its lazy geometry offset.
 * This small adapter is tied to the existing locked library and cross-tested
 * against loadGeometry(). No library or global prototype is patched. */
function boundedLines(feature,remaining){
  const pbf=feature._pbf;
  if(!pbf||!Number.isInteger(feature._geometry)||feature._geometry<0)throw new Error('ROAD_MVT_GEOMETRY');
  pbf.pos=feature._geometry;
  const length=pbf.readVarint(),end=pbf.pos+length;
  if(!Number.isSafeInteger(end)||end>pbf.length)throw new Error('ROAD_MVT_TRUNCATED');
  const lines=[];let line=null,x=0,y=0,points=0;
  while(pbf.pos<end){
    const command=pbf.readVarint(),id=command%8,count=Math.floor(command/8);
    if(!Number.isSafeInteger(command)||command<0||command>0xffffffff||count<1||![1,2].includes(id)||
       (id===1&&count!==1)||(id===2&&!line))throw new Error('ROAD_MVT_COMMAND');
    if(points+count>remaining)throw new Error('ROAD_POINT_BUDGET');
    if(id===1){if(line&&line.length<2)throw new Error('ROAD_INVALID_LINE');line=[];lines.push(line);}
    for(let i=0;i<count;i++){
      x+=pbf.readSVarint();y+=pbf.readSVarint();points++;
      if(pbf.pos>end||![x,y].every(Number.isSafeInteger)||[x,y].some(v=>v < -feature.extent||v > 2*feature.extent))throw new Error('ROAD_MVT_COORDINATE');
      line.push([x,y]);
    }
  }
  if(pbf.pos!==end||!line||line.length<2)throw new Error('ROAD_INVALID_LINE');
  return {lines,points};
}
export function decodeRoadMvt(bytes,id,metadata){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_MVT_BYTES)throw new Error('ROAD_RESPONSE_BUDGET');
  return decodeRoadLayer(new VectorTile(new Pbf(bytes)),id,metadata);
}
export function decodeRoadLayer(tile,id,metadata){
  const layer=tile.layers.road;
  // Missing road layer is a valid empty tile, but metadata must advertise roads.
  if(!layer)return {...metadata,...id,extent:4096,features:[],ignoredGeometries:0,decodedBytes:128};
  if(![1,2].includes(layer.version)||!Number.isInteger(layer.extent)||layer.extent<1||layer.extent>ROAD_LIMITS.maxExtent||layer.length>ROAD_LIMITS.maxFeatures)throw new Error('ROAD_MVT_LAYER');
  const features=[];let count=0,ignoredGeometries=0;
  for(let i=0;i<layer.length;i++){
    const feature=layer.feature(i);
    if(feature.type!==2){ignoredGeometries++;continue;}
    const attributes=normalizeMapboxRoad(feature.properties);if(!attributes)continue;
    const decoded=boundedLines(feature,ROAD_LIMITS.maxPoints-count);count+=decoded.points;
    features.push({attributes,lines:decoded.lines});
  }
  return {...metadata,...id,extent:layer.extent,features,ignoredGeometries,
    // Conservative payload accounting, not a measurement of the JS heap.
    decodedBytes:count*48+features.length*1024+256};
}
