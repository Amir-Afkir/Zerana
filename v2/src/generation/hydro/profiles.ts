import type { CanonicalEnvironmentTile } from '../environment/kernel.js';
import type { TerrainHeightSource } from '../terrain/elevation-source.js';
import type { HydroRegion, WaterGeometry } from '../water/model.js';
import { WATER_LIMITS } from '../water/model.js';
import { value } from '../roads/exact.js';
import { waterHeight } from '../water/hydro.js';
import { HYDRO_POLICY, inRing, metricFactors } from './conditioned-elevation.js';
import type { HydroFootprint, WaterSurfaceProfile, Point2, HydroKind } from './conditioned-elevation.js';

const wrap = (u: number) => ((u % 1) + 1) % 1;
const median = (values: number[]) => { values.sort((a,b) => a-b); return values[Math.floor((values.length-1)/2)]!; };
/** A shared, bounded profile field, independent of the requested WorldCell.
 * Closed bodies use BANK observations, not their possibly bumpy interior DEM.
 * Flowing bodies project filtered elevations onto available mapped centreline
 * segments. No direction of flow, bathymetry or ocean datum is manufactured.
 * The final water surface is the piecewise affine approximation on the shared
 * hydro lattice; it has C0 continuity, NOT a claim of hydraulic/C1 correctness.
 */
export function buildWaterSurfaceProfile(
  tiles: readonly CanonicalEnvironmentTile[], geometries: readonly WaterGeometry[],
  raw: TerrainHeightSource, revision: string,
): WaterSurfaceProfile {
  const z = tiles[0]?.z;
  if (z !== 16 && z !== 15 || !tiles.length || tiles.length > 16 || geometries.length !== tiles.length) throw new Error('HYDRO_CONTEXT_CONTRACT');
  const n = 2 ** z, scale = n * WATER_LIMITS.gridDivisions;
  const byTile = new Map(tiles.map(t => [`${t.x}/${t.y}`, t]));
  if (byTile.size !== tiles.length || tiles.some(t => t.z !== z)) throw new Error('HYDRO_CONTEXT_CONTRACT');
  const footprints: HydroFootprint[] = [], basinLevels = new Map<string, number>();
  const axes: {a: Point2;b: Point2;core: readonly [number, number, number, number]}[] = [];
  for (const tile of tiles) for (const f of tile.features) {
    if (f.attributes.layer !== 'waterway' || f.attributes.intermittent || f.attributes.water === 'UNKNOWN') continue;
    for (const path of f.paths) for (let i = 1; i < path.length; i++) {
      axes.push({a:[value(path[i-1]!.u),value(path[i-1]!.v)], b:[value(path[i]!.u),value(path[i]!.v)],
        core:[tile.x/n,tile.y/n,(tile.x+1)/n,(tile.y+1)/n]});
      if (axes.length > HYDRO_POLICY.maxPoints) throw new Error('HYDRO_PROFILE_BUDGET');
    }
  }
  for (let j = 0; j < tiles.length; j++) {
    const tile = tiles[j]!, geometry = geometries[j]!;
    if (geometry.sourceKey !== tile.sourceKey) throw new Error('HYDRO_CONTEXT_CONTRACT');
    const core = [tile.x/n,tile.y/n,(tile.x+1)/n,(tile.y+1)/n] as const;
    for (const b of geometry.basins) {
      const heights: number[] = [];
      // Fixed subdivisions of each original bank edge. Never dependent on cells.
      for (let i = 0; i < b.rings[0]!.length; i++) {
        const a = b.rings[0]![i]!, c = b.rings[0]![(i+1)%b.rings[0]!.length]!;
        const av:Point2=[value(a.u),value(a.v)],cv:Point2=[value(c.u),value(c.v)],m=metricFactors((av[1]+cv[1])/2);
        const steps=Math.max(1,Math.ceil(Math.hypot((cv[0]-av[0])*m[0],(cv[1]-av[1])*m[1])/8));
        if (heights.length + steps > 4096) throw new Error('HYDRO_PROFILE_BUDGET');
        for(let k=0;k<steps;k++) heights.push(waterHeight(raw,av[0]+(cv[0]-av[0])*k/steps,av[1]+(cv[1]-av[1])*k/steps));
      }
      if(!heights.length) throw new Error('HYDRO_PROFILE_UNRESOLVED');
      basinLevels.set(b.key,median(heights));
    }
    for (const f of tile.features.filter(f => f.attributes.layer === 'water')) for(let i=0;i<f.polygons.length;i++) {
      const key=`${f.key}/polygon/${i}`, level=basinLevels.get(key)??null;
      const poly=f.polygons[i]!.map(r=>r.map(p=>[value(p.u),value(p.v)] as const));
      const bounds=f.bounds;
      const flowing=axes.some(a=>Math.max(a.a[0],a.b[0])>=value(bounds.west)&&Math.min(a.a[0],a.b[0])<=value(bounds.east)&&
        Math.max(a.a[1],a.b[1])>=value(bounds.north)&&Math.min(a.a[1],a.b[1])<=value(bounds.south));
      const kind:HydroKind=level!==null?'CLOSED_STANDING_WATER':flowing?'FLOWING_WATER':'COASTAL_OPEN_WATER';
      footprints.push({key,kind,rings:poly,core,level});
    }
    for(const p of geometry.primitives.filter(p=>p.kind==='waterway')) footprints.push({key:p.key,kind:'LINEAR_WATERWAY',
      rings:[p.polygon.map(p=>[value(p.u),value(p.v)] as const)],core,level:null});
  }
  footprints.sort((a,b)=>a.key.localeCompare(b.key));
  const byCore=new Map<string,HydroFootprint[]>();
  for(const f of footprints){const k=`${Math.floor(f.core[0]*n)}/${Math.floor(f.core[1]*n)}`;const a=byCore.get(k)||[];a.push(f);byCore.set(k,a);}
  const covered=(u:number,v:number):boolean=>{
    u=wrap(u);const x=Math.floor(u*n),y=Math.min(n-1,Math.floor(v*n));
    if(!byTile.has(`${x}/${y}`))throw new Error('HYDRO_CONTEXT_INCOMPLETE');
    return (byCore.get(`${x}/${y}`)||[]).some(f=>inRing([u,v],f.rings[0]!)&&!f.rings.slice(1).some(r=>inRing([u,v],r)));
  };
  const rawNodes=new Map<string,number>(),nodes=new Map<string,number>();
  function rawNode(ix:number,iy:number):number {
    ix=((ix%scale)+scale)%scale;iy=Math.max(0,Math.min(scale,iy));const k=`${ix}/${iy}`,hit=rawNodes.get(k);if(hit!==undefined)return hit;
    if(rawNodes.size>=4096)throw new Error('HYDRO_PROFILE_BUDGET');
    const hs:number[]=[];
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const u=(ix*2+dx)/(scale*2),v=Math.max(0,Math.min(1,(iy*2+dy)/(scale*2)));
      if(covered(u,v))hs.push(waterHeight(raw,u,v));
    }
    const h=hs.length?median(hs):waterHeight(raw,ix/scale,iy/scale);rawNodes.set(k,h);return h;
  }
  function interpolate(u:number,v:number,node:(x:number,y:number)=>number):number {
    const x=wrap(u)*scale,y=Math.max(0,Math.min(1,v))*scale,ix=Math.floor(x),iy=Math.min(scale-1,Math.floor(y)),dx=x-ix,dy=y-iy;
    const a=node(ix,iy),b=node(ix+1,iy),c=node(ix,iy+1),d=node(ix+1,iy+1);
    return dx+dy<=1?(1-dx-dy)*a+dx*b+dy*c:(1-dy)*b+(1-dx)*c+(dx+dy-1)*d;
  }
  function node(ix:number,iy:number):number {
    ix=((ix%scale)+scale)%scale;iy=Math.max(0,Math.min(scale,iy));const k=`${ix}/${iy}`,hit=nodes.get(k);if(hit!==undefined)return hit;
    if(nodes.size>=2048)throw new Error('HYDRO_PROFILE_BUDGET');
    const u=ix/scale,v=iy/scale,m=metricFactors(v);let distance=Infinity,nearest:Point2|null=null;
    // Only use axes in the immediate neighbourhood: a canal on the other side
    // of the region must not control this waterbody. Unknown flow stays estimated.
    for(const a of axes){
      const uu=u+Math.round((a.core[0]+a.core[2])/2-u),dx=(a.b[0]-a.a[0])*m[0],dy=(a.b[1]-a.a[1])*m[1],l2=dx*dx+dy*dy;
      if(l2<1e-12)continue;
      const t=Math.max(0,Math.min(1,((uu-a.a[0])*m[0]*dx+(v-a.a[1])*m[1]*dy)/l2));
      const p:Point2=[a.a[0]+(a.b[0]-a.a[0])*t,a.a[1]+(a.b[1]-a.a[1])*t];
      if(p[0]<a.core[0]||p[0]>a.core[2]||p[1]<a.core[1]||p[1]>a.core[3])continue;
      const d=Math.hypot((p[0]-uu)*m[0],(p[1]-v)*m[1]);
      if(d<distance){distance=d;nearest=p;}
    }
    const h=nearest&&distance<=40&&covered(u,v)?interpolate(nearest[0],nearest[1],rawNode):rawNode(ix,iy);
    nodes.set(k,h);return h;
  }
  const levelAt=(u:number,v:number)=>interpolate(u,v,node);
  return Object.freeze({revision,verticalReference:raw.verticalReference,authority:'estimated-not-hydraulically-qualified' as const,
    footprints:Object.freeze(footprints),levelAt});
}
export function regionFromProfile(geometry:WaterGeometry, profile:WaterSurfaceProfile, sourceTiles:readonly string[]):HydroRegion {
  const n=WATER_LIMITS.gridDivisions,scale=2**geometry.z*n,levels=new Float64Array((n+1)**2);
  for(let y=0;y<=n;y++)for(let x=0;x<=n;x++)levels[y*(n+1)+x]=profile.levelAt((geometry.x*n+x)/scale,(geometry.y*n+y)/scale);
  const basinLevels=new Map<string,number>();
  for(const b of geometry.basins){const f=profile.footprints.find(f=>f.key===b.key);if(f?.level!==null&&f?.level!==undefined)basinLevels.set(b.key,f.level);}
  return {key:`hydro/${geometry.z}/${geometry.x}/${geometry.y}/${profile.revision}`,z:geometry.z,x:geometry.x,y:geometry.y,
    levels,basinLevels,geometry,sourceTiles,verticalReference:profile.verticalReference,heightAuthority:profile.authority};
}
