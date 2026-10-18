/**
 * Curve features (plan "Feature extraction"). Pure function of the resampled curve.
 * Flow F(t) is the Savitzky–Golay derivative (window 11, order 2); the scale's own EMA
 * flow is never used here. `curveChannelScore` depends on the curve alone.
 */

import { runningMedian, sgDerivative, sgSmooth } from '../math/sg';
import { FEAT } from '../params';
import type { FeatureFlag, Features, RoastLevel } from '../types';

export interface CurveInput {
  t: Float32Array;
  g: Float32Array;
  mask: Uint8Array;
  /** Seconds; when stop was sent or the auto-end fired. */
  endAt: number;
  finalYieldG: number;
  /** False after a late or forgotten tap: the pump start is unknown. */
  firstDripKnown: boolean;
  roastLevel?: RoastLevel;
}

export function deriveFlow(
  g: ArrayLike<number>,
  mask: Uint8Array,
  window: number = FEAT.sgWindow,
): Float64Array {
  return sgDerivative(g, FEAT.gridMs / 1000, window, mask);
}

/** First time the (interpolated) curve crosses `level`, or null. */
function crossing(
  t: Float32Array,
  g: Float32Array,
  mask: Uint8Array,
  level: number,
): number | null {
  for (let k = 0; k < g.length; k++) {
    if (mask[k] !== 1) continue;
    const gk = g[k] ?? 0;
    if (gk >= level) {
      if (k === 0 || mask[k - 1] !== 1) return t[k] ?? null;
      const g0 = g[k - 1] ?? 0;
      const t0 = t[k - 1] ?? 0;
      const t1 = t[k] ?? 0;
      const f = gk > g0 ? (level - g0) / (gk - g0) : 1;
      return t0 + (t1 - t0) * Math.max(0, Math.min(1, f));
    }
  }
  return null;
}

function idxAt(tS: number): number {
  return Math.round(tS / (FEAT.gridMs / 1000));
}

export function computeFeatures(c: CurveInput): Features {
  const { t, g, mask } = c;
  const n = g.length;
  const Y = c.finalYieldG;
  const F = deriveFlow(g, mask);
  const flags: FeatureFlag[] = [];
  const invalid: string[] = [];
  const endIdx = Math.min(n - 1, idxAt(c.endAt));

  // First drip: w ≥ 0.5 g and F ≥ 0.2 g/s for 5 consecutive samples.
  let firstDripS: number | null = null;
  if (c.firstDripKnown) {
    let run = 0;
    for (let k = 0; k <= endIdx; k++) {
      const ok =
        mask[k] === 1 && (g[k] ?? 0) >= FEAT.firstDripG && (F[k] ?? 0) >= FEAT.firstDripFlowGps;
      run = ok ? run + 1 : 0;
      if (run >= FEAT.firstDripConsecutive) {
        firstDripS = t[k - FEAT.firstDripConsecutive + 1] ?? null;
        break;
      }
    }
  }

  const t25 = crossing(t, g, mask, FEAT.plateauLo * Y);
  const t50 = crossing(t, g, mask, 0.5 * Y);
  const t75 = crossing(t, g, mask, FEAT.plateauHi * Y);
  const t90 = crossing(t, g, mask, FEAT.jumpWindowHiFrac * Y);
  let plateauFlow: number | null = null;
  let plateauDurS = 0;
  if (t25 !== null && t75 !== null && t75 > t25) {
    plateauDurS = t75 - t25;
    plateauFlow = ((FEAT.plateauHi - FEAT.plateauLo) * Y) / plateauDurS;
  }

  const meanFlow =
    Y > 0 && c.endAt > 0
      ? firstDripS !== null && c.endAt > firstDripS
        ? Y / (c.endAt - firstDripS)
        : Y / c.endAt
      : null;

  // Late slope: mean F where w ∈ [0.80, 0.95]·Y, relative to the plateau.
  let lateSlopeRel: number | null = null;
  if (plateauFlow !== null && plateauFlow > 0) {
    let s = 0;
    let cnt = 0;
    for (let k = 0; k <= endIdx; k++) {
      const w = g[k] ?? 0;
      if (mask[k] !== 1 || w < FEAT.lateLo * Y || w > FEAT.lateHi * Y) continue;
      const v = F[k] ?? Number.NaN;
      if (Number.isNaN(v)) continue;
      s += v;
      cnt++;
    }
    if (cnt > 0) lateSlopeRel = (s / cnt - plateauFlow) / plateauFlow;
  }

  // Max 1 s flow jump in [firstDrip + 2 s, t90].
  let maxJump1s: number | null = null;
  const jumpStart = idxAt((firstDripS ?? 0) + FEAT.jumpStartAfterDripS);
  const jumpEnd = t90 !== null ? idxAt(t90) : endIdx;
  const oneS = idxAt(1);
  for (let k = jumpStart; k + oneS <= Math.min(jumpEnd, endIdx); k++) {
    const a = F[k] ?? Number.NaN;
    const b = F[k + oneS] ?? Number.NaN;
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    const d = Math.abs(b - a);
    if (maxJump1s === null || d > maxJump1s) maxJump1s = d;
  }

  // Dips: F < 0.7 × running 3 s median for ≥ 0.5 s, recovering above 0.9×, inside [t25, t90].
  let dipCount = 0;
  if (t25 !== null) {
    const med = runningMedian(F, idxAt(FEAT.dipMedianWindowS) * 2 + 1);
    const from = idxAt(t25);
    const to = Math.min(endIdx, t90 !== null ? idxAt(t90) : endIdx);
    let inDip = false;
    let dipLen = 0;
    let counted = false;
    for (let k = from; k <= to; k++) {
      const f = F[k] ?? Number.NaN;
      const m = med[k] ?? Number.NaN;
      if (Number.isNaN(f) || Number.isNaN(m) || m <= 0) continue;
      if (!inDip && f < FEAT.dipRatio * m) {
        inDip = true;
        dipLen = 1;
        counted = false;
      } else if (inDip) {
        if (f > FEAT.dipRecoverRatio * m) {
          inDip = false;
        } else {
          dipLen++;
          if (!counted && dipLen >= idxAt(FEAT.dipMinS)) {
            dipCount++;
            counted = true;
          }
        }
      }
    }
  }

  const wEnd = g[endIdx] ?? Y;
  const tailMassG = Math.max(0, Y - wEnd);
  const totalTimeS = c.endAt;

  // Noisy: RMS residual of the raw weight around its local quadratic fit over the plateau
  // (measurement noise in grams; a clean Themis Mini capture sits near 0.05 g).
  let noisy = false;
  if (t25 !== null && t75 !== null) {
    const smooth = sgSmooth(g, FEAT.sgWindow, mask);
    let ss = 0;
    let cnt = 0;
    for (let k = idxAt(t25); k <= idxAt(t75); k++) {
      const a = smooth[k] ?? Number.NaN;
      if (Number.isNaN(a)) continue;
      ss += ((g[k] ?? 0) - a) ** 2;
      cnt++;
    }
    noisy = cnt > 0 && Math.sqrt(ss / cnt) > FEAT.noisyResidualG;
  }

  if (maxJump1s !== null && maxJump1s > FEAT.spikeGps) flags.push('spike');
  if (dipCount >= 1) flags.push('dip');
  if (firstDripS !== null && firstDripS < FEAT.earlyDripS) flags.push('early_drip');
  if (firstDripS !== null && firstDripS > FEAT.lateDripS) flags.push('late_drip');
  const kChoke = idxAt(FEAT.chokedAtS);
  if (
    c.endAt >= FEAT.chokedAtS &&
    kChoke < n &&
    mask[kChoke] === 1 &&
    (F[kChoke] ?? 0) < FEAT.chokedFlowGps &&
    (g[kChoke] ?? 0) < FEAT.chokedWeightG
  ) {
    flags.push('choked');
  }
  if (lateSlopeRel !== null && lateSlopeRel > FEAT.blondRiseRel) flags.push('blond_rise');
  if (plateauDurS < FEAT.lowInfoPlateauS || Y < FEAT.lowInfoYieldG) flags.push('low_info');
  if (noisy) flags.push('noisy');

  const lightRoast = c.roastLevel === 'light' || c.roastLevel === 'medium_light';
  const w = FEAT.channelW;
  const score =
    (maxJump1s !== null && maxJump1s > FEAT.spikeGps ? w.jump : 0) +
    (dipCount >= 2 ? w.dips : 0) +
    (lateSlopeRel !== null && lateSlopeRel > FEAT.blondRiseRel ? w.lateSlope : 0) +
    (firstDripS !== null && firstDripS < FEAT.earlyDripS && lightRoast ? w.earlyDripLight : 0);
  const curveChannelScore = Math.max(0, Math.min(1, score));

  // Validity.
  let valid = 0;
  for (let k = 0; k <= endIdx; k++) if (mask[k] === 1) valid++;
  const present = endIdx >= 0 ? valid / (endIdx + 1) : 0;
  if (Y < FEAT.validMinYieldG) invalid.push(`yield ${Y.toFixed(1)} g < ${FEAT.validMinYieldG} g`);
  if (totalTimeS < FEAT.validTimeS[0] || totalTimeS > FEAT.validTimeS[1]) {
    invalid.push(
      `time ${totalTimeS.toFixed(1)} s outside ${FEAT.validTimeS[0]}–${FEAT.validTimeS[1]} s`,
    );
  }
  if (present < FEAT.validGridFraction)
    invalid.push(`only ${(present * 100).toFixed(0)} % of samples present`);
  if (plateauFlow === null) invalid.push('no plateau (25–75 % crossings missing)');
  else if (plateauDurS < FEAT.validMinPlateauS)
    invalid.push(`plateau ${plateauDurS.toFixed(1)} s < ${FEAT.validMinPlateauS} s`);

  return {
    firstDripS,
    t50S: t50,
    plateauFlow,
    meanFlow,
    lateSlopeRel,
    maxJump1s,
    dipCount,
    tailMassG,
    totalTimeS,
    finalYieldG: Y,
    plateauDurS,
    curveChannelScore,
    flags,
    valid: invalid.length === 0,
    invalidReasons: invalid,
  };
}

/** Grid helpers exposed for the recorder and charts. */
export const gridDtS = FEAT.gridMs / 1000;
export function dtIndex(tS: number): number {
  return idxAt(tS);
}
