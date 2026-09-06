import type { TerrainCellPacket } from './terrain-builder.js';
import { ZERO,ONE,add,sub,mul,div,fraction,compare,key,value } from '../roads/exact.js';
import type { Fraction,RoadPoint } from '../roads/exact.js';

/** Interpolates the ACTUAL rendered terrain triangle in its canonical UV grid.
 * This is a cartographic overlay, NOT a survey of road elevations. No vertical
 * offset, second collider or independently resampled DEM is introduced. */
export function sampleTerrainPoint(p:RoadPoint,t:TerrainCellPacket):readonly [number,number,number]{
  const n=t.subdivisions,s=fraction(n*2**t.id.level);
  const x=value(sub(mul(p.u,s),fraction(t.id.x*n))),y=value(sub(mul(p.v,s),fraction(t.id.y*n)));
  if(x < -1e-8||y < -1e-8||x>n+1e-8||y>n+1e-8)throw new Error('ROAD_OUTSIDE_TERRAIN');
  const col=Math.min(n-1,Math.max(0,Math.floor(x))),row=Math.min(n-1,Math.max(0,Math.floor(y)));
  const dx=Math.max(0,Math.min(1,x-col)),dy=Math.max(0,Math.min(1,y-row)),a=row*(n+1)+col,b=a+1,c=a+n+1,d=c+1;
  const ids=dx+dy<=1?[a,c,b]:[b,c,d],weights=dx+dy<=1?[1-dx-dy,dy,dx]:[1-dy,1-dx,dx+dy-1];
  const out=[0,0,0];
  for(let axis=0;axis<3;axis++)for(let i=0;i<3;i++)out[axis]!+=t.positions[ids[i]!*3+axis]!*weights[i]!;
  return [out[0]!,out[1]!,out[2]!];
}
/** Split at all UV mesh edges (vertical, horizontal and x+y integer diagonals).
 * Each output segment lies in ONE terrain triangle; sampling endpoints alone
 * without these splits would create chords cutting through hills. */
export function terrainSegmentParameters(a:RoadPoint,b:RoadPoint,t:TerrainCellPacket):readonly Fraction[]{
  const scale=fraction(t.subdivisions*2**t.id.level);
  const point=(p:RoadPoint):readonly [Fraction,Fraction]=>[sub(mul(p.u,scale),fraction(t.id.x*t.subdivisions)),sub(mul(p.v,scale),fraction(t.id.y*t.subdivisions))];
  const p=point(a),q=point(b),breaks=new Map<string,Fraction>([[key(ZERO),ZERO],[key(ONE),ONE]]);
  for(const [start,end] of [[p[0],q[0]],[p[1],q[1]],[add(p[0],p[1]),add(q[0],q[1])]] as const){
    const delta=sub(end,start);if(delta.n===0n)continue;
    for(let i=Math.ceil(Math.min(value(start),value(end)));i<=Math.floor(Math.max(value(start),value(end)));i++){
      const t=div(sub(fraction(i),start),delta);
      if(compare(t,ZERO)>0&&compare(t,ONE)<0)breaks.set(key(t),t);
    }
  }
  return [...breaks.values()].sort(compare);
}
