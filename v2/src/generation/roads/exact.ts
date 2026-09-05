/** Exact normalized Web-Mercator coordinates. BigInt is confined to the bounded
 * road worker/CPU kernel. Reducing fractions makes independent clipping agree.
 * Source quantization is NOT improved by exact arithmetic. */
export interface Fraction { readonly n: bigint; readonly d: bigint; }
export interface RoadPoint { readonly u: Fraction; readonly v: Fraction; }
export interface ExactBox { readonly west: Fraction; readonly north: Fraction; readonly east: Fraction; readonly south: Fraction; }
export const ZERO: Fraction = Object.freeze({n:0n,d:1n});
export const ONE: Fraction = Object.freeze({n:1n,d:1n});
export function fraction(n: bigint | number, d: bigint | number = 1): Fraction {
  let a=BigInt(n), b=BigInt(d);
  if(b===0n)throw new RangeError('ROAD_ZERO_DENOMINATOR');
  if(b<0n){a=-a;b=-b;}
  let x=a<0n?-a:a,y=b;
  while(y){const r=x%y;x=y;y=r;}
  return Object.freeze({n:a/x,d:b/x});
}
export const add=(a:Fraction,b:Fraction):Fraction=>fraction(a.n*b.d+b.n*a.d,a.d*b.d);
export const sub=(a:Fraction,b:Fraction):Fraction=>fraction(a.n*b.d-b.n*a.d,a.d*b.d);
export const mul=(a:Fraction,b:Fraction):Fraction=>fraction(a.n*b.n,a.d*b.d);
export const div=(a:Fraction,b:Fraction):Fraction=>fraction(a.n*b.d,a.d*b.n);
export function compare(a:Fraction,b:Fraction):number { const d=a.n*b.d-b.n*a.d;return d<0n?-1:d>0n?1:0; }
export const value=(a:Fraction):number=>Number(a.n)/Number(a.d);
export const key=(a:Fraction):string=>`${a.n}/${a.d}`;
export const wrap=(a:Fraction):Fraction=>fraction(((a.n%a.d)+a.d)%a.d,a.d);
export const pointKey=(p:RoadPoint):string=>`${key(wrap(p.u))},${key(p.v)}`;
export const same=(a:RoadPoint,b:RoadPoint):boolean=>compare(a.u,b.u)===0&&compare(a.v,b.v)===0;
export function interpolate(a:RoadPoint,b:RoadPoint,t:Fraction):RoadPoint {
  return {u:add(a.u,mul(sub(b.u,a.u),t)),v:add(a.v,mul(sub(b.v,a.v),t))};
}
export function box(level:number,x:number,y:number):ExactBox {
  const n=2**level;return {west:fraction(x,n),east:fraction(x+1,n),north:fraction(y,n),south:fraction(y+1,n)};
}
/** Liang-Barsky/slab interval, closed crossing points; zero-length contacts omitted.
 * Parallel segments on east/south edges are excluded (half-open ownership).
 * The outer south Mercator boundary is retained because it has no south owner. */
export function clip(a:RoadPoint,b:RoadPoint,r:ExactBox):readonly [RoadPoint,RoadPoint]|null {
  let lo=ZERO,hi=ONE;
  for(const [start,end,min,max] of [[a.u,b.u,r.west,r.east],[a.v,b.v,r.north,r.south]] as const){
    const delta=sub(end,start);
    if(delta.n===0n){if(compare(start,min)<0||compare(start,max)>0)return null;continue;}
    let entry=div(sub(min,start),delta),exit=div(sub(max,start),delta);
    if(compare(entry,exit)>0)[entry,exit]=[exit,entry];
    if(compare(entry,lo)>0)lo=entry;if(compare(exit,hi)<0)hi=exit;
    if(compare(lo,hi)>=0)return null;
  }
  const p=interpolate(a,b,lo),q=interpolate(a,b,hi);
  if(same(p,q))return null;
  if(compare(p.u,r.east)===0&&compare(q.u,r.east)===0)return null;
  if(compare(r.south,ONE)!==0&&compare(p.v,r.south)===0&&compare(q.v,r.south)===0)return null;
  return [p,q];
}
