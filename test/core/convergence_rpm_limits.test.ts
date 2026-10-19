/**
 * RPM convergence at the limits (plan "RPM calibration" §6), 200 seeds each:
 *  (m) a calibrated grinder with |k_r| ≥ 0.03, then a bag 0.3 ln faster whose balanced dial
 *      sits a few lines below chirp + 5: the backup RPM lever has to cover the rest of the flow.
 *  (n) the grinder stalls (E006) below 750 RPM, so block 1's low level stalls: the floor
 *      rises to the stall + 100 and the session still completes. (The plan said 650; block 1
 *      never goes below 700, so 650 would rarely bite.)
 * Set CONVERGENCE_OUT=<file> to write the measured rates as JSON.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RULES } from '../../src/core/params';
import { passRate, runMany, type SimRun } from '../../src/core/sim/scenarios';
import { effectiveSetpoint, trueLnFlow } from '../../src/core/sim/truth';

const SEEDS = 200;
const T = 300_000;

const rates: Record<string, number> = {};

function msg(name: string, target: number, label = 'plan target'): string {
  return `${name}: measured ${(rates[name] ?? 0).toFixed(3)}, ${label} ${target}`;
}

/** Some RPM within ±400 of 1000 puts bag 1 at the dial floor within β of the balanced flow. */
function reachable(r: SimRun): boolean {
  const floor = r.marks.floorLines ?? 0;
  const first = r.steps[r.marks.bag1 ?? 0];
  const ratio = first ? first.settings.targetYieldG / first.settings.doseG : 2;
  for (let rpm = 600; rpm <= 1400; rpm += 100) {
    const y = trueLnFlow(r.truth, 1, floor, rpm, 18, 3);
    if (Math.abs(y - effectiveSetpoint(r.truth, ratio, rpm)) <= RULES.beta) return true;
  }
  return false;
}

beforeAll(() => {
  const M = runMany('m', SEEDS);
  const reach = M.filter(reachable);
  rates.m_reachable = reach.length / M.length;
  const bag1 = (r: SimRun) => r.steps.slice(r.marks.bag1 ?? 0);
  // Backup lever used: a bag-1 recommendation changed RPM with the dial at its floor.
  rates.m_used = passRate(reach, (r) =>
    bag1(r).some((s) => s.rec.source === 'rpmModel' && s.rec.delta.rpm !== undefined),
  );
  // Reached the band (truth): a bag-1 shot at a backup RPM within β of the balanced flow there.
  rates.m_band = passRate(reach, (r) =>
    bag1(r).some(
      (s) => s.settings.grind.rpm !== 1000 && Math.abs(s.yTrue - s.sStarEff) <= RULES.beta,
    ),
  );
  // Still there on the last bag-1 shot (setpoint exploration keeps probing around it).
  rates.m_band_last = passRate(reach, (r) => {
    const last = bag1(r)[bag1(r).length - 1];
    return last !== undefined && Math.abs(last.yTrue - last.sStarEff) <= RULES.beta;
  });
  // The same without the RPM lever's help: would the floor alone be in band at 1000 RPM?
  rates.m_band_floor_only = passRate(reach, (r) => {
    const s = bag1(r)[bag1(r).length - 1];
    if (!s) return false;
    const y = trueLnFlow(r.truth, 1, r.marks.floorLines ?? 0, 1000, 18, 7);
    return (
      Math.abs(y - effectiveSetpoint(r.truth, s.settings.targetYieldG / s.settings.doseG)) <=
      RULES.beta
    );
  });
  // Reached where the app aimed: last bag-1 shot within β of the target it was pulled for.
  rates.m_aim = passRate(reach, (r) => {
    const steps = bag1(r);
    const last = steps[steps.length - 1];
    const prev = steps[steps.length - 2];
    return (
      last !== undefined &&
      prev !== undefined &&
      Math.abs(last.yTrue - prev.rec.targetLnFlow) <= RULES.beta
    );
  });

  const N = runMany('n', SEEDS);
  rates.n_stalled = passRate(N, (r) => r.steps.some((s) => s.stalled));
  rates.n_floor = passRate(N, (r) => {
    let floor = 0;
    for (const s of r.steps) {
      if (s.stalled) floor = Math.max(floor, s.settings.grind.rpm + 100);
      if (s.rec.next.grind.rpm < floor) return false;
    }
    return true;
  });
  rates.n_one_stall = passRate(N, (r) => r.steps.filter((s) => s.stalled).length <= 1);
  rates.n_complete = passRate(N, (r) => r.runs[0]?.status === 'done');
}, T);

afterAll(() => {
  if (process.env.CONVERGENCE_OUT) {
    writeFileSync(`${process.env.CONVERGENCE_OUT}.mn.json`, JSON.stringify(rates, null, 2));
  }
});

describe('RPM convergence m–n: targets met', () => {
  it('(m) the backup RPM reaches the band at the dial floor in reachable seeds (≥ 80 %)', () => {
    expect(rates.m_band, msg('m_band', 0.8)).toBeGreaterThanOrEqual(0.8);
  });
  it('(n) after a stall no recommendation goes below stall + 100 (100 %), one stall per seed', () => {
    expect(rates.n_stalled, msg('n_stalled', 1, 'setup')).toBe(1);
    expect(rates.n_floor, msg('n_floor', 1)).toBe(1);
    expect(rates.n_one_stall, msg('n_one_stall', 1)).toBe(1);
  });
  it('(n) the session completes after the stall (≥ 90 %)', () => {
    expect(rates.n_complete, msg('n_complete', 0.9)).toBeGreaterThanOrEqual(0.9);
  });
});

describe('RPM convergence m–n: regression floors (measured 2026-10-19, see README)', () => {
  it('(m) backup used ≈ 92 %; still in band on the last shot ≈ 57 % (setpoint search keeps probing); on the aimed flow ≈ 56 %', () => {
    expect(rates.m_used, msg('m_used', 0.85, 'floor')).toBeGreaterThanOrEqual(0.85);
    expect(rates.m_band_last, msg('m_band_last', 0.5, 'floor')).toBeGreaterThanOrEqual(0.5);
    expect(rates.m_aim, msg('m_aim', 0.5, 'floor')).toBeGreaterThanOrEqual(0.5);
  });
});
