import type { TerrainCellPacket } from '../terrain/terrain-builder.js';
import { sampleTerrainPoint, terrainSegmentParameters } from '../terrain/surface-query.js';
import { interpolate, fraction } from '../roads/exact.js';
import { clipEnvironmentCell, environmentAt } from './kernel.js';
import type { CanonicalEnvironmentTile } from './kernel.js';
import { ENV_LIMITS as L } from './model.js';
import type { EnvironmentAttributes } from './model.js';

export interface EnvironmentPacket {
  readonly schema:'environment-debug-v1'; readonly cellKey:string; readonly terrainSourceId:string;
  readonly positions:Float32Array; readonly colors:Float32Array; readonly segmentCount:number;
  readonly fragmentCount:number; readonly sourceZoom:number; readonly sourceTiles:readonly string[];
  readonly missingLayers:readonly string[]; readonly classCounts:Readonly<Record<string,number>>;
  readonly center:readonly EnvironmentAttributes[];
  readonly surfaceAuthority:'diagnostic-on-terrain'; readonly hydroAuthority:'unresolved';
}
function color(a:EnvironmentAttributes):readonly [number,number,number] {
  if(a.layer==='water'||a.layer==='waterway')return [.15,.65,1];
  if(a.wetland)return [.6,.4,1];
  if(a.cover==='WOOD'||a.cover==='SCRUB')return [.2,1,.45];
  if(a.cover==='GRASS')return [.65,1,.25];
  if(a.cover==='CROPS')return [1,.7,.15];
  if(a.cover==='ICE')return [.85,.95,1];
  if(a.cover==='SAND'||a.cover==='ROCK')return [.85,.7,.5];
  return [1,.45,.7];
}
export function buildEnvironmentPacket(tiles:readonly CanonicalEnvironmentTile[],terrain:TerrainCellPacket):EnvironmentPacket {
  const cell=clipEnvironmentCell(tiles,terrain.id),positions:number[]=[],colors:number[]=[],counts:Record<string,number>=Object.create(null) as Record<string,number>;
  for(const f of cell.fragments){
    const label=`${f.shape.attributes.layer}:${f.shape.attributes.sourceClass||'unclassified'}`;counts[label]=(counts[label]||0)+1;
    const c=color(f.shape.attributes);
    for(const [a,b] of f.boundaries){
      const ts=terrainSegmentParameters(a,b,terrain);
      if(positions.length/6+ts.length-1>L.maxSegments)throw new Error('ENV_DEBUG_BUDGET');
      for(let i=1;i<ts.length;i++){
        positions.push(...sampleTerrainPoint(interpolate(a,b,ts[i-1]!),terrain),...sampleTerrainPoint(interpolate(a,b,ts[i]!),terrain));colors.push(...c,...c);
      }
    }
  }
  const d=2**(terrain.id.level+1),p={u:fraction(2*terrain.id.x+1,d),v:fraction(2*terrain.id.y+1,d)};
  const packet:EnvironmentPacket={schema:'environment-debug-v1',cellKey:cell.cellKey,terrainSourceId:terrain.sourceId,
    positions:new Float32Array(positions),colors:new Float32Array(colors),segmentCount:positions.length/6,
    fragmentCount:cell.fragments.length,sourceZoom:cell.sourceZoom,sourceTiles:cell.sourceTiles,missingLayers:cell.missingLayers,
    classCounts:counts,center:environmentAt(cell,p),surfaceAuthority:'diagnostic-on-terrain',hydroAuthority:'unresolved'};
  validateEnvironmentPacket(packet,terrain);return packet;
}
/** Includes bounded semantic bookkeeping; not a claim about total JS heap. */
export function environmentPacketBytes(p:EnvironmentPacket):number {
  return p.positions.byteLength+p.colors.byteLength+p.center.length*1024+Object.keys(p.classCounts).length*512+p.sourceTiles.length*256+1024;
}
export function validateEnvironmentPacket(p:EnvironmentPacket,t:TerrainCellPacket):void {
  if(p.schema!=='environment-debug-v1'||p.surfaceAuthority!=='diagnostic-on-terrain'||p.hydroAuthority!=='unresolved'||p.terrainSourceId!==t.sourceId||
    p.cellKey!==`web-mercator/${t.id.level}/${t.id.x}/${t.id.y}`||!(p.positions instanceof Float32Array)||!(p.colors instanceof Float32Array)||
    p.positions.length%6||p.positions.length!==p.colors.length||p.segmentCount!==p.positions.length/6||p.segmentCount>L.maxSegments||
    !p.positions.every(Number.isFinite)||!p.colors.every(v=>Number.isFinite(v)&&v>=0&&v<=1)||
    !Number.isInteger(p.fragmentCount)||p.fragmentCount<0||p.fragmentCount>L.maxFragments||
    !Number.isInteger(p.sourceZoom)||p.sourceZoom<0||p.sourceZoom>24||p.sourceTiles.length>L.maxTiles||
    p.sourceTiles.some(s=>typeof s!=='string'||s.length>128)||p.center.length>L.maxFragments||Object.keys(p.classCounts).length>L.maxFeatures||
    Object.entries(p.classCounts).some(([k,n])=>k.length>160||!Number.isInteger(n)||n<1)||environmentPacketBytes(p)>L.maxPacketBytes)throw new Error('ENV_PACKET_CONTRACT');
}
