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

interface IndexedTriangle extends Triangle { readonly sourceIndex: number; }
interface Leaf { readonly box: Box; readonly triangles: readonly IndexedTriangle[]; }
interface Branch { readonly box: Box; readonly left: Node; readonly right: Node; }
type Node=Leaf|Branch;
/** Immutable cell-local BVH. Render-origin changes never modify these vertices. */
export class TriangleIndex {
  private readonly root: Node | null;
  private readonly prepared: PreparedTriangleIndex | null = null;
  readonly triangleCount: number;
  constructor(positions: Float32Array,indices: Uint16Array|Uint32Array){
    if(positions.length%3 || indices.length%3 || !indices.length) throw new RangeError('Invalid collider buffers');
    if(indices.length/3>131072) throw new RangeError('Collider triangle budget exceeded');
    for(const v of positions) if(!Number.isFinite(v)) throw new RangeError('Non-finite collider position');
    const read=(i: number): Vec3=>{
      if(i*3+2>=positions.length) throw new RangeError('Collider index out of range');
      return [positions[i*3]!,positions[i*3+1]!,positions[i*3+2]!];
    };
    const triangles: IndexedTriangle[]=[];
    for(let i=0;i<indices.length;i+=3){
      const t={a:read(indices[i]!),b:read(indices[i+1]!),c:read(indices[i+2]!),sourceIndex:i/3};
      unit(cross(sub(t.b,t.a),sub(t.c,t.a)));triangles.push(t);
    }
    this.triangleCount=triangles.length;
    const build=(items: IndexedTriangle[]): Node=>{
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
  /** Transferable snapshot. Triangles are exact copies of the Float32 render
   * coordinates; no extra quantisation, rotation or world-origin offset. */
  snapshot(): PreparedTriangleIndex {
    if (this.prepared) throw new Error('An adopted collider is owned by the physics world');
    const boxes: number[] = [], links: number[] = [], triangles: number[] = [], sourceIds: number[] = [];
    const visit = (node: Node): number => {
      const id = boxes.length / 6;
      boxes.push(...node.box.min, ...node.box.max); links.push(-1, -1, 0, 0);
      if ('triangles' in node) {
        links[id * 4 + 2] = triangles.length / 9; links[id * 4 + 3] = node.triangles.length;
        for (const t of node.triangles) { triangles.push(...t.a, ...t.b, ...t.c); sourceIds.push(t.sourceIndex); }
      } else { links[id * 4] = visit(node.left); links[id * 4 + 1] = visit(node.right); }
      return id;
    };
    visit(this.root!);
    return { version: 'cell-bvh-v1', boxes: new Float32Array(boxes), links: new Int32Array(links),
      triangles: new Float32Array(triangles), sourceIds: new Uint32Array(sourceIds) };
  }
  /** Validation is cooperative (one batch per next()). The caller transfers
   * ownership of snapshot arrays after success; never mutate or retransfer them.
   * No sorting, tree building or vertex copying takes place on the main thread. */
  static *adopt(snapshot: PreparedTriangleIndex, positions: Float32Array,
    indices: Uint16Array | Uint32Array): Generator<void, TriangleIndex, undefined> {
    const invalid = (): never => { throw new Error('INVALID_PREPARED_COLLIDER'); };
    const n = indices.length / 3;
    if (!(positions instanceof Float32Array) || !(indices instanceof Uint16Array || indices instanceof Uint32Array) ||
      !Number.isInteger(n) || n < 1 || n > 131072 || positions.length % 3 || !snapshot ||
      snapshot.version !== 'cell-bvh-v1' || !(snapshot.boxes instanceof Float32Array) ||
      !(snapshot.links instanceof Int32Array) || !(snapshot.triangles instanceof Float32Array) ||
      !(snapshot.sourceIds instanceof Uint32Array)) invalid();
    const nodes = snapshot.boxes.length / 6, { boxes, links, triangles, sourceIds } = snapshot;
    if (!Number.isInteger(nodes) || nodes < 1 || nodes > 2 * n - 1 || links.length !== 4 * nodes ||
      triangles.length !== n * 9 || sourceIds.length !== n) invalid();
    for (let i = 0; i < positions.length; i++) {
      if (!Number.isFinite(positions[i]!)) invalid();
      if (i % 384 === 383) yield;
    }
    const idsSeen = new Uint8Array(n), rangesSeen = new Uint8Array(n), parents = new Uint8Array(nodes);
    for (let t = 0; t < n; t++) {
      const id = sourceIds[t]!;
      if (id >= n || idsSeen[id]) invalid(); idsSeen[id] = 1;
      for (let j = 0; j < 9; j++) {
        const index = indices[id * 3 + Math.floor(j / 3)]! * 3 + j % 3;
        const value = triangles[t * 9 + j]!;
        if (index >= positions.length || !Number.isFinite(value) || value !== positions[index]) invalid();
      }
      const o = t * 9;
      const a: Vec3 = [triangles[o]!, triangles[o+1]!, triangles[o+2]!];
      const b: Vec3 = [triangles[o+3]!, triangles[o+4]!, triangles[o+5]!];
      const c: Vec3 = [triangles[o+6]!, triangles[o+7]!, triangles[o+8]!];
      if (length(cross(sub(b, a), sub(c, a))) < 1e-12) invalid();
      if (t % 128 === 127) yield;
    }
    for (let i = 0; i < nodes; i++) {
      const b = i * 6, o = i * 4, left = links[o]!, right = links[o+1]!, start = links[o+2]!, count = links[o+3]!;
      for (let j = 0; j < 3; j++) if (!Number.isFinite(boxes[b+j]!) || !Number.isFinite(boxes[b+j+3]!) || boxes[b+j]! > boxes[b+j+3]!) invalid();
      if (left === -1 && right === -1) {
        if (start < 0 || count < 1 || count > 8 || start + count > n) invalid();
        for (let t = start; t < start + count; t++) {
          if (rangesSeen[t]) invalid(); rangesSeen[t] = 1;
          for (let j = 0; j < 9; j++) {
            const v = triangles[t*9+j]!, axis = j%3;
            if (v < boxes[b+axis]! || v > boxes[b+axis+3]!) invalid();
          }
        }
      } else {
        if (left <= i || right <= i || left >= nodes || right >= nodes || left === right || count !== 0 || start !== 0) invalid();
        for (const child of [left, right]) {
          if (parents[child]) invalid(); parents[child] = 1;
          for (let j = 0; j < 3; j++) if (boxes[child*6+j]! < boxes[b+j]! || boxes[child*6+j+3]! > boxes[b+j+3]!) invalid();
        }
      }
      if (i % 128 === 127) yield;
    }
    if (parents[0] || parents.subarray(1).some(v => v !== 1) || rangesSeen.some(v => v !== 1)) invalid();
    const index = Object.create(TriangleIndex.prototype) as TriangleIndex;
    Object.defineProperties(index, { root: { value: null }, prepared: { value: snapshot }, triangleCount: { value: n } });
    return index;
  }
  query(box: Box): readonly Triangle[]{
    if (this.prepared) {
      const { boxes, links, triangles } = this.prepared, stack = [0], found: Triangle[] = [];
      while (stack.length) {
        const id = stack.pop()!, b = id*6, o = id*4;
        let intersects = true;
        for (let j = 0; j < 3; j++) if (boxes[b+j]! > box.max[j]! || boxes[b+j+3]! < box.min[j]!) intersects = false;
        if (!intersects) continue;
        if (links[o] !== -1) { stack.push(links[o+1]!, links[o]!); continue; }
        for (let t = links[o+2]!; t < links[o+2]! + links[o+3]!; t++) {
          const p = t*9;
          found.push({ a: [triangles[p]!,triangles[p+1]!,triangles[p+2]!],
            b: [triangles[p+3]!,triangles[p+4]!,triangles[p+5]!], c: [triangles[p+6]!,triangles[p+7]!,triangles[p+8]!] });
        }
      }
      return found;
    }
    const found: Triangle[]=[];
    const visit=(node: Node): void=>{
      if(!overlaps(box,node.box)) return;
      if('triangles' in node) found.push(...node.triangles);else{visit(node.left);visit(node.right);}
    };
    visit(this.root!);return found;
  }
}

/** Arrays are transferred, not structured-cloned object trees. */
export interface PreparedTriangleIndex {
  readonly version: 'cell-bvh-v1';
  readonly boxes: Float32Array;
  readonly links: Int32Array;
  readonly triangles: Float32Array;
  readonly sourceIds: Uint32Array;
}
