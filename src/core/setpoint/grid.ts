/**
 * Preference-based setpoint search: a discrete posterior p(s) over the optimal ln plateau
 * flow s on a grid μ0 ± 0.6 (step 0.01). Updated by better/same/worse comparisons against
 * the previous tasted shot (preference likelihood), or, when no valid comparison exists,
 * by the sour–bitter slider and chips (tempered pseudo-likelihoods). Never both for one
 * tasting. The thin–heavy slider never touches p(s): texture is the RPM lever's signal.
 */

import { normalPdf, phi } from '../math/normal';
import { mulberry32, type Rng } from '../math/rng';
import { MODEL, SETPOINT } from '../params';
import type { Chip, SliderValue, VsPrevious } from '../types';

export interface SetpointPosterior {
  mu0: number;
  grid: number[];
  p: number[];
  /** Consecutive 'same' comparisons at the end of the history. */
  sameStreak: number;
  /** Alternating probe side. */
  probeSide: 1 | -1;
  updates: number;
}

export function recipeMu0(yieldG: number, timeS: number | [number, number]): number {
  const t = Array.isArray(timeS) ? (timeS[0] + timeS[1]) / 2 : timeS;
  return Math.log(yieldG / Math.max(5, t - MODEL.firstDripAssumedS)) + MODEL.plateauOffsetLn;
}

export function initSetpoint(mu0Roast: number, recipe?: number): SetpointPosterior {
  const mu0 =
    recipe === undefined
      ? mu0Roast
      : (1 - SETPOINT.recipeWeight) * mu0Roast + SETPOINT.recipeWeight * recipe;
  const n = Math.round((2 * SETPOINT.gridHalfWidth) / SETPOINT.gridStep) + 1;
  const grid: number[] = [];
  const p: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = mu0 - SETPOINT.gridHalfWidth + i * SETPOINT.gridStep;
    grid.push(s);
    p.push(normalPdf(s, mu0, SETPOINT.priorSd));
  }
  return normalize({ mu0, grid, p, sameStreak: 0, probeSide: 1, updates: 0 });
}

export function cloneSetpoint(sp: SetpointPosterior): SetpointPosterior {
  return { ...sp, grid: [...sp.grid], p: [...sp.p] };
}

function normalize(sp: SetpointPosterior): SetpointPosterior {
  let z = 0;
  for (const v of sp.p) z += v;
  if (!(z > 0) || !Number.isFinite(z)) {
    // Degenerate: fall back to the prior shape.
    const fresh = initSetpoint(sp.mu0);
    return { ...sp, p: fresh.p };
  }
  sp.p = sp.p.map((v) => v / z);
  return sp;
}

export function summary(sp: SetpointPosterior): { mean: number; sd: number } {
  let m = 0;
  for (let i = 0; i < sp.grid.length; i++) m += (sp.grid[i] ?? 0) * (sp.p[i] ?? 0);
  let v = 0;
  for (let i = 0; i < sp.grid.length; i++) v += ((sp.grid[i] ?? 0) - m) ** 2 * (sp.p[i] ?? 0);
  return { mean: m, sd: Math.sqrt(Math.max(0, v)) };
}

/** Convolve with N(0, sd²); mass beyond the grid edges is folded back by renormalising. */
export function forget(sp: SetpointPosterior, sd: number): SetpointPosterior {
  if (!(sd > 0)) return sp;
  const out = cloneSetpoint(sp);
  const step = SETPOINT.gridStep;
  const h = Math.min(sp.grid.length - 1, Math.ceil((4 * sd) / step));
  const kernel: number[] = [];
  let ks = 0;
  for (let k = -h; k <= h; k++) {
    const v = normalPdf(k * step, 0, sd);
    kernel.push(v);
    ks += v;
  }
  const n = sp.grid.length;
  const p = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const pi = sp.p[i] ?? 0;
    if (pi === 0) continue;
    for (let k = -h; k <= h; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      p[j] = (p[j] ?? 0) + (pi * (kernel[k + h] ?? 0)) / ks;
    }
  }
  out.p = p;
  return normalize(out);
}

export function forgetDays(sp: SetpointPosterior, days: number): SetpointPosterior {
  return forget(sp, SETPOINT.forgetPerDaySd * Math.sqrt(Math.max(0, days)));
}

export function forgetLeverChange(sp: SetpointPosterior): SetpointPosterior {
  return forget(sp, SETPOINT.forgetOnLeverChangeSd);
}

export function utility(y: number, s: number): number {
  return -((y - s) ** 2) / (2 * SETPOINT.utilityW ** 2);
}

/** P(vs | s) for the rated shot j against the previous tasted shot i. */
export function preferenceLikelihood(
  s: number,
  yj: number,
  yi: number,
  vs: VsPrevious,
  dDays: number,
): number {
  const d = utility(yj, s) - utility(yi, s);
  const tau = SETPOINT.tauBase * (1 + SETPOINT.tauPerDay * Math.max(0, dDays));
  const eps = SETPOINT.lapse;
  const pBetter = eps / 3 + (1 - eps) * phi((d - SETPOINT.jnd) / tau);
  const pWorse = eps / 3 + (1 - eps) * phi((-d - SETPOINT.jnd) / tau);
  if (vs === 'better') return pBetter;
  if (vs === 'worse') return pWorse;
  return Math.max(1e-6, 1 - pBetter - pWorse);
}

export function updatePreference(
  sp: SetpointPosterior,
  yj: number,
  yi: number,
  vs: VsPrevious,
  dDays: number,
): SetpointPosterior {
  const out = cloneSetpoint(sp);
  out.p = out.p.map((pv, i) => pv * preferenceLikelihood(out.grid[i] ?? 0, yj, yi, vs, dDays));
  out.sameStreak = vs === 'same' ? sp.sameStreak + 1 : 0;
  out.updates += 1;
  return normalize(out);
}

/** L_v(s) = 0.25 + 0.75·Φ(sgn(v)·(s − y_j)/0.10)^{|v|/3}. v = −1 (sour) favours s < y_j: finer. */
export function sliderLikelihood(
  s: number,
  yj: number,
  v: number,
  scale: number = SETPOINT.sliderScale,
): number {
  const sign = v < 0 ? -1 : 1;
  const base = phi((sign * (s - yj)) / scale);
  return SETPOINT.sliderFloor + (1 - SETPOINT.sliderFloor) * base ** (Math.abs(v) / 3);
}

/**
 * Slider update. `scale` widens beyond 0.10 when y_j is referenced to 1000 RPM through an
 * uncertain balance shift δ (√(0.10² + (sd(δ)·u)²)), so that uncertainty is counted once.
 */
export function updateSlider(
  sp: SetpointPosterior,
  yj: number,
  v: number,
  scale: number = SETPOINT.sliderScale,
): SetpointPosterior {
  if (v === 0) return sp;
  const out = cloneSetpoint(sp);
  out.p = out.p.map((pv, i) => pv * sliderLikelihood(out.grid[i] ?? 0, yj, v, scale));
  out.updates += 1;
  return normalize(out);
}

/** balanced with overall ≥ 7: a bump at the realised flow. */
export function updateBalanced(
  sp: SetpointPosterior,
  yj: number,
  scale: number = SETPOINT.sliderScale,
): SetpointPosterior {
  const out = cloneSetpoint(sp);
  const peak = normalPdf(0, 0, scale);
  out.p = out.p.map(
    (pv, i) =>
      pv *
      (SETPOINT.sliderFloor +
        (1 - SETPOINT.sliderFloor) * (normalPdf(out.grid[i] ?? 0, yj, scale) / peak)),
  );
  out.updates += 1;
  return normalize(out);
}

/** Chip → equivalent slider value; null = no setpoint update from chips. */
export function chipSlider(chips: readonly Chip[]): number | null {
  if (chips.includes('astringent') || chips.includes('channelled')) return null;
  if (chips.includes('hollow')) return -1;
  if (chips.includes('harsh')) return 1;
  return null;
}

export interface TastingInput {
  yj: number;
  /** Previous tasted shot's ln flow, when a valid comparison exists. */
  yi: number | null;
  vs: VsPrevious | null;
  comparisonValid: boolean;
  dDays: number;
  sourBitter: SliderValue | null;
  chips: readonly Chip[];
  overall: number | null;
  /** True when the slider has just driven the yield rule (stage C): skip the slider update. */
  sliderDrovesYield: boolean;
  /** Extra sd on y_j from referencing it to 1000 RPM (sd(δ)·|u|); 0 when omitted. */
  refSd?: number;
}

/** One tasting → one update at most (preference first; pseudo-likelihoods otherwise). */
export function applyTasting(
  sp: SetpointPosterior,
  t: TastingInput,
): { sp: SetpointPosterior; applied: 'preference' | 'slider' | 'chip' | 'balanced' | 'none' } {
  if (t.vs !== null && t.vs !== 'same' && t.comparisonValid && t.yi !== null) {
    return { sp: updatePreference(sp, t.yj, t.yi, t.vs, t.dDays), applied: 'preference' };
  }
  let out = sp;
  if (t.vs === 'same' && t.comparisonValid && t.yi !== null) {
    out = updatePreference(out, t.yj, t.yi, 'same', t.dDays);
  }
  if (t.sliderDrovesYield) return { sp: out, applied: t.vs === 'same' ? 'preference' : 'none' };
  const scale = Math.sqrt(SETPOINT.sliderScale ** 2 + (t.refSd ?? 0) ** 2);
  const v = t.sourBitter;
  if (v !== null && v !== 0) return { sp: updateSlider(out, t.yj, v, scale), applied: 'slider' };
  const cv = chipSlider(t.chips);
  if (cv !== null) return { sp: updateSlider(out, t.yj, cv, scale), applied: 'chip' };
  if (
    t.chips.includes('balanced') &&
    t.overall !== null &&
    t.overall >= SETPOINT.balancedMinOverall
  ) {
    return { sp: updateBalanced(out, t.yj, scale), applied: 'balanced' };
  }
  return { sp: out, applied: t.vs === 'same' && t.comparisonValid ? 'preference' : 'none' };
}

export interface ComparisonFacts {
  learnJ: boolean;
  learnI: boolean;
  channelJ: boolean;
  channelI: boolean;
  yieldJ: number;
  yieldI: number;
  rpmJ: number;
  rpmI: number;
  tempJ: number;
  tempI: number;
  doseJ: number;
  doseI: number;
  yj: number | null;
  yi: number | null;
}

/** Checks shared by both comparison routes (null = passes). */
function commonValidity(c: ComparisonFacts): string | null {
  if (c.yj === null || c.yi === null) return 'plateau flow missing on one of the shots';
  if (!c.learnJ || !c.learnI) return 'one of the shots is excluded from learning';
  if (c.channelJ || c.channelI) return 'one of the shots channelled';
  if (Math.abs(Math.log(c.yieldJ / c.yieldI)) >= SETPOINT.maxLnYieldDiff)
    return 'yields differ by more than 10 %';
  if (c.tempJ !== c.tempI) return 'temperature switch changed between the shots';
  if (Math.abs(c.doseJ - c.doseI) > SETPOINT.maxDoseDiffG) return 'dose changed by more than 0.3 g';
  return null;
}

/**
 * Why a better/worse comparison is invalid for the FLOW setpoint (null = valid). Same RPM only:
 * comparisons across RPMs go to the RPM preference model instead (rpmComparisonValidity).
 */
export function comparisonValidity(c: ComparisonFacts): string | null {
  const common = commonValidity(c);
  if (common) return common;
  if (c.rpmJ !== c.rpmI) return 'RPM changed between the shots';
  if (Math.abs((c.yj ?? 0) - (c.yi ?? 0)) < SETPOINT.minLnFlowDiff)
    return 'flows within 4 %: comparison uninformative';
  return null;
}

/**
 * Why a better/worse comparison is invalid for the RPM preference (null = valid): different RPM
 * and MATCHED flow (|Δ y_ref| ≤ matchedFlowLn, flows referenced to 1000 RPM), so the answer is
 * about RPM rather than flow.
 */
export function rpmComparisonValidity(c: ComparisonFacts, matchedFlowLn: number): string | null {
  const common = commonValidity(c);
  if (common) return common;
  if (c.rpmJ === c.rpmI) return 'same RPM';
  if (Math.abs((c.yj ?? 0) - (c.yi ?? 0)) > matchedFlowLn)
    return 'flows differ by more than 7 %: not a fair RPM comparison';
  return null;
}

export interface TargetChoice {
  yStar: number;
  mode: 'thompson' | 'probe' | 'mean';
}

/** Target choice: Thompson sample while uncertain, deterministic probe once converged and flat. */
export function chooseTarget(sp: SetpointPosterior, seed: number): TargetChoice {
  const { mean, sd } = summary(sp);
  if (sd > SETPOINT.thompsonSd) {
    const rng: Rng = mulberry32(seed >>> 0);
    const u = rng();
    let acc = 0;
    let sample = mean;
    for (let i = 0; i < sp.grid.length; i++) {
      acc += sp.p[i] ?? 0;
      if (acc >= u) {
        sample = sp.grid[i] ?? mean;
        break;
      }
    }
    const clamped = Math.max(
      mean - SETPOINT.thompsonClamp,
      Math.min(mean + SETPOINT.thompsonClamp, sample),
    );
    return { yStar: clamped, mode: 'thompson' };
  }
  if (sp.sameStreak >= 2)
    return { yStar: mean + sp.probeSide * SETPOINT.probeOffset, mode: 'probe' };
  return { yStar: mean, mode: 'mean' };
}

/** Flip the probe side after a probe was issued. */
export function afterProbe(sp: SetpointPosterior): SetpointPosterior {
  return { ...sp, probeSide: sp.probeSide === 1 ? -1 : 1 };
}
