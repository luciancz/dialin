import { describe, expect, it } from 'vitest';
import { mulberry32, randn } from '../../src/core/math/rng';
import { replay } from '../../src/core/replay';
import { balanceSd, initBalance, sStarAt, updateBalance } from '../../src/core/rpm/balance';
import {
  beanPrior,
  betaMarginal,
  bodyLikelihood,
  initPreference,
  probImprove,
  summarizePreference,
  updateBody,
  updateRpmComparison,
} from '../../src/core/rpm/preference';
import {
  allowedRpmRange,
  clampRpm,
  e006Guidance,
  quantRpm,
  settingsRange,
  uOf,
} from '../../src/core/rpm/range';
import { summary } from '../../src/core/setpoint/grid';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Features,
  Rating,
  Shot,
  ShotQuality,
} from '../../src/core/types';
import { DEFAULT_DIAL_SPEC, fromLines } from '../../src/core/units';

const FULL: [number, number] = [500, 1600];

describe('preferred-RPM posterior', () => {
  it('starts normalised around 1000 RPM with a moderate body sensitivity', () => {
    const pr = initPreference();
    expect(pr.p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const s = summarizePreference(pr, FULL);
    // The grid runs 500–1600, so truncation lifts the prior mean slightly above 1000.
    expect(Math.abs(s.thetaMean - 1000)).toBeLessThan(25);
    expect(s.pInsensitive).toBeGreaterThan(0.2);
    expect(s.pInsensitive).toBeLessThan(0.6);
    expect(s.bayesRpm % 100).toBe(0);
    // The ordered probit sums to one over the seven slider values.
    let t = 0;
    for (let h = -3; h <= 3; h++) t += bodyLikelihood(h, 0.7);
    expect(t).toBeCloseTo(1, 9);
  });

  it('heavy at high RPM and thin at low RPM pull the preferred RPM between them', () => {
    let pr = initPreference();
    for (let i = 0; i < 3; i++) {
      pr = updateBody(pr, 1300, 2);
      pr = updateBody(pr, 700, -2);
    }
    const s = summarizePreference(pr, FULL);
    expect(s.thetaMean).toBeGreaterThan(850);
    expect(s.thetaMean).toBeLessThan(1150);
    expect(s.pInsensitive).toBeLessThan(0.2);
    expect(s.band[0]).toBeGreaterThan(500);
    expect(s.band[1]).toBeLessThan(1600);
    // Thin at 700 only: the preferred RPM moves up.
    let up = initPreference();
    for (let i = 0; i < 4; i++) up = updateBody(up, 700, -3);
    expect(summarizePreference(up, FULL).thetaMean).toBeGreaterThan(1000);
  });

  it('concludes "RPM barely changes body" when body reads the same everywhere', () => {
    let pr = initPreference();
    for (const rpm of [700, 1300, 1300, 700, 500, 1600, 1600, 500]) pr = updateBody(pr, rpm, 0);
    const s = summarizePreference(pr, FULL);
    expect(s.pInsensitive).toBeGreaterThan(0.6);
    expect(s.band[1] - s.band[0]).toBeGreaterThanOrEqual(600);
  });

  it('matched-flow comparisons in ABBA order move θ toward the better level and cancel order bias', () => {
    let pr = initPreference();
    // L=700 H=1300: H judged better than L, H vs H same, L judged worse than H.
    pr = updateRpmComparison(pr, 700, 1300, 'better');
    pr = updateRpmComparison(pr, 1300, 1300, 'same');
    pr = updateRpmComparison(pr, 1300, 700, 'worse');
    const s = summarizePreference(pr, FULL);
    expect(s.thetaMean).toBeGreaterThan(1050);
    expect(probImprove(pr, 700, 1300)).toBeGreaterThan(0.5);
    // Bias marginal stays symmetric: index order is [−0.25, 0, 0.25].
    const nB = pr.betas.length;
    const nO = pr.biases.length;
    const bias = [0, 0, 0];
    for (let i = 0; i < pr.p.length; i++) bias[i % nO] = (bias[i % nO] ?? 0) + (pr.p[i] ?? 0);
    expect(Math.abs((bias[0] ?? 0) - (bias[2] ?? 0))).toBeLessThan(0.05);
    expect(nB).toBe(9);
    expect(betaMarginal(pr).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('a new bean starts from earlier beans (same roast weighted higher)', () => {
    let earlier = initPreference();
    for (let i = 0; i < 6; i++) {
      earlier = updateBody(earlier, 1200, 2);
      earlier = updateBody(earlier, 600, -1);
    }
    const thetaEarlier = summarizePreference(earlier, FULL).thetaMean;
    const prior = beanPrior([{ pref: earlier, roastWeight: 1, recency: 1 }]);
    const s = summarizePreference(prior, FULL);
    expect(Math.abs(s.thetaMean - thetaEarlier)).toBeLessThan(Math.abs(1000 - thetaEarlier));
    expect(prior.ratings).toBe(0);
    // Fewer than 3 informative ratings: population prior.
    const thin = updateBody(initPreference(), 1500, 3);
    expect(
      summarizePreference(beanPrior([{ pref: thin, roastWeight: 1, recency: 1 }]), FULL).thetaMean,
    ).toBeCloseTo(1013, -1);
  });
});

describe('balance shift δ', () => {
  it('recovers δ from matched sour–bitter pairs and ignores small RPM differences', () => {
    const rng = mulberry32(2);
    const delta = 0.03;
    const sStar = 0.6;
    let b = initBalance();
    for (let i = 0; i < 30; i++) {
      const uI = -3;
      const uJ = 3;
      const yI = sStar + 0.05 * randn(rng);
      const yJ = sStar + 0.05 * randn(rng);
      // Convention: v ≈ 12·(s*(u) − y), positive = bitter.
      const vI = Math.round(12 * (sStar + delta * uI - yI) + randn(rng));
      const vJ = Math.round(12 * (sStar + delta * uJ - yJ) + randn(rng));
      b = updateBalance(b, { uI, uJ, vI, vJ, yI, yJ });
    }
    expect(Math.abs(b.mean - delta)).toBeLessThan(0.01);
    expect(balanceSd(b)).toBeLessThan(0.01);
    expect(sStarAt(0.6, b, 2)).toBeCloseTo(0.6 + 2 * b.mean, 12);
    const same = updateBalance(initBalance(), { uI: 0, uJ: 0.5, vI: 2, vJ: -2, yI: 0.6, yJ: 0.6 });
    expect(same.n).toBe(0);
  });
});

// ---- replay routing ----

const dial = fromLines(180, DEFAULT_DIAL_SPEC);
const epoch: CalibrationEpoch = {
  id: 'e1',
  createdAt: 'x',
  updatedAt: 'x',
  deviceId: 'd',
  startedAt: '2026-09-01T00:00:00.000Z',
  kind: 'initial',
  dialSpec: DEFAULT_DIAL_SPEC,
  burrSet: 'stock',
  washerCount: 0,
  springSet: 'stock',
};
const bean: Bean = {
  id: 'bean',
  createdAt: 'x',
  updatedAt: 'x',
  deviceId: 'd',
  roaster: 'R',
  name: 'N',
  roastLevel: 'light',
  roastTarget: 'espresso',
  process: 'washed',
  decaf: false,
};
const bag: Bag = {
  id: 'bag',
  createdAt: 'x',
  updatedAt: 'x',
  deviceId: 'd',
  beanId: 'bean',
  roastDate: '2026-09-20',
  doseDefaultG: 18,
  targetYieldG: 40,
  storage: [],
  rpm: 1000,
  tsSeed: 1,
  archived: false,
};
function feat(plateau: number): Features {
  return {
    firstDripS: 8,
    t50S: 20,
    plateauFlow: plateau,
    meanFlow: plateau,
    lateSlopeRel: 0,
    maxJump1s: 0.1,
    dipCount: 0,
    tailMassG: 1,
    totalTimeS: 30,
    finalYieldG: 40,
    plateauDurS: 10,
    curveChannelScore: 0,
    flags: [],
    valid: true,
    invalidReasons: [],
  };
}
function mkShot(i: number, rpm: number, plateau: number): Shot {
  return {
    id: `s${i}`,
    createdAt: 'x',
    updatedAt: 'x',
    deviceId: 'd',
    bagId: 'bag',
    epochId: 'e1',
    at: new Date(Date.UTC(2026, 9, 1, 9, i * 10)).toISOString(),
    settings: {
      grind: { dialPos: dial, rpm, rpmConfirmed: true },
      doseG: 18,
      targetYieldG: 40,
      tempSwitch: 1,
    },
    context: { shotIndexOfDay: i + 1, appVersion: 't' },
    features: feat(plateau),
    endedBy: 'tap',
    recommendationId: null,
    deviation: null,
  };
}
function mkRating(
  shotId: string,
  cmp: string | null,
  vs: Rating['vsPrevious'],
  v: number | null,
  h: number | null,
): Rating {
  return {
    id: `r-${shotId}`,
    createdAt: 'x',
    updatedAt: 'x',
    deviceId: 'd',
    shotId,
    comparedToShotId: cmp,
    vsPrevious: vs,
    sourBitter: v as Rating['sourBitter'],
    thinHeavy: h as Rating['thinHeavy'],
    chips: [],
    drink: 'black',
  };
}
const q = (shotId: string): ShotQuality => ({
  id: `q-${shotId}`,
  createdAt: 'x',
  updatedAt: 'x',
  deviceId: 'd',
  shotId,
  status: 'ok',
  learn: true,
  notes: [],
});

describe('replay routing', () => {
  it('a cross-RPM matched-flow comparison feeds the RPM preference, never the flow setpoint', () => {
    const shots = [mkShot(0, 700, 1.9), mkShot(1, 1300, 1.92)];
    const base = {
      epochs: [epoch],
      beans: [bean],
      bags: [bag],
      shots,
      quality: shots.map((s) => q(s.id)),
      recommendations: [],
    };
    const withCmp = replay({ ...base, ratings: [mkRating('s1', 's0', 'better', null, null)] });
    const without = replay({ ...base, ratings: [mkRating('s1', 's0', null, null, null)] });
    const spA = summary(withCmp.bags.get('bag')?.setpoint ?? initSp());
    const spB = summary(without.bags.get('bag')?.setpoint ?? initSp());
    expect(spA.mean).toBeCloseTo(spB.mean, 12);
    expect(spA.sd).toBeCloseTo(spB.sd, 12);
    expect(withCmp.prefByBean.get('bean')?.ratings).toBe(1);
    expect(without.prefByBean.get('bean')?.ratings).toBe(0);
  });

  it('a same-RPM comparison feeds the setpoint, not the RPM preference', () => {
    const shots = [mkShot(0, 1000, 1.7), mkShot(1, 1000, 2.1)];
    const res = replay({
      epochs: [epoch],
      beans: [bean],
      bags: [bag],
      shots,
      quality: shots.map((s) => q(s.id)),
      ratings: [mkRating('s1', 's0', 'better', null, null)],
      recommendations: [],
    });
    expect(res.prefByBean.get('bean')?.ratings).toBe(0);
    expect(summary(res.bags.get('bag')?.setpoint ?? initSp()).mean).toBeGreaterThan(0.6);
  });

  it('an RPM change alone does not widen the taste setpoint', () => {
    const rated = [mkShot(0, 1000, 1.9), mkShot(1, 1000, 1.9)];
    const ratings = [mkRating('s0', null, null, -1, null), mkRating('s1', 's0', null, 1, null)];
    const run = (rpm2: number) =>
      replay({
        epochs: [epoch],
        beans: [bean],
        bags: [bag],
        shots: [...rated, mkShot(2, rpm2, 1.9)],
        quality: [...rated, mkShot(2, rpm2, 1.9)].map((s) => q(s.id)),
        ratings,
        recommendations: [],
      });
    const a = summary(run(1000).bags.get('bag')?.setpoint ?? initSp());
    const b = summary(run(1400).bags.get('bag')?.setpoint ?? initSp());
    expect(b.sd).toBeCloseTo(a.sd, 12);
  });

  it('thin–heavy ratings reach the preference and sour–bitter pairs across RPMs reach δ', () => {
    const shots = [
      mkShot(0, 700, 1.9),
      mkShot(1, 1300, 1.9),
      mkShot(2, 1300, 1.9),
      mkShot(3, 700, 1.9),
    ];
    const ratings = [
      mkRating('s0', null, null, -2, -2),
      mkRating('s1', 's0', 'same', 2, 2),
      mkRating('s2', 's1', 'same', 2, 2),
      mkRating('s3', 's2', 'same', -2, -2),
    ];
    const res = replay({
      epochs: [epoch],
      beans: [bean],
      bags: [bag],
      shots,
      quality: shots.map((s) => q(s.id)),
      ratings,
      recommendations: [],
    });
    const pr = res.prefByBean.get('bean');
    expect(pr?.ratings).toBeGreaterThanOrEqual(4);
    // At matched flow, high RPM tasted more bitter: the balanced flow is higher at high RPM.
    expect(res.balance.n).toBe(2);
    expect(res.balance.mean).toBeGreaterThan(0);
    const views = res.bags.get('bag')?.views ?? [];
    expect(views[1]?.u).toBe(3);
    expect(views[1]?.yRef).not.toBeNull();
  });
});

function initSp() {
  return replay({
    epochs: [epoch],
    beans: [bean],
    bags: [bag],
    shots: [mkShot(0, 1000, 1.9)],
    quality: [q('s0')],
    ratings: [],
    recommendations: [],
  }).bags.get('bag')?.setpoint as NonNullable<
    ReturnType<typeof replay>['bags'] extends Map<string, infer B> ? B : never
  >['setpoint'];
}

describe('RPM range and E006', () => {
  it('quantises to the VS6 100 RPM step and clamps to the range', () => {
    expect(quantRpm(1249)).toBe(1200);
    expect(quantRpm(1250)).toBe(1300);
    expect(clampRpm(450, [500, 1600])).toBe(500);
    expect(clampRpm(1720, [500, 1600])).toBe(1600);
    expect(uOf(1300)).toBe(3);
  });

  it('sanitises the settings range to the hardware limits', () => {
    expect(settingsRange(undefined)).toEqual([500, 1600]);
    expect(settingsRange([400, 2000])).toEqual([500, 1600]);
    expect(settingsRange([740, 1260])).toEqual([700, 1300]);
    expect(settingsRange([1400, 800])).toEqual([500, 1600]);
  });

  it('raises the floor above reported stalls for that bean', () => {
    expect(allowedRpmRange([500, 1600], [])).toEqual([500, 1600]);
    expect(
      allowedRpmRange([500, 1600], [{ stalls: [{ at: 'x', rpm: 600 }] }, { stalls: [] }]),
    ).toEqual([700, 1600]);
    expect(allowedRpmRange([500, 1000], [{ stalls: [{ at: 'x', rpm: 1100 }] }])).toEqual([
      1000, 1000,
    ]);
  });

  it('gives E006 guidance at 600 RPM and below only', () => {
    expect(e006Guidance(600).length).toBeGreaterThan(0);
    expect(e006Guidance(500)[0]).toMatch(/start the motor/);
    expect(e006Guidance(700)).toEqual([]);
  });
});
