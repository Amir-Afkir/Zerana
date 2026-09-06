import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildEngineeringProfile, DEFAULT_ENGINEERING_POLICY, profileAt, crossSectionHeight,
  validateEngineeringProfile, evaluateCubic, transitionWeight } from '../dist/generation/roads/engineering-profile.js';
import { sampleEarthwork, buildEarthworkStrip } from '../dist/generation/roads/earthwork.js';
import { ENGINEERING_FIXTURE, fixtureProfile, fixtureRoadPosition, fixtureEngineeringSample, fixtureRawHeight } from '../dist/generation/roads/engineering-fixture.js';
import { syntheticElevation } from '../dist/generation/terrain/synthetic-elevation.js';
import { TerrainSampler } from '../dist/generation/terrain/terrain-sampler.js';
import { buildTerrainCell } from '../dist/generation/terrain/terrain-builder.js';
import { terrainPatchCells } from '../dist/world/terrain-patch.js';
import { createGeoAnchor } from '../dist/geo/enu.js';
import { geodeticToEcef } from '../dist/geo/ecef.js';
import { ecefToThreeLocal } from '../dist/geo/three-frame.js';
import { measureTerrainSeams } from '../dist/debug/seam-metrics.js';
import { TerrainPhysics } from '../dist/physics/terrain-physics.js';
const input=(raw,change={})=>({corridorKey:'fixture-corridor',sourceRevision:'fixture-v1',startBoundaryKey:'start',endBoundaryKey:'end',
  verticalReference:'ELLIPSOIDAL_WGS84',startStationMeters:100,stepMeters:4,groundHeightsMeters:Float64Array.from(raw),curvaturePerMeter:null,startGrade:0,endGrade:0,...change});
const ready=(raw,change={},policy={})=>{const result=buildEngineeringProfile(input(raw,change),{...DEFAULT_ENGINEERING_POLICY,...policy});assert.equal(result.kind,'ready',JSON.stringify(result));return result.profile;};
const flat=()=>ready(Array(81).fill(30));
const close=(a,b,tol=1e-8)=>assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}`);

test('banded smoothing matches an independent NumPy dense matrix solve',()=>{
  const f=JSON.parse(fs.readFileSync(new URL('fixtures/engineering-dense-reference.json',import.meta.url)));
  const p=ready(f.raw,{}, {smoothingLengthMeters:f.smoothingLengthMeters,maxGrade:.3,maxGradeRatePerMeter:.1});
  f.heights.forEach((h,i)=>close(profileAt(p,100+i*f.stepMeters).heightMeters,h,1e-11));
});
test('constant profile is preserved, with finite zero grades',()=>{
  const p=flat();for(let s=100;s<=420;s+=.5){close(profileAt(p,s).heightMeters,30,1e-10);close(profileAt(p,s).grade,0,1e-10);}
});
test('affine grade is preserved with shared boundary inclinations',()=>{
  const p=ready(Array.from({length:65},(_,i)=>12+i*.08),{startGrade:.02,endGrade:.02});
  for(let s=100;s<=356;s+=.25){close(profileAt(p,s).heightMeters,12+(s-100)*.02,1e-9);close(profileAt(p,s).grade,.02,1e-9);}
});
test('deterministic immutable corridor solution does not mutate supplied arrays',()=>{
  const v=input(Array.from({length:65},(_,i)=>30+.2*Math.sin(i))),copy=v.groundHeightsMeters.slice();
  const a=buildEngineeringProfile(v),b=buildEngineeringProfile(v);assert.deepEqual(a,b);assert.deepEqual(v.groundHeightsMeters,copy);
  assert.notEqual(a.profile.groundHeightsMeters,v.groundHeightsMeters);
});
test('heights and inclinations agree at every cubic interval boundary',()=>{
  const p=fixtureProfile(),n=p.groundHeightsMeters.length-1;
  for(let i=0;i<n-1;i++)for(const c of [p.elevationCoefficients,p.bankCoefficients]){
    const a=evaluateCubic(c,i,p.stepMeters),b=evaluateCubic(c,i+1,0);close(a[0],b[0]);close(a[1],b[1]);
  }
});
test('grade rejection examines the interior, not only station inclinations',()=>{
  const r=buildEngineeringProfile(input([0,.5,1]),{...DEFAULT_ENGINEERING_POLICY,maxGrade:.15,maxGradeRatePerMeter:1});
  assert.equal(r.kind,'structure-required');assert.ok(r.reasons.includes('GRADE_LIMIT'));assert.ok(r.diagnostics.maxGrade>.15);
});
test('earthwork budget is not silently relaxed by the fitter',()=>{
  const r=buildEngineeringProfile(input([0,0,0,0,10,0,0,0,0]),{...DEFAULT_ENGINEERING_POLICY,maxGrade:1,maxGradeRatePerMeter:1,maxCutMeters:.1,maxFillMeters:.1});
  assert.equal(r.kind,'structure-required');assert.ok(r.reasons.includes('CUT_LIMIT'));
});
test('contradictory endpoint grades return structure-required rather than a clamped profile',()=>{
  const r=buildEngineeringProfile(input([0,0,0],{startGrade:.8,endGrade:0}));assert.equal(r.kind,'structure-required');assert.ok(r.reasons.includes('GRADE_LIMIT'));
});
test('unknown plan curvature produces no invented bank',()=>assert.ok(flat().bankCoefficients.every(v=>v===0)));
test('left/right curve bank signs are physically oriented, and junction bank is zero',()=>{
  for(const sign of [-1,1]){
    const p=ready(Array(81).fill(30),{curvaturePerMeter:new Float64Array(81).fill(sign/500)});
    assert.equal(Math.sign(profileAt(p,260).bankSlope),-sign);
    close(profileAt(p,100).bankSlope,0);close(profileAt(p,420).bankSlope,0);
    close(evaluateCubic(p.bankCoefficients,0,0)[1],0);
    close(evaluateCubic(p.bankCoefficients,79,4)[1],0);
  }
});
test('unbanked crown lowers both edges while preserving the centre elevation',()=>{
  const p=flat();close(crossSectionHeight(p,260,0),30);close(crossSectionHeight(p,260,3),29.94);close(crossSectionHeight(p,260,-3),29.94);
});
test('bank and transverse crown are dimensionless slopes over horizontal metres',()=>{
  const p=ready(Array(81).fill(30),{curvaturePerMeter:new Float64Array(81).fill(1/650)}),v=profileAt(p,260);
  close(crossSectionHeight(p,260,2)-crossSectionHeight(p,260,-2),4*v.bankSlope);
});
test('quintic transition has clamped values and zero endpoint derivatives',()=>{
  assert.equal(transitionWeight(-1),0);assert.equal(transitionWeight(2),1);
  close(transitionWeight(.5),.5);const e=1e-4;
  assert.ok(transitionWeight(e)/e<1e-6);assert.ok((1-transitionWeight(1-e))/e<1e-6);
});
test('earthwork rejoins raw ground, with no displacement outside its fixed support',()=>{
  const p=flat(),section={widthMeters:6,blendMeters:12,endTransitionMeters:24};
  for(const t of [-100,-15,15,100])assert.deepEqual(sampleEarthwork(p,section,260,t,33),{kind:'outside',heightMeters:33,deltaMeters:0});
  close(sampleEarthwork(p,section,260,0,33).heightMeters,30);
  close(sampleEarthwork(p,section,260,3,33).heightMeters,29.94);
  close(sampleEarthwork(p,section,260,14.999,33).heightMeters,33,1e-9);
  assert.equal(sampleEarthwork(p,section,100,0,33).kind,'outside');assert.equal(sampleEarthwork(p,section,420,0,33).kind,'outside');
});
test('cut/fill rejection returns no alternative discontinuous height',()=>{
  const s={widthMeters:6,blendMeters:12,endTransitionMeters:24};
  assert.deepEqual(sampleEarthwork(flat(),s,260,0,60),{kind:'structure-required',reason:'CUT_LIMIT'});
  assert.deepEqual(sampleEarthwork(flat(),s,260,0,0),{kind:'structure-required',reason:'FILL_LIMIT'});
});
test('entire strip is refused when any earthwork sample exceeds the budget',()=>{
  const p=flat(),section={widthMeters:6,blendMeters:12,endTransitionMeters:24};
  assert.throws(()=>buildEarthworkStrip(p,section,[-15,-3,0,3,15],(s,t)=>s===260&&t===0?100:30),/CUT_LIMIT/);
  const strip=buildEarthworkStrip(p,section,[-15,-3,0,3,15],()=>31);
  assert.equal(strip.indices.length,80*4*6);assert.ok(strip.positions.every(Number.isFinite));assert.ok(strip.maxCutMeters>0&&strip.maxCutMeters<2);
});
test('profiles with unresolved datum remain explicitly unresolved',()=>{
  const p=ready(Array(65).fill(30),{verticalReference:'UNRESOLVED_DATUM_PREVIEW'});assert.equal(p.verticalReference,'UNRESOLVED_DATUM_PREVIEW');assert.equal(p.authority,'estimated-profile');
});
for(const [label,change] of [
 ['NaN heights',{groundHeightsMeters:new Float64Array([0,NaN,0])}],['zero step',{stepMeters:0}],
 ['missing datum',{verticalReference:'unknown'}],['bad curvature',{curvaturePerMeter:new Float64Array([0,Infinity,0])}],
 ['oversized corridor',{groundHeightsMeters:new Float64Array(1026)}],['empty source revision',{sourceRevision:''}],
 ])test(`profile refuses ${label}`,()=>assert.throws(()=>buildEngineeringProfile(input([0,0,0],change)),/INPUT/));
test('policy keys and physical ranges are checked, not just object length',()=>{
 const p={...DEFAULT_ENGINEERING_POLICY};delete p.maxGrade;p.unrelated=.2;
 assert.throws(()=>buildEngineeringProfile(input([0,0,0]),p),/POLICY/);
 assert.throws(()=>buildEngineeringProfile(input([0,0,0]),{...DEFAULT_ENGINEERING_POLICY,maxBankSlope:5}),/POLICY/);
});
test('out-of-domain evaluation and malformed strips fail closed',()=>{
  const p=flat();for(const s of [99,421,NaN,Infinity])assert.throws(()=>profileAt(p,s),/RANGE/);
  assert.throws(()=>crossSectionHeight(p,260,NaN),/RANGE/);
  assert.throws(()=>buildEarthworkStrip(p,{widthMeters:6,blendMeters:12,endTransitionMeters:24},[0,0,1],()=>30),/LATTICE/);
});
test('serialized profiles are revalidated against actual coefficients and diagnostics',()=>{
  const p=structuredClone(flat());p.elevationCoefficients[4]+=1;assert.throws(()=>validateEngineeringProfile(p),/SEAM/);
  const q=structuredClone(flat());q.diagnostics.maxGrade=99;assert.throws(()=>validateEngineeringProfile(q),/DIAGNOSTICS/);
});
test('experimental track reports real cut/fill, banking and an unchanged source datum',()=>{
  const p=fixtureProfile();assert.ok(p.diagnostics.maxCutMeters>1&&p.diagnostics.maxFillMeters>1);assert.equal(p.verticalReference,'ELLIPSOIDAL_WGS84');
  for(let s=100;s<=1100;s+=5){const v=fixtureEngineeringSample(fixtureRoadPosition(s));assert.ok(Number.isFinite(v.heightMeters));assert.ok(Math.abs(v.deltaMeters)<=8);}
});
test('engineered and raw terrain are separate versioned synthetic sources',()=>{
  const raw=syntheticElevation('engineering-raw'),engineered=syntheticElevation('engineering'),p=fixtureRoadPosition(615);
  assert.notEqual(raw.id,engineered.id);close(raw.heightAt(p),fixtureRawHeight(p));assert.ok(Math.abs(raw.heightAt(p)-engineered.heightAt(p))>1);
  assert.equal(engineered.provenance,'synthetic');
});
test('nine independently built cells share engineered height/normal seams regardless of order',()=>{
  const source=syntheticElevation('engineering'),ids=terrainPatchCells(fixtureRoadPosition(600),19,3);
  const packets=ids.map(id=>buildTerrainCell(id,new TerrainSampler(source),32));
  const backwards=[...ids].reverse().map(id=>buildTerrainCell(id,new TerrainSampler(source),32)).reverse();
  for(let i=0;i<packets.length;i++)assert.deepEqual(packets[i],backwards[i]);
  const seams=measureTerrainSeams(packets,packets[4].anchor);assert.equal(seams.mismatchedKeys,0);assert.ok(seams.maxGapMeters<.001);assert.ok(seams.maxNormalDelta<1e-6);
});
test('physical terrain uses exactly the engineered meshes and survives a rebase',()=>{
  const source=syntheticElevation('engineering'),point=fixtureRoadPosition(615),ids=terrainPatchCells(point,19,3),packets=ids.map(id=>buildTerrainCell(id,new TerrainSampler(source),32));
  const anchor=createGeoAnchor(point),physics=new TerrainPhysics(packets,anchor);
  const p=ecefToThreeLocal(geodeticToEcef(point),anchor),hit=physics.raycast([p[0],source.heightAt(point)+5,p[2]],[0,-1,0],20);
  assert.ok(hit);close(hit.distance,5,.08);const count=physics.triangleCount,buffers=packets.map(p=>p.positions);
  physics.rebase(packets[8].anchor);assert.equal(physics.triangleCount,count);packets.forEach((p,i)=>assert.equal(p.positions,buffers[i]));
  physics.dispose();assert.equal(physics.colliderCount,0);
});
test('the terrain grid approximation is measured separately from exact profile continuity',()=>{
  const f=ENGINEERING_FIXTURE;assert.equal(f.stepMeters,4);assert.equal(f.lengthMeters,1200);
  const p=fixtureProfile();for(let s=0;s<f.lengthMeters;s+=.1){const v=profileAt(p,s);assert.ok(Math.abs(v.grade)<=p.policy.maxGrade+1e-9);}
});


test('longitudinal smoothing reduces high-frequency roughness without moving corridor endpoints',()=>{
 const p=fixtureProfile(),raw=p.groundHeightsMeters;let before=0,after=0;
 for(let i=30;i<raw.length-31;i++){
  const y=[i-1,i,i+1].map(j=>profileAt(p,j*p.stepMeters).heightMeters);
  before+=(raw[i-1]-2*raw[i]+raw[i+1])**2;after+=(y[0]-2*y[1]+y[2])**2;
 }
 assert.ok(Math.sqrt(after/before)<.4);
 close(profileAt(p,0).heightMeters,raw[0]);close(profileAt(p,1200).heightMeters,raw.at(-1));
});
