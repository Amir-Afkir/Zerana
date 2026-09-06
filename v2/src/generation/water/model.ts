import type { RoadPoint,ExactBox } from '../roads/exact.js';
import type { Polygon } from './geometry.js';
import type { HeightReference } from '../terrain/elevation-source.js';
export const WATER_VERSION='water-preview-v1';
export const WATER_LIMITS=Object.freeze({gridDivisions:16,maxSourceTriangles:16384,maxSourcePoints:16384,
  maxVertices:16000,maxTriangles:20000,maxOperations:150000,maxPieces:128,
  packetBytes:1048576,residentBytes:4194304,regionEntries:4,regionBytes:16777216});
export interface WaterPrimitive {
  readonly polygon:Polygon; readonly bounds:ExactBox; readonly key:string;
  readonly kind:'area'|'waterway'; readonly basinKey:string|null;
}
export interface EnclosedBasin {
  readonly key:string; readonly rings:readonly Polygon[];
  readonly samples:readonly {readonly point:RoadPoint;readonly weight:number}[];
}
export interface WaterGeometry {
  readonly sourceKey:string; readonly core:ExactBox; readonly z:number; readonly x:number; readonly y:number;
  readonly primitives:readonly WaterPrimitive[]; readonly basins:readonly EnclosedBasin[];
  readonly deferredWaterways:number;
}
export interface HydroRegion {
  readonly key:string; readonly z:number; readonly x:number; readonly y:number;
  readonly levels:Float64Array; readonly basinLevels:ReadonlyMap<string,number>;
  readonly geometry:WaterGeometry; readonly sourceTiles:readonly string[];
  readonly verticalReference:HeightReference;
  readonly heightAuthority:'estimated-not-hydraulically-qualified';
}
export interface WaterRead {readonly layer:'elevation'|'vector';readonly tile:string;readonly sha256:string}
