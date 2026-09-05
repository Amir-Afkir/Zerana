import type { RoadPoint } from './exact.js';

export const ROAD_LIMITS=Object.freeze({maxTiles:16,maxFeatures:12000,maxPoints:120000,
  maxEdges:60000,maxFragments:30000,maxDebugSegments:60000,maxCells:9,maxExtent:65536});
export type RoadCategory='MOTORWAY'|'TRUNK'|'PRIMARY'|'SECONDARY'|'TERTIARY'|'STREET'|'SERVICE'|'TRACK'|'PEDESTRIAN'|'CYCLEWAY'|'FOOTWAY'|'TRAIL'|'STEPS'|'CONSTRUCTION'|'UNKNOWN';
export type RoadStructure='ground'|'bridge'|'tunnel'|'ford'|'unknown';
export interface RoadAttributes {
  readonly category:RoadCategory;
  readonly sourceClass:string; readonly sourceType:string;
  readonly structure:RoadStructure; readonly layer:number|null;
  readonly oneway:'forward'|'both'|'unknown';
  readonly surface:'paved'|'unpaved'|'unknown'; readonly access:'restricted'|'unknown';
  readonly widthMeters:number|null; readonly widthProvenance:'unknown';
}
export interface DecodedRoadFeature { readonly attributes:RoadAttributes; readonly lines:readonly (readonly (readonly [number,number])[])[]; }
export interface DecodedRoadTile {
  readonly providerId:string; readonly version:string; readonly digest:string;
  readonly z:number; readonly x:number; readonly y:number; readonly extent:number;
  readonly features:readonly DecodedRoadFeature[];
}
export interface RoadEdge {
  readonly key:string; readonly a:RoadPoint; readonly b:RoadPoint;
  readonly context:readonly [RoadPoint,RoadPoint]; readonly attributes:RoadAttributes;
  readonly evidence:readonly string[];
}
export interface RoadNode { readonly key:string; readonly point:RoadPoint; readonly edges:readonly string[]; readonly sourceBoundary:boolean; }
export interface RoadGraph {
  readonly schema:'zerana-road-kernel-v1'; readonly topologyAuthority:'cartographic-not-routable';
  readonly edges:readonly RoadEdge[]; readonly nodes:readonly RoadNode[];
  readonly duplicateSegments:number; readonly unresolvedSourcePorts:number;
  readonly sourceTiles:readonly string[];
}
export function attributesKey(a:RoadAttributes):string {
  return JSON.stringify([a.category,a.sourceClass,a.sourceType,a.structure,a.layer,a.oneway,a.surface,a.access]);
}
export function validateTile(t:DecodedRoadTile):void {
  const n=2**t.z;
  if(!Number.isInteger(t.z)||t.z<0||t.z>24||!Number.isInteger(t.x)||t.x<0||t.x>=n||!Number.isInteger(t.y)||t.y<0||t.y>=n||
    !Number.isInteger(t.extent)||t.extent<1||t.extent>ROAD_LIMITS.maxExtent||!t.providerId||t.providerId.length>128||!t.version||t.version.length>128||!(/^[a-f0-9]{64}$/.test(t.digest)))throw new Error('ROAD_TILE_CONTRACT');
  if(t.features.length>ROAD_LIMITS.maxFeatures)throw new Error('ROAD_FEATURE_BUDGET');
}
