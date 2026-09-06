import { fraction,value } from '../roads/exact.js';
import { unprojectMercator } from '../../geo/mercator.js';
import { geodeticRadians } from '../../geo/geodetic.js';
import { meters } from '../../geo/units.js';
import type { TerrainHeightSource } from '../terrain/elevation-source.js';
import type { CanonicalEnvironmentTile } from '../environment/kernel.js';
import type { WaterGeometry,HydroRegion } from './model.js';
import { WATER_LIMITS as L, WATER_VERSION } from './model.js';

export function waterHeight(source:TerrainHeightSource,u:number,v:number):number {
  const geo=unprojectMercator({u,v}),h=Number(source.heightAt(geodeticRadians(geo.longitudeRad,geo.latitudeRad,meters(0))));
  if(!Number.isFinite(h)||Math.abs(h)>100000)throw new Error('WATER_HEIGHT_UNRESOLVED');return h;
}
/** Compact numeric view for selecting DEM taps only. Exact clipping remains the
 * geometry authority; these tests cannot modify a shoreline or create land. */
function ringContains(u:number,v:number,ring:readonly (readonly [number,number])[]):boolean {
  let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i]!,b=ring[j]!;
    if((a[1]>v)!==(b[1]>v)&&u<(b[0]-a[0])*(v-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }return inside;
}
/** Complete one-source-tile halo is required even if the active cell is tiny.
 * At a shared grid node every region evaluates the SAME fixed 5x5 DEM taps.
 * Thus the result never depends on player position, LOD, or arrival order.
 * This is an elevation preview, NOT a river flow-direction solver. */
export function buildHydroRegion(geometry:WaterGeometry,tiles:readonly CanonicalEnvironmentTile[],source:TerrainHeightSource):HydroRegion {
  const {z,x,y}=geometry,n=2**z,byId=new Map(tiles.map(t=>[`${t.x}/${t.y}`,t]));
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(y+dy<0||y+dy>=n)continue;
    const t=byId.get(`${(x+dx+n)%n}/${y+dy}`);
    if(!t||t.z!==z)throw new Error('WATER_CONTEXT_INCOMPLETE');
  }
  // A fetched, valid tile with no water layer means no mapped water there.
  // It is not equivalent to a missing or malformed provider response.
  const mask=new Map(tiles.map(t=>[`${t.x}/${t.y}`,t.features.filter(f=>f.attributes.layer==='water').flatMap(f=>
    f.polygons.map(poly=>poly.map(r=>r.map(p=>[value(p.u),value(p.v)] as const))))]));
  const covered=(uu:number,v:number):boolean=>{
    const u=((uu%1)+1)%1,xx=Math.floor(u*n),yy=Math.min(n-1,Math.floor(v*n));
    const polygons=mask.get(`${xx}/${yy}`);if(!polygons)throw new Error('WATER_CONTEXT_INCOMPLETE');
    return polygons.some(p=>ringContains(u,v,p[0]!)&&p.slice(1).every(h=>!ringContains(u,v,h)));
  };
  const level=(gx:number,gy:number):number=>{
    const values:number[]=[],scale=n*L.gridDivisions,u=gx/scale,v=gy/scale;
    // Tap coordinates are dyadic global addresses, not accumulated local offsets.
    for(let oy=-2;oy<=2;oy++)for(let ox=-2;ox<=2;ox++){
      const su=(gx*2+ox)/(scale*2),sv=Math.max(0,Math.min(1,(gy*2+oy)/(scale*2)));
      if(covered(su,sv))values.push(waterHeight(source,su,sv));
    }
    if(!values.length)return waterHeight(source,u,v);
    values.sort((a,b)=>a-b);return values[Math.floor((values.length-1)/2)]!;
  };
  const width=L.gridDivisions+1,levels=new Float64Array(width*width);
  for(let row=0;row<width;row++)for(let col=0;col<width;col++)levels[row*width+col]=level(x*L.gridDivisions+col,y*L.gridDivisions+row);
  const basinLevels=new Map<string,number>();
  for(const b of geometry.basins){
    const samples=b.samples.map(s=>({h:waterHeight(source,value(s.point.u),value(s.point.v)),w:s.weight})).sort((a,b)=>a.h-b.h);
    const total=samples.reduce((sum,s)=>sum+s.w,0);let acc=0;
    for(const s of samples){acc+=s.w;if(acc>=total/2){basinLevels.set(b.key,s.h);break;}}
  }
  return {key:`${WATER_VERSION}/${z}/${x}/${y}/${source.id}`,z,x,y,levels,basinLevels,geometry,
    sourceTiles:tiles.map(t=>t.sourceKey).sort(),verticalReference:source.verticalReference,heightAuthority:'estimated-not-hydraulically-qualified'};
}
/** Piecewise-linear global hydro lattice, same diagonal convention as terrain.
 * Shared boundary heights are exact inputs; Float32 is only the final renderer. */
export function hydroLevel(r:HydroRegion,u:number,v:number):number {
  const n=r.gridDivisions??L.gridDivisions,s=n*2**r.z,x=u*s-r.x*n,y=v*s-r.y*n;
  if(x < -1e-7||y < -1e-7||x>n+1e-7||y>n+1e-7)throw new Error('WATER_OUTSIDE_REGION');
  const col=Math.max(0,Math.min(n-1,Math.floor(x))),row=Math.max(0,Math.min(n-1,Math.floor(y)));
  const dx=Math.max(0,Math.min(1,x-col)),dy=Math.max(0,Math.min(1,y-row)),a=row*(n+1)+col,b=a+1,c=a+n+1,d=c+1;
  return dx+dy<=1?r.levels[a]!*(1-dx-dy)+r.levels[b]!*dx+r.levels[c]!*dy:
    r.levels[b]!*(1-dy)+r.levels[c]!*(1-dx)+r.levels[d]!*(dx+dy-1);
}
export function hydroGridPoint(r:HydroRegion,x:number,y:number){const n=r.gridDivisions??L.gridDivisions;return {u:fraction(r.x*n+x,2**r.z*n),v:fraction(r.y*n+y,2**r.z*n)};}
