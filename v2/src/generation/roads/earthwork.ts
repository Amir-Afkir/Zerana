import type { EngineeringProfile } from './engineering-profile.js';
import { crossSectionHeight, transitionWeight, validateEngineeringProfile } from './engineering-profile.js';

export interface EarthworkSection {
  readonly widthMeters: number;
  readonly blendMeters: number;
  readonly endTransitionMeters: number;
}
export type EarthworkSample =
  | { readonly kind: 'outside'; readonly heightMeters: number; readonly deltaMeters: 0 }
  | { readonly kind: 'ready'; readonly heightMeters: number; readonly deltaMeters: number }
  | { readonly kind: 'structure-required'; readonly reason: 'CUT_LIMIT' | 'FILL_LIMIT' };
export function validateEarthworkSection(section: EarthworkSection): void {
  if (!Number.isFinite(section.widthMeters) || section.widthMeters < .5 || section.widthMeters > 20 ||
      !Number.isFinite(section.blendMeters) || section.blendMeters < 1 || section.blendMeters > 48 ||
      !Number.isFinite(section.endTransitionMeters) || section.endTransitionMeters < 1 || section.endTransitionMeters > 256)
    throw new Error('ROAD_EARTHWORK_SECTION');
}
/** Pointwise proposal, NOT permission to patch one live cell. A rejected sample
 * rejects its complete corridor transaction. Never clamp an offending height or
 * switch to raw point-by-point: that would introduce terrain discontinuities.
 *
 * The extended road cross slope is blended into raw ground by a quintic whose
 * first two derivatives vanish at its ends. Pure: no WorldCell or load order. */
export function sampleEarthwork(profile: EngineeringProfile, section: EarthworkSection,
  stationMeters: number, lateralMeters: number, rawHeightMeters: number): EarthworkSample {
  validateEarthworkSection(section);
  if (![stationMeters,lateralMeters,rawHeightMeters].every(Number.isFinite)) throw new Error('ROAD_EARTHWORK_COORDINATE');
  const start = profile.startStationMeters, end = start + (profile.groundHeightsMeters.length-1)*profile.stepMeters;
  const half = section.widthMeters / 2;
  if (stationMeters <= start || stationMeters >= end || Math.abs(lateralMeters) >= half + section.blendMeters)
    return {kind:'outside',heightMeters:rawHeightMeters,deltaMeters:0};
  const across = 1-transitionWeight(Math.max(0,Math.abs(lateralMeters)-half)/section.blendMeters);
  const along = transitionWeight((stationMeters-start)/section.endTransitionMeters)*transitionWeight((end-stationMeters)/section.endTransitionMeters);
  const target = crossSectionHeight(profile,stationMeters,lateralMeters);
  const delta = across*along*(target-rawHeightMeters);
  if (delta > profile.policy.maxFillMeters+1e-10) return {kind:'structure-required',reason:'FILL_LIMIT'};
  if (-delta > profile.policy.maxCutMeters+1e-10) return {kind:'structure-required',reason:'CUT_LIMIT'};
  return {kind:'ready',heightMeters:rawHeightMeters+delta,deltaMeters:delta};
}
export interface EarthworkStrip {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
  readonly maxCutMeters: number;
  readonly maxFillMeters: number;
}
/** Bounded cross-section strip for engineering inspection and independent tests.
 * Coordinates are [s,height,t], not Three.js world coordinates. A caller must use
 * its GeoAnchor adapter. Any failed sample rejects the ENTIRE strip. */
export function buildEarthworkStrip(profile: EngineeringProfile, section: EarthworkSection,
  lateralStationsMeters: readonly number[], rawHeightAt: (stationMeters:number,lateralMeters:number)=>number): EarthworkStrip {
  validateEngineeringProfile(profile); validateEarthworkSection(section);
  if (lateralStationsMeters.length < 3 || lateralStationsMeters.length > 129 ||
      lateralStationsMeters.some((v,i)=>!Number.isFinite(v)||Math.abs(v)>64||(i>0&&v<=lateralStationsMeters[i-1]!)))
    throw new Error('ROAD_EARTHWORK_LATTICE');
  const rows = profile.groundHeightsMeters.length, cols = lateralStationsMeters.length;
  if (rows*cols>65536) throw new Error('ROAD_EARTHWORK_BUDGET');
  const positions = new Float64Array(rows*cols*3), indices = new Uint32Array((rows-1)*(cols-1)*6);
  let maxCutMeters=0,maxFillMeters=0,k=0;
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++) {
    const s=profile.startStationMeters+row*profile.stepMeters,t=lateralStationsMeters[col]!;
    const sample=sampleEarthwork(profile,section,s,t,rawHeightAt(s,t));
    if(sample.kind==='structure-required')throw new Error(`ROAD_EARTHWORK_${sample.reason}`);
    positions.set([s,sample.heightMeters,t],(row*cols+col)*3);
    maxCutMeters=Math.max(maxCutMeters,-sample.deltaMeters);maxFillMeters=Math.max(maxFillMeters,sample.deltaMeters);
    if(row<rows-1&&col<cols-1){const a=row*cols+col,b=a+cols;indices.set([a,a+1,b,a+1,b+1,b],k);k+=6;}
  }
  return {positions,indices,maxCutMeters,maxFillMeters};
}
