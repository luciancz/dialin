import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/math/rng';
import { RULES, SETPOINT } from '../../src/core/params';
import {
  applyTasting,
  chooseTarget,
  comparisonValidity,
  forget,
  initSetpoint,
  recipeMu0,
  sliderLikelihood,
  summary,
  updatePreference,
  updateSlider,
} from '../../src/core/setpoint/grid';
import { tasteSlider } from '../../src/core/sim/taste';
import { effectiveSetpoint, sampleTruth } from '../../src/core/sim/truth';

const mu0 = 0.65;

describe('setpoint posterior', () => {
  it('starts as the prior and stays normalised', () => {
    const sp = initSetpoint(mu0);
    expect(sp.grid.length).toBe(121);
    expect(sp.p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const s = summary(sp);
    expect(s.mean).toBeCloseTo(mu0, 3);
    expect(s.sd).toBeCloseTo(SETPOINT.priorSd, 2);
    const blended = initSetpoint(mu0, recipeMu0(40, [28, 32]));
    expect(blended.mu0).toBeCloseTo(0.5 * mu0 + 0.5 * (Math.log(40 / 22) + 0.08), 9);
  });

  it('sign test: sour (v = −1) moves the setpoint down (finer), bitter moves it up', () => {
    const sp = initSetpoint(mu0);
    const y = mu0;
    expect(sliderLikelihood(y - 0.2, y, -1)).toBeGreaterThan(sliderLikelihood(y + 0.2, y, -1));
    const sour = summary(updateSlider(sp, y, -1));
    const bitter = summary(updateSlider(sp, y, 1));
    expect(sour.mean).toBeLessThan(mu0 - 0.02);
    expect(bitter.mean).toBeGreaterThan(mu0 + 0.02);
    const sour3 = summary(updateSlider(sp, y, -3));
    expect(sour3.mean).toBeLessThan(sour.mean);
  });

  it('the simulated taster follows the sign test: fast or short reads sour, sliders move toward the truth', () => {
    const rng = mulberry32(5);
    const t = sampleTruth(rng);
    const bal = effectiveSetpoint(t, t.rStar);
    for (const y of [bal + 0.2, bal - 0.2]) {
      const v = tasteSlider(t, y, t.rStar, rng);
      expect(Math.sign(v)).toBe(y > bal ? -1 : 1);
      const after = summary(updateSlider(initSetpoint(y), y, v)).mean;
      expect(Math.abs(after - bal)).toBeLessThan(Math.abs(y - bal));
    }
    expect(tasteSlider(t, t.sStar, t.rStar - 1, rng)).toBeLessThan(0);
  });

  it('one tasting cannot collapse the posterior', () => {
    // The slider floor bounds how far one tasting moves the odds between two setpoints.
    const y = mu0;
    for (const v of [-3, -2, -1, 1, 2, 3]) {
      const ls = initSetpoint(mu0).grid.map((s) => sliderLikelihood(s, y, v));
      expect(Math.max(...ls) / Math.min(...ls)).toBeLessThanOrEqual(
        1 / SETPOINT.sliderFloor + 1e-9,
      );
    }
    // From the prior, no single slider or preference shrinks σ_s by more than 40 % (measured
    // worst case 2026-10-18: slider 12 %, preference 33 %), so the converged gate needs several
    // tastings and a lapse or a mis-set slider can be outvoted.
    const sp = initSetpoint(mu0);
    const s0 = summary(sp);
    let minRatio = 1;
    for (const dy of [-0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.3]) {
      for (const v of [-3, -2, -1, 1, 2, 3]) {
        minRatio = Math.min(minRatio, summary(updateSlider(sp, mu0 + dy, v)).sd / s0.sd);
      }
      for (const d of [0.04, 0.1, 0.2, 0.3]) {
        for (const vs of ['better', 'worse', 'same'] as const) {
          minRatio = Math.min(
            minRatio,
            summary(updatePreference(sp, mu0 + dy, mu0 + dy + d, vs, 0)).sd / s0.sd,
            summary(updatePreference(sp, mu0 + dy + d, mu0 + dy, vs, 0)).sd / s0.sd,
          );
        }
      }
    }
    expect(minRatio).toBeGreaterThan(0.6);
    expect(s0.sd * minRatio).toBeGreaterThan(RULES.setpointSdConverged);
  });

  it('a "better" after moving slower shifts the setpoint down', () => {
    const sp = initSetpoint(mu0);
    const yi = mu0 + 0.1;
    const yj = mu0 - 0.1;
    const better = summary(updatePreference(sp, yj, yi, 'better', 0));
    const worse = summary(updatePreference(sp, yj, yi, 'worse', 0));
    expect(better.mean).toBeLessThan(mu0);
    expect(worse.mean).toBeGreaterThan(mu0);
    const same = summary(updatePreference(sp, yj, yi, 'same', 0));
    expect(Math.abs(same.mean - mu0)).toBeLessThan(0.02);
  });

  it('never double-counts a tasting that has both a preference and a slider', () => {
    const sp = initSetpoint(mu0);
    const yi = mu0 + 0.1;
    const yj = mu0 - 0.1;
    const both = applyTasting(sp, {
      yj,
      yi,
      vs: 'better',
      comparisonValid: true,
      dDays: 0,
      sourBitter: -2,
      chips: [],
      overall: null,
      sliderDrovesYield: false,
    });
    expect(both.applied).toBe('preference');
    const prefOnly = updatePreference(sp, yj, yi, 'better', 0);
    expect(summary(both.sp).mean).toBeCloseTo(summary(prefOnly).mean, 9);
    const invalid = applyTasting(sp, {
      yj,
      yi,
      vs: 'better',
      comparisonValid: false,
      dDays: 0,
      sourBitter: -2,
      chips: [],
      overall: null,
      sliderDrovesYield: false,
    });
    expect(invalid.applied).toBe('slider');
    const skipped = applyTasting(sp, {
      yj,
      yi: null,
      vs: null,
      comparisonValid: false,
      dDays: 0,
      sourBitter: -2,
      chips: [],
      overall: null,
      sliderDrovesYield: true,
    });
    expect(skipped.applied).toBe('none');
    const chip = applyTasting(sp, {
      yj,
      yi: null,
      vs: null,
      comparisonValid: false,
      dDays: 0,
      sourBitter: null,
      chips: ['hollow'],
      overall: null,
      sliderDrovesYield: false,
    });
    expect(chip.applied).toBe('chip');
    expect(summary(chip.sp).mean).toBeLessThan(mu0);
    const astr = applyTasting(sp, {
      yj,
      yi: null,
      vs: null,
      comparisonValid: false,
      dDays: 0,
      sourBitter: null,
      chips: ['astringent'],
      overall: null,
      sliderDrovesYield: false,
    });
    expect(astr.applied).toBe('none');
  });

  it('forgetting widens σ_s by the stated amount', () => {
    let sp = initSetpoint(mu0);
    for (let i = 0; i < 6; i++) sp = updateSlider(sp, mu0 + 0.05, -1);
    for (let i = 0; i < 6; i++) sp = updateSlider(sp, mu0 - 0.05, 1);
    const before = summary(sp);
    const after = summary(forget(sp, 0.08));
    expect(after.sd ** 2 - before.sd ** 2).toBeCloseTo(0.08 ** 2, 3);
    expect(after.mean).toBeCloseTo(before.mean, 2);
  });

  it('converges with consistent preferences and chooses targets sensibly', () => {
    let sp = initSetpoint(mu0);
    const sStar = mu0 - 0.12;
    let prev = mu0 + 0.1;
    for (let i = 0; i < 12; i++) {
      const cur = sStar + (i % 2 ? 0.05 : -0.05) * (1 - i / 14);
      const vs = Math.abs(cur - sStar) < Math.abs(prev - sStar) ? 'better' : 'worse';
      sp = updatePreference(sp, cur, prev, vs, 1);
      prev = cur;
    }
    const s = summary(sp);
    expect(Math.abs(s.mean - sStar)).toBeLessThan(0.08);
    expect(s.sd).toBeLessThan(0.12);
    const t = chooseTarget(initSetpoint(mu0), 42);
    expect(t.mode).toBe('thompson');
    expect(Math.abs(t.yStar - mu0)).toBeLessThanOrEqual(SETPOINT.thompsonClamp + 1e-9);
    const t2 = chooseTarget(initSetpoint(mu0), 42);
    expect(t2.yStar).toBe(t.yStar);
    const tight = { ...sp, sameStreak: 2 };
    if (s.sd <= SETPOINT.thompsonSd) expect(chooseTarget(tight, 1).mode).toBe('probe');
  });

  it('validity gate lists the reasons', () => {
    const base = {
      learnJ: true,
      learnI: true,
      channelJ: false,
      channelI: false,
      yieldJ: 40,
      yieldI: 40,
      rpmJ: 1000,
      rpmI: 1000,
      tempJ: 1,
      tempI: 1,
      doseJ: 18,
      doseI: 18,
      yj: 0.6,
      yi: 0.7,
    };
    expect(comparisonValidity(base)).toBeNull();
    expect(comparisonValidity({ ...base, learnI: false })).toMatch(/excluded/);
    expect(comparisonValidity({ ...base, channelJ: true })).toMatch(/channel/);
    expect(comparisonValidity({ ...base, yieldI: 46 })).toMatch(/yield/);
    expect(comparisonValidity({ ...base, rpmI: 1200 })).toMatch(/RPM/);
    expect(comparisonValidity({ ...base, tempI: 2 })).toMatch(/temperature/);
    expect(comparisonValidity({ ...base, doseI: 18.5 })).toMatch(/dose/);
    expect(comparisonValidity({ ...base, yi: 0.62 })).toMatch(/uninformative/);
  });
});
