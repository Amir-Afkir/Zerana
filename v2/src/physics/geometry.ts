import type { Vec3 } from '../geo/linear.js';

// Small, allocation-local Float64 operations. No renderer or global scratch state.
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0]*s, a[1]*s, a[2]*s];
export const dot = (a: Vec3, b: Vec3): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const length = (v: Vec3): number => Math.hypot(...v);
export function unit(v: Vec3): Vec3 {
  const n=length(v);
  if (!Number.isFinite(n) || n<1e-12) throw new RangeError('Invalid direction');
  return scale(v,1/n);
}
const clamp = (v: number): number => Math.max(0,Math.min(1,v));
export interface Triangle { readonly a: Vec3; readonly b: Vec3; readonly c: Vec3; }
export interface Box { readonly min: Vec3; readonly max: Vec3; }
export function bounds(points: readonly Vec3[], margin=0): Box {
  return {min:[0,1,2].map(i=>Math.min(...points.map(p=>p[i]!))-margin) as unknown as Vec3,
    max:[0,1,2].map(i=>Math.max(...points.map(p=>p[i]!))+margin) as unknown as Vec3};
}
export function overlaps(a: Box,b: Box): boolean {
  return [0,1,2].every(i=>a.min[i]!<=b.max[i]! && a.max[i]!>=b.min[i]!);
}
export function closestPoint(p: Vec3,t: Triangle): Vec3 {
  const {a,b,c}=t, ab=sub(b,a), ac=sub(c,a), ap=sub(p,a);
  const d1=dot(ab,ap), d2=dot(ac,ap);
  if(d1<=0 && d2<=0) return a;
  const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);
  if(d3>=0 && d4<=d3) return b;
  const vc=d1*d4-d3*d2;
  if(vc<=0 && d1>=0 && d3<=0) return add(a,scale(ab,d1/(d1-d3)));
  const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);
  if(d6>=0 && d5<=d6) return c;
  const vb=d5*d2-d1*d6;
  if(vb<=0 && d2>=0 && d6<=0) return add(a,scale(ac,d2/(d2-d6)));
  const va=d3*d6-d5*d4;
  if(va<=0 && d4-d3>=0 && d5-d6>=0) return add(b,scale(sub(c,b),(d4-d3)/(d4-d3+d5-d6)));
  const inv=1/(va+vb+vc);
  return add(a,add(scale(ab,vb*inv),scale(ac,vc*inv)));
}
function segmentPair(p: Vec3,q: Vec3,a: Vec3,b: Vec3): readonly [Vec3,Vec3] {
  const d1=sub(q,p),d2=sub(b,a),r=sub(p,a),aa=dot(d1,d1),ee=dot(d2,d2),f=dot(d2,r);
  let s=0,t=0;
  if(aa<=1e-24 && ee<=1e-24) return [p,a];
  if(aa<=1e-24) t=clamp(f/ee);
  else {
    const c=dot(d1,r);
    if(ee<=1e-24) s=clamp(-c/aa);
    else {
      const bb=dot(d1,d2),denom=aa*ee-bb*bb;
      s=denom>1e-14*aa*ee ? clamp((bb*f-c*ee)/denom) : 0;
      t=(bb*s+f)/ee;
      if(t<0){t=0;s=clamp(-c/aa);} else if(t>1){t=1;s=clamp((bb-c)/aa);}
    }
  }
  return [add(p,scale(d1,s)),add(a,scale(d2,t))];
}
/** Double-sided Möller–Trumbore; t is in metres for a unit ray direction. */
export function rayTriangle(origin: Vec3,direction: Vec3,t: Triangle, edgeToleranceMeters=0): number | null {
  const e1=sub(t.b,t.a),e2=sub(t.c,t.a),h=cross(direction,e2),det=dot(e1,h);
  if(Math.abs(det)<1e-12*length(e1)*length(e2)) return null;
  const s=sub(origin,t.a),u=dot(s,h)/det;
  const area=length(cross(e1,e2));
  const uTolerance=1e-12+edgeToleranceMeters*length(e2)/area;
  if(u < -uTolerance) return null;
  const q=cross(s,e1),v=dot(direction,q)/det;
  const vTolerance=1e-12+edgeToleranceMeters*length(e1)/area;
  const wTolerance=1e-12+edgeToleranceMeters*length(sub(t.c,t.b))/area;
  if(v < -vTolerance || 1-u-v < -wTolerance) return null;
  const distance=dot(e2,q)/det;
  return distance>=-1e-9 ? Math.max(0,distance) : null;
}
/** Closest segment/triangle pair, including a segment crossing the triangle face. */
export function segmentTriangle(p: Vec3,q: Vec3,t: Triangle): {distance: number; normal: Vec3} {
  const axis=sub(q,p),axisLength=length(axis);
  let best=Infinity,normal: Vec3=[0,1,0];
  const face=unit(cross(sub(t.b,t.a),sub(t.c,t.a)));
  const choose=(a: Vec3,b: Vec3): void=>{
    const d=sub(a,b),n=length(d);
    if(n<best){best=n;normal=n>1e-12 ? scale(d,1/n) : scale(face,dot(sub(scale(add(p,q),.5),t.a),face)<0 ? -1 : 1);}
  };
  if(axisLength>1e-12){
    const hit=rayTriangle(p,scale(axis,1/axisLength),t);
    if(hit!==null && hit<=axisLength){const a=add(p,scale(axis,hit/axisLength));choose(a,a);}
  }
  choose(p,closestPoint(p,t));choose(q,closestPoint(q,t));
  for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]] as const) choose(...segmentPair(p,q,a,b));
  return {distance:best,normal};
}

interface Leaf { readonly box: Box; readonly triangles: readonly Triangle[]; }
interface Branch { readonly box: Box; readonly left: Node; readonly right: Node; }
type Node=Leaf|Branch;
/** Immutable cell-local BVH. Render-origin changes never modify these vertices. */
export class TriangleIndex {
  private readonly root: Node;
  readonly triangleCount: number;
  constructor(positions: Float32Array,indices: Uint16Array|Uint32Array){
    if(positions.length%3 || indices.length%3 || !indices.length) throw new RangeError('Invalid collider buffers');
    if(indices.length/3>131072) throw new RangeError('Collider triangle budget exceeded');
    for(const v of positions) if(!Number.isFinite(v)) throw new RangeError('Non-finite collider position');
    const read=(i: number): Vec3=>{
      if(i*3+2>=positions.length) throw new RangeError('Collider index out of range');
      return [positions[i*3]!,positions[i*3+1]!,positions[i*3+2]!];
    };
    const triangles: Triangle[]=[];
    for(let i=0;i<indices.length;i+=3){
      const t={a:read(indices[i]!),b:read(indices[i+1]!),c:read(indices[i+2]!)};
      unit(cross(sub(t.b,t.a),sub(t.c,t.a)));triangles.push(t);
    }
    this.triangleCount=triangles.length;
    const build=(items: Triangle[]): Node=>{
      // Avoid spreading a potentially large array into Math.min/max.
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
      for(const t of items) for(const p of [t.a,t.b,t.c]) for(let i=0;i<3;i++){
        min[i]=Math.min(min[i]!,p[i]!);max[i]=Math.max(max[i]!,p[i]!);
      }
      const box={min:min as unknown as Vec3,max:max as unknown as Vec3};
      if(items.length<=8) return {box,triangles:items};
      let axis=0;for(let i=1;i<3;i++) if(max[i]!-min[i]!>max[axis]!-min[axis]!) axis=i;
      items.sort((a,b)=>(a.a[axis]!+a.b[axis]!+a.c[axis]!)-(b.a[axis]!+b.b[axis]!+b.c[axis]!));
      const middle=Math.floor(items.length/2);
      return {box,left:build(items.slice(0,middle)),right:build(items.slice(middle))};
    };
    this.root=build(triangles);
  }
  query(box: Box): readonly Triangle[]{
    const found: Triangle[]=[];
    const visit=(node: Node): void=>{
      if(!overlaps(box,node.box)) return;
      if('triangles' in node) found.push(...node.triangles);else{visit(node.left);visit(node.right);}
    };
    visit(this.root);return found;
  }
}
