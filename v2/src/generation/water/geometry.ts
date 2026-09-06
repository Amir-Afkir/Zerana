import { ZERO, add, sub, mul, div, compare, same, interpolate } from '../roads/exact.js';
import type { RoadPoint as Point, ExactBox, Fraction } from '../roads/exact.js';
export type Polygon = readonly Point[];
export function cross(a:Point,b:Point,p:Point):Fraction {
  return sub(mul(sub(b.u,a.u),sub(p.v,a.v)),mul(sub(b.v,a.v),sub(p.u,a.u)));
}
export function area2(p:Polygon):Fraction {
  let sum=ZERO;for(let i=1;i+1<p.length;i++)sum=add(sum,cross(p[0]!,p[i]!,p[i+1]!));return sum;
}
export function clean(p:Polygon):Polygon {
  const out:Point[]=[];for(const v of p)if(!out.length||!same(v,out[out.length-1]!))out.push(v);
  if(out.length>1&&same(out[0]!,out[out.length-1]!))out.pop();
  return out.length>=3&&area2(out).n!==0n?out:[];
}
export function split(p:Polygon,a:Point,b:Point):{inside:Polygon;outside:Polygon} {
  const inside:Point[]=[],outside:Point[]=[];
  for(let i=0;i<p.length;i++){
    const v=p[i]!,next=p[(i+1)%p.length]!,d=cross(a,b,v),e=cross(a,b,next);
    if(d.n>=0n)inside.push(v);if(d.n<=0n)outside.push(v);
    if((d.n<0n&&e.n>0n)||(d.n>0n&&e.n<0n)){
      const q=interpolate(v,next,div(d,sub(d,e)));inside.push(q);outside.push(q);
    }
  }
  return {inside:clean(inside),outside:clean(outside)};
}
export function rectangle(r:ExactBox):Polygon {
  return [{u:r.west,v:r.north},{u:r.east,v:r.north},{u:r.east,v:r.south},{u:r.west,v:r.south}];
}
export function intersect(subject:Polygon,clip:Polygon):Polygon {
  let p=subject;for(let i=0;i<clip.length&&p.length;i++)p=split(p,clip[i]!,clip[(i+1)%clip.length]!).inside;return p;
}
/** Exact complementary partition; disjoint objects do not fragment the subject. */
export function partition(subject:Polygon,clip:Polygon):{inside:Polygon;outside:Polygon[]} {
  const separate=(a:Polygon,b:Polygon):boolean=>a.some((v,i)=>b.every(p=>cross(v,a[(i+1)%a.length]!,p).n<=0n));
  if(separate(subject,clip)||separate(clip,subject))return {inside:[],outside:[subject]};
  let inside=subject;const outside:Polygon[]=[];
  for(let i=0;i<clip.length&&inside.length;i++){
    const part=split(inside,clip[i]!,clip[(i+1)%clip.length]!);if(part.outside.length)outside.push(part.outside);inside=part.inside;
  }
  return {inside,outside};
}
export function bounds(p:Polygon):ExactBox {
  if(!p.length)throw new Error('WATER_EMPTY_POLYGON');
  let west=p[0]!.u,east=west,north=p[0]!.v,south=north;
  for(const q of p){if(compare(q.u,west)<0)west=q.u;if(compare(q.u,east)>0)east=q.u;if(compare(q.v,north)<0)north=q.v;if(compare(q.v,south)>0)south=q.v;}
  return {west,east,north,south};
}
export function overlaps(a:ExactBox,b:ExactBox):boolean {
  return compare(a.east,b.west)>0&&compare(a.west,b.east)<0&&compare(a.south,b.north)>0&&compare(a.north,b.south)<0;
}
