/** Metric road profiles are solved ONCE for an immutable corridor, never per
 * WorldCell. These are estimated game geometry, not civil-engineering designs.
 * s and t denote horizontal distances in metres. Height datum is explicit. */
export const ENGINEERING_VERSION = 'road-engineering-v1';
export interface EngineeringPolicy {
  readonly smoothingLengthMeters: number;
  readonly maxGrade: number;
  readonly maxGradeRatePerMeter: number;
  readonly maxCutMeters: number;
  readonly maxFillMeters: number;
  readonly designSpeedMetersPerSecond: number;
  readonly maxBankSlope: number;
  readonly maxBankRatePerMeter: number;
  readonly crownSlope: number;
  readonly junctionTransitionMeters: number;
}
/** Versioned experimental defaults, NOT country-specific legal standards. */
export const DEFAULT_ENGINEERING_POLICY: EngineeringPolicy = Object.freeze({
  smoothingLengthMeters: 12, maxGrade: .16, maxGradeRatePerMeter: .025,
  maxCutMeters: 8, maxFillMeters: 8, designSpeedMetersPerSecond: 12,
  maxBankSlope: .06, maxBankRatePerMeter: .006, crownSlope: .02,
  junctionTransitionMeters: 32,
});
export interface ProfileInput {
  readonly corridorKey: string;
  readonly sourceRevision: string;
  readonly startBoundaryKey: string;
  readonly endBoundaryKey: string;
  readonly verticalReference: 'ELLIPSOIDAL_WGS84' | 'UNRESOLVED_DATUM_PREVIEW';
  readonly startStationMeters: number;
  readonly stepMeters: number;
  readonly groundHeightsMeters: Float64Array;
  /** Signed plan curvature; positive = left turn. Null means unknown: no bank. */
  readonly curvaturePerMeter: Float64Array | null;
  readonly startGrade: number;
  readonly endGrade: number;
}
export interface ProfileDiagnostics {
  readonly maxGrade: number;
  readonly maxGradeRatePerMeter: number;
  readonly maxCutMeters: number;
  readonly maxFillMeters: number;
  readonly maxBankSlope: number;
  readonly maxBankRatePerMeter: number;
}
export interface EngineeringProfile extends ProfileInput {
  readonly version: typeof ENGINEERING_VERSION;
  readonly policy: EngineeringPolicy;
  /** Per interval coefficients [a,b,c,d] of h(ds)=a+b ds+c ds²+d ds³. */
  readonly elevationCoefficients: Float64Array;
  readonly bankCoefficients: Float64Array;
  readonly diagnostics: ProfileDiagnostics;
  readonly authority: 'estimated-profile';
}
export type ProfileResult =
  | { readonly kind: 'ready'; readonly profile: EngineeringProfile }
  | { readonly kind: 'structure-required'; readonly reasons: readonly string[]; readonly diagnostics: ProfileDiagnostics };
const finite = (v: number): boolean => Number.isFinite(v);
const clamp = (v: number, low: number, high: number): number => Math.max(low, Math.min(high, v));
export function transitionWeight(x: number): number {
  const u = clamp(x, 0, 1);
  return u * u * u * (10 + u * (-15 + 6 * u));
}
function validateInput(input: ProfileInput, p: EngineeringPolicy): void {
  const n = input.groundHeightsMeters?.length;
  if (![input.corridorKey,input.sourceRevision,input.startBoundaryKey,input.endBoundaryKey]
      .every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) ||
      !['ELLIPSOIDAL_WGS84','UNRESOLVED_DATUM_PREVIEW'].includes(input.verticalReference) ||
      !(input.groundHeightsMeters instanceof Float64Array) || n < 3 || n > 1025 ||
      !input.groundHeightsMeters.every(v => finite(v) && Math.abs(v) <= 100000) ||
      !finite(input.stepMeters) || input.stepMeters < .5 || input.stepMeters > 16 ||
      !finite(input.startStationMeters) || Math.abs(input.startStationMeters) > 1e9 ||
      (n - 1) * input.stepMeters > 8192 || !finite(input.startGrade) || !finite(input.endGrade) ||
      (input.curvaturePerMeter !== null && (!(input.curvaturePerMeter instanceof Float64Array) ||
        input.curvaturePerMeter.length !== n || !input.curvaturePerMeter.every(v => finite(v) && Math.abs(v) <= 2))))
    throw new Error('ROAD_ENGINEERING_INPUT');
  const keys = Object.keys(DEFAULT_ENGINEERING_POLICY) as (keyof EngineeringPolicy)[];
  if (!p || Object.keys(p).length !== keys.length || !keys.every(k => finite(p[k]) && p[k] >= 0) ||
      p.smoothingLengthMeters > 32 || (p.smoothingLengthMeters / input.stepMeters) ** 4 > 1e7 ||
      p.maxGrade <= 0 || p.maxGrade > 1 || p.maxGradeRatePerMeter <= 0 || p.maxGradeRatePerMeter > 1 ||
      p.maxCutMeters > 50 || p.maxFillMeters > 50 || p.designSpeedMetersPerSecond > 50 ||
      p.maxBankSlope <= 0 || p.maxBankSlope > .2 || p.maxBankRatePerMeter <= 0 ||
      p.maxBankRatePerMeter > .05 || p.crownSlope > .1 || p.junctionTransitionMeters <= 0)
    throw new Error('ROAD_ENGINEERING_POLICY');
}
/** Solve (I + mu D2^T D2) h = raw with HARD endpoint heights. Banded Cholesky,
 * O(n) memory/work. D2=[1,-2,1]; mu=(smoothingLength/step)^4. No iterative
 * convergence assumption. Affine ground profiles are in the nullspace of D2. */
function smooth(raw: Float64Array, mu: number): Float64Array {
  const n = raw.length, diag = new Float64Array(n).fill(1), lower = new Float64Array(n),
    lower2 = new Float64Array(n), rhs = raw.slice();
  const stencil = [1,-2,1];
  for (let row = 0; row < n - 2; row++) for (let i = 0; i < 3; i++) for (let j = 0; j <= i; j++) {
    const a = row + i, b = row + j, v = mu * stencil[i]! * stencil[j]!;
    if (a === b) diag[a]! += v;
    else if (a - b === 1) lower[a]! += v;
    else lower2[a]! += v;
  }
  for (const fixed of [0, n - 1]) {
    for (let row = Math.max(0, fixed - 2); row <= Math.min(n - 1, fixed + 2); row++) {
      if (row === fixed) continue;
      const high = Math.max(row, fixed), band = Math.abs(row - fixed) === 1 ? lower : lower2;
      rhs[row]! -= band[high]! * raw[fixed]!; band[high] = 0;
    }
    diag[fixed] = 1; rhs[fixed] = raw[fixed]!;
  }
  const d = new Float64Array(n), l1 = new Float64Array(n), l2 = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (i >= 2) l2[i] = lower2[i]! / d[i - 2]!;
    if (i >= 1) l1[i] = (lower[i]! - l2[i]! * (l1[i - 1] || 0)) / d[i - 1]!;
    const q = diag[i]! - l1[i]! ** 2 - l2[i]! ** 2;
    if (!(q > 0) || !finite(q)) throw new Error('ROAD_ENGINEERING_SOLVER');
    d[i] = Math.sqrt(q);
    y[i] = (rhs[i]! - (i ? l1[i]! * y[i - 1]! : 0) - (i > 1 ? l2[i]! * y[i - 2]! : 0)) / d[i]!;
  }
  const result = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) result[i] = (y[i]! - (i + 1 < n ? l1[i + 1]! * result[i + 1]! : 0) -
    (i + 2 < n ? l2[i + 2]! * result[i + 2]! : 0)) / d[i]!;
  for (let i = 0; i < n; i++) {
    const terms = [diag[i]! * result[i]!, i ? lower[i]! * result[i - 1]! : 0,
      i > 1 ? lower2[i]! * result[i - 2]! : 0, i + 1 < n ? lower[i + 1]! * result[i + 1]! : 0,
      i + 2 < n ? lower2[i + 2]! * result[i + 2]! : 0];
    if (!finite(result[i]!) || Math.abs(terms.reduce((a,b) => a+b, 0) - rhs[i]!) >
        1e-9 * Math.max(1, Math.abs(rhs[i]!), terms.reduce((a,b) => a+Math.abs(b), 0)))
      throw new Error('ROAD_ENGINEERING_SOLVER_RESIDUAL');
  }
  return result;
}
function hermite(values: Float64Array, step: number, startGrade: number, endGrade: number): Float64Array {
  const n = values.length, slopes = new Float64Array(n), coefficients = new Float64Array((n - 1) * 4);
  slopes[0] = startGrade; slopes[n - 1] = endGrade;
  for (let i = 1; i < n - 1; i++) {
    const a = (values[i]! - values[i - 1]!) / step, b = (values[i + 1]! - values[i]!) / step;
    slopes[i] = a * b > 0 ? 2 * a * b / (a + b) : 0;
  }
  for (let i = 0; i < n - 1; i++) {
    const delta = (values[i + 1]! - values[i]!) / step;
    coefficients.set([values[i]!, slopes[i]!, (3 * delta - 2 * slopes[i]! - slopes[i + 1]!) / step,
      (slopes[i]! + slopes[i + 1]! - 2 * delta) / (step * step)], i * 4);
  }
  return coefficients;
}
export function evaluateCubic(coefficients: Float64Array, interval: number, dsMeters: number): readonly [number,number,number] {
  if (!(coefficients instanceof Float64Array) || !Number.isInteger(interval) || interval < 0 || interval * 4 + 3 >= coefficients.length || !finite(dsMeters))
    throw new Error('ROAD_ENGINEERING_EVALUATION');
  const i = interval * 4, a = coefficients[i]!, b = coefficients[i + 1]!, c = coefficients[i + 2]!, d = coefficients[i + 3]!;
  return [a + dsMeters * (b + dsMeters * (c + dsMeters * d)), b + dsMeters * (2 * c + 3 * d * dsMeters), 2 * c + 6 * d * dsMeters];
}
function quadraticRoots(a: number, b: number, c: number): number[] {
  if (a === 0) return b === 0 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const q = -.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(discriminant));
  return q === 0 ? [0] : [q / a, c / q];
}
/** Analytic extrema on EVERY interval, not endpoint-only sampling. Cut/fill is
 * bounded against the piecewise-linear longitudinal input, not an unknown DEM. */
function diagnose(input: ProfileInput, elevation: Float64Array, bank: Float64Array): ProfileDiagnostics {
  const ds = input.stepMeters, raw = input.groundHeightsMeters;
  let grade = 0, rate = 0, cut = 0, fill = 0, maxBank = 0, bankRate = 0;
  for (let i = 0; i < raw.length - 1; i++) {
    for (const [coeff, isBank] of [[elevation,false],[bank,true]] as const) {
      const c = coeff[i * 4 + 2]!, d = coeff[i * 4 + 3]!;
      for (const x of [0,ds,...(d !== 0 ? [-c / (3 * d)] : [])]) if (x >= 0 && x <= ds) {
        const [,g,r] = evaluateCubic(coeff,i,x);
        if (isBank) bankRate = Math.max(bankRate,Math.abs(g));
        else { grade = Math.max(grade,Math.abs(g)); rate = Math.max(rate,Math.abs(r)); }
      }
    }
    const rawGrade = (raw[i + 1]! - raw[i]!) / ds;
    for (const x of [0,ds,...quadraticRoots(3 * elevation[i * 4 + 3]!, 2 * elevation[i * 4 + 2]!, elevation[i * 4 + 1]! - rawGrade)]) {
      if (x < 0 || x > ds) continue;
      const delta = evaluateCubic(elevation,i,x)[0] - raw[i]! - rawGrade * x;
      fill = Math.max(fill,delta); cut = Math.max(cut,-delta);
    }
    for (const x of [0,ds,...quadraticRoots(3 * bank[i * 4 + 3]!,2 * bank[i * 4 + 2]!,bank[i * 4 + 1]!)])
      if (x >= 0 && x <= ds) maxBank = Math.max(maxBank,Math.abs(evaluateCubic(bank,i,x)[0]));
  }
  return {maxGrade:grade,maxGradeRatePerMeter:rate,maxCutMeters:cut,maxFillMeters:fill,maxBankSlope:maxBank,maxBankRatePerMeter:bankRate};
}
function violations(d: ProfileDiagnostics, p: EngineeringPolicy): string[] {
  const limits: readonly [keyof ProfileDiagnostics,number,string][] = [
    ['maxGrade',p.maxGrade,'GRADE_LIMIT'], ['maxGradeRatePerMeter',p.maxGradeRatePerMeter,'VERTICAL_CURVE_LIMIT'],
    ['maxCutMeters',p.maxCutMeters,'CUT_LIMIT'], ['maxFillMeters',p.maxFillMeters,'FILL_LIMIT'],
    ['maxBankSlope',p.maxBankSlope,'BANK_LIMIT'], ['maxBankRatePerMeter',p.maxBankRatePerMeter,'BANK_TRANSITION_LIMIT'],
  ];
  return limits.filter(([key,limit]) => !finite(d[key]) || d[key] > limit + 1e-10).map(([, ,reason]) => reason);
}
export function buildEngineeringProfile(input: ProfileInput, policy: EngineeringPolicy = DEFAULT_ENGINEERING_POLICY): ProfileResult {
  validateInput(input,policy);
  const ground = input.groundHeightsMeters.slice(), n = ground.length, step = input.stepMeters;
  const heights = smooth(ground,(policy.smoothingLengthMeters / step) ** 4), banks = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const taper = transitionWeight(i * step / policy.junctionTransitionMeters) * transitionWeight((n - 1 - i) * step / policy.junctionTransitionMeters);
    // t points LEFT. In a left turn the inside edge is lower, hence the minus.
    banks[i] = -clamp((input.curvaturePerMeter?.[i] || 0) * policy.designSpeedMetersPerSecond ** 2 / 9.80665,
      -policy.maxBankSlope,policy.maxBankSlope) * taper;
  }
  const elevationCoefficients = hermite(heights,step,input.startGrade,input.endGrade), bankCoefficients = hermite(banks,step,0,0);
  const diagnostics = diagnose(input,elevationCoefficients,bankCoefficients), reasons = violations(diagnostics,policy);
  if (reasons.length) return {kind:'structure-required',reasons,diagnostics};
  const profile: EngineeringProfile = {...input,groundHeightsMeters:ground,curvaturePerMeter:input.curvaturePerMeter?.slice() || null,
    version:ENGINEERING_VERSION,policy:Object.freeze({...policy}),elevationCoefficients,bankCoefficients,diagnostics,authority:'estimated-profile'};
  validateEngineeringProfile(profile);
  return {kind:'ready',profile};
}
export function profileAt(p: EngineeringProfile, stationMeters: number): {heightMeters:number;grade:number;bankSlope:number;crownSlope:number} {
  const ds = stationMeters - p.startStationMeters, length = (p.groundHeightsMeters.length - 1) * p.stepMeters;
  if (!finite(ds) || ds < 0 || ds > length) throw new Error('ROAD_ENGINEERING_STATION_RANGE');
  const i = Math.min(p.groundHeightsMeters.length - 2,Math.floor(ds / p.stepMeters)), local = ds - i * p.stepMeters;
  const [heightMeters,grade] = evaluateCubic(p.elevationCoefficients,i,local), bankSlope = evaluateCubic(p.bankCoefficients,i,local)[0];
  return {heightMeters,grade,bankSlope,crownSlope:p.policy.crownSlope * (1 - Math.min(1,(bankSlope / p.policy.maxBankSlope) ** 2))};
}
export function crossSectionHeight(p: EngineeringProfile, stationMeters: number, lateralMeters: number): number {
  if (!finite(lateralMeters) || Math.abs(lateralMeters) > 64) throw new Error('ROAD_ENGINEERING_LATERAL_RANGE');
  const h = profileAt(p,stationMeters);
  return h.heightMeters + lateralMeters * h.bankSlope - Math.abs(lateralMeters) * h.crownSlope;
}
export function validateEngineeringProfile(p: EngineeringProfile): void {
  validateInput(p,p.policy);
  const n = p.groundHeightsMeters.length - 1;
  if (p.version !== ENGINEERING_VERSION || p.authority !== 'estimated-profile' ||
      ![p.elevationCoefficients,p.bankCoefficients].every(c => c instanceof Float64Array && c.length === n * 4 && c.every(finite)))
    throw new Error('ROAD_ENGINEERING_PROFILE_CONTRACT');
  for (const c of [p.elevationCoefficients,p.bankCoefficients]) for (let i = 0; i < n - 1; i++) {
    const end = evaluateCubic(c,i,p.stepMeters), start = evaluateCubic(c,i+1,0);
    if (Math.abs(end[0]-start[0]) > 1e-8 || Math.abs(end[1]-start[1]) > 1e-8) throw new Error('ROAD_ENGINEERING_PROFILE_SEAM');
  }
  const start = profileAt(p,p.startStationMeters), end = profileAt(p,p.startStationMeters+n*p.stepMeters);
  if (Math.abs(start.heightMeters-p.groundHeightsMeters[0]!) > 1e-8 || Math.abs(end.heightMeters-p.groundHeightsMeters[n]!) > 1e-8 ||
      Math.abs(start.grade-p.startGrade) > 1e-8 || Math.abs(end.grade-p.endGrade) > 1e-8 ||
      Math.abs(start.bankSlope)+Math.abs(end.bankSlope) > 1e-8) throw new Error('ROAD_ENGINEERING_ENDPOINT_CONTRACT');
  const diagnostics=diagnose(p,p.elevationCoefficients,p.bankCoefficients);
  if (violations(diagnostics,p.policy).length) throw new Error('ROAD_ENGINEERING_UNSAFE_PROFILE');
  for(const key of Object.keys(diagnostics) as (keyof ProfileDiagnostics)[])
    if(!p.diagnostics || !finite(p.diagnostics[key]) || Math.abs(p.diagnostics[key]-diagnostics[key])>1e-9)
      throw new Error('ROAD_ENGINEERING_DIAGNOSTICS');
}
