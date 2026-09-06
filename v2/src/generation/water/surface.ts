import type { TerrainCellPacket } from '../terrain/terrain-builder.js';
import { unprojectMercator } from '../../geo/mercator.js';
import { geodeticRadians } from '../../geo/geodetic.js';
import { geodeticToEcef } from '../../geo/ecef.js';
import { ecefToThreeLocal,enuToThree } from '../../geo/three-frame.js';
import { rotate,vector } from '../../geo/linear.js';
import { meters } from '../../geo/units.js';
import { box,value,pointKey } from '../roads/exact.js';
import { area2,bounds,overlaps,rectangle,intersect,partition } from './geometry.js';
import type { Polygon } from './geometry.js';
import { pointInRing } from '../environment/kernel.js';
import { hydroLevel,hydroGridPoint } from './hydro.js';
import { WATER_LIMITS as L,WATER_VERSION } from './model.js';
import type { HydroRegion,WaterRead } from './model.js';

export interface WaterPacket {
  readonly schema:typeof WATER_VERSION; readonly cellKey:string;readonly terrainSourceId:string;
  readonly positions:Float32Array;readonly normals:Float32Array;readonly uvs:Float32Array;readonly indices:Uint16Array;
  readonly triangleCount:number;readonly areaSquareMeters:number;readonly regionKey:string;
  readonly enclosedLevels:number;readonly deferredWaterways:number;
  readonly minLevelMeters:number|null;readonly maxLevelMeters:number|null;
  readonly sourceTiles:readonly string[];readonly readSet:readonly WaterRead[];
  readonly verticalReference:TerrainCellPacket['verticalReference'];
  readonly heightAuthority:'estimated-not-hydraulically-qualified';readonly renderLiftMeters:0|0.03; readonly hydroRevision?:string;
  readonly terrainModified:boolean;readonly collidersAdded:0;readonly swimming:false;
}
export function waterPacketBytes(p:WaterPacket):number {
  return p.positions.byteLength+p.normals.byteLength+p.uvs.byteLength+p.indices.byteLength+p.readSet.length*256+p.sourceTiles.length*256+2048;
}
export function validateWaterReadSet(reads:readonly WaterRead[]):void {
  if(!Array.isArray(reads)||reads.length>128)throw new Error('WATER_READSET_CONTRACT');
  const found=new Map<string,string>();
  for(const r of reads){
    if(!r||!['elevation','vector'].includes(r.layer)||!/^\d{1,2}\/\d{1,8}\/\d{1,8}$/.test(r.tile)||!(/^[a-f0-9]{64}$/.test(r.sha256)))throw new Error('WATER_READSET_CONTRACT');
    const [z=0,x=0,y=0]=r.tile.split('/').map(Number);if(z>24||x>=2**z||y>=2**z)throw new Error('WATER_READSET_CONTRACT');
    const key=`${r.layer}/${r.tile}`,old=found.get(key);if(old&&old!==r.sha256)throw new Error('WATER_SOURCE_REVISION_CONFLICT');found.set(key,r.sha256);
  }
}
export function assertWaterReadSets(reads:readonly WaterRead[],sets:readonly (readonly WaterRead[])[]):void {
  validateWaterReadSet(reads);const found=new Map(reads.map(r=>[`${r.layer}/${r.tile}`,r.sha256]));
  for(const set of sets){validateWaterReadSet(set);for(const r of set){const digest=found.get(`${r.layer}/${r.tile}`);if(digest&&digest!==r.sha256)throw new Error('WATER_SOURCE_REVISION_CONFLICT');}}
}
/** Union inside exact global hydro triangles. Areas precede line ribbons;
 * holes and source-core ownership survive triangulation and WorldCell clipping.
 * No duplicated coplanar surfaces, late terrain edits or water-floor collider. */
export function buildWaterSurface(r:HydroRegion,t:TerrainCellPacket,readSet:readonly WaterRead[]=[],options:{readonly hydroRevision?:string}={}):WaterPacket {
  const conditioned=options.hydroRevision!==undefined, lift=conditioned?0:.03;
  if(conditioned&&!/^[a-f0-9]{64}$/.test(options.hydroRevision!))throw new Error('HYDRO_REVISION_CONTRACT');
  if(!r||r.heightAuthority!=='estimated-not-hydraulically-qualified'||r.verticalReference!==t.verticalReference||
    !(r.levels instanceof Float64Array)||r.levels.length!==(L.gridDivisions+1)**2||r.levels.some(v=>!Number.isFinite(v)||Math.abs(v)>100000)||
    r.geometry.z!==r.z||r.geometry.x!==r.x||r.geometry.y!==r.y||r.geometry.primitives.length>L.maxSourceTriangles)throw new Error('WATER_REGION_CONTRACT');
  if(t.id.level<r.z||t.id.level>21||t.id.level<15)throw new Error('WATER_CELL_LEVEL');
  const cellBox=box(t.id.level,t.id.x,t.id.y),cell=rectangle(cellBox),n=L.gridDivisions,period=2**r.z*n;
  if(!overlaps(cellBox,r.geometry.core))throw new Error('WATER_REGION_MISMATCH');
  const primitives=r.geometry.primitives.filter(p=>overlaps(p.bounds,cellBox));
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[],indices:number[]=[],vertices=new Map<string,number>();
  let operations=0,area=0,minLevel=Infinity,maxLevel=-Infinity;
  const uOffset=Math.floor(t.id.x*2**(20-t.id.level)/256)*256,vOffset=Math.floor(t.id.y*2**(20-t.id.level)/256)*256;
  const vertex=(p:Polygon[number],basinKey:string|null):number=>{
    const u=value(p.u),v=value(p.v);let h=basinKey?r.basinLevels.get(basinKey):undefined;
    // A waterway entering an enclosed footprint uses its shared boundary level.
    if(h===undefined)for(const b of r.geometry.basins)if(pointInRing(p,b.rings[0]!)!=='outside'&&b.rings.slice(1).every(ring=>pointInRing(p,ring)==='outside')){h=r.basinLevels.get(b.key);break;}
    h??=hydroLevel(r,u,v);if(!Number.isFinite(h))throw new Error('WATER_HEIGHT_UNRESOLVED');
    const k=`${pointKey(p)}/${h}`,old=vertices.get(k);if(old!==undefined)return old;
    if(vertices.size>=L.maxVertices)throw new Error('WATER_VERTEX_BUDGET');
    const geo=unprojectMercator({u,v}),local=ecefToThreeLocal(geodeticToEcef(geodeticRadians(geo.longitudeRad,geo.latitudeRad,meters(h+lift))),t.anchor);
    const cl=Math.cos(geo.longitudeRad),sl=Math.sin(geo.longitudeRad),cp=Math.cos(geo.latitudeRad),sp=Math.sin(geo.latitudeRad);
    const normal=enuToThree(rotate(t.anchor.ecefToEnu,vector(cp*cl,cp*sl,sp)));
    const index=vertices.size;vertices.set(k,index);positions.push(...local);normals.push(...normal);
    uvs.push(u*2**20-uOffset,v*2**20-vOffset);minLevel=Math.min(minLevel,h);maxLevel=Math.max(maxLevel,h);return index;
  };
  const emit=(p:Polygon,basinKey:string|null):void=>{
    for(let i=1;i+1<p.length;i++){
      if(area2([p[0]!,p[i]!,p[i+1]!]).n===0n)continue;
      if(indices.length>=L.maxTriangles*3)throw new Error('WATER_TRIANGLE_BUDGET');
      const a=vertex(p[0]!,basinKey),b=vertex(p[i+1]!,basinKey),c=vertex(p[i]!,basinKey);indices.push(a,b,c);
      const ab=[0,1,2].map(j=>positions[b*3+j]!-positions[a*3+j]!),ac=[0,1,2].map(j=>positions[c*3+j]!-positions[a*3+j]!);
      area+=Math.hypot(ab[1]!*ac[2]!-ab[2]!*ac[1]!,ab[2]!*ac[0]!-ab[0]!*ac[2]!,ab[0]!*ac[1]!-ab[1]!*ac[0]!)/2;
    }
  };
  const startX=Math.max(0,Math.floor(value(cellBox.west)*period-r.x*n)),endX=Math.min(n,Math.ceil(value(cellBox.east)*period-r.x*n));
  const startY=Math.max(0,Math.floor(value(cellBox.north)*period-r.y*n)),endY=Math.min(n,Math.ceil(value(cellBox.south)*period-r.y*n));
  for(let y=startY;y<endY;y++)for(let x=startX;x<endX;x++){
    const a=hydroGridPoint(r,x,y),b=hydroGridPoint(r,x+1,y),c=hydroGridPoint(r,x,y+1),d=hydroGridPoint(r,x+1,y+1);
    for(const triangle of [[a,b,c],[b,d,c]]){
      const clipped=intersect(triangle,cell);if(!clipped.length)continue;const bb=bounds(clipped);
      let uncovered:Polygon[]=[clipped];
      for(const primitive of primitives){
        if(!overlaps(primitive.bounds,bb))continue;
        const clip=intersect(primitive.polygon,clipped);if(!clip.length)continue;
        const next:Polygon[]=[];
        for(const piece of uncovered){
          if(++operations>L.maxOperations)throw new Error('WATER_OPERATION_BUDGET');
          const part=partition(piece,clip);if(part.inside.length)emit(part.inside,primitive.basinKey);next.push(...part.outside);
          if(next.length>L.maxPieces)throw new Error('WATER_COMPLEXITY_BUDGET');
        }
        uncovered=next;if(!uncovered.length)break;
      }
    }
  }
  const packet:WaterPacket={schema:WATER_VERSION,cellKey:`web-mercator/${t.id.level}/${t.id.x}/${t.id.y}`,terrainSourceId:t.sourceId,
    positions:new Float32Array(positions),normals:new Float32Array(normals),uvs:new Float32Array(uvs),indices:new Uint16Array(indices),
    triangleCount:indices.length/3,areaSquareMeters:area,regionKey:r.key,enclosedLevels:r.basinLevels.size,
    deferredWaterways:r.geometry.deferredWaterways,minLevelMeters:minLevel===Infinity?null:minLevel,maxLevelMeters:maxLevel===-Infinity?null:maxLevel,
    sourceTiles:r.sourceTiles,readSet,verticalReference:r.verticalReference,heightAuthority:r.heightAuthority,renderLiftMeters:lift,...(conditioned?{hydroRevision:options.hydroRevision!}:{}),
    terrainModified:conditioned,collidersAdded:0,swimming:false};validateWaterPacket(packet,t);return packet;
}
export function validateWaterPacket(p:WaterPacket,t:TerrainCellPacket):void {
  if(p?.schema!==WATER_VERSION||p.cellKey!==`web-mercator/${t.id.level}/${t.id.x}/${t.id.y}`||p.terrainSourceId!==t.sourceId||
    p.heightAuthority!=='estimated-not-hydraulically-qualified'||p.verticalReference!==t.verticalReference||typeof p.terrainModified!=='boolean'||p.collidersAdded!==0||p.swimming!==false||
    (p.terrainModified?(p.renderLiftMeters!==0||!p.hydroRevision||!(/^[a-f0-9]{64}$/.test(p.hydroRevision))||!p.terrainSourceId.endsWith(p.hydroRevision)):(p.renderLiftMeters!==.03||p.hydroRevision!==undefined))||
    !(p.positions instanceof Float32Array)||!(p.normals instanceof Float32Array)||!(p.uvs instanceof Float32Array)||!(p.indices instanceof Uint16Array)||
    p.positions.length%3||p.normals.length!==p.positions.length||p.uvs.length!==p.positions.length/3*2||p.positions.length/3>L.maxVertices||
    p.indices.length%3||p.triangleCount!==p.indices.length/3||p.triangleCount>L.maxTriangles||p.indices.some(i=>i>=p.positions.length/3)||
    ![p.positions,p.normals,p.uvs].every(b=>b.every(Number.isFinite))||!Number.isFinite(p.areaSquareMeters)||p.areaSquareMeters<0||
    (p.triangleCount===0&&(p.minLevelMeters!==null||p.maxLevelMeters!==null))||
    typeof p.regionKey!=='string'||p.regionKey.length>512||p.sourceTiles.length>16||p.sourceTiles.some(s=>typeof s!=='string'||s.length>128)||
    !Number.isInteger(p.enclosedLevels)||p.enclosedLevels<0||!Number.isInteger(p.deferredWaterways)||p.deferredWaterways<0||
    (p.triangleCount>0&&(!Number.isFinite(p.minLevelMeters)||!Number.isFinite(p.maxLevelMeters)||p.minLevelMeters!>p.maxLevelMeters!))||waterPacketBytes(p)>L.packetBytes)throw new Error('WATER_PACKET_CONTRACT');
  validateWaterReadSet(p.readSet);
}
