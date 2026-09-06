import type { EnvironmentAttributes, EnvironmentLayer, SurfaceCover, ZoneUse, WaterKind } from '../../generation/environment/model.js';

const covers:Readonly<Record<string,SurfaceCover>>=Object.freeze({wood:'WOOD',scrub:'SCRUB',grass:'GRASS',agriculture:'CROPS',rock:'ROCK',sand:'SAND',glacier:'ICE'});
const uses:Readonly<Record<string,ZoneUse>>=Object.freeze({agriculture:'AGRICULTURE',airport:'AIRPORT',cemetery:'CEMETERY',commercial_area:'COMMERCIAL',industrial:'INDUSTRIAL',park:'PARK',parking:'PARKING',residential:'RESIDENTIAL',pitch:'SPORT',piste:'SPORT',facility:'FACILITY',hospital:'FACILITY',school:'FACILITY',national_park:'PROTECTED'});
const waters:Readonly<Record<string,WaterKind>>=Object.freeze({river:'RIVER',canal:'CANAL',stream:'STREAM',stream_intermittent:'STREAM',drain:'DRAIN',ditch:'DITCH'});
const text=(v:unknown):string=>typeof v==='string'?v.slice(0,128):'';
const own=<T>(map:Readonly<Record<string,T>>,k:string,fallback:T):T=>Object.prototype.hasOwnProperty.call(map,k)?map[k]!:fallback;
export function normalizeMapboxEnvironment(layer:EnvironmentLayer,p:Readonly<Record<string,unknown>>):EnvironmentAttributes {
  const sourceClass=text(p.class),sourceType=text(p.type),land=layer==='landuse'||layer==='landuse_overlay';
  return Object.freeze({layer,sourceClass,sourceType,
    cover:land?own(covers,sourceClass,'UNKNOWN'):'UNKNOWN',
    use:land?own(uses,sourceClass,'UNKNOWN'):'UNKNOWN',
    water:layer==='water'?'WATER_AREA':layer==='waterway'?own(waters,sourceClass,'UNKNOWN'):'UNKNOWN',
    wetland:land&&['wetland','wetland_noveg'].includes(sourceClass),
    intermittent:layer==='waterway'&&sourceClass==='stream_intermittent',
    authority:'source-classification',waterHeightMeters:null});
}
