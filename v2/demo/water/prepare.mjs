import earcut from 'earcut';
import { WATER_LIMITS as L } from '../../src/generation/water/model.ts';
import { bounds,area2,intersect,rectangle,overlaps } from '../../src/generation/water/geometry.ts';
import { fraction,value,sub,mul,add,div,compare } from '../../src/generation/roads/exact.ts';
import { pointInRing } from '../../src/generation/environment/kernel.ts';

const WIDTH={RIVER:6,CANAL:4,STREAM:1.5,DRAIN:1,DITCH:.8};
function inside(rings,p){return pointInRing(p,rings[0])!=='outside'&&rings.slice(1).every(r=>pointInRing(p,r)==='outside');}
/** Uses the already locked Earcut adapter, then restores ORIGINAL exact source
 * vertices. It never confuses a clipped tile boundary with a natural bank. */
export function prepareWaterGeometry(tile){
  const primitives=[],basins=[],core=rectangle(tile.core);let count=0,deferredWaterways=0;
  const append=(polygon,key,kind,basinKey=null)=>{
    const ccw=area2(polygon).n<0n?[...polygon].reverse():polygon;
    const cut=intersect(ccw,core);if(!cut.length)return;
    if(primitives.length>=L.maxSourceTriangles)throw new Error('WATER_SOURCE_TRIANGLE_BUDGET');
    primitives.push({polygon:cut,bounds:bounds(cut),key,kind,basinKey});
  };
  const lines=tile.features.filter(f=>f.attributes.layer==='waterway');
  for(const shape of tile.features.filter(f=>f.attributes.layer==='water')){
    for(let k=0;k<shape.polygons.length;k++){
      const rings=shape.polygons[k],points=[],flat=[],holes=[];
      for(let i=0;i<rings.length;i++){
        if(i)holes.push(points.length);
        for(const p of rings[i]){
          if(++count>L.maxSourcePoints)throw new Error('WATER_SOURCE_POINT_BUDGET');
          points.push(p);flat.push(value(mul(sub(p.u,tile.core.west),fraction(2**tile.z))),value(mul(sub(p.v,tile.core.north),fraction(2**tile.z))));
        }
      }
      const indices=earcut(flat,holes,2);
      if(!indices.length||earcut.deviation(flat,holes,2,indices)>1e-9)throw new Error('WATER_TRIANGULATION_UNRESOLVED');
      const b=bounds(rings[0]),key=`${shape.key}/polygon/${k}`;
      // A complete enclosed footprint is a LEVEL preview, not a certified lake.
      // Open bodies and bodies with mapped flowing axes retain regional profiles.
      const complete=compare(b.west,tile.core.west)>0&&compare(b.east,tile.core.east)<0&&compare(b.north,tile.core.north)>0&&compare(b.south,tile.core.south)<0;
      const flowing=lines.some(l=>overlaps(l.bounds,b));
      const basinKey=complete&&!flowing?key:null,samples=[];
      for(let i=0;i<indices.length;i+=3){
        const triangle=indices.slice(i,i+3).map(j=>points[j]),weight=Math.abs(value(area2(triangle)));
        const center={u:div(triangle.reduce((s,p)=>add(s,p.u),fraction(0)),fraction(3)),v:div(triangle.reduce((s,p)=>add(s,p.v),fraction(0)),fraction(3))};
        if(!inside(rings,center))throw new Error('WATER_TRIANGULATION_UNRESOLVED');
        if(weight>0)samples.push({point:center,weight});
        append(triangle,`${key}/${i/3}`,'area',basinKey);
      }
      if(basinKey)basins.push({key,rings,samples});
    }
  }
  // Polygonal areas win during the later union. Waterways never double-fill a
  // river polygon. Widths are horizontal metres estimated by explicit policy.
  for(const shape of lines){
    const width=WIDTH[shape.attributes.water];
    if(!width||shape.attributes.intermittent){deferredWaterways++;continue;}
    for(const path of shape.paths)for(let i=1;i<path.length;i++){
      const a=path[i-1],b=path[i],u=(value(a.u)+value(b.u))/2,v=(value(a.v)+value(b.v))/2;
      const lat=Math.atan(Math.sinh(Math.PI*(1-2*v))),sin=Math.sin(lat),q=1-0.0066943799901413165*sin*sin;
      const east=2*Math.PI*6378137/Math.sqrt(q)*Math.cos(lat),south=2*Math.PI*6378137*(1-0.0066943799901413165)/q**1.5*Math.cos(lat);
      const dx=value(sub(b.u,a.u))*east,dy=value(sub(b.v,a.v))*south,len=Math.hypot(dx,dy);if(len<1e-8)continue;
      const du=-dy/len*width/2/east,dv=dx/len*width/2/south,scale=2**40;
      const offset=(p,ox,oy)=>({u:add(p.u,fraction(Math.round(ox*scale),scale)),v:add(p.v,fraction(Math.round(oy*scale),scale))});
      append([offset(a,du,dv),offset(a,-du,-dv),offset(b,-du,-dv),offset(b,du,dv)],`${shape.key}/${i}`,'waterway');
      // Bounded round joins. Coordinate quantisation <= 0.04 mm at the equator.
      for(const [j,p] of [[0,a],[1,b]]){
        const ring=Array.from({length:12},(_,k)=>offset(p,Math.cos(k*Math.PI/6)*width/2/east,Math.sin(k*Math.PI/6)*width/2/south));
        append(ring,`${shape.key}/${i}/cap/${j}`,'waterway');
      }
    }
  }
  return {sourceKey:tile.sourceKey,core:tile.core,z:tile.z,x:tile.x,y:tile.y,primitives,basins,deferredWaterways};
}
