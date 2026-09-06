import type { RoadGraph } from '../roads/model.js';
import type { WaterGeometry } from '../water/model.js';
import { value } from '../roads/exact.js';
import type { Point2 } from './conditioned-elevation.js';
/** Conservative cartographic intersection, not inferred bridge engineering.
 * Known elevated/underground strata are untouched. Every ambiguous ground
 * centreline crossing is recorded and omitted from the draped road renderer.
 */
export function deferHydroCrossings(graph:RoadGraph,geometries:readonly WaterGeometry[]):{graph:RoadGraph;deferredStructures:number} {
  const polygons=geometries.flatMap(g=>g.primitives.map(p=>({p:p.polygon.map(q=>[value(q.u),value(q.v)] as Point2),
    b:[value(p.bounds.west),value(p.bounds.north),value(p.bounds.east),value(p.bounds.south)] as const})));
  let operations=0,deferredStructures=0;
  const edges=graph.edges.map(edge=>{
    if(!['ground','ford'].includes(edge.attributes.structure))return edge;
    const a:Point2=[value(edge.a.u),value(edge.a.v)],b:Point2=[value(edge.b.u),value(edge.b.v)];
    for(const shape of polygons){
      const bounds=shape.b;
      if(Math.max(a[0],b[0])<bounds[0]||Math.min(a[0],b[0])>bounds[2]||Math.max(a[1],b[1])<bounds[1]||Math.min(a[1],b[1])>bounds[3])continue;
      if(++operations>150000)throw new Error('HYDRO_CROSSING_BUDGET');
      let lo=0,hi=1;
      for(let i=0;i<shape.p.length&&lo<=hi;i++){
        const p=shape.p[i]!,q=shape.p[(i+1)%shape.p.length]!;
        const ca=(q[0]-p[0])*(a[1]-p[1])-(q[1]-p[1])*(a[0]-p[0]),cb=(q[0]-p[0])*(b[1]-p[1])-(q[1]-p[1])*(b[0]-p[0]);
        if(ca<0&&cb<0){lo=2;break;}
        if((ca<0)!==(cb<0)){const t=ca/(ca-cb);if(ca<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);}
      }
      if(lo<=hi){deferredStructures++;return {...edge,attributes:{...edge.attributes,structure:'unknown' as const}};}
    }
    return edge;
  });
  return {graph:{...graph,edges},deferredStructures};
}
