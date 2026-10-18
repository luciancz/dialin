import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/math/rng';
import { initSetpoint, summary, updateSlider } from '../../src/core/setpoint/grid';
import {
  balancedLnFlow,
  bestLines,
  createDemoWorld,
  perceivedOffset,
  ratioOf,
  simulateDemoShot,
  tasteDemoShot,
  trueLnFlow,
} from '../../src/core/sim/demoWorld';
import type { ShotSettings } from '../../src/core/types';
import { DEFAULT_DIAL_SPEC, fromLines } from '../../src/core/units';

const settings = (lines: number, over: Partial<ShotSettings> = {}): ShotSettings => ({
  grind: { dialPos: fromLines(lines, DEFAULT_DIAL_SPEC), rpm: 1000, rpmConfirmed: true },
  doseG: 18,
  targetYieldG: 40,
  tempSwitch: 1,
  ...over,
});

describe('demo world', () => {
  it('is deterministic per seed and keeps its parameters in plausible ranges', () => {
    const a = createDemoWorld({ seed: 42, L0: 180 });
    const b = createDemoWorld({ seed: 42, L0: 180 });
    expect(a).toEqual(b);
    expect(a.kG).toBeGreaterThanOrEqual(0.03);
    expect(a.kG).toBeLessThanOrEqual(0.07);
    expect(a.rpmStar % 100).toBe(0);
    expect(createDemoWorld({ seed: 43, L0: 180 }).kG).not.toBe(a.kG);
  });

  it('coarser is faster, and the best dial tastes balanced', () => {
    const w = createDemoWorld({ seed: 7, L0: 180 });
    expect(trueLnFlow(w, settings(190), DEFAULT_DIAL_SPEC)).toBeGreaterThan(
      trueLnFlow(w, settings(170), DEFAULT_DIAL_SPEC),
    );
    const s = settings(180);
    const L = bestLines(w, s);
    const atBest = w.a + w.kG * (L - w.L0);
    expect(perceivedOffset(w, atBest, ratioOf(s))).toBeCloseTo(0, 9);
    // A longer ratio tolerates a faster shot.
    expect(balancedLnFlow(w, 2.6)).toBeGreaterThan(balancedLnFlow(w, 2.0));
  });

  it('tastes sour when faster than balanced (under-extracted) and bitter when slower', () => {
    const w = { ...createDemoWorld({ seed: 9, L0: 180 }), tasteNoise: 0 };
    const rng = mulberry32(1);
    const bal = balancedLnFlow(w, 2.2);
    const sour = tasteDemoShot(
      w,
      { y: bal + 0.2, ratio: 2.2, rpm: w.rpmStar, channel: false },
      null,
      rng,
    );
    const bitter = tasteDemoShot(
      w,
      { y: bal - 0.2, ratio: 2.2, rpm: w.rpmStar, channel: false },
      null,
      rng,
    );
    expect(sour.sourBitter).toBeLessThan(0);
    expect(bitter.sourBitter).toBeGreaterThan(0);
    // A too-short ratio also reads sour at the balanced flow for the optimal ratio.
    const short = tasteDemoShot(
      w,
      { y: balancedLnFlow(w, w.rStar), ratio: w.rStar - 0.5, rpm: w.rpmStar, channel: false },
      null,
      rng,
    );
    expect(short.sourBitter).toBeLessThan(0);
    expect(sour.thinHeavy).toBe(0);
    const better = tasteDemoShot(
      w,
      { y: bal, ratio: 2.2, rpm: w.rpmStar - 200, channel: false },
      { y: bal - 0.3, ratio: 2.2 },
      rng,
    );
    expect(better.vs).toBe('better');
    expect(better.thinHeavy).toBe(-2);
    const ch = tasteDemoShot(w, { y: bal, ratio: 2.2, rpm: 1000, channel: true }, null, rng);
    expect(ch.chips.some((c) => c === 'channelled' || c === 'astringent')).toBe(true);
  });

  it("agrees with the app's slider convention: its ratings move the setpoint toward the truth", () => {
    const w = { ...createDemoWorld({ seed: 21, L0: 180 }), tasteNoise: 0 };
    const rng = mulberry32(3);
    const bal = balancedLnFlow(w, 2.2);
    for (const y of [bal + 0.2, bal - 0.2]) {
      const sp0 = initSetpoint(y);
      const t = tasteDemoShot(w, { y, ratio: 2.2, rpm: w.rpmStar, channel: false }, null, rng);
      const after = summary(updateSlider(sp0, y, t.sourBitter)).mean;
      // The posterior mean moves from the tasted flow toward the balanced flow.
      expect(Math.abs(after - bal)).toBeLessThan(Math.abs(y - bal));
    }
  });

  it('simulated shots go through the real feature extractor and land near the true flow', () => {
    const w = { ...createDemoWorld({ seed: 11, L0: 180 }), channelProb: 0 };
    const s = settings(180);
    const errs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const shot = simulateDemoShot(w, s, DEFAULT_DIAL_SPEC, mulberry32(100 + i));
      expect(shot.channel).toBe(false);
      expect(shot.features.plateauFlow).not.toBeNull();
      errs.push(Math.log(shot.features.plateauFlow ?? 1) - shot.yObs);
      expect(Math.abs(shot.finalYieldG - s.targetYieldG)).toBeLessThan(3);
    }
    const meanAbs = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
    expect(meanAbs).toBeLessThan(0.05);
  });
});
