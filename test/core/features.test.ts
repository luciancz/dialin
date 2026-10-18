import { describe, expect, it } from 'vitest';
import { computeFeatures } from '../../src/core/curve/features';
import { resample } from '../../src/core/curve/resample';
import { mulberry32 } from '../../src/core/math/rng';
import { type CurveSpec, synthCurve } from '../../src/core/sim/curveSynth';

function featuresOf(spec: CurveSpec, seed = 1, firstDripKnown = true) {
  const c = synthCurve(spec, mulberry32(seed));
  const samples = c.t.map((t, i) => ({ t, g: c.g[i] ?? 0 }));
  const grid = resample(samples, c.endAt + 6);
  const f = computeFeatures({
    t: grid.t,
    g: grid.g,
    mask: grid.mask,
    endAt: c.endAt,
    finalYieldG: c.finalYieldG,
    firstDripKnown,
    roastLevel: 'light',
  });
  return { f, c };
}

const base: CurveSpec = {
  firstDripS: 8,
  plateauGps: 1.9,
  rampS: 3,
  lateRise: 0,
  stopAtG: 36,
  tailG: 1.2,
  tailS: 4.5,
  noiseG: 0.05,
  truncG: 0.1,
};

describe('computeFeatures on synthetic curves', () => {
  it('recovers first drip, plateau flow (±1 %), tail and end time', () => {
    const { f, c } = featuresOf(base);
    expect(f.valid).toBe(true);
    expect(f.firstDripS).not.toBeNull();
    // The detector needs 0.5 g and 0.2 g/s for 5 samples, so it lags the true onset by < 2 s.
    expect(f.firstDripS ?? 0).toBeGreaterThanOrEqual(8);
    expect(f.firstDripS ?? 0).toBeLessThan(10);
    expect(f.plateauFlow).not.toBeNull();
    expect(Math.abs((f.plateauFlow ?? 0) / 1.9 - 1)).toBeLessThan(0.01);
    expect(f.tailMassG).toBeGreaterThan(0.8);
    expect(f.tailMassG).toBeLessThan(1.5);
    expect(f.totalTimeS).toBeCloseTo(c.endAt, 6);
    expect(f.finalYieldG).toBeCloseTo(c.finalYieldG, 6);
    expect(f.flags).not.toContain('spike');
    expect(f.flags).not.toContain('noisy');
    expect(f.curveChannelScore).toBe(0);
    expect(f.t50S).not.toBeNull();
    expect(f.meanFlow).not.toBeNull();
  });

  it('flags a +0.9 g/s spike of 1.5 s and scores ≥ 0.5', () => {
    const { f } = featuresOf({ ...base, spike: { atS: 18, gps: 0.9, durS: 1.5 } });
    expect(f.flags).toContain('spike');
    expect(f.maxJump1s ?? 0).toBeGreaterThan(0.7);
    expect(f.curveChannelScore).toBeGreaterThanOrEqual(0.5);
  });

  it('counts dips and flags blond rise', () => {
    const { f } = featuresOf({
      ...base,
      dips: [
        { atS: 16, depth: 0.6, durS: 1.0 },
        { atS: 21, depth: 0.6, durS: 1.0 },
      ],
    });
    expect(f.dipCount).toBeGreaterThanOrEqual(2);
    expect(f.flags).toContain('dip');
    const rise = featuresOf({ ...base, lateRise: 3 });
    expect(Math.abs(featuresOf(base).f.lateSlopeRel ?? 0)).toBeLessThan(0.1);
    expect(rise.f.lateSlopeRel ?? 0).toBeGreaterThan(0.15);
  });

  it('marks early and late drips', () => {
    expect(featuresOf({ ...base, firstDripS: 2 }).f.flags).toContain('early_drip');
    expect(featuresOf({ ...base, firstDripS: 17 }).f.flags).toContain('late_drip');
  });

  it('leaves firstDripS null after a late tap', () => {
    const { f } = featuresOf(base, 1, false);
    expect(f.firstDripS).toBeNull();
    expect(f.plateauFlow).not.toBeNull();
    expect(f.valid).toBe(true);
  });

  it('invalidates short, tiny or gappy shots', () => {
    const { f } = featuresOf({ ...base, stopAtG: 6 });
    expect(f.valid).toBe(false);
    expect(f.invalidReasons.join(' ')).toMatch(/yield/);
    const c = synthCurve(base, mulberry32(3));
    const samples = c.t.map((t, i) => ({ t, g: c.g[i] ?? 0 })).filter((s) => s.t < 10 || s.t > 25);
    const grid = resample(samples, c.endAt + 6);
    expect(grid.gaps.length).toBe(1);
    const g = computeFeatures({
      t: grid.t,
      g: grid.g,
      mask: grid.mask,
      endAt: c.endAt,
      finalYieldG: c.finalYieldG,
      firstDripKnown: true,
    });
    expect(g.valid).toBe(false);
  });

  it('flags choked shots', () => {
    const { f } = featuresOf({ ...base, plateauGps: 0.25, firstDripS: 12, maxS: 60, stopAtG: 12 });
    expect(f.flags).toContain('choked');
  });
});

describe('resample', () => {
  it('interpolates onto the grid and masks gaps > 400 ms', () => {
    const samples = [
      { t: 0, g: 0 },
      { t: 0.1, g: 1 },
      { t: 0.2, g: 2 },
      { t: 1.0, g: 10 },
      { t: 1.1, g: 11 },
    ];
    const grid = resample(samples, 1.1);
    expect(grid.t.length).toBe(12);
    expect(grid.g[1]).toBeCloseTo(1, 6);
    expect(grid.mask[5]).toBe(0);
    expect(grid.mask[10]).toBe(1);
    expect(grid.gaps).toEqual([[0.2, 1.0]]);
    expect(grid.present).toBeLessThan(1);
  });
});
