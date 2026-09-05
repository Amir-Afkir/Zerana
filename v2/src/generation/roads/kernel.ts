import type { WorldCellId } from '../../geo/cell-scheme.js';
import { cellId } from '../../geo/mercator-cell-scheme.js';
import { geodeticRadians } from '../../geo/geodetic.js';
import { unprojectMercator } from '../../geo/mercator.js';
import { meters } from '../../geo/units.js';
import { ROAD_LIMITS,attributesKey,validateTile } from './model.js';
import type { DecodedRoadTile,RoadEdge,RoadGraph,RoadNode } from './model.js';
import { fraction,box,clip,pointKey,same,value,add,compare } from './exact.js';
import type { RoadPoint } from './exact.js';

export interface RoadFragment { readonly key:string; readonly cellKey:string; readonly edge:RoadEdge; readonly a:RoadPoint; readonly b:RoadPoint; readonly startKey:string; readonly endKey:string; }
export const roadCellKey=(id:WorldCellId):string=>`${id.scheme}/${id.level}/${id.x}/${id.y}`;
export function roadPointGeodetic(p:RoadPoint,heightMeters=0){
  const g=unprojectMercator({u:value(p.u),v:value(p.v)});
  return geodeticRadians(g.longitudeRad,g.latitudeRad,meters(heightMeters));
}
function sourcePoint(tile:DecodedRoadTile,p:readonly [number,number]):RoadPoint {
  if(!p.every(Number.isSafeInteger)||p.some(v=>v < -tile.extent || v > 2*tile.extent))throw new Error('ROAD_COORDINATE_BUDGET');
  const d=BigInt(tile.extent)*2n**BigInt(tile.z);
  return {u:fraction(BigInt(tile.x)*BigInt(tile.extent)+BigInt(p[0]),d),v:fraction(BigInt(tile.y)*BigInt(tile.extent)+BigInt(p[1]),d)};
}
/** ID is a normalized segment identity within a source version/zoom, NOT an OSM
 * way ID or a persistent real-world RoadID. Tile IDs and arbitrary MVT IDs never
 * decide topology. The core tile owns geometry; buffers provide context only. */
export function buildRoadGraph(tiles:readonly DecodedRoadTile[]):RoadGraph {
  if(tiles.length>ROAD_LIMITS.maxTiles)throw new Error('ROAD_TILE_BUDGET');
  const tileMap=new Map<string,DecodedRoadTile>();let features=0,points=0;
  for(const tile of tiles){
    validateTile(tile);const first=tiles[0]!;
    if(tile.z!==first.z||tile.providerId!==first.providerId||tile.version!==first.version)throw new Error('ROAD_MIXED_SOURCE');
    const k=`${tile.z}/${tile.x}/${tile.y}`,old=tileMap.get(k);
    if(old&&old.digest!==tile.digest)throw new Error('ROAD_SNAPSHOT_CONFLICT');
    tileMap.set(k,tile);
  }
  const edges=new Map<string,RoadEdge>();let duplicates=0;
  for(const [tileKey,tile] of [...tileMap].sort(([a],[b])=>a.localeCompare(b))){
    const bounds=box(tile.z,tile.x,tile.y);
    for(const feature of tile.features){
      if(++features>ROAD_LIMITS.maxFeatures)throw new Error('ROAD_FEATURE_BUDGET');
      const semantic=attributesKey(feature.attributes);
      for(const line of feature.lines){
        if(line.length<2)throw new Error('ROAD_INVALID_LINE');
        points+=line.length;if(points>ROAD_LIMITS.maxPoints)throw new Error('ROAD_POINT_BUDGET');
        for(let i=1;i<line.length;i++){
          const originalA=sourcePoint(tile,line[i-1]!),originalB=sourcePoint(tile,line[i]!);
          if(same(originalA,originalB))continue;
          const clipped=clip(originalA,originalB,bounds);if(!clipped)continue;
          let [a,b]=clipped,context:readonly [RoadPoint,RoadPoint]=[originalA,originalB];
          if(feature.attributes.oneway==='both'&&pointKey(a)>pointKey(b)){[a,b]=[b,a];context=[originalB,originalA];}
          const k=JSON.stringify(['roads-v1',tile.providerId,tile.version,tile.z,semantic,pointKey(a),pointKey(b)]);
          const evidence=`${tileKey}@${tile.digest}`;
          if(edges.has(k)){
            const old=edges.get(k);duplicates++;
            const contextKey=(c:readonly [RoadPoint,RoadPoint]):string=>JSON.stringify(c.map(pointKey));
            if(old&&contextKey(context)<contextKey(old.context))edges.set(k,{...old,context});
            continue;
          }
          if(edges.size>=ROAD_LIMITS.maxEdges)throw new Error('ROAD_EDGE_BUDGET');
          edges.set(k,{key:k,a,b,context,attributes:feature.attributes,evidence:[evidence]});
        }
      }
    }
  }
  const nodes=new Map<string,{point:RoadPoint;edges:string[];sourceBoundary:boolean}>();
  for(const edge of [...edges.values()].sort((a,b)=>a.key.localeCompare(b.key))){
    for(const p of [edge.a,edge.b]){
      const a=edge.attributes;
      // Unknown vertical strata remain isolated. Even equal known strata provide
      // only a CARTOGRAPHIC junction candidate, not a proven navigable junction.
      const stratum=a.structure!=='unknown'&&a.layer!==null?`${a.structure}/${a.layer}`:edge.key;
      const k=`${stratum}:${pointKey(p)}`;
      const z=tiles[0]!.z,n=2n**BigInt(z);
      const boundary=(p.u.n*n)%p.u.d===0n||(p.v.n*n)%p.v.d===0n;
      const node=nodes.get(k)||{point:p,edges:[],sourceBoundary:boundary};
      node.edges.push(edge.key);nodes.set(k,node);
    }
  }
  const result:RoadNode[]=[...nodes].sort(([a],[b])=>a.localeCompare(b)).map(([k,n])=>({key:k,...n,edges:n.edges.sort()}));
  return {schema:'zerana-road-kernel-v1',topologyAuthority:'cartographic-not-routable',
    edges:[...edges.values()].sort((a,b)=>a.key.localeCompare(b.key)),nodes:result,
    duplicateSegments:duplicates,unresolvedSourcePorts:result.filter(n=>n.sourceBoundary&&n.edges.length===1).length,
    sourceTiles:[...tileMap].map(([k,t])=>`${k}@${t.digest}`).sort()};
}
/** Clip normalized geometry to half-open WorldCells, retaining exact boundary
 * coordinates and source-segment context. No rounding or tolerance-based weld. */
export function clipRoadGraph(graph:RoadGraph,cells:readonly WorldCellId[]):readonly RoadFragment[]{
  if(cells.length>ROAD_LIMITS.maxCells)throw new Error('ROAD_CELL_BUDGET');
  const result:RoadFragment[]=[];
  if(new Set(cells.map(roadCellKey)).size!==cells.length)throw new Error('ROAD_DUPLICATE_CELL');
  for(const cell of [...cells].sort((a,b)=>roadCellKey(a).localeCompare(roadCellKey(b)))){
    if(cell.scheme!=='web-mercator'||cell.level<15||cell.level>24)throw new Error('ROAD_CELL_CONTRACT');
    cellId(cell.level,cell.x,cell.y);
    const bounds=box(cell.level,cell.x,cell.y),ck=roadCellKey(cell);
    for(const edge of graph.edges){
      // Canonical source cores are [0,1]. Only boundary aliases need wrapping;
      // no global translation of all points, nor an anti-meridian long segment.
      for(const shift of [-1,0,1]){
        const delta=fraction(shift),a={u:add(edge.a.u,delta),v:edge.a.v},b={u:add(edge.b.u,delta),v:edge.b.v};
        if((compare(a.u,bounds.west)<0&&compare(b.u,bounds.west)<0)||(compare(a.u,bounds.east)>0&&compare(b.u,bounds.east)>0))continue;
        const c=clip(a,b,bounds);if(!c)continue;
        if(result.length>=ROAD_LIMITS.maxFragments)throw new Error('ROAD_FRAGMENT_BUDGET');
        const startKey=pointKey(c[0]),endKey=pointKey(c[1]);
        result.push({key:`${edge.key}|${ck}|${startKey}>${endKey}`,cellKey:ck,edge,a:c[0],b:c[1],startKey,endKey});
      }
    }
  }
  return result;
}
