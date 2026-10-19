/**
 * Prediction at arbitrary settings and inversion for a target ln flow, with the step clamps:
 *   L* = L_ref,b + (y* − h₀·m) / max(k̂_g, 0.010), h₀ = the shot row at L = L_ref,b, so every
 *   shared term (a_b, k_r·u, κ·u², k_d·d) enters exactly once.
 *   |L* − L_cur| ≤ 10 lines (≤ 5 while sd(k_g) > 0.012), ≤ 15 absolutely; within
 *   [chirp + 5, max lines]; rounded to the nearest line.
 */
import { MODEL } from '../params';
import type { DialSpec, Id } from '../types';
import { maxLines } from '../units';
import { bagOf, type FlowModelState, IDX_KG, kGrind } from './state';
import { rowFor } from './update';

export interface Prediction {
  yHat: number;
  /** Parameter-only sd of the predicted mean. */
  sP: number;
  /** Predictive sd including σ_y. */
  sPred: number;
}

export function predictAt(
  s: FlowModelState,
  bagId: Id,
  lines: number,
  rpm: number,
  doseG: number,
): Prediction | null {
  const b = bagOf(s, bagId);
  if (!b) return null;
  const h = rowFor(s, b.index, lines, b.LrefB, rpm, doseG, b.meta.doseDefaultG);
  const n = s.m.length;
  let yHat = 0;
  for (let i = 0; i < n; i++) yHat += (h[i] ?? 0) * (s.m[i] ?? 0);
  let v = 0;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += (s.P[i]?.[j] ?? 0) * (h[j] ?? 0);
    v += (h[i] ?? 0) * acc;
  }
  const sP = Math.sqrt(Math.max(0, v));
  return { yHat, sP, sPred: Math.sqrt(sP * sP + MODEL.sigmaY ** 2) };
}

export interface Inversion {
  /** Unclamped target line (fractional). */
  raw: number;
  /** Clamped, rounded line to recommend. */
  lines: number;
  deltaLines: number;
  vetoes: string[];
  /** True when the gain was at its floor (model unsure). */
  gainFloored: boolean;
  probeStep: boolean;
  /** Which dial limit cut the step, if any (the backup RPM lever reacts to this). */
  clamped: 'chirp' | 'end' | null;
}

export function invert(
  s: FlowModelState,
  bagId: Id,
  yTarget: number,
  rpm: number,
  doseG: number,
  currentLines: number,
  spec: DialSpec,
  chirpLines: number | null,
): Inversion | null {
  const b = bagOf(s, bagId);
  if (!b) return null;
  const kg = kGrind(s);
  const gainFloored = kg.mean <= MODEL.kGrindFloor;
  const gain = gainFloored ? MODEL.kGrindPrior.mean : kg.mean;
  const h0 = rowFor(s, b.index, b.LrefB, b.LrefB, rpm, doseG, b.meta.doseDefaultG);
  let y0 = 0;
  for (let i = 0; i < s.m.length; i++) y0 += (h0[i] ?? 0) * (s.m[i] ?? 0);
  const raw = b.LrefB + (yTarget - y0) / gain;
  const vetoes: string[] = [];
  if (gainFloored) vetoes.push('model unsure: grind gain at its floor, prior gain used');
  const probeStep = kg.sd > MODEL.kGrindSdConverged;
  const maxStep = probeStep ? MODEL.probeStepLines : MODEL.stepMaxLines;
  let delta = raw - currentLines;
  if (Math.abs(delta) > maxStep + 0.5) {
    vetoes.push(
      `step of ${Math.round(delta)} lines clamped to ${maxStep}${probeStep ? ' while the grinder gain is still being learned' : ''}`,
    );
  }
  delta = Math.max(-maxStep, Math.min(maxStep, delta));
  let L = Math.round(currentLines + delta);
  const lo = chirpLines !== null ? chirpLines + MODEL.chirpMarginLines : 0;
  const hi = maxLines(spec);
  let clamped: Inversion['clamped'] = null;
  if (L < lo) {
    vetoes.push(`clamped above the chirp point (${lo} lines)`);
    L = lo;
    clamped = 'chirp';
  }
  if (L > hi) {
    vetoes.push(`clamped at the end of the dial (${hi} lines)`);
    L = hi;
    clamped = 'end';
  }
  return { raw, lines: L, deltaLines: L - currentLines, vetoes, gainFloored, probeStep, clamped };
}

export { IDX_KG };
