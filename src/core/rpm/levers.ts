/**
 * The three ways a calibrated RPM is used (plan "Using RPM"):
 *  - body move: change RPM toward the preferred body and re-invert the dial so the flow (and
 *    the balance, through δ) holds;
 *  - backup flow lever: when the dial is clamped at a limit, cover the remaining flow gap with RPM;
 *  - fine trim: when the needed dial change is below one line, close the residual with RPM,
 *    staying inside the RPM band that costs no noticeable body.
 * All RPMs are multiples of 100 inside the allowed range.
 */
import { type Inversion, invert, predictAt } from '../flowmodel/invert';
import { type FlowModelState, rpmSlope } from '../flowmodel/state';
import { RPM } from '../params';
import type { DialSpec } from '../types';
import { clampRpm, quantRpm, type RpmRange, uOf } from './range';

export interface LeverCtx {
  model: FlowModelState;
  bagId: string;
  doseG: number;
  spec: DialSpec;
  chirpLines: number | null;
  curLines: number;
  range: RpmRange;
  /** Balanced (target) ln flow at an RPM: setpoint at 1000 RPM + δ̂·u. */
  targetAt: (rpm: number) => number;
}

/** Dial that holds the balanced flow at `rpm` (step clamps of invert() apply). */
export function compensatedDial(ctx: LeverCtx, rpm: number): Inversion | null {
  return invert(
    ctx.model,
    ctx.bagId,
    ctx.targetAt(rpm),
    rpm,
    ctx.doseG,
    ctx.curLines,
    ctx.spec,
    ctx.chirpLines,
  );
}

/** Body move target: toward the Bayes RPM, at most 300 RPM per move. */
export function bodyMoveTarget(currentRpm: number, bayesRpm: number, range: RpmRange): number {
  const step = Math.max(-RPM.bodyStepCap, Math.min(RPM.bodyStepCap, bayesRpm - currentRpm));
  return clampRpm(currentRpm + step, range);
}

/** True when the RPM flow slope at `rpm` is known well enough to steer flow with it. */
export function slopeSignificant(model: FlowModelState, rpm: number): boolean {
  const s = rpmSlope(model, uOf(rpm));
  return Math.abs(s.mean) >= RPM.backupZ * s.sd && Math.abs(s.mean) > 1e-6;
}

function residualAt(ctx: LeverCtx, lines: number, rpm: number): number | null {
  const p = predictAt(ctx.model, ctx.bagId, lines, rpm, ctx.doseG);
  return p ? p.yHat - ctx.targetAt(rpm) : null;
}

/**
 * Backup flow lever: the dial is stuck at `clampedLines`; pick the RPM within ±400 that brings
 * the prediction closest to target, preferring the body band. Null when nothing helps by ≥ 0.01.
 */
export function backupRpm(
  ctx: LeverCtx,
  clampedLines: number,
  currentRpm: number,
  band: [number, number] | null,
): { rpm: number; residual: number } | null {
  if (!slopeSignificant(ctx.model, currentRpm)) return null;
  const base = residualAt(ctx, clampedLines, currentRpm);
  if (base === null) return null;
  const [lo, hi] = ctx.range;
  let best: { rpm: number; residual: number; inBand: boolean } | null = null;
  for (
    let r = quantRpm(Math.max(lo, currentRpm - RPM.backupMaxStep));
    r <= Math.min(hi, currentRpm + RPM.backupMaxStep);
    r += RPM.step
  ) {
    if (r === currentRpm || r < lo) continue;
    const res = residualAt(ctx, clampedLines, r);
    if (res === null) continue;
    const inBand = band ? r >= band[0] && r <= band[1] : true;
    const cand = { rpm: r, residual: res, inBand };
    if (
      !best ||
      (cand.inBand && !best.inBand && Math.abs(res) < Math.abs(base) - RPM.trimMinGain) ||
      (cand.inBand === best.inBand && Math.abs(res) < Math.abs(best.residual))
    ) {
      best = cand;
    }
  }
  if (!best || Math.abs(best.residual) > Math.abs(base) - RPM.trimMinGain) return null;
  return { rpm: best.rpm, residual: best.residual };
}

/**
 * Fine trim: the dial change rounds to zero but the predicted flow is still ≥ 0.015 ln off.
 * Pick an RPM inside the body band within ±200 that improves the residual by ≥ 0.01.
 */
export function trimRpm(
  ctx: LeverCtx,
  lines: number,
  currentRpm: number,
  band: [number, number] | null,
): { rpm: number; before: number; after: number } | null {
  if (!slopeSignificant(ctx.model, currentRpm)) return null;
  const before = residualAt(ctx, lines, currentRpm);
  if (before === null || Math.abs(before) < RPM.trimMinResidual) return null;
  const [lo, hi] = band ?? ctx.range;
  let best: { rpm: number; after: number } | null = null;
  for (let d = -RPM.trimMaxStep; d <= RPM.trimMaxStep; d += RPM.step) {
    const r = currentRpm + d;
    if (d === 0 || r < Math.max(lo, ctx.range[0]) || r > Math.min(hi, ctx.range[1])) continue;
    const after = residualAt(ctx, lines, r);
    if (after === null) continue;
    if (!best || Math.abs(after) < Math.abs(best.after)) best = { rpm: r, after };
  }
  if (!best || Math.abs(before) - Math.abs(best.after) < RPM.trimMinGain) return null;
  return { rpm: best.rpm, before, after: best.after };
}
