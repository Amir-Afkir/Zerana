import type { WorldCellId } from '../../geo/cell-scheme.js';
import { cellId } from '../../geo/mercator-cell-scheme.js';
import { ENV_LIMITS as L, ENV_LAYERS } from './model.js';
import type { EnvironmentTile, EnvironmentAttributes, TilePoint } from './model.js';
import { fraction, box, clip, compare, sub, mul, value, ONE } from '../roads/exact.js';
import type { RoadPoint, ExactBox } from '../roads/exact.js';

export interface EnvironmentShape {
  readonly key:string; readonly attributes:EnvironmentAttributes;
  readonly geometry:'polygon'|'line'; readonly paths:readonly (readonly RoadPoint[])[];
  /** Each polygon consists of one exterior followed by its holes. */
  readonly polygons:readonly (readonly (readonly RoadPoint[])[])[];
  readonly bounds:ExactBox;
}
export interface CanonicalEnvironmentTile {
  readonly providerId:string; readonly version:string; readonly digest:string;
  readonly z:number; readonly x:number; readonly y:number; readonly core:ExactBox;
  readonly features:readonly EnvironmentShape[]; readonly sourceKey:string;
  readonly absentLayers:readonly string[]; readonly pointCount:number;
}
export interface EnvironmentFragment {
  readonly shape:EnvironmentShape; readonly mask:ExactBox;
  /** Deliberately NOT flattened/clipped rings: P intersect rectangle retains
   * holes and disconnected components without inventing connecting edges. */
  readonly representation:'polygon-intersect-box'|'line-intersect-box';
  readonly boundaries:readonly (readonly [RoadPoint,RoadPoint])[];
}
export interface EnvironmentCell {
  readonly schema:'environment-kernel-v1'; readonly cellKey:string;
  readonly fragments:readonly EnvironmentFragment[]; readonly sourceTiles:readonly string[];
  readonly missingLayers:readonly string[]; readonly sourceZoom:number;
}
const minimum=(a:ReturnType<typeof fraction>,b:ReturnType<typeof fraction>)=>compare(a,b)<0?a:b;
const maximum=(a:ReturnType<typeof fraction>,b:ReturnType<typeof fraction>)=>compare(a,b)>0?a:b;
function intersection(a:ExactBox,b:ExactBox):ExactBox|null {
  const r={west:maximum(a.west,b.west),north:maximum(a.north,b.north),east:minimum(a.east,b.east),south:minimum(a.south,b.south)};
  return compare(r.west,r.east)<0&&compare(r.north,r.south)<0?r:null;
}
function insideBox(p:RoadPoint,r:ExactBox,halfOpen=false):boolean {
  return compare(p.u,r.west)>=0&&compare(p.v,r.north)>=0&&compare(p.u,r.east)<(halfOpen?0:1)&&
    compare(p.v,r.south)<(halfOpen&&compare(r.south,ONE)!==0?0:1);
}
function signArea(path:readonly TilePoint[]):bigint {
  let a=0n;for(let i=0;i<path.length;i++){const p=path[i]!,q=path[(i+1)%path.length]!;a+=BigInt(p[0])*BigInt(q[1])-BigInt(q[0])*BigInt(p[1]);}return a;
}
/** Exact even/odd predicate. Boundary is reported separately; no epsilon weld. */
export function pointInRing(p:RoadPoint,ring:readonly RoadPoint[]):'inside'|'outside'|'boundary' {
  let inside=false;
  for(let i=0;i<ring.length;i++){
    const a=ring[i]!,b=ring[(i+1)%ring.length]!;
    const cross=sub(mul(sub(b.u,a.u),sub(p.v,a.v)),mul(sub(b.v,a.v),sub(p.u,a.u)));
    if(cross.n===0n&&compare(p.u,minimum(a.u,b.u))>=0&&compare(p.u,maximum(a.u,b.u))<=0&&
       compare(p.v,minimum(a.v,b.v))>=0&&compare(p.v,maximum(a.v,b.v))<=0)return 'boundary';
    if((compare(a.v,p.v)>0)!==(compare(b.v,p.v)>0)){
      if((cross.n>0n)===(compare(b.v,a.v)>0))inside=!inside;
    }
  }
  return inside?'inside':'outside';
}
function polygonContains(s:EnvironmentShape,p:RoadPoint):boolean {
  return s.polygons.some(poly=>pointInRing(p,poly[0]!)!=='outside'&&poly.slice(1).every(hole=>pointInRing(p,hole)==='outside'));
}
/** Preserve every matching classification. A park is NOT proof of grass, and
 * an overlap is NOT a confidence percentage. Hole boundaries exclude coverage. */
export function environmentAt(cell:EnvironmentCell,p:RoadPoint):readonly EnvironmentAttributes[] {
  return cell.fragments.filter(f=>f.shape.geometry==='polygon'&&insideBox(p,f.mask,true)&&polygonContains(f.shape,p)).map(f=>f.shape.attributes);
}
/** Prepared once per source snapshot, reused by all WorldCells in the worker.
 * Identity is scoped to bytes/layer/feature position, never a persistent LakeID. */
export function canonicalizeEnvironmentTile(t:EnvironmentTile):CanonicalEnvironmentTile {
  const n=2**t.z;
  if(!Number.isInteger(t.z)||t.z<0||t.z>24||!Number.isInteger(t.x)||t.x<0||t.x>=n||!Number.isInteger(t.y)||t.y<0||t.y>=n||
    !t.providerId||t.providerId.length>128||!t.version||t.version.length>128||!(/^[a-f0-9]{64}$/.test(t.digest))||
    !Array.isArray(t.layers)||t.layers.length>4)throw new Error('ENV_TILE_CONTRACT');
  const sourceKey=`${t.z}/${t.x}/${t.y}@${t.digest}`,features:EnvironmentShape[]=[],seen=new Set<string>(),absentLayers:string[]=[];
  let points=0,pathsCount=0;
  for(const layer of t.layers){
    if(!ENV_LAYERS.includes(layer.name)||seen.has(layer.name)||!Number.isInteger(layer.extent)||layer.extent<1||layer.extent>L.maxTileExtent||
      !['present','absent'].includes(layer.state))throw new Error('ENV_LAYER_CONTRACT');
    seen.add(layer.name);if(layer.state==='absent'){if(layer.features.length)throw new Error('ENV_ABSENT_LAYER');absentLayers.push(layer.name);}
    const indices=new Set<number>();
    for(const f of layer.features){
      if(features.length>=L.maxFeatures)throw new Error('ENV_FEATURE_BUDGET');
      if(!Number.isSafeInteger(f.sourceIndex)||f.sourceIndex<0||indices.has(f.sourceIndex)||f.attributes.layer!==layer.name||
        f.attributes.authority!=='source-classification'||f.attributes.waterHeightMeters!==null||
        f.geometry!==(layer.name==='waterway'?'line':'polygon'))throw new Error('ENV_FEATURE_CONTRACT');
      indices.add(f.sourceIndex);
      const paths:RoadPoint[][]=[],polygons:RoadPoint[][][]=[];let current:RoadPoint[][]|null=null;
      let west:RoadPoint['u']|null=null;let east:RoadPoint['u']|null=null;let north:RoadPoint['v']|null=null;let south:RoadPoint['v']|null=null;
      for(const raw of f.paths){
        points+=raw.length;if(points>L.maxPoints||++pathsCount>L.maxPaths)throw new Error('ENV_POINT_BUDGET');
        if(raw.length<(f.geometry==='polygon'?3:2))throw new Error('ENV_PATH_CONTRACT');
        const path:RoadPoint[]=[];
        for(const p of raw){
          if(p.length!==2||!p.every(Number.isSafeInteger)||p.some((v:number)=>v < -layer.extent||v>2*layer.extent))throw new Error('ENV_COORDINATE');
          const d=BigInt(layer.extent)*2n**BigInt(t.z);
          const q={u:fraction(BigInt(t.x)*BigInt(layer.extent)+BigInt(p[0]),d),v:fraction(BigInt(t.y)*BigInt(layer.extent)+BigInt(p[1]),d)};
          west=west===null?q.u:minimum(west,q.u);east=east===null?q.u:maximum(east,q.u);
          north=north===null?q.v:minimum(north,q.v);south=south===null?q.v:maximum(south,q.v);path.push(q);
        }
        paths.push(path);
        if(f.geometry==='polygon'){
          const area=signArea(raw);if(area===0n)throw new Error('ENV_ZERO_AREA_RING');
          if(area>0n){current=[path];polygons.push(current);}else{if(!current)throw new Error('ENV_ORPHAN_HOLE');current.push(path);}
        }
      }
      if(west===null||east===null||north===null||south===null)throw new Error('ENV_EMPTY_FEATURE');
      features.push({key:`${t.providerId}/${t.version}/${sourceKey}/${layer.name}/${f.sourceIndex}`,attributes:f.attributes,
        geometry:f.geometry,paths,polygons,bounds:{west,east,north,south}});
    }
  }
  return {providerId:t.providerId,version:t.version,digest:t.digest,z:t.z,x:t.x,y:t.y,core:box(t.z,t.x,t.y),
    features:features.sort((a,b)=>a.key.localeCompare(b.key)),sourceKey,absentLayers:absentLayers.sort(),pointCount:points};
}
export function clipEnvironmentCell(tiles:readonly CanonicalEnvironmentTile[],id:WorldCellId):EnvironmentCell {
  if(id.scheme!=='web-mercator'||id.level<15||id.level>24)throw new Error('ENV_CELL_CONTRACT');cellId(id.level,id.x,id.y);
  if(!tiles.length||tiles.length>L.maxTiles)throw new Error('ENV_TILE_BUDGET');
  const map=new Map<string,CanonicalEnvironmentTile>(),first=tiles[0]!,fragments:EnvironmentFragment[]=[],sourceTiles:string[]=[],missing=new Set<string>();
  for(const t of tiles){
    if(t.z!==first.z||t.providerId!==first.providerId||t.version!==first.version)throw new Error('ENV_MIXED_SOURCE');
    const k=`${t.z}/${t.x}/${t.y}`,old=map.get(k);if(old&&old.digest!==t.digest)throw new Error('ENV_SNAPSHOT_CONFLICT');map.set(k,t);
  }
  let examined=0,segments=0;const bounds=box(id.level,id.x,id.y);
  for(const [,t] of [...map].sort(([a],[b])=>a.localeCompare(b))){
    const mask=intersection(t.core,bounds);if(!mask)continue;
    sourceTiles.push(t.sourceKey);for(const name of t.absentLayers)missing.add(name);
    examined+=t.pointCount;if(examined>L.maxCellPoints)throw new Error('ENV_CELL_POINT_BUDGET');
    for(const shape of t.features){
      // Closed bbox test also admits vertical/horizontal line geometries.
      if(compare(shape.bounds.east,mask.west)<0||compare(shape.bounds.west,mask.east)>0||compare(shape.bounds.south,mask.north)<0||compare(shape.bounds.north,mask.south)>0)continue;
      const boundaries:(readonly [RoadPoint,RoadPoint])[]=[];
      for(const path of shape.paths){
        const end=shape.geometry==='polygon'?path.length:path.length-1;
        for(let i=0;i<end;i++){
          const a=path[i]!,b=path[(i+1)%path.length]!,c=clip(a,b,mask);if(!c)continue;
          // Source-core cut edges must not be presented as known shorelines.
          if(shape.geometry==='polygon'&&((compare(a.u,b.u)===0&&[t.core.west,t.core.east].some(x=>compare(a.u,x)===0))||
             (compare(a.v,b.v)===0&&[t.core.north,t.core.south].some(y=>compare(a.v,y)===0))))continue;
          if(++segments>L.maxSegments)throw new Error('ENV_SEGMENT_BUDGET');boundaries.push(c);
        }
      }
      const corners=[{u:mask.west,v:mask.north},{u:mask.east,v:mask.north},{u:mask.west,v:mask.south},{u:mask.east,v:mask.south}];
      if(!boundaries.length&&!(shape.geometry==='polygon'&&corners.some(p=>polygonContains(shape,p))))continue;
      if(fragments.length>=L.maxFragments)throw new Error('ENV_FRAGMENT_BUDGET');
      fragments.push({shape,mask,representation:shape.geometry==='polygon'?'polygon-intersect-box':'line-intersect-box',boundaries});
    }
  }
  if(!sourceTiles.length)throw new Error('ENV_SOURCE_COVERAGE');
  // Full coverage, including cells coarser than the selected source zoom.
  const expected=first.z<=id.level?1:4**(first.z-id.level);
  if(sourceTiles.length!==expected)throw new Error('ENV_SOURCE_COVERAGE');
  return {schema:'environment-kernel-v1',cellKey:`web-mercator/${id.level}/${id.x}/${id.y}`,fragments,sourceTiles,missingLayers:[...missing].sort(),sourceZoom:first.z};
}
/** Numeric bounds are a diagnostic convenience, never clipping authority. */
export function environmentBounds(f:EnvironmentFragment):readonly number[]{return [value(f.mask.west),value(f.mask.north),value(f.mask.east),value(f.mask.south)];}
