import type { EcefPosition } from '../../geo/geodetic.js';
import { ecefToThreeLocal } from '../../geo/three-frame.js';
import type { GeoAnchor } from '../../geo/enu.js';
import type { WaterPacket } from '../water/surface.js';

/** Read-only diagnostic, called explicitly (not per frame). Query the actual
 * uploaded triangles. Distinguish a submerged viewpoint from a dry-bank view;
 * never move the camera/player or fabricate an invisible water collider. */
export function probeWaterView(point:EcefPosition, surfaces:readonly {anchor:GeoAnchor;water:WaterPacket}[]) {
  let columnClearance:number|null=null,nearbyMax:number|null=null,nearbyVertices=0;
  if(surfaces.length>128)throw new Error('HYDRO_VIEW_BUDGET');
  for(const s of surfaces){
    const q=ecefToThreeLocal(point,s.anchor),pos=s.water.positions,idx=s.water.indices;
    for(let i=0;i<pos.length;i+=3)if(Math.hypot(pos[i]!-q[0],pos[i+2]!-q[2])<=100){
      nearbyVertices++;nearbyMax=Math.max(nearbyMax??-Infinity,pos[i+1]!-q[1]);
    }
    for(let i=0;i<idx.length;i+=3){
      const a=idx[i]!*3,b=idx[i+1]!*3,c=idx[i+2]!*3;
      const bx=pos[b]!-pos[a]!,bz=pos[b+2]!-pos[a+2]!,cx=pos[c]!-pos[a]!,cz=pos[c+2]!-pos[a+2]!;
      const den=bx*cz-bz*cx;if(Math.abs(den)<1e-12)continue;
      const dx=q[0]-pos[a]!,dz=q[2]-pos[a+2]!,u=(dx*cz-dz*cx)/den,v=(bx*dz-bz*dx)/den;
      if(u<0||v<0||u+v>1)continue;
      const height=pos[a+1]!*(1-u-v)+pos[b+1]!*u+pos[c+1]!*v;
      columnClearance=Math.min(columnClearance??Infinity,q[1]-height);
    }
  }
  return {overWater:columnClearance!==null,clearanceMeters:columnClearance,
    nearbyMaxWaterAbovePointMeters:nearbyMax,nearbyVertices,nearbyRadiusMeters:100};
}
