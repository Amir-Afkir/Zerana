import { canonicalizeEnvironmentTile } from '../../src/generation/environment/kernel.ts';
import { normalizeMapboxEnvironment } from '../../src/providers/vectors/mapbox-environment.ts';
/** Explicitly fictitious lake/island/forest/wetland and stream, no paid calls. */
export function syntheticEnvironmentTile(road){
  const ring=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  const f=(layer,c,paths,geometry='polygon')=>({sourceIndex:0,attributes:normalizeMapboxEnvironment(layer,{class:c}),paths,geometry});
  return canonicalizeEnvironmentTile({...road,layers:[
    {name:'water',extent:4096,state:'present',features:[f('water','',[ring(1300,1600,2100,2100),ring(2250,2300,400,400).reverse()])]},
    {name:'waterway',extent:4096,state:'present',features:[f('waterway','stream',[[[0,1850],[4096,1850]]],'line')]},
    {name:'landuse',extent:4096,state:'present',features:[f('landuse','wood',[ring(100,1500,3950,2400)])]},
    {name:'landuse_overlay',extent:4096,state:'present',features:[f('landuse_overlay','wetland',[ring(900,1500,600,2400)])]},
  ]});
}
