/**
 * Joint Gaussian state over the pooled gains and per-bag intercepts for one calibration
 * epoch: z = [k_g, k_r, k_d, a_b1 … a_bn]. Each bag has its own reference line L_ref,b
 * (its first learnable shot), so a bag's first observation lands on its intercept and
 * never on the pooled grind gain. Priors and process noise live in params.ts.
 */
import { extend, identity, type Mat, zeros } from '../math/linalg';
import { MODEL } from '../params';
import type { Id, Process, RoastLevel, RoastTarget } from '../types';

export const IDX_KG = 0;
export const IDX_KR = 1;
export const IDX_KD = 2;
export const N_SHARED = 3;

export interface BagMeta {
  roastLevel: RoastLevel;
  process: Process;
  decaf: boolean;
  roastTarget: RoastTarget;
  roastDate: string;
  doseDefaultG: number;
  recipe?: { yieldG?: number; timeS?: [number, number] } | undefined;
}

export interface BagState {
  bagId: Id;
  index: number;
  /** Reference line of this bag (line of its first learnable shot in the epoch). */
  LrefB: number;
  lastAt: string | null;
  consecutiveSkips: number;
  /** Next learnable shot is accepted with w = w0 regardless of its residual. */
  anchorPending: boolean;
  shotsSeen: number;
  frozen: boolean;
  meta: BagMeta;
}

export interface PooledBag {
  bagId: Id;
  /** Final intercept translated to the epoch anchor line. */
  aAtAnchor: number;
  shots: number;
  meta: BagMeta;
}

export interface FlowModelState {
  epochId: Id;
  /** Epoch anchor line: chirp line if known, else the epoch's first shot line. */
  LrefE: number | null;
  m: number[];
  P: Mat;
  bags: BagState[];
  /** Earlier bags (finished or from earlier epochs, transformed) used for pooling only. */
  pooled: PooledBag[];
  lastAt: string | null;
  lastOutlier: { bagId: Id; r: number; shotId: Id } | null;
}

export function initFlowModel(epochId: Id, LrefE: number | null = null): FlowModelState {
  return {
    epochId,
    LrefE,
    m: [MODEL.kGrindPrior.mean, MODEL.kRpmPrior.mean, MODEL.kDosePrior.mean],
    P: [
      [MODEL.kGrindPrior.sd ** 2, 0, 0],
      [0, MODEL.kRpmPrior.sd ** 2, 0],
      [0, 0, MODEL.kDosePrior.sd ** 2],
    ],
    bags: [],
    pooled: [],
    lastAt: null,
    lastOutlier: null,
  };
}

export function cloneState(s: FlowModelState): FlowModelState {
  return {
    ...s,
    m: [...s.m],
    P: s.P.map((r) => [...r]),
    bags: s.bags.map((b) => ({ ...b, meta: { ...b.meta } })),
    pooled: s.pooled.map((p) => ({ ...p })),
    lastOutlier: s.lastOutlier ? { ...s.lastOutlier } : null,
  };
}

/** ln plateau flow expected for a roast level at default dose/ratio: ln(Y/(t_mid − 8)) + 0.08. */
export function mu0Roast(roast: RoastLevel): number {
  const d = MODEL.roastDefaults[roast];
  const Y = MODEL.doseDefaultG * d.ratio;
  return Math.log(Y / (d.tMidS - MODEL.firstDripAssumedS)) + MODEL.plateauOffsetLn;
}

export function deltaMeta(meta: BagMeta): number {
  let d = 0;
  if (meta.roastLevel === 'light' || meta.roastLevel === 'medium_light') d += MODEL.deltaMeta.light;
  if (meta.roastLevel === 'dark' || meta.roastLevel === 'medium_dark') d += MODEL.deltaMeta.dark;
  if (meta.process === 'natural' || meta.process === 'honey' || meta.process === 'anaerobic') {
    d += MODEL.deltaMeta.naturalLike;
  }
  if (meta.decaf) d += MODEL.deltaMeta.decaf;
  if (meta.roastTarget === 'filter') d += MODEL.deltaMeta.filter;
  return d;
}

export function ageDays(meta: BagMeta, atIso: string): number {
  return Math.max(0, (Date.parse(atIso) - Date.parse(meta.roastDate)) / 86_400_000);
}

/** Feature row for the ridge regression: [light, dark, natural-like, decaf]. */
function metaFeatures(meta: BagMeta): number[] {
  return [
    meta.roastLevel === 'light' || meta.roastLevel === 'medium_light' ? 1 : 0,
    meta.roastLevel === 'dark' || meta.roastLevel === 'medium_dark' ? 1 : 0,
    meta.process === 'natural' || meta.process === 'honey' || meta.process === 'anaerobic' ? 1 : 0,
    meta.decaf ? 1 : 0,
  ];
}

/**
 * Once ≥ 4 bags with ≥ 3 learnable shots exist, replace δ_meta by a ridge regression (λ = 1)
 * of final intercepts on the metadata features. With identical features (this user's
 * mostly light/washed bags) the fit degenerates to the mean, which is intended.
 */
export function metaOffsetRidge(
  pooled: PooledBag[],
  meta: BagMeta,
): { offset: number; sd: number } | null {
  const rows = pooled.filter((p) => p.shots >= MODEL.ridgeMinShotsPerBag);
  if (rows.length < MODEL.ridgeMinBags) return null;
  const X = rows.map((r) => metaFeatures(r.meta));
  const yMean = rows.reduce((s, r) => s + r.aAtAnchor, 0) / rows.length;
  const y = rows.map((r) => r.aAtAnchor - yMean);
  const k = 4;
  // (XᵀX + λI) β = Xᵀy
  const A = zeros(k, k);
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const xi = X[i] ?? [];
    for (let p = 0; p < k; p++) {
      b[p] = (b[p] ?? 0) + (xi[p] ?? 0) * (y[i] ?? 0);
      for (let q = 0; q < k; q++)
        (A[p] as number[])[q] = (A[p]?.[q] ?? 0) + (xi[p] ?? 0) * (xi[q] ?? 0);
    }
  }
  for (let p = 0; p < k; p++) (A[p] as number[])[p] = (A[p]?.[p] ?? 0) + MODEL.ridgeLambda;
  const beta = solveSmall(A, b);
  let ss = 0;
  for (let i = 0; i < rows.length; i++) {
    const xi = X[i] ?? [];
    let pred = 0;
    for (let p = 0; p < k; p++) pred += (beta[p] ?? 0) * (xi[p] ?? 0);
    ss += ((y[i] ?? 0) - pred) ** 2;
  }
  const resid = Math.sqrt(ss / Math.max(1, rows.length - 1));
  const f = metaFeatures(meta);
  let offset = 0;
  for (let p = 0; p < k; p++) offset += (beta[p] ?? 0) * (f[p] ?? 0);
  return { offset, sd: Math.max(MODEL.ridgeMinSd, resid) };
}

function solveSmall(A: Mat, b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]?.[c] ?? 0) > Math.abs(M[p]?.[c] ?? 0)) p = r;
    const t = M[c] as number[];
    M[c] = M[p] as number[];
    M[p] = t;
    const pivot = M[c]?.[c] ?? 0;
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = (M[r]?.[c] ?? 0) / pivot;
      const Mr = M[r] as number[];
      const Mc = M[c] as number[];
      for (let k2 = c; k2 <= n; k2++) Mr[k2] = (Mr[k2] ?? 0) - f * (Mc[k2] ?? 0);
    }
  }
  return M.map((row, i) => ((row[i] ?? 0) === 0 ? 0 : (row[n] ?? 0) / (row[i] ?? 1)));
}

export function kGrind(s: FlowModelState): { mean: number; sd: number } {
  return { mean: s.m[IDX_KG] ?? 0, sd: Math.sqrt(Math.max(0, s.P[IDX_KG]?.[IDX_KG] ?? 0)) };
}

export function kRpm(s: FlowModelState): { mean: number; sd: number } {
  return { mean: s.m[IDX_KR] ?? 0, sd: Math.sqrt(Math.max(0, s.P[IDX_KR]?.[IDX_KR] ?? 0)) };
}

export function kDose(s: FlowModelState): { mean: number; sd: number } {
  return { mean: s.m[IDX_KD] ?? 0, sd: Math.sqrt(Math.max(0, s.P[IDX_KD]?.[IDX_KD] ?? 0)) };
}

export function bagOf(s: FlowModelState, bagId: Id): BagState | undefined {
  return s.bags.find((b) => b.bagId === bagId);
}

export function aBag(s: FlowModelState, bagId: Id): { mean: number; sd: number } | null {
  const b = bagOf(s, bagId);
  if (!b) return null;
  return { mean: s.m[b.index] ?? 0, sd: Math.sqrt(Math.max(0, s.P[b.index]?.[b.index] ?? 0)) };
}

/** Pooled intercept at the epoch anchor from the last three bags with shots. */
export function pooledIntercept(s: FlowModelState): number | null {
  const kg = kGrind(s).mean;
  const LrefE = s.LrefE;
  if (LrefE === null) return null;
  const candidates: { at: string; a: number }[] = [];
  for (const b of s.bags) {
    if (b.shotsSeen === 0) continue;
    const a = s.m[b.index] ?? 0;
    candidates.push({ at: b.lastAt ?? '', a: a + kg * (LrefE - b.LrefB) });
  }
  for (const p of s.pooled) candidates.push({ at: '', a: p.aAtAnchor });
  if (candidates.length === 0) return null;
  const last3 = candidates.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 3);
  return last3.reduce((acc, c) => acc + c.a, 0) / last3.length;
}

/**
 * Register a bag on its first learnable shot. Mutates and returns the state.
 * The first bag of an epoch gets N(μ0_roast, 0.5²); later bags a pooled, metadata-adjusted
 * prior whose variance is honest about the gain uncertainty over the distance to the anchor.
 */
export function addBag(
  s: FlowModelState,
  bagId: Id,
  meta: BagMeta,
  LrefB: number,
  atIso: string,
): BagState {
  const existing = bagOf(s, bagId);
  if (existing) return existing;
  if (s.LrefE === null) s.LrefE = LrefB;
  const pooled = pooledIntercept(s);
  const kgSd = kGrind(s).sd;
  let mean: number;
  let variance: number;
  if (pooled === null) {
    mean = mu0Roast(meta.roastLevel);
    variance = MODEL.aFirstSd ** 2;
  } else {
    const ridge = metaOffsetRidge(s.pooled, meta);
    const dMeta = ridge ? ridge.offset : deltaMeta(meta);
    const age = ageDays(meta, atIso);
    const drift = age <= MODEL.driftAgeSplitDays ? MODEL.driftYoung : MODEL.driftOld;
    mean =
      pooled +
      kGrind(s).mean * (LrefB - (s.LrefE ?? LrefB)) +
      dMeta +
      drift * (age - MODEL.refAgeDays);
    const base = ridge ? ridge.sd : MODEL.aLaterSd;
    variance = base ** 2 + kgSd ** 2 * (LrefB - (s.LrefE ?? LrefB)) ** 2;
  }
  const index = s.m.length;
  s.m.push(mean);
  s.P = extend(s.P, variance);
  const frozen = false;
  const bag: BagState = {
    bagId,
    index,
    LrefB,
    lastAt: atIso,
    consecutiveSkips: 0,
    anchorPending: false,
    shotsSeen: 0,
    frozen,
    meta,
  };
  s.bags.push(bag);
  return bag;
}

/** Diagonal helper for tests. */
export function diagOf(s: FlowModelState): number[] {
  return s.m.map((_, i) => s.P[i]?.[i] ?? 0);
}

export { identity };
