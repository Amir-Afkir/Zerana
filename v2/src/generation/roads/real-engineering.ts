/** Bounded road engineering from an immutable geographic context.
 * A region is a fixed recipe domain, NOT the player's streaming WorldCell.
 * The boundary collar deliberately returns to raw DEM: this first real-data
 * stage does not claim a globally solved civil-engineering alignment.
 */
import type { WorldCellId } from '../../geo/cell-scheme.js';
import { MercatorCellScheme, cellId } from '../../geo/mercator-cell-scheme.js';
import { createGeoAnchor } from '../../geo/enu.js';
import type { GeoAnchor } from '../../geo/enu.js';
import { geodeticToEcef, ecefToGeodetic } from '../../geo/ecef.js';
import { geodeticRadians } from '../../geo/geodetic.js';
import type { GeodeticPosition } from '../../geo/geodetic.js';
import { ecefToThreeLocal, threeLocalToEcef } from '../../geo/three-frame.js';
import { projectMercator } from '../../geo/mercator.js';
import { WGS84 } from '../../geo/wgs84.js';
import { meters } from '../../geo/units.js';
import type { TerrainHeightSource } from '../terrain/elevation-source.js';
import type { RoadGraph, RoadEdge } from './model.js';
import { attributesKey } from './model.js';
import { roadPointGeodetic } from './kernel.js';
import { pointKey } from './exact.js';
import { resolveRoadSurfaceStyle } from './surface-style.js';
import { buildEngineeringProfile, profileAt, transitionWeight, DEFAULT_ENGINEERING_POLICY } from './engineering-profile.js';
import type { EngineeringProfile } from './engineering-profile.js';

export const REAL_ENGINEERING_VERSION = 'real-ground-engineering-v1';
export const REAL_ENGINEERING_LIMITS = Object.freeze({ regionLevel: 16, maxLatitudeDegrees: 75,
  maxCorridors: 256, maxSegments: 4096, maxStations: 1025, maxLengthMeters: 2000,
  minLengthMeters: 24, sampleStepMeters: 4, blendMeters: 12, collarMeters: 12,
  maxCutFillMeters: 3, binMeters: 32, maxIndexReferences: 65536 });
const scheme = new MercatorCellScheme();
type XY = readonly [number, number]; // East, North, horizontal metres in a fixed ENU.
interface Path {
  readonly key: string; readonly points: readonly XY[]; readonly stations: Float64Array;
  readonly nodeKeys: readonly [string,string]; readonly width: number;
  readonly profile: EngineeringProfile; readonly endFade: number;
}
interface Link { readonly a: XY; readonly b: XY; readonly path: number; readonly index: number }
interface Junction { readonly point: XY; readonly height: number; readonly inner: number; readonly outer: number }
interface Obstacle { readonly a: XY; readonly b: XY }
export interface RealEngineeringDiagnostics {
  readonly version: typeof REAL_ENGINEERING_VERSION;
  readonly regionKey: string; readonly sourceRevision: string;
  readonly authority: 'estimated-game-earthwork'; readonly topologyAuthority: 'cartographic-not-routable';
  readonly boundaryMode: 'fixed-raw-collar'; readonly qualifiedForDriving: false;
  readonly candidates: number; readonly accepted: number; readonly deferred: Readonly<Record<string,number>>;
  readonly junctions: number; readonly segments: number; readonly indexReferences: number;
}
export interface RealEngineeringRegion {
  readonly id: WorldCellId; readonly diagnostics: RealEngineeringDiagnostics;
  readonly raw: TerrainHeightSource;
  sample(position: GeodeticPosition): {heightMeters: number; rawHeightMeters: number; deltaMeters: number};
}
const distance = (a: XY,b: XY): number => Math.hypot(a[0]-b[0],a[1]-b[1]);
const local = (p: GeodeticPosition,anchor: GeoAnchor): XY => {
  const v=ecefToThreeLocal(geodeticToEcef(geodeticRadians(p.longitudeRad,p.latitudeRad,meters(0))),anchor);
  return [v[0],-v[2]];
};
const geo = (p: XY,anchor: GeoAnchor): GeodeticPosition => {
  const g=ecefToGeodetic(threeLocalToEcef([p[0],0,-p[1]],anchor));
  return geodeticRadians(g.longitudeRad,g.latitudeRad,meters(0));
};
function projection(p: XY,a: XY,b: XY): {t:number;distance:number;lateral:number} {
  const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
  const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(length*length)));
  return {t,distance:Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy),
    lateral:(dx*(p[1]-a[1])-dy*(p[0]-a[0]))/length};
}
function pathPoint(points: readonly XY[],stations: Float64Array,s: number): XY {
  let low=0,high=stations.length-1;
  while(high-low>1){const mid=(low+high)>>1;if(stations[mid]!<=s)low=mid;else high=mid;}
  const t=Math.max(0,Math.min(1,(s-stations[low]!)/(stations[low+1]!-stations[low]!)));
  return [points[low]![0]+t*(points[low+1]![0]-points[low]![0]),points[low]![1]+t*(points[low+1]![1]-points[low]![1])];
}
/** Exact normalized region ownership, including the anti-meridian alias. */
export function engineeringRegionAt(p: GeodeticPosition): WorldCellId {
  return scheme.getCellAt(p,REAL_ENGINEERING_LIMITS.regionLevel);
}
/** Includes the terrain normal's one-sample halo. At this stage only fine
 * equal-LOD grids qualify, rather than silently making a coarse collider fine. */
export function engineeringRegionsForCell(id: WorldCellId,n: number): readonly WorldCellId[] {
  cellId(id.level,id.x,id.y);
  if(id.scheme!=='web-mercator'||![19,21].includes(id.level)||n!==32)throw new Error('ROAD_ENGINEERING_RESOLUTION');
  const period=2**REAL_ENGINEERING_LIMITS.regionLevel,scale=period/(2**id.level*n),found=new Map<string,WorldCellId>();
  const y0=Math.max(0,Math.floor((id.y*n-1)*scale)),y1=Math.min(period-1,Math.floor(((id.y+1)*n+1)*scale));
  for(let y=y0;y<=y1;y++)for(let x=Math.floor((id.x*n-1)*scale);x<=Math.floor(((id.x+1)*n+1)*scale);x++){
    const xx=((x%period)+period)%period,c=cellId(REAL_ENGINEERING_LIMITS.regionLevel,xx,y);
    found.set(`${xx}/${y}`,c);
  }
  if(found.size>4)throw new Error('ROAD_ENGINEERING_REGION_BUDGET');
  return [...found.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
}
/** Geometry-only construction candidates. Missing drawing layer stays a
 * separate UNKNOWN stratum, never converted to layer=0 or a routing edge. */
export function buildRealEngineeringRegion(id: WorldCellId,graph: RoadGraph,raw: TerrainHeightSource,revision: string): RealEngineeringRegion {
  cellId(id.level,id.x,id.y);
  if(id.scheme!=='web-mercator'||id.level!==REAL_ENGINEERING_LIMITS.regionLevel||!(/^[a-f0-9]{64}$/.test(revision))||
    !raw?.id||typeof raw.heightAt!=='function'||!Array.isArray(graph?.edges)||graph.edges.length>60000||graph.schema!=='zerana-road-kernel-v1')throw new Error('ROAD_ENGINEERING_REGION_CONTRACT');
  const anchor=createGeoAnchor(scheme.getCenter(id)),regionKey=`engineering/${id.level}/${id.x}/${id.y}`;
  const deferred:Record<string,number>={};const defer=(why:string):void=>{deferred[why]=(deferred[why]||0)+1;};
  const paths:Path[]=[],junctions:Junction[]=[],obstacles:Obstacle[]=[];
  const nodePoints=new Map<string,XY>(),incidence=new Map<string,RoadEdge[]>(),endpoints=new Map<string,readonly [string,string]>();
  const latitude=Math.abs(scheme.getCenter(id).latitudeRad)*180/Math.PI;
  const eligible=(e:RoadEdge):boolean=>e.attributes.structure==='ground'&&resolveRoadSurfaceStyle(e.attributes)!==null;
  for(const e of graph.edges){
    if(!eligible(e)) {obstacles.push({a:local(roadPointGeodetic(e.a),anchor),b:local(roadPointGeodetic(e.b),anchor)});continue;}
    const stratum=`ground/${e.attributes.layer===null?'unknown-drawing-layer':e.attributes.layer}`;
    const keys=[`${stratum}/${pointKey(e.a)}`,`${stratum}/${pointKey(e.b)}`] as const;
    endpoints.set(e.key,keys);
    for(let k=0;k<2;k++){
      const key=keys[k]!,p=k===0?e.a:e.b;
      nodePoints.set(key,local(roadPointGeodetic(p),anchor));
      const adjacent=incidence.get(key)||[];adjacent.push(e);incidence.set(key,adjacent);
    }
  }
  const nodeOther=(e:RoadEdge,key:string):string=>{const p=endpoints.get(e.key)!;return p[0]===key?p[1]:p[0];};
  // A sharp cartographic corner terminates an alignment; it does not receive an
  // invented large-radius horizontal bend or silently moved source geometry.
  const joins=(key:string):boolean=>{
    const es=incidence.get(key)!;
    if(es.length!==2||attributesKey(es[0]!.attributes)!==attributesKey(es[1]!.attributes))return false;
    const p=nodePoints.get(key)!,a=nodePoints.get(nodeOther(es[0]!,key))!,b=nodePoints.get(nodeOther(es[1]!,key))!;
    return ((a[0]-p[0])*(b[0]-p[0])+(a[1]-p[1])*(b[1]-p[1]))/(distance(a,p)*distance(b,p)) < -Math.cos(Math.PI/9);
  };
  const chains:{edges:RoadEdge[];nodes:string[]}[]=[],visited=new Set<string>();
  const trace=(first:RoadEdge,start:string):void=>{
    const edges:RoadEdge[]=[],nodes=[start];let edge=first,node=start;
    while(!visited.has(edge.key)){
      visited.add(edge.key);edges.push(edge);node=nodeOther(edge,node);nodes.push(node);
      if(!joins(node))break;
      const next=incidence.get(node)!.find(e=>e.key!==edge.key)!;if(visited.has(next.key))break;edge=next;
    }
    if(nodes[0]!>nodes[nodes.length-1]!){nodes.reverse();edges.reverse();}
    chains.push({edges,nodes});
  };
  const ordered=[...endpoints.keys()].sort();const edgeByKey=new Map(graph.edges.map(e=>[e.key,e]));
  for(const key of ordered){const e=edgeByKey.get(key)!,ends=endpoints.get(key)!;
    if(!visited.has(key)&&(!joins(ends[0])||!joins(ends[1])))trace(e,!joins(ends[0])?ends[0]:ends[1]);}
  for(const key of ordered)if(!visited.has(key))trace(edgeByKey.get(key)!,endpoints.get(key)![0]);
  chains.sort((a,b)=>a.nodes[0]!.localeCompare(b.nodes[0]!)||a.edges[0]!.key.localeCompare(b.edges[0]!.key));
  const nodeOrdinal=new Map([...nodePoints.keys()].sort().map((key,i)=>[key,i]));
  let candidates=0,totalSegments=0;
  const core=scheme.getBounds(id),corners=[
    geodeticRadians(core.westRad,core.southRad,meters(0)),geodeticRadians(core.eastRad,core.northRad,meters(0)),
    geodeticRadians(core.westRad,core.northRad,meters(0)),geodeticRadians(core.eastRad,core.southRad,meters(0))].map(p=>local(p,anchor));
  const minX=Math.min(...corners.map(p=>p[0]))-20,maxX=Math.max(...corners.map(p=>p[0]))+20,
    minY=Math.min(...corners.map(p=>p[1]))-20,maxY=Math.max(...corners.map(p=>p[1]))+20;
  const rawAt=(p:XY):number=>raw.heightAt(geo(p,anchor));
  for(const chain of chains){
    const points=chain.nodes.map(key=>nodePoints.get(key)!);
    let loX=Infinity,hiX=-Infinity,loY=Infinity,hiY=-Infinity;
    for(const p of points){loX=Math.min(loX,p[0]);hiX=Math.max(hiX,p[0]);loY=Math.min(loY,p[1]);hiY=Math.max(hiY,p[1]);}
    if(hiX<minX||loX>maxX||hiY<minY||loY>maxY)continue;
    candidates++;
    if(latitude>REAL_ENGINEERING_LIMITS.maxLatitudeDegrees){defer('LATITUDE_UNQUALIFIED');continue;}
    if(chain.nodes[0]===chain.nodes[chain.nodes.length-1]){defer('CLOSED_ALIGNMENT_DEFERRED');continue;}
    const stations=new Float64Array(points.length);
    for(let i=1;i<points.length;i++)stations[i]=stations[i-1]!+distance(points[i-1]!,points[i]!);
    const length=stations[stations.length-1]!;
    if(!Number.isFinite(length)||length<REAL_ENGINEERING_LIMITS.minLengthMeters||length>REAL_ENGINEERING_LIMITS.maxLengthMeters){defer('ALIGNMENT_LENGTH');continue;}
    if(paths.length>=REAL_ENGINEERING_LIMITS.maxCorridors||totalSegments+points.length-1>REAL_ENGINEERING_LIMITS.maxSegments){defer('ALIGNMENT_BUDGET');continue;}
    const count=Math.ceil(length/REAL_ENGINEERING_LIMITS.sampleStepMeters)+1,step=length/(count-1);
    if(count>REAL_ENGINEERING_LIMITS.maxStations){defer('STATION_BUDGET');continue;}
    const heights=new Float64Array(count),curvature=new Float64Array(count);
    for(let i=0;i<count;i++){
      const s=i*step,p=pathPoint(points,stations,s);heights[i]=rawAt(p);
      if(i>0&&i<count-1){const a=pathPoint(points,stations,Math.max(0,s-8)),b=pathPoint(points,stations,Math.min(length,s+8));
        const denom=distance(a,p)*distance(p,b)*distance(a,b);
        curvature[i]=denom>1e-9?2*((p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]))/denom:0;}
    }
    // Shared junction reference heights and zero terminal grade are estimates.
    const policy={...DEFAULT_ENGINEERING_POLICY,maxCutMeters:3,maxFillMeters:3,designSpeedMetersPerSecond:6};
    const index=paths.length,key=`${regionKey}@${revision}/${index}`;
    const result=buildEngineeringProfile({corridorKey:key,sourceRevision:revision,startBoundaryKey:`${regionKey}/n${nodeOrdinal.get(chain.nodes[0]!)}`,
      endBoundaryKey:`${regionKey}/n${nodeOrdinal.get(chain.nodes[chain.nodes.length-1]!)}`,verticalReference:raw.verticalReference,
      startStationMeters:0,stepMeters:step,groundHeightsMeters:heights,curvaturePerMeter:curvature,startGrade:0,endGrade:0},policy);
    if(result.kind!=='ready'){for(const reason of result.reasons)defer(`STRUCTURE_REQUIRED_${reason}`);continue;}
    const width=resolveRoadSurfaceStyle(chain.edges[0]!.attributes)!.widthMeters;
    // Validate a fixed metric strip BEFORE using this alignment anywhere.
    // This is sampling, not a proof about every unsampled DEM point.
    let acceptable=true;
    for(let i=0;i<count&&acceptable;i++){
      const s=i*step,p=pathPoint(points,stations,s),a=pathPoint(points,stations,Math.max(0,s-.25)),b=pathPoint(points,stations,Math.min(length,s+.25));
      const l=distance(a,b),h=profileAt(result.profile,s);
      for(const t of [-width/2-12,-width/2,0,width/2,width/2+12]){
        const q:XY=[p[0]-t*(b[1]-a[1])/l,p[1]+t*(b[0]-a[0])/l];
        const target=h.heightMeters+h.bankSlope*t-h.crownSlope*Math.abs(t);
        if(Math.abs(target-rawAt(q))>3){acceptable=false;break;}
      }
    }
    if(!acceptable){defer('STRUCTURE_REQUIRED_STRIP_CUT_FILL');continue;}
    paths.push({key,points,stations,nodeKeys:[chain.nodes[0]!,chain.nodes[chain.nodes.length-1]!],width,profile:result.profile,endFade:24});
    totalSegments+=points.length-1;
  }
  // One reference plane per compatible cartographic junction. No graph mutation,
  // no merge between known/unknown strata, no bridge/tunnel fabricated as ground.
  const usedNodes=new Set(paths.flatMap(p=>p.nodeKeys));
  for(const key of [...usedNodes].sort()){
    const edges=incidence.get(key)!;
    if(edges.length<2||joins(key))continue;
    const point=nodePoints.get(key)!,height=rawAt(point);
    const inner=Math.max(...edges.map(e=>resolveRoadSurfaceStyle(e.attributes)!.widthMeters))*.6,outer=inner+8;
    let safe=true;
    for(let i=0;i<16;i++){
      const a=i*Math.PI/8;
      if(Math.abs(height-rawAt([point[0]+outer*Math.cos(a),point[1]+outer*Math.sin(a)]))>3){safe=false;break;}
    }
    if(safe)junctions.push({point,height,inner,outer});else defer('JUNCTION_CUT_FILL_DEFERRED');
  }
  const bins=new Map<string,number[]>(),links:Link[]=[],obstacleBins=new Map<string,number[]>(),junctionBins=new Map<string,number[]>();let references=0;
  const insert=(map:Map<string,number[]>,a:XY,b:XY,r:number,index:number):void=>{
    const step=REAL_ENGINEERING_LIMITS.binMeters;
    for(let y=Math.floor((Math.min(a[1],b[1])-r)/step);y<=Math.floor((Math.max(a[1],b[1])+r)/step);y++)
      for(let x=Math.floor((Math.min(a[0],b[0])-r)/step);x<=Math.floor((Math.max(a[0],b[0])+r)/step);x++){
        if(++references>REAL_ENGINEERING_LIMITS.maxIndexReferences)throw new Error('ROAD_ENGINEERING_INDEX_BUDGET');
        const key=`${x}/${y}`,values=map.get(key)||[];values.push(index);map.set(key,values);
      }
  };
  for(let p=0;p<paths.length;p++)for(let i=1;i<paths[p]!.points.length;i++){
    const link={a:paths[p]!.points[i-1]!,b:paths[p]!.points[i]!,path:p,index:i-1};
    insert(bins,link.a,link.b,paths[p]!.width/2+12,links.length);links.push(link);
  }
  for(let i=0;i<obstacles.length;i++)insert(obstacleBins,obstacles[i]!.a,obstacles[i]!.b,20,i);
  for(let i=0;i<junctions.length;i++)insert(junctionBins,junctions[i]!.point,junctions[i]!.point,junctions[i]!.outer,i);
  const diagnostics:RealEngineeringDiagnostics=Object.freeze({version:REAL_ENGINEERING_VERSION,regionKey,sourceRevision:revision,
    authority:'estimated-game-earthwork',topologyAuthority:'cartographic-not-routable',boundaryMode:'fixed-raw-collar',qualifiedForDriving:false,
    candidates,accepted:paths.length,deferred:Object.freeze(deferred),junctions:junctions.length,segments:links.length,indexReferences:references});
  return Object.freeze({id:Object.freeze({...id}),diagnostics,raw,
    sample(position:GeodeticPosition){
      const owner=engineeringRegionAt(position);
      if(owner.x!==id.x||owner.y!==id.y)throw new Error('ROAD_ENGINEERING_REGION_OWNERSHIP');
      const rawHeightMeters=raw.heightAt(position),p=local(position,anchor),bin=`${Math.floor(p[0]/32)}/${Math.floor(p[1]/32)}`;
      // Blend ALL supported projections, not the nearest polyline segment.
      // A nearest-segment switch at a corner otherwise jumps between two
      // distinct stations even though both distances are equal. Each input to
      // this partition of unity is continuous. It is not a C1 road-fit proof.
      const contributions=new Map<number,{sum:number;weighted:number;uncovered:number}>();
      for(const li of bins.get(bin)||[]){
        const l=links[li]!,q=projection(p,l.a,l.b),path=paths[l.path]!,length=path.stations[path.stations.length-1]!;
        const s=path.stations[l.index]!+q.t*(path.stations[l.index+1]!-path.stations[l.index]!);
        const w=(1-transitionWeight((q.distance-path.width/2)/12))*transitionWeight(s/path.endFade)*transitionWeight((length-s)/path.endFade);
        if(w<=0)continue;
        const h=profileAt(path.profile,Math.max(0,Math.min(length,s)));
        const target=h.heightMeters+h.bankSlope*q.lateral-h.crownSlope*Math.abs(q.lateral);
        const c=contributions.get(l.path)||{sum:0,weighted:0,uncovered:1};
        c.sum+=w;c.weighted+=w*(target-rawHeightMeters);c.uncovered*=1-w;contributions.set(l.path,c);
      }
      let sum=0,weighted=0,uncovered=1;
      for(const [,c] of [...contributions].sort(([a],[b])=>a-b)){
        const weight=1-c.uncovered;
        weighted+=weight*c.weighted/c.sum;sum+=weight;uncovered*=1-weight;
      }
      let delta=sum>0?(1-uncovered)*weighted/sum:0;
      let jSum=0,jWeighted=0,jUncovered=1;
      for(const ji of junctionBins.get(bin)||[]){const j=junctions[ji]!,weight=1-transitionWeight((distance(p,j.point)-j.inner)/(j.outer-j.inner));
        if(weight>0){jSum+=weight;jWeighted+=weight*(j.height-rawHeightMeters);jUncovered*=1-weight;}}
      if(jSum>0)delta=jUncovered*delta+(1-jUncovered)*jWeighted/jSum;
      let permitted=1;
      for(const oi of obstacleBins.get(bin)||[]){const o=obstacles[oi]!,d=projection(p,o.a,o.b).distance;permitted=Math.min(permitted,transitionWeight((d-12)/8));}
      const m=projectMercator(position.longitudeRad,position.latitudeRad),n=2**id.level,sin=Math.sin(position.latitudeRad),cos=Math.cos(position.latitudeRad),e2=WGS84.eccentricitySquared;
      const east=2*Math.PI*WGS84.semiMajorMeters*cos/Math.sqrt(1-e2*sin*sin);
      const north=2*Math.PI*WGS84.semiMajorMeters*(1-e2)*cos/(1-e2*sin*sin)**1.5;
      const border=Math.min((m.u-id.x/n)*east,((id.x+1)/n-m.u)*east,(m.v-id.y/n)*north,((id.y+1)/n-m.v)*north);
      delta*=permitted*transitionWeight(border/REAL_ENGINEERING_LIMITS.collarMeters);
      if(!Number.isFinite(delta)||Math.abs(delta)>REAL_ENGINEERING_LIMITS.maxCutFillMeters+1e-9)throw new Error('ROAD_ENGINEERING_CUT_FILL_REJECTED');
      return {heightMeters:rawHeightMeters+delta,rawHeightMeters,deltaMeters:delta};
    }});
}
