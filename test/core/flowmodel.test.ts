import { describe, expect, it } from 'vitest';
import { applyEpochEvent } from '../../src/core/flowmodel/epoch';
import { invert, predictAt } from '../../src/core/flowmodel/invert';
import {
  aBag,
  addBag,
  type BagMeta,
  cloneState,
  diagOf,
  IDX_KQ,
  initFlowModel,
  kDose,
  kGrind,
  kRpm,
  kRpmCurv,
  metaOffsetRidge,
  mu0Roast,
  N_SHARED,
  rpmEffect,
  rpmSlope,
} from '../../src/core/flowmodel/state';
import { type Observation, update } from '../../src/core/flowmodel/update';
import { isPsd, solve } from '../../src/core/math/linalg';
import { mulberry32, randn } from '../../src/core/math/rng';
import { MODEL } from '../../src/core/params';
import { DEFAULT_DIAL_SPEC } from '../../src/core/units';

const meta: BagMeta = {
  roastLevel: 'light',
  process: 'washed',
  decaf: false,
  roastTarget: 'espresso',
  roastDate: '2026-09-20',
  doseDefaultG: 18,
};

function day(n: number): string {
  return new Date(Date.UTC(2026, 9, 1 + n, 9)).toISOString();
}

function obs(over: Partial<Observation> & { y: number; lines: number }): Observation {
  return {
    bagId: 'bag1',
    shotId: `s${Math.random()}`,
    rpm: 1000,
    doseG: 18,
    w0: 1,
    at: day(0),
    ...over,
  };
}

describe('flow model: RPM slope and curvature', () => {
  it('has four shared elements; the first bag sits at index 4', () => {
    const s = initFlowModel('e1');
    expect(N_SHARED).toBe(4);
    expect(s.m.length).toBe(4);
    expect(kRpm(s).mean).toBeCloseTo(MODEL.kRpmPrior.mean, 12);
    expect(kRpmCurv(s).sd).toBeCloseTo(MODEL.kRpmCurvPrior.sd, 12);
    const b = addBag(s, 'bag1', meta, 250, day(0));
    expect(b.index).toBe(4);
  });

  it('recovers k_r from a fixed-dial L H H L design (700/1300 RPM)', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 6; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    const kr = -0.03;
    const rng = mulberry32(5);
    for (const rpm of [700, 1300, 1300, 700, 700, 1300, 1300, 700]) {
      const u = (rpm - 1000) / 100;
      update(s, obs({ lines: 250, rpm, y: 0.6 + kr * u + 0.02 * randn(rng) }));
    }
    expect(kRpm(s).mean).toBeCloseTo(kr, 2);
    expect(kRpm(s).sd).toBeLessThan(0.01);
    // Symmetric levels keep the curvature near its prior: the slope estimate is not biased by it.
    expect(Math.abs(kRpmCurv(s).mean)).toBeLessThan(0.005);
  });

  it('identifies curvature with a third level and predicts the RPM effect with its sd', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 6; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    const kr = -0.02;
    const kq = -0.004;
    for (const rpm of [700, 1300, 1000, 1000, 1300, 700, 1600, 1600, 500, 500]) {
      const u = (rpm - 1000) / 100;
      update(s, obs({ lines: 250, rpm, y: 0.6 + kr * u + kq * u * u }));
    }
    expect(kRpmCurv(s).mean).toBeLessThan(-0.002);
    const eff = rpmEffect(s, 5);
    expect(eff.mean).toBeCloseTo(kr * 5 + kq * 25, 1);
    expect(eff.sd).toBeGreaterThan(0);
    const slope = rpmSlope(s, 3);
    expect(slope.mean).toBeCloseTo(kRpm(s).mean + 2 * kRpmCurv(s).mean * 3, 10);
  });

  it('invert includes k_r·u + κ·u², so predictAt at the inverted dial hits the target', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 6; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    s.m[1] = -0.03;
    s.m[IDX_KQ] = -0.003;
    const target = 0.62;
    for (const rpm of [600, 1000, 1400]) {
      const inv = invert(s, 'bag1', target, rpm, 18, 250, DEFAULT_DIAL_SPEC, null);
      const atRaw = predictAt(s, 'bag1', inv?.raw ?? 0, rpm, 18);
      expect(atRaw?.yHat ?? 0).toBeCloseTo(target, 6);
      expect(inv?.clamped).toBeNull();
    }
    const low = invert(s, 'bag1', -2, 1000, 18, 250, DEFAULT_DIAL_SPEC, 248);
    expect(low?.clamped).toBe('chirp');
  });

  it('new burrs reset k_g, k_r and κ but keep k_d', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (const rpm of [700, 1300, 1000, 1600])
      update(s, obs({ lines: 250, rpm, doseG: 19, y: 0.5 }));
    const kd = kDose(s).mean;
    const s2 = applyEpochEvent(s, {
      newEpochId: 'e2',
      kind: 'new_burrs',
      oldSpec: DEFAULT_DIAL_SPEC,
      newSpec: DEFAULT_DIAL_SPEC,
    });
    expect(kRpm(s2).mean).toBeCloseTo(MODEL.kRpmPrior.mean, 12);
    expect(kRpm(s2).sd).toBeCloseTo(MODEL.kRpmPrior.sd, 12);
    expect(kRpmCurv(s2).mean).toBeCloseTo(0, 12);
    expect(kRpmCurv(s2).sd).toBeCloseTo(MODEL.kRpmCurvPrior.sd, 12);
    expect(kDose(s2).mean).toBeCloseTo(kd, 12);
    expect(isPsd(s2.P)).toBe(true);
  });
});

describe('flow model', () => {
  it('first-bag prior is ln(Y/(t_mid−8)) + 0.08 (light ≈ 0.65)', () => {
    expect(mu0Roast('light')).toBeCloseTo(Math.log(41.4 / 23.5) + 0.08, 6);
    expect(mu0Roast('light')).toBeCloseTo(0.65, 1);
  });

  it('recovers a noiseless single bag exactly', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    const kg = 0.05;
    const a = 0.6;
    for (let i = 0; i < 8; i++) {
      const lines = 250 + ([0, 5, 10, -5, 15, 3, 8, -3][i] ?? 0);
      update(s, obs({ lines, y: a + kg * (lines - 250), at: day(0) }));
    }
    expect(kGrind(s).mean).toBeCloseTo(kg, 2);
    expect(aBag(s, 'bag1')?.mean ?? 0).toBeCloseTo(a, 2);
    expect(kGrind(s).sd).toBeLessThan(0.012);
  });

  it('equals closed-form Bayesian regression on 5 points at one time', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    const pts: [number, number][] = [
      [250, 0.62],
      [255, 0.88],
      [245, 0.4],
      [260, 1.1],
      [252, 0.7],
    ];
    for (const [L, y] of pts) update(s, obs({ lines: L, y, at: day(0) }));
    // Closed form on (k_g, a): prior N(m0, P0), likelihood N(y | H z, σ²).
    const P0inv = [
      [1 / MODEL.kGrindPrior.sd ** 2, 0],
      [0, 1 / MODEL.aFirstSd ** 2],
    ];
    const m0 = [MODEL.kGrindPrior.mean, mu0Roast('light')];
    const A = P0inv.map((r) => [...r]);
    const b = [(P0inv[0]?.[0] ?? 0) * (m0[0] ?? 0), (P0inv[1]?.[1] ?? 0) * (m0[1] ?? 0)];
    const s2 = MODEL.sigmaY ** 2;
    for (const [L, y] of pts) {
      const h = [L - 250, 1];
      for (let i = 0; i < 2; i++) {
        b[i] = (b[i] ?? 0) + ((h[i] ?? 0) * y) / s2;
        for (let j = 0; j < 2; j++)
          (A[i] as number[])[j] = (A[i]?.[j] ?? 0) + ((h[i] ?? 0) * (h[j] ?? 0)) / s2;
      }
    }
    const z = solve(A, b);
    expect(kGrind(s).mean).toBeCloseTo(z[0] ?? 0, 6);
    expect(aBag(s, 'bag1')?.mean ?? 0).toBeCloseTo(z[1] ?? 0, 6);
    // Posterior covariance = A⁻¹.
    const det = (A[0]?.[0] ?? 0) * (A[1]?.[1] ?? 0) - (A[0]?.[1] ?? 0) * (A[1]?.[0] ?? 0);
    expect(kGrind(s).sd ** 2).toBeCloseTo((A[1]?.[1] ?? 0) / det, 8);
  });

  it('keeps P symmetric and PSD over 1000 noisy updates (Joseph form)', () => {
    const s = initFlowModel('e1');
    const rng = mulberry32(3);
    addBag(s, 'bag1', meta, 250, day(0));
    addBag(s, 'bag2', { ...meta, roastDate: '2026-09-25' }, 262, day(0));
    for (let i = 0; i < 1000; i++) {
      const bagId = i % 2 ? 'bag2' : 'bag1';
      const L = 250 + Math.round(randn(rng) * 8);
      update(
        s,
        obs({ bagId, lines: L, y: 0.6 + 0.05 * (L - 250) + 0.07 * randn(rng), at: day(i % 30) }),
      );
    }
    const n = s.m.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) expect(s.P[i]?.[j]).toBeCloseTo(s.P[j]?.[i] ?? 0, 12);
    expect(isPsd(s.P)).toBe(true);
    for (const v of diagOf(s)) expect(v).toBeGreaterThan(0);
  });

  it('skips an r = 6 outlier, re-anchors on the second consecutive skip and accepts the third', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 6; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    const sdBefore = aBag(s, 'bag1')?.sd ?? 0;
    const r1 = update(
      s,
      obs({ lines: 250, y: 0.6 + 6 * Math.sqrt(sdBefore ** 2 + MODEL.sigmaY ** 2) + 0.3 }),
    );
    expect(r1.accepted).toBe(false);
    expect(Math.abs(r1.r)).toBeGreaterThan(3);
    expect(s.lastOutlier?.bagId).toBe('bag1');
    const r2 = update(s, obs({ lines: 250, y: 1.6 }));
    expect(r2.accepted).toBe(false);
    expect(r2.reanchored).toBe(true);
    expect(aBag(s, 'bag1')?.sd ?? 0).toBeCloseTo(0.5, 6);
    const r3 = update(s, obs({ lines: 250, y: 1.6 }));
    expect(r3.accepted).toBe(true);
    expect(r3.anchorShot).toBe(true);
    expect(aBag(s, 'bag1')?.mean ?? 0).toBeGreaterThan(1.3);
    expect(s.lastOutlier).toBeNull();
  });

  it('uses asymmetric thresholds: fast shots are downweighted sooner', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 6; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    const sd = Math.sqrt((aBag(s, 'bag1')?.sd ?? 0) ** 2 + MODEL.sigmaY ** 2);
    const sFast = cloneState(s);
    const sSlow = cloneState(s);
    // r = 1.8: beyond the fast-side knee (1.5) but inside the slow-side knee (2).
    const fast = update(sFast, obs({ lines: 250, y: 0.6 + 1.8 * sd }));
    const slow = update(sSlow, obs({ lines: 250, y: 0.6 - 1.8 * sd }));
    expect(fast.w).toBeLessThan(1);
    expect(slow.w).toBeCloseTo(1, 6);
  });

  it('washer_change keeps the gains and shifts the intercepts by −k_g·20·Δwashers', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 6; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    const kg = kGrind(s).mean;
    const a0 = aBag(s, 'bag1')?.mean ?? 0;
    const s2 = applyEpochEvent(s, {
      newEpochId: 'e2',
      kind: 'washer_change',
      oldSpec: DEFAULT_DIAL_SPEC,
      newSpec: DEFAULT_DIAL_SPEC,
      deltaWashers: 1,
    });
    expect(kGrind(s2).mean).toBeCloseTo(kg, 12);
    expect(aBag(s2, 'bag1')?.mean ?? 0).toBeCloseTo(a0 - kg * 20, 10);
    expect(aBag(s2, 'bag1')?.sd ?? 0).toBeCloseTo(0.5, 10);
    expect(s2.bags[0]?.anchorPending).toBe(true);
    // The anchor shot is accepted regardless of residual.
    const r = update(s2, obs({ lines: 250, y: a0 - kg * 20 + 0.6 }));
    expect(r.accepted).toBe(true);
    expect(r.anchorShot).toBe(true);
    // cleaning keeps the mean, variance 0.25²; new_burrs resets the gains.
    const s3 = applyEpochEvent(s, {
      newEpochId: 'e3',
      kind: 'cleaning',
      oldSpec: DEFAULT_DIAL_SPEC,
      newSpec: DEFAULT_DIAL_SPEC,
    });
    expect(aBag(s3, 'bag1')?.mean ?? 0).toBeCloseTo(a0, 12);
    expect(aBag(s3, 'bag1')?.sd ?? 0).toBeCloseTo(0.25, 12);
    const s4 = applyEpochEvent(s, {
      newEpochId: 'e4',
      kind: 'new_burrs',
      oldSpec: DEFAULT_DIAL_SPEC,
      newSpec: DEFAULT_DIAL_SPEC,
    });
    expect(kGrind(s4).mean).toBeCloseTo(MODEL.kGrindPrior.mean, 12);
    expect(kGrind(s4).sd).toBeCloseTo(MODEL.kGrindPrior.sd, 12);
    expect(kDose(s4).mean).toBeCloseTo(kDose(s).mean, 12);
    // dial_recount converts reference lines through the new spec.
    const s5 = applyEpochEvent(s, {
      newEpochId: 'e5',
      kind: 'dial_recount',
      oldSpec: DEFAULT_DIAL_SPEC,
      newSpec: { ...DEFAULT_DIAL_SPEC, linesPerNumber: 5 },
    });
    expect(s5.bags[0]?.LrefB).toBe(125);
  });

  it('keeps both intercepts when two bags alternate, and a new bag leaves k_g unchanged', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 5; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    const kgBefore = kGrind(s).mean;
    addBag(s, 'bag2', { ...meta, roastDate: '2026-09-28' }, 262, day(0));
    const prior2 = aBag(s, 'bag2');
    expect(prior2).not.toBeNull();
    // Pooled prior: a1 + k_g·(262 − 250) + δ_meta(light) ≈ 0.6 + 0.6 + 0.1
    expect(prior2?.mean ?? 0).toBeCloseTo(
      0.6 + kgBefore * 12 + 0.1 + MODEL.driftYoung * (ageDaysOf('2026-09-28', day(0)) - 14),
      1,
    );
    update(s, obs({ bagId: 'bag2', lines: 262, y: 1.5 }));
    expect(kGrind(s).mean).toBeCloseTo(kgBefore, 10);
    for (let i = 0; i < 6; i++) {
      update(
        s,
        obs({
          bagId: i % 2 ? 'bag2' : 'bag1',
          lines: 250 + 12 * (i % 2) + (i % 3) * 4,
          y: (i % 2 ? 1.5 : 0.6) + 0.05 * ((i % 3) * 4),
        }),
      );
    }
    expect(aBag(s, 'bag1')?.mean ?? 0).toBeCloseTo(0.6, 1);
    expect(aBag(s, 'bag2')?.mean ?? 0).toBeCloseTo(1.5, 1);
  });

  it('absorbs a dose change in k_d rather than the intercept', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 6; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    const a0 = aBag(s, 'bag1')?.mean ?? 0;
    for (let i = 0; i < 4; i++) update(s, obs({ lines: 250, doseG: 19, y: 0.6 - 0.08 }));
    expect(kDose(s).mean).toBeLessThan(-0.06);
    expect(Math.abs((aBag(s, 'bag1')?.mean ?? 0) - a0)).toBeLessThan(0.03);
  });

  it('drifts the intercept with bean age and inflates its variance between days', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    update(s, obs({ lines: 250, y: 0.6, at: day(0) }));
    const a0 = aBag(s, 'bag1')?.mean ?? 0;
    const v0 = (aBag(s, 'bag1')?.sd ?? 0) ** 2;
    // predict is applied inside update; use a tiny-weight observation to read the predicted state
    // Five days later the bean is 16 days old: young drift, mid-age process noise.
    update(s, obs({ lines: 250, y: 0.6, at: day(5), w0: 1e-6 }));
    expect((aBag(s, 'bag1')?.mean ?? 0) - a0).toBeCloseTo(MODEL.driftYoung * 5, 3);
    expect((aBag(s, 'bag1')?.sd ?? 0) ** 2 - v0).toBeCloseTo(MODEL.qMid ** 2 * 5, 3);
  });

  it('predicts and inverts with the step clamps and chirp floor', () => {
    const s = initFlowModel('e1');
    addBag(s, 'bag1', meta, 250, day(0));
    for (let i = 0; i < 6; i++)
      update(s, obs({ lines: 250 + (i % 3) * 5, y: 0.6 + 0.05 * ((i % 3) * 5) }));
    const p = predictAt(s, 'bag1', 260, 1000, 18);
    expect(p?.yHat ?? 0).toBeCloseTo(1.1, 1);
    expect(p?.sPred ?? 0).toBeGreaterThan(p?.sP ?? 0);
    const inv = invert(s, 'bag1', 0.6 + 0.05 * 7, 1000, 18, 250, DEFAULT_DIAL_SPEC, null);
    expect(inv?.lines).toBe(257);
    const big = invert(s, 'bag1', 0.6 + 0.05 * 40, 1000, 18, 250, DEFAULT_DIAL_SPEC, null);
    expect(big?.deltaLines).toBeLessThanOrEqual(10);
    expect(big?.vetoes.join(' ')).toMatch(/clamped/);
    const floor = invert(s, 'bag1', -1, 1000, 18, 250, DEFAULT_DIAL_SPEC, 248);
    expect(floor?.lines).toBe(253);
  });

  it('ridge regression degenerates to the mean for identical metadata', () => {
    const pooled = Array.from({ length: 5 }, (_, i) => ({
      bagId: `b${i}`,
      aAtAnchor: 0.6 + 0.05 * i,
      shots: 4,
      meta,
    }));
    const r = metaOffsetRidge(pooled, meta);
    expect(r).not.toBeNull();
    expect(Math.abs(r?.offset ?? 1)).toBeLessThan(1e-9);
    expect(r?.sd ?? 0).toBeGreaterThanOrEqual(0.15);
    const dark = metaOffsetRidge(pooled, { ...meta, roastLevel: 'dark' });
    expect(Math.abs(dark?.offset ?? 1)).toBeLessThan(1e-9);
  });
});

function ageDaysOf(roastDate: string, at: string): number {
  return (Date.parse(at) - Date.parse(roastDate)) / 86_400_000;
}
