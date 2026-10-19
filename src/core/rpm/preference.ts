/**
 * Preferred grinder RPM for body, per bean: a grid posterior over
 *   θ   preferred RPM (500–1600, step 50)
 *   β   body sensitivity, thin–heavy slider steps per 100 RPM (0 = RPM doesn't change body)
 *   b   order bias of "vs the previous shot" answers
 * Body data: the thin–heavy slider as an ordered probit h* ~ N(β·(u − θ_u), 0.8²).
 * Taste data: better/same/worse between shots at DIFFERENT RPMs and matched flow, with utility
 * U(u) = −β²(u − θ_u)²/18 (the setpoint layer handles same-RPM comparisons).
 * Research 2026-10-19: Psi method / ordered probit with ties; docs/ALGORITHM.md "RPM".
 */
import { phi } from '../math/normal';
import { RPM } from '../params';
import type { RpmRange } from './range';
import { quantRpm, uOf } from './range';

export interface RpmPreference {
  thetas: number[];
  betas: readonly number[];
  biases: readonly number[];
  /** Joint weights, index ((t · nB) + b) · nO + o. */
  p: Float64Array;
  /** Informative ratings absorbed (body sliders + cross-RPM comparisons). */
  ratings: number;
}

export interface PreferenceSummary {
  thetaMean: number;
  thetaSd: number;
  /** P(|6β| < 1): RPM changes body by less than one slider step over 600 RPM. */
  pInsensitive: number;
  /** RPM (step 100, inside the range) with the least expected body loss. */
  bayesRpm: number;
  /** RPMs whose expected regret vs bayesRpm is ≤ the JND, as [lo, hi] (contiguous). */
  band: [number, number];
  ratings: number;
}

const BIAS_PRIOR = [0.25, 0.5, 0.25];

function thetaGrid(): number[] {
  const out: number[] = [];
  for (let t = RPM.thetaMin; t <= RPM.thetaMax + 1e-9; t += RPM.thetaStep) out.push(t);
  return out;
}

function gauss(x: number, m: number, sd: number): number {
  const z = (x - m) / sd;
  return Math.exp(-0.5 * z * z);
}

/** Population prior: θ ~ N(1000, 300²), β ~ N(0.25, 0.35²), bias {¼, ½, ¼}. */
export function initPreference(
  thetaPrior?: readonly number[],
  betaPrior?: readonly number[],
): RpmPreference {
  const thetas = thetaGrid();
  const betas = RPM.betaGrid;
  const biases = RPM.orderBiasGrid;
  const tw = thetaPrior ?? thetas.map((t) => gauss(t, RPM.thetaPriorMean, RPM.thetaPriorSd));
  const bw = betaPrior ?? betas.map((b) => gauss(b, 0.25, 0.35));
  const p = new Float64Array(thetas.length * betas.length * biases.length);
  for (let t = 0; t < thetas.length; t++)
    for (let b = 0; b < betas.length; b++)
      for (let o = 0; o < biases.length; o++)
        p[(t * betas.length + b) * biases.length + o] =
          (tw[t] ?? 0) * (bw[b] ?? 0) * (BIAS_PRIOR[o] ?? 0);
  return normalize({ thetas, betas, biases, p, ratings: 0 });
}

function normalize(pr: RpmPreference): RpmPreference {
  let z = 0;
  for (const v of pr.p) z += v;
  if (!(z > 0) || !Number.isFinite(z)) return initPreference();
  for (let i = 0; i < pr.p.length; i++) pr.p[i] = (pr.p[i] ?? 0) / z;
  return pr;
}

function clone(pr: RpmPreference): RpmPreference {
  return { ...pr, p: new Float64Array(pr.p) };
}

/** P(slider = h) for an ordered probit with cut points at ±0.5, ±1.5, ±2.5. */
export function bodyLikelihood(h: number, mu: number, sd = RPM.bodyNoise): number {
  const lo = h <= -3 ? Number.NEGATIVE_INFINITY : h - 0.5;
  const hi = h >= 3 ? Number.POSITIVE_INFINITY : h + 0.5;
  const pHi = hi === Number.POSITIVE_INFINITY ? 1 : phi((hi - mu) / sd);
  const pLo = lo === Number.NEGATIVE_INFINITY ? 0 : phi((lo - mu) / sd);
  return Math.max(1e-9, pHi - pLo);
}

function forEach(
  pr: RpmPreference,
  fn: (theta: number, beta: number, bias: number, i: number) => void,
): void {
  const nB = pr.betas.length;
  const nO = pr.biases.length;
  for (let t = 0; t < pr.thetas.length; t++)
    for (let b = 0; b < nB; b++)
      for (let o = 0; o < nO; o++)
        fn(pr.thetas[t] ?? 0, pr.betas[b] ?? 0, pr.biases[o] ?? 0, (t * nB + b) * nO + o);
}

/** A thin–heavy rating h ∈ −3..3 of a shot pulled at `rpm` (positive = heavier body). */
export function updateBody(pr: RpmPreference, rpm: number, h: number): RpmPreference {
  const out = clone(pr);
  const u = uOf(rpm);
  forEach(out, (theta, beta, _bias, i) => {
    out.p[i] = (out.p[i] ?? 0) * bodyLikelihood(h, beta * (u - uOf(theta)));
  });
  out.ratings += 1;
  return normalize(out);
}

export function utility(rpm: number, theta: number, beta: number): number {
  const d = uOf(rpm) - uOf(theta);
  return (-(beta * beta) * d * d) / RPM.utilityScale;
}

export function comparisonLikelihood(
  vs: 'better' | 'same' | 'worse',
  d: number,
  dDays: number,
): number {
  const sigma = 0.5 * (1 + 0.25 * Math.max(0, dDays));
  const eps = RPM.lapse;
  const pBetter = eps / 3 + (1 - eps) * phi((d - RPM.tieBand) / sigma);
  const pWorse = eps / 3 + (1 - eps) * phi((-d - RPM.tieBand) / sigma);
  if (vs === 'better') return pBetter;
  if (vs === 'worse') return pWorse;
  return Math.max(1e-6, 1 - pBetter - pWorse);
}

/**
 * "This shot (at rpmCur) was better/same/worse than the previous one (at rpmPrev)", valid only
 * at matched flow (see rpmComparisonValidity in setpoint/grid.ts).
 */
export function updateRpmComparison(
  pr: RpmPreference,
  rpmPrev: number,
  rpmCur: number,
  vs: 'better' | 'same' | 'worse',
  dDays = 0,
): RpmPreference {
  const out = clone(pr);
  forEach(out, (theta, beta, bias, i) => {
    const d = utility(rpmCur, theta, beta) - utility(rpmPrev, theta, beta) + bias;
    out.p[i] = (out.p[i] ?? 0) * comparisonLikelihood(vs, d, dDays);
  });
  out.ratings += 1;
  return normalize(out);
}

export function thetaMarginal(pr: RpmPreference): number[] {
  const m = new Array<number>(pr.thetas.length).fill(0);
  const per = pr.betas.length * pr.biases.length;
  for (let i = 0; i < pr.p.length; i++) {
    const t = Math.floor(i / per);
    m[t] = (m[t] ?? 0) + (pr.p[i] ?? 0);
  }
  return m;
}

export function betaMarginal(pr: RpmPreference): number[] {
  const m = new Array<number>(pr.betas.length).fill(0);
  const nO = pr.biases.length;
  for (let i = 0; i < pr.p.length; i++) {
    const b = Math.floor(i / nO) % pr.betas.length;
    m[b] = (m[b] ?? 0) + (pr.p[i] ?? 0);
  }
  return m;
}

/** Expected body loss E[β²(u − θ_u)²]/18 of pulling at `rpm`. */
export function expectedLoss(pr: RpmPreference, rpm: number): number {
  let l = 0;
  forEach(pr, (theta, beta, _bias, i) => {
    l += (pr.p[i] ?? 0) * -utility(rpm, theta, beta);
  });
  return l;
}

/** P(U(target) > U(current)): the chance a move from current to target improves body. */
export function probImprove(pr: RpmPreference, current: number, target: number): number {
  let pr1 = 0;
  forEach(pr, (theta, beta, _bias, i) => {
    if (utility(target, theta, beta) > utility(current, theta, beta) + 1e-12) pr1 += pr.p[i] ?? 0;
  });
  return pr1;
}

export function summarizePreference(pr: RpmPreference, range: RpmRange): PreferenceSummary {
  const tm = thetaMarginal(pr);
  let mean = 0;
  for (let t = 0; t < pr.thetas.length; t++) mean += (pr.thetas[t] ?? 0) * (tm[t] ?? 0);
  let v = 0;
  for (let t = 0; t < pr.thetas.length; t++) v += ((pr.thetas[t] ?? 0) - mean) ** 2 * (tm[t] ?? 0);
  const bm = betaMarginal(pr);
  let pIns = 0;
  for (let b = 0; b < pr.betas.length; b++)
    if (Math.abs(6 * (pr.betas[b] ?? 0)) < 1) pIns += bm[b] ?? 0;
  const [lo, hi] = range;
  let best = quantRpm(Math.min(hi, Math.max(lo, mean)));
  let bestLoss = Number.POSITIVE_INFINITY;
  const losses = new Map<number, number>();
  for (let r = lo; r <= hi; r += RPM.step) {
    const l = expectedLoss(pr, r);
    losses.set(r, l);
    // Ties go to the RPM nearer the population centre (1000).
    if (
      l < bestLoss - 1e-12 ||
      (Math.abs(l - bestLoss) <= 1e-12 && Math.abs(r - 1000) < Math.abs(best - 1000))
    ) {
      bestLoss = l;
      best = r;
    }
  }
  let bandLo = best;
  let bandHi = best;
  for (let r = best - RPM.step; r >= lo; r -= RPM.step) {
    if ((losses.get(r) ?? Number.POSITIVE_INFINITY) - bestLoss > RPM.regretJnd) break;
    bandLo = r;
  }
  for (let r = best + RPM.step; r <= hi; r += RPM.step) {
    if ((losses.get(r) ?? Number.POSITIVE_INFINITY) - bestLoss > RPM.regretJnd) break;
    bandHi = r;
  }
  return {
    thetaMean: mean,
    thetaSd: Math.sqrt(Math.max(0, v)),
    pInsensitive: pIns,
    bayesRpm: best,
    band: [bandLo, bandHi],
    ratings: pr.ratings,
  };
}

export interface EarlierBean {
  pref: RpmPreference;
  /** 1 for the same roast group, RPM.otherRoastWeight otherwise. */
  roastWeight: number;
  /** Recency weight, newest = 1. */
  recency: number;
}

/**
 * A new bean's prior from earlier beans: 0.8 × the weighted mix of their θ posteriors, each
 * blurred by N(0, 150²), + 0.2 × the population prior; β prior is half the pooled β posteriors,
 * half N(0.25, 0.35²). Only beans with ≥ 3 informative ratings count.
 */
export function beanPrior(earlier: readonly EarlierBean[]): RpmPreference {
  const base = initPreference();
  const used = earlier.filter((e) => e.pref.ratings >= RPM.beanPriorMinRatings);
  if (used.length === 0) return base;
  const thetas = base.thetas;
  const pop = thetas.map((t) => gauss(t, RPM.thetaPriorMean, RPM.thetaPriorSd));
  const popZ = pop.reduce((a, b) => a + b, 0);
  const mix = new Array<number>(thetas.length).fill(0);
  const betaMix = new Array<number>(base.betas.length).fill(0);
  let wSum = 0;
  for (const e of used) {
    const w = e.roastWeight * e.recency;
    wSum += w;
    const tm = thetaMarginal(e.pref);
    for (let t = 0; t < thetas.length; t++) {
      let acc = 0;
      for (let s = 0; s < thetas.length; s++)
        acc += (tm[s] ?? 0) * gauss(thetas[t] ?? 0, thetas[s] ?? 0, RPM.beanPriorBlur);
      mix[t] = (mix[t] ?? 0) + w * acc;
    }
    const bm = betaMarginal(e.pref);
    for (let b = 0; b < betaMix.length; b++) betaMix[b] = (betaMix[b] ?? 0) + w * (bm[b] ?? 0);
  }
  const mixZ = mix.reduce((a, b) => a + b, 0) || 1;
  const thetaPrior = thetas.map(
    (_, t) =>
      RPM.beanPriorWeight * ((mix[t] ?? 0) / mixZ) +
      (1 - RPM.beanPriorWeight) * ((pop[t] ?? 0) / popZ),
  );
  const betaPop = base.betas.map((b) => gauss(b, 0.25, 0.35));
  const betaPopZ = betaPop.reduce((a, b) => a + b, 0);
  const betaPrior = base.betas.map(
    (_, b) => 0.5 * ((betaMix[b] ?? 0) / (wSum || 1)) + 0.5 * ((betaPop[b] ?? 0) / betaPopZ),
  );
  return initPreference(thetaPrior, betaPrior);
}
