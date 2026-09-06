import type { TerrainCellPacket } from '../terrain/terrain-builder.js';
import type { WaterPacket } from '../water/surface.js';
import { HYDRO_POLICY } from './conditioned-elevation.js';

type P = readonly [number, number];
interface Triangle {p:readonly P[];height:(p:P)=>number;bounds:readonly [number,number,number,number]}
export interface HydroCertificate {
  readonly testedIntersections:number;
  readonly testedVertices:number;
  readonly waterProjectedAreaSquareMeters:number;
  readonly coveredProjectedAreaSquareMeters:number;
  readonly boundaryProjectionToleranceMeters:number;
  readonly maxTerrainAboveWaterMeters:number|null;
  readonly minClearanceMeters:number|null;
  readonly maxWaterAboveTerrainMeters:number|null;
  readonly toleranceMeters:number;
  readonly passed:boolean;
}
function triangle(pos:Float32Array, a:number,b:number,c:number):Triangle {
  const p=[a,b,c].map(i=>[pos[3*i]!,pos[3*i+2]!] as const),[pa,pb,pc]=p as [P,P,P];
  const den=(pb[0]-pa[0])*(pc[1]-pa[1])-(pb[1]-pa[1])*(pc[0]-pa[0]);
  if(!Number.isFinite(den)||Math.abs(den)<1e-12)throw new Error('HYDRO_PROOF_DEGENERATE');
  return {p:den>0?p:[pa,pc,pb],bounds:[Math.min(...p.map(v=>v[0])),Math.min(...p.map(v=>v[1])),Math.max(...p.map(v=>v[0])),Math.max(...p.map(v=>v[1]))],
    height:q=>{
      const x=q[0]-pa[0],z=q[1]-pa[1],u=(x*(pc[1]-pa[1])-z*(pc[0]-pa[0]))/den,v=((pb[0]-pa[0])*z-(pb[1]-pa[1])*x)/den;
      return pos[3*a+1]!*(1-u-v)+pos[3*b+1]!*u+pos[3*c+1]!*v;
    }};
}
function cross(a:P,b:P,p:P):number{return (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);}
function clip(subject:readonly P[],boundary:readonly P[]):readonly P[]{
  let output=subject;
  for(let i=0;i<boundary.length&&output.length;i++){
    const a=boundary[i]!,b=boundary[(i+1)%boundary.length]!,input=output,next:P[]=[];
    for(let j=0;j<input.length;j++){
      const p=input[j]!,q=input[(j+1)%input.length]!,cp=cross(a,b,p),cq=cross(a,b,q);
      if(cp>=0)next.push(p);
      if((cp>=0)!==(cq>=0)){const t=cp/(cp-cq);next.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t]);}
    }
    output=next;
  }
  return output;
}
/** Certifies the ACTUAL uploaded Float32 triangles in their common ENU frame,
 * not merely the analytic source, samples, triangle centroids or raster pixels.
 * On a convex overlap h_terrain - h_water is affine, so its maximum occurs at
 * an overlap vertex. Every positive-area overlap is covered, via a bounded
 * broad phase; there is no statistical sampling and no mesh modification.
 */
export function certifyHydroTriangles(terrain:TerrainCellPacket,water:WaterPacket):HydroCertificate {
  if(water.terrainSourceId!==terrain.sourceId)throw new Error('HYDRO_PROOF_REVISION_MISMATCH');
  const ts:Triangle[]=[];
  for(let i=0;i<terrain.indices.length;i+=3)ts.push(triangle(terrain.positions,terrain.indices[i]!,terrain.indices[i+1]!,terrain.indices[i+2]!));
  const bins=new Map<string,number[]>(),size=16;
  const bx=terrain.bounds.min[0],bz=terrain.bounds.min[2],sx=(terrain.bounds.max[0]-bx)/size,sz=(terrain.bounds.max[2]-bz)/size;
  if(!(sx>0&&sz>0))throw new Error('HYDRO_PROOF_DEGENERATE');
  const range=(b:Triangle['bounds'])=>[Math.max(0,Math.min(size-1,Math.floor((b[0]-bx)/sx))),Math.max(0,Math.min(size-1,Math.floor((b[1]-bz)/sz))),
    Math.max(0,Math.min(size-1,Math.floor((b[2]-bx)/sx))),Math.max(0,Math.min(size-1,Math.floor((b[3]-bz)/sz)))];
  ts.forEach((t,i)=>{const [x0=0,z0=0,x1=0,z1=0]=range(t.bounds);for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++){const k=`${x}/${z}`,list=bins.get(k)||[];list.push(i);bins.set(k,list);}});
  let operations=0,testedVertices=0,testedIntersections=0,max=-Infinity,min=Infinity,waterArea=0,coveredArea=0;
  const boundaryTolerance=.001; // ECEF heights shift the ENU boundary projection slightly.
  for(let i=0;i<water.indices.length;i+=3){
    const w=triangle(water.positions,water.indices[i]!,water.indices[i+1]!,water.indices[i+2]!);
    const expectedArea=Math.abs(cross(w.p[0]!,w.p[1]!,w.p[2]!))/2;let covered=0;
    const perimeter=w.p.reduce((s,p,i)=>s+Math.hypot(p[0]-w.p[(i+1)%3]![0],p[1]-w.p[(i+1)%3]![1]),0);
    const [x0=0,z0=0,x1=0,z1=0]=range(w.bounds),ids=new Set<number>();
    for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++)for(const id of bins.get(`${x}/${z}`)||[])ids.add(id);
    for(const id of ids){
      if(++operations>150000)throw new Error('HYDRO_PROOF_BUDGET');
      const t=ts[id]!,b=t.bounds,c=w.bounds;
      if(b[0]>c[2]||b[2]<c[0]||b[1]>c[3]||b[3]<c[1])continue;
      const intersection=clip(w.p,t.p);if(intersection.length<3)continue;
      let area=0;for(let k=1;k+1<intersection.length;k++)area+=Math.abs(cross(intersection[0]!,intersection[k]!,intersection[k+1]!))/2;
      if(area<1e-12)continue;
      covered+=area;testedIntersections++;
      for(const p of intersection){const delta=t.height(p)-w.height(p);if(!Number.isFinite(delta))throw new Error('HYDRO_PROOF_NONFINITE');max=Math.max(max,delta);min=Math.min(min,delta);testedVertices++;}
    }
    if(Math.abs(covered-expectedArea)>Math.max(1e-8,perimeter*boundaryTolerance))throw new Error('HYDRO_PROOF_COVERAGE');
    waterArea+=expectedArea;coveredArea+=covered;
  }
  if(water.triangleCount>0&&!testedIntersections)throw new Error('HYDRO_PROOF_NO_OVERLAP');
  return {testedIntersections,testedVertices,waterProjectedAreaSquareMeters:waterArea,coveredProjectedAreaSquareMeters:coveredArea,boundaryProjectionToleranceMeters:boundaryTolerance,maxTerrainAboveWaterMeters:max===-Infinity?null:max,minClearanceMeters:max===-Infinity?null:-max,maxWaterAboveTerrainMeters:min===Infinity?null:-min,
    toleranceMeters:HYDRO_POLICY.numericalToleranceMeters,passed:max<=HYDRO_POLICY.numericalToleranceMeters};
}
