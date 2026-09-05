import type { RoadAttributes,RoadCategory } from '../../generation/roads/model.js';

function text(v:unknown):string { return typeof v==='string'?v.slice(0,96):''; }
/** Normalization is deliberately limited to documented Streets v8 semantics.
 * Missing tags stay unknown. No fake widths, lanes, elevations or routing rights. */
export function normalizeMapboxRoad(p:Readonly<Record<string,unknown>>):RoadAttributes|null {
  const c=text(p['class']),t=text(p['type']);
  if(['major_rail','minor_rail','service_rail','ferry','aerialway','golf'].includes(c))return null;
  const categories:Record<string,RoadCategory>={motorway:'MOTORWAY',motorway_link:'MOTORWAY',trunk:'TRUNK',trunk_link:'TRUNK',primary:'PRIMARY',primary_link:'PRIMARY',secondary:'SECONDARY',secondary_link:'SECONDARY',tertiary:'TERTIARY',tertiary_link:'TERTIARY',street:'STREET',street_limited:'STREET',service:'SERVICE',track:'TRACK',pedestrian:'PEDESTRIAN',construction:'CONSTRUCTION'};
  const paths:Record<string,RoadCategory>={cycleway:'CYCLEWAY',footway:'FOOTWAY',sidewalk:'FOOTWAY',steps:'STEPS',path:'TRAIL',hiking:'TRAIL',trail:'TRAIL',bridleway:'TRAIL',mountain_bike:'TRAIL'};
  const category=c==='path'?(paths[t]??'UNKNOWN'):(categories[c]??'UNKNOWN');
  const s=p['structure'];
  return Object.freeze({category,sourceClass:c,sourceType:t,
    structure:s==='none'?'ground':s==='bridge'||s==='tunnel'||s==='ford'?s:'unknown',
    layer:Number.isInteger(p['layer'])&&Math.abs(Number(p['layer']))<=100?Number(p['layer']):null,
    oneway:p['oneway']==='true'||p['oneway']===true?'forward':p['oneway']==='false'||p['oneway']===false?'both':'unknown',
    surface:p['surface']==='paved'?'paved':p['surface']==='unpaved'?'unpaved':'unknown',
    access:p['access']==='restricted'?'restricted':'unknown',widthMeters:null,widthProvenance:'unknown'});
}
