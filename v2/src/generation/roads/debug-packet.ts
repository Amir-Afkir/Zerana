import type { TerrainCellPacket } from '../terrain/terrain-builder.js';
import { validateTerrainGrid } from '../terrain/lattice.js';
import type { RoadGraph } from './model.js';
import { ROAD_LIMITS } from './model.js';
import { clipRoadGraph,roadCellKey } from './kernel.js';
import { interpolate } from './exact.js';
import { sampleTerrainPoint as sample, terrainSegmentParameters as parameters } from '../terrain/surface-query.js';

export interface RoadDebugPacket {
  readonly cellKey:string; readonly positions:Float32Array; readonly colors:Float32Array;
  readonly segmentCount:number; readonly fragmentCount:number;
  readonly surfaceAuthority:'diagnostic-on-terrain';
}
export function buildRoadDebugPackets(graph:RoadGraph,terrains:readonly TerrainCellPacket[]):readonly RoadDebugPacket[]{
  const fragments=clipRoadGraph(graph,terrains.map(t=>t.id)),result:RoadDebugPacket[]=[];let total=0;
  for(const terrain of terrains){
    validateTerrainGrid(terrain.id,terrain.subdivisions);
    const cellKey=roadCellKey(terrain.id),positions:number[]=[],colors:number[]=[];let fragmentCount=0;
    for(const f of fragments){
      if(f.cellKey!==cellKey||!['ground','ford'].includes(f.edge.attributes.structure)||f.edge.attributes.category==='STEPS')continue;
      fragmentCount++;
      const color=['FOOTWAY','TRAIL','CYCLEWAY'].includes(f.edge.attributes.category)?[1,.78,.2]:f.edge.attributes.category==='UNKNOWN'?[1,.3,.8]:[.1,.95,1];
      const ts=parameters(f.a,f.b,terrain);
      for(let i=1;i<ts.length;i++){
        if(++total>ROAD_LIMITS.maxDebugSegments)throw new Error('ROAD_DEBUG_BUDGET');
        positions.push(...sample(interpolate(f.a,f.b,ts[i-1]!),terrain),...sample(interpolate(f.a,f.b,ts[i]!),terrain));
        colors.push(...color,...color);
      }
    }
    result.push({cellKey,positions:new Float32Array(positions),colors:new Float32Array(colors),segmentCount:positions.length/6,fragmentCount,surfaceAuthority:'diagnostic-on-terrain'});
  }
  return result;
}
