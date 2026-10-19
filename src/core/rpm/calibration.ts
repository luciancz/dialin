/**
 * RPM calibration session planner (pure). One run = 8 slots:
 *   block 1  A B B A  with {A, B} = {L, H}, L = max(lo, 700), H = min(hi, L + 600), starting at
 *            the level closer to the current RPM (ABBA cancels linear warm-up drift);
 *   block 2  X Y Y X  chosen when block 1 is done, maximising the expected information about
 *            the preferred RPM θ plus the information about the RPM flow effect (k_r, κ).
 * Every slot is pulled at a COMPENSATED dial (invert at the balanced flow for that RPM), so the
 * cup stays drinkable and taste comparisons happen at matched flow.
 * A slot counts when its shot is learnable, accepted and has Huber weight ≥ 0.5; otherwise the
 * level is repeated, and after 2 repeats the run stops as too noisy. The planner stops early
 * after block 1 when sd(k_r) is already small enough and block 2 would teach little about θ.
 */
import { type FlowModelState, IDX_KQ, IDX_KR, kRpm } from '../flowmodel/state';
import { rowFor } from '../flowmodel/update';
import { MODEL, RPM, RULES } from '../params';
import type { ShotView } from '../recommend';
import type { RpmCalibrationRun } from '../types';
import {
  bodyLikelihood,
  comparisonLikelihood,
  type RpmPreference,
  summarizePreference,
  utility,
} from './preference';
import { type RpmRange, uOf } from './range';

export const CALIBRATION_SLOTS = 8;

export type SlotStatus = 'pending' | 'done' | 'failed';

export interface SlotState {
  slot: number;
  plannedRpm: number | null;
  shotIds: string[];
  status: SlotStatus;
  tries: number;
}

export type StopReason = 'complete' | 'early' | 'too_noisy' | 'range_too_narrow' | 'ended';

export interface CalibrationProgress {
  runId: string;
  slots: SlotState[];
  /** Next slot to pull; null when the run is finished or stopped. */
  next: { slot: number; rpm: number } | null;
  stopReason: StopReason | null;
  shotsUsed: number;
}

/** "Calibrated": the RPM slope is known to ±0.015 ln per 100 RPM. */
export function isCalibrated(model: FlowModelState): boolean {
  return kRpm(model).sd <= RPM.calibratedSd;
}

/** Precision needed to stop: sd(k_r) ≤ min(0.015, 0.05/u_max) over the allowed range. */
export function stopSd(range: RpmRange): number {
  const uMax = Math.max(Math.abs(uOf(range[0])), Math.abs(uOf(range[1])), 1);
  return Math.min(RPM.calibratedSd, RPM.stopFlowErr / uMax);
}

/** Block-1 levels in pull order [A, B]; null when the range is too narrow for a useful contrast. */
export function block1Levels(range: RpmRange, startRpm: number): [number, number] | null {
  const [lo, hi] = range;
  let L = Math.max(lo, RPM.blockLow);
  let H = Math.min(hi, L + RPM.blockSpan);
  if (H - L < RPM.blockSpan) L = Math.max(lo, H - RPM.blockSpan);
  if (H - L < RPM.block2MinSpan) return null;
  if (Math.abs(startRpm - H) < Math.abs(startRpm - L)) [L, H] = [H, L];
  return [L, H];
}

function slotDone(v: ShotView): boolean {
  return v.learn && !v.skipped && v.w >= RPM.slotMinWeight;
}

export interface PlanInput {
  run: RpmCalibrationRun;
  /** Views of the run's bag, in order (all shots; tagged ones are picked out). */
  views: readonly ShotView[];
  model: FlowModelState;
  bagId: string;
  pref: RpmPreference;
  range: RpmRange;
  /** RPM when the run started (used until slot 0 has a shot). */
  currentRpm: number;
  doseG: number;
  doseDefaultG: number;
}

export function planCalibration(p: PlanInput): CalibrationProgress {
  const tagged = p.views.filter((v) => v.shot.calibration?.runId === p.run.id);
  const slots: SlotState[] = Array.from({ length: CALIBRATION_SLOTS }, (_, slot) => ({
    slot,
    plannedRpm: null,
    shotIds: [],
    status: 'pending',
    tries: 0,
  }));
  for (const v of tagged) {
    const tag = v.shot.calibration;
    if (!tag) continue;
    const s = slots[tag.slot];
    if (!s) continue;
    if (s.plannedRpm === null) s.plannedRpm = tag.plannedRpm;
    s.shotIds.push(v.shot.id);
    s.tries += 1;
    if (slotDone(v)) s.status = 'done';
  }
  const result = (next: CalibrationProgress['next'], stopReason: StopReason | null) => ({
    runId: p.run.id,
    slots,
    next,
    stopReason,
    shotsUsed: tagged.length,
  });
  for (const s of slots) {
    if (s.status !== 'done' && s.tries > RPM.maxRepeatsPerSlot) s.status = 'failed';
  }
  if (slots.some((s) => s.status === 'failed')) return result(null, 'too_noisy');
  if (p.run.status !== 'active') return result(null, 'ended');

  // Block 1 levels: fixed by slot 0's tag once pulled.
  const startRpm = slots[0]?.plannedRpm ?? p.currentRpm;
  const b1 = block1Levels(p.range, startRpm);
  if (!b1) return result(null, 'range_too_narrow');
  const [A, B] = b1;
  const block1Rpm = [A, B, B, A];
  for (let i = 0; i < 4; i++) {
    const s = slots[i];
    if (s && s.plannedRpm === null) s.plannedRpm = block1Rpm[i] ?? null;
  }
  const b1Next = slots.slice(0, 4).find((s) => s.status !== 'done');
  if (b1Next) return result({ slot: b1Next.slot, rpm: b1Next.plannedRpm ?? A }, null);

  // Block 1 complete: stop early when the flow effect is already pinned and θ would barely move.
  const slot4 = slots[4];
  const slot5 = slots[5];
  if (!slot4 || !slot5) return result(null, 'complete');
  if (slot4.tries === 0) {
    const choice = chooseBlock2({
      pref: p.pref,
      model: p.model,
      bagId: p.bagId,
      range: p.range,
      lastRpm: A,
      doseG: p.doseG,
      doseDefaultG: p.doseDefaultG,
    });
    if (kRpm(p.model).sd <= stopSd(p.range) && (choice?.miTheta ?? 0) < RPM.stopMiNats) {
      return result(null, 'early');
    }
    if (!choice) return result(null, 'complete');
    slot4.plannedRpm = choice.pair[0];
    slot5.plannedRpm = choice.pair[1];
  } else if (slot5.plannedRpm === null) {
    const X = slot4.plannedRpm ?? A;
    const choice = chooseBlock2({
      pref: p.pref,
      model: p.model,
      bagId: p.bagId,
      range: p.range,
      lastRpm: X,
      doseG: p.doseG,
      doseDefaultG: p.doseDefaultG,
      fixedX: X,
    });
    slot5.plannedRpm =
      choice?.pair[1] ?? (X >= 1000 ? X - RPM.block2MinSpan : X + RPM.block2MinSpan);
  }
  const X = slot4.plannedRpm ?? A;
  const Y = slot5.plannedRpm ?? B;
  const block2Rpm = [X, Y, Y, X];
  for (let i = 4; i < 8; i++) {
    const s = slots[i];
    if (s && s.plannedRpm === null) s.plannedRpm = block2Rpm[i - 4] ?? null;
  }
  const b2Next = slots.slice(4).find((s) => s.status !== 'done');
  if (b2Next) return result({ slot: b2Next.slot, rpm: b2Next.plannedRpm ?? X }, null);
  return result(null, 'complete');
}

export interface Block2Input {
  pref: RpmPreference;
  model: FlowModelState;
  bagId: string;
  range: RpmRange;
  /** RPM of the last calibration shot: X is the level of the pair closer to it. */
  lastRpm: number;
  doseG: number;
  doseDefaultG: number;
  /** Keep X fixed (slot 4 already pulled) and choose only Y. */
  fixedX?: number;
}

export interface Block2Choice {
  pair: [number, number];
  miTheta: number;
  miFlow: number;
}

function entropy(ws: readonly number[]): number {
  let z = 0;
  for (const w of ws) z += w;
  if (!(z > 0)) return 0;
  let h = 0;
  for (const w of ws) {
    const q = w / z;
    if (q > 0) h -= q * Math.log(q);
  }
  return h;
}

/**
 * Expected information (nats) about θ from an X Y Y X block: one body reading at each level and
 * one matched-flow comparison of Y against X (the information structure of the block, cheaply).
 */
export function miTheta(pref: RpmPreference, X: number, Y: number): number {
  const nB = pref.betas.length;
  const nO = pref.biases.length;
  const nT = pref.thetas.length;
  const n = pref.p.length;
  const theta = new Int32Array(n);
  const lbX: Float64Array[] = [];
  const lbY: Float64Array[] = [];
  for (let h = -3; h <= 3; h++) {
    lbX.push(new Float64Array(n));
    lbY.push(new Float64Array(n));
  }
  const lc: Float64Array[] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const uX = uOf(X);
  const uY = uOf(Y);
  for (let i = 0; i < n; i++) {
    const t = Math.floor(i / (nB * nO));
    const b = Math.floor(i / nO) % nB;
    const o = i % nO;
    theta[i] = t;
    const th = uOf(pref.thetas[t] ?? 1000);
    const beta = pref.betas[b] ?? 0;
    for (let h = -3; h <= 3; h++) {
      (lbX[h + 3] as Float64Array)[i] = bodyLikelihood(h, beta * (uX - th));
      (lbY[h + 3] as Float64Array)[i] = bodyLikelihood(h, beta * (uY - th));
    }
    const d =
      utility(Y, pref.thetas[t] ?? 1000, beta) -
      utility(X, pref.thetas[t] ?? 1000, beta) +
      (pref.biases[o] ?? 0);
    (lc[0] as Float64Array)[i] = comparisonLikelihood('better', d, 0);
    (lc[1] as Float64Array)[i] = comparisonLikelihood('same', d, 0);
    (lc[2] as Float64Array)[i] = comparisonLikelihood('worse', d, 0);
  }
  const prior = new Array<number>(nT).fill(0);
  for (let i = 0; i < n; i++) prior[theta[i] ?? 0] = (prior[theta[i] ?? 0] ?? 0) + (pref.p[i] ?? 0);
  const h0 = entropy(prior);
  let expected = 0;
  const marg = new Array<number>(nT);
  for (let hx = 0; hx < 7; hx++) {
    const ax = lbX[hx] as Float64Array;
    for (let hy = 0; hy < 7; hy++) {
      const ay = lbY[hy] as Float64Array;
      for (let c = 0; c < 3; c++) {
        const ac = lc[c] as Float64Array;
        marg.fill(0);
        let po = 0;
        for (let i = 0; i < n; i++) {
          const w = (pref.p[i] ?? 0) * (ax[i] ?? 0) * (ay[i] ?? 0) * (ac[i] ?? 0);
          po += w;
          const t = theta[i] ?? 0;
          marg[t] = (marg[t] ?? 0) + w;
        }
        if (po > 0) expected += po * entropy(marg);
      }
    }
  }
  return Math.max(0, h0 - expected);
}

/** Information (nats) about (k_r, κ) from four covariance-only Kalman updates at X Y Y X. */
export function miFlow(
  model: FlowModelState,
  bagIndex: number | null,
  X: number,
  Y: number,
  doseG: number,
  doseDefaultG: number,
): number {
  const n = model.m.length;
  let P = model.P.map((r) => [...r]);
  const det2 = (M: number[][]) =>
    (M[IDX_KR]?.[IDX_KR] ?? 0) * (M[IDX_KQ]?.[IDX_KQ] ?? 0) -
    (M[IDX_KR]?.[IDX_KQ] ?? 0) * (M[IDX_KQ]?.[IDX_KR] ?? 0);
  const before = det2(P);
  for (const rpm of [X, Y, Y, X]) {
    const h = rowFor(model, bagIndex ?? -1, 0, 0, rpm, doseG, doseDefaultG);
    if (bagIndex === null) h.length = n;
    const Ph = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += (P[i]?.[j] ?? 0) * (h[j] ?? 0);
      Ph[i] = acc;
    }
    let s = MODEL.sigmaY ** 2;
    for (let i = 0; i < n; i++) s += (h[i] ?? 0) * (Ph[i] ?? 0);
    P = P.map((row, i) => row.map((v, j) => v - ((Ph[i] ?? 0) * (Ph[j] ?? 0)) / s));
  }
  const after = det2(P);
  return before > 0 && after > 0 ? 0.5 * Math.log(before / after) : 0;
}

export function chooseBlock2(b: Block2Input): Block2Choice | null {
  const [lo, hi] = b.range;
  const levels: number[] = [];
  for (let r = lo; r <= hi; r += RPM.step) levels.push(r);
  const bag = b.model.bags.find((x) => x.bagId === b.bagId);
  const bagIndex = bag ? bag.index : null;
  const bayes = summarizePreference(b.pref, b.range).bayesRpm;
  let best: (Block2Choice & { tie: number }) | null = null;
  for (const P of levels) {
    for (const Q of levels) {
      if (Q <= P || Q - P < RPM.block2MinSpan) continue;
      if (b.fixedX !== undefined && P !== b.fixedX && Q !== b.fixedX) continue;
      const mt = miTheta(b.pref, P, Q);
      const mf = miFlow(b.model, bagIndex, P, Q, b.doseG, b.doseDefaultG);
      const score = mt + mf;
      const tie = Math.abs((P + Q) / 2 - bayes);
      // X = the level closer to the last RPM (or the fixed one); Y = the other.
      let pair: [number, number] =
        Math.abs(P - b.lastRpm) <= Math.abs(Q - b.lastRpm) ? [P, Q] : [Q, P];
      if (b.fixedX !== undefined) pair = [b.fixedX, P === b.fixedX ? Q : P];
      const better =
        !best ||
        score > best.miTheta + best.miFlow + 1e-9 ||
        (Math.abs(score - (best.miTheta + best.miFlow)) <= 1e-9 &&
          (tie < best.tie - 1e-9 ||
            (Math.abs(tie - best.tie) <= 1e-9 && Math.min(P, Q) < Math.min(...best.pair))));
      if (better) best = { pair, miTheta: mt, miFlow: mf, tie };
    }
  }
  if (!best) return null;
  return { pair: best.pair, miTheta: best.miTheta, miFlow: best.miFlow };
}

// ---- the offer ----

export interface OfferFacts {
  model: FlowModelState;
  views: readonly ShotView[];
  /** Balanced flow at the shot's RPM, for "predicted in band". */
  balancedAt: (rpm: number) => number;
  setpointSd: number;
  ageDays: number;
  gateDays: number;
  runsThisEpoch: readonly RpmCalibrationRun[];
  now: string;
}

/** Why the calibration offer is not shown (null = show it). */
export function offerBlocker(f: OfferFacts): string | null {
  if (f.runsThisEpoch.some((r) => r.status === 'active')) return 'a calibration is running';
  const recent = f.runsThisEpoch.filter(
    (r) =>
      Date.parse(f.now) - Date.parse(r.updatedAt || r.startedAt) <
      RPM.offerDeclineDays * 86_400_000,
  );
  if (recent.length > 0) return 'a calibration was run or declined in the last 7 days';
  if (isCalibrated(f.model)) return 'RPM is already calibrated';
  const kgSd = Math.sqrt(Math.max(0, f.model.P[0]?.[0] ?? 1));
  if (kgSd > MODEL.kGrindSdConverged) return 'the grind gain is still being learned';
  const last3 = f.views.filter((v) => v.learn).slice(-3);
  const inBand = last3.filter(
    (v) =>
      v.predictedY !== null &&
      Math.abs(v.predictedY - f.balancedAt(v.shot.settings.grind.rpm)) <= RULES.beta,
  ).length;
  if (inBand < 2) return 'flow not yet settled (2 of the last 3 shots predicted in band)';
  if (f.setpointSd > RPM.offerMaxSetpointSd) return 'the taste setpoint is still uncertain';
  if (f.ageDays < f.gateDays) return 'the bean is still resting';
  return null;
}
