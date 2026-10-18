/**
 * Robust measurement update (Huber weights with asymmetric thresholds, Joseph form),
 * the two-skip escape hatch and the anchor-shot rule.
 *
 *   ν = y − H m;  S = H P Hᵀ + σ_y²/w0;  r = ν/√S
 *   (r1, r2) = (2, 4) for ν < 0, (1.5, 3) for ν > 0   — channeling only makes shots faster
 *   w = w0 · {1 | r1/|r| | 0 → skip}
 *   R = σ_y²/w;  K = P Hᵀ/(H P Hᵀ + R);  m += Kν;  P = (I−KH)P(I−KH)ᵀ + K R Kᵀ
 */
import { add, identity, matMul, outer, scale, sub, symmetrize, transpose } from '../math/linalg';
import { MODEL } from '../params';
import type { Id, StorageEventKind } from '../types';
import { predictBag } from './predict';
import { bagOf, type FlowModelState, IDX_KD, IDX_KG, IDX_KQ, IDX_KR } from './state';

export interface Observation {
  bagId: Id;
  shotId: Id;
  /** Absolute dial lines of the shot. */
  lines: number;
  rpm: number;
  doseG: number;
  /** ln(plateauFlow). */
  y: number;
  /** Base weight (channeling, freshness, low-info factors already applied). */
  w0: number;
  at: string;
  storageEvents?: StorageEventKind[];
}

export interface UpdateResult {
  accepted: boolean;
  r: number;
  w: number;
  innovation: number;
  reanchored: boolean;
  anchorShot: boolean;
}

export function rowFor(
  s: FlowModelState,
  bagIndex: number,
  lines: number,
  LrefB: number,
  rpm: number,
  doseG: number,
  doseDefaultG: number,
): number[] {
  const h = new Array<number>(s.m.length).fill(0);
  const u = (rpm - 1000) / 100;
  h[IDX_KG] = lines - LrefB;
  h[IDX_KR] = u;
  h[IDX_KQ] = u * u;
  h[IDX_KD] = doseG - doseDefaultG;
  h[bagIndex] = 1;
  return h;
}

/** Base weight w0 from the shot's quality signals (plan: robust update). */
export function baseWeight(f: {
  channelFlag: boolean;
  freshnessGate: boolean;
  lowInfo: boolean;
  earlyChannel: boolean;
}): number {
  let w = 1;
  if (f.channelFlag) w *= MODEL.wChannel;
  if (f.freshnessGate) w *= MODEL.wFreshness;
  if (f.lowInfo) w *= MODEL.wLowInfo;
  if (f.earlyChannel) w *= MODEL.wEarlyChannel;
  return w;
}

export function update(s: FlowModelState, obs: Observation): UpdateResult {
  const b = bagOf(s, obs.bagId);
  if (!b) throw new Error(`bag ${obs.bagId} not registered`);
  predictBag(s, b, obs.at, obs.storageEvents ?? []);
  const h = rowFor(s, b.index, obs.lines, b.LrefB, obs.rpm, obs.doseG, b.meta.doseDefaultG);
  const n = s.m.length;
  let hm = 0;
  for (let i = 0; i < n; i++) hm += (h[i] ?? 0) * (s.m[i] ?? 0);
  const nu = obs.y - hm;
  // P hᵀ
  const Ph = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += (s.P[i]?.[j] ?? 0) * (h[j] ?? 0);
    Ph[i] = acc;
  }
  let hPh = 0;
  for (let i = 0; i < n; i++) hPh += (h[i] ?? 0) * (Ph[i] ?? 0);
  const sigma2 = MODEL.sigmaY ** 2;
  const w0 = Math.max(1e-6, obs.w0);
  const S = hPh + sigma2 / w0;
  const r = nu / Math.sqrt(S);
  const anchorShot = b.anchorPending;
  let w = w0;
  let reanchored = false;
  if (!anchorShot) {
    const [r1, r2] = nu < 0 ? MODEL.huberNeg : MODEL.huberPos;
    const ar = Math.abs(r);
    if (ar > r2) {
      b.consecutiveSkips += 1;
      s.lastOutlier = { bagId: obs.bagId, r, shotId: obs.shotId };
      if (b.consecutiveSkips >= MODEL.reanchorSkips) {
        // Escape hatch: the model lost track of this bean; re-open its intercept.
        (s.P[b.index] as number[])[b.index] = Math.max(
          s.P[b.index]?.[b.index] ?? 0,
          MODEL.reanchorSd ** 2,
        );
        b.anchorPending = true;
        b.consecutiveSkips = 0;
        reanchored = true;
      }
      return { accepted: false, r, w: 0, innovation: nu, reanchored, anchorShot: false };
    }
    if (ar > r1) w = w0 * (r1 / ar);
  }
  const R = sigma2 / w;
  const denom = hPh + R;
  const K = Ph.map((v) => v / denom);
  for (let i = 0; i < n; i++) s.m[i] = (s.m[i] ?? 0) + (K[i] ?? 0) * nu;
  // Joseph form.
  const I = identity(n);
  const KH = outer(K, h);
  const IKH = sub(I, KH);
  const P1 = matMul(matMul(IKH, s.P), transpose(IKH));
  const KRK = scale(outer(K, K), R);
  s.P = symmetrize(add(P1, KRK));
  b.consecutiveSkips = 0;
  b.anchorPending = false;
  b.shotsSeen += 1;
  if (s.lastOutlier && s.lastOutlier.bagId === obs.bagId) s.lastOutlier = null;
  return { accepted: true, r, w, innovation: nu, reanchored: false, anchorShot };
}
