/** Source classifications, NOT a land survey or a hydrological solution. */
export const ENV_LAYERS = ['water', 'waterway', 'landuse', 'landuse_overlay'] as const;
export type EnvironmentLayer = typeof ENV_LAYERS[number];
export type SurfaceCover = 'WOOD'|'SCRUB'|'GRASS'|'CROPS'|'ROCK'|'SAND'|'ICE'|'UNKNOWN';
export type ZoneUse = 'AGRICULTURE'|'AIRPORT'|'CEMETERY'|'COMMERCIAL'|'INDUSTRIAL'|'PARK'|'PARKING'|'RESIDENTIAL'|'SPORT'|'FACILITY'|'PROTECTED'|'UNKNOWN';
export type WaterKind = 'WATER_AREA'|'RIVER'|'CANAL'|'STREAM'|'DRAIN'|'DITCH'|'UNKNOWN';
export interface EnvironmentAttributes {
  readonly layer: EnvironmentLayer; readonly sourceClass: string; readonly sourceType: string;
  readonly cover: SurfaceCover; readonly use: ZoneUse; readonly water: WaterKind;
  readonly wetland: boolean; readonly intermittent: boolean;
  readonly authority: 'source-classification'; readonly waterHeightMeters: null;
}
export type TilePoint = readonly [number, number];
export interface EnvironmentFeature {
  readonly sourceIndex: number; readonly attributes: EnvironmentAttributes;
  readonly geometry: 'polygon'|'line';
  /** MVT winding: positive shoelace exterior, then negative holes, Y down. */
  readonly paths: readonly (readonly TilePoint[])[];
}
export interface EnvironmentTile {
  readonly providerId: string; readonly version: string; readonly digest: string;
  readonly z: number; readonly x: number; readonly y: number;
  /** Each MVT layer owns its extent; never assume all layers use 4096. */
  readonly layers: readonly {readonly name: EnvironmentLayer; readonly extent: number;
    readonly features: readonly EnvironmentFeature[]; readonly state: 'present'|'absent'}[];
}
export const ENV_LIMITS = Object.freeze({maxTiles:16, maxFeatures:4096, maxPoints:65536,
  maxTileExtent:65536, maxPaths:8192, maxCellPoints:131072, maxFragments:4096,
  maxSegments:12000, maxPacketBytes:1048576, residentBytes:4194304});
