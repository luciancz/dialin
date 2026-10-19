/**
 * RPM calibration convergence (plan "RPM calibration" §6), scenarios k and l: 200 seeds of
 * 8 rated shots, an 8-slot calibration session pulled minutes apart, then 10 daily shots.
 * Scenario k is the prefix of scenario l (same seed, same truth, same session), so both are
 * measured on the l runs.
 *
 * As in the main suite: targets the plan asked for that are not met sit under `it.fails`,
 * and regression floors (measured 2026-10-19 minus a margin) guard against regressions.
 * Set CONVERGENCE_OUT=<file> to write the measured rates as JSON.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RULES } from '../../src/core/params';
import { passRate, runMany, type SimRun, type SimStep } from '../../src/core/sim/scenarios';
import { bodyUtility } from '../../src/core/sim/truth';

const SEEDS = 200;
const T = 300_000;

const rates: Record<string, number> = {};

function msg(name: string, target: number, label = 'plan target'): string {
  return `${name}: measured ${(rates[name] ?? 0).toFixed(3)}, ${label} ${target}`;
}

function session(r: SimRun): SimStep[] {
  return r.steps.slice(r.marks.calStart ?? 0, r.marks.calEnd ?? 0);
}

function afterSession(r: SimRun): SimStep | undefined {
  return r.steps[(r.marks.calEnd ?? 1) - 1];
}

beforeAll(() => {
  const L = runMany('l', SEEDS);
  // ---- k: the session itself ----
  rates.k_sd = passRate(L, (r) => (afterSession(r)?.krSd ?? 1) <= 0.012);
  rates.k_cover = passRate(L, (r) => {
    const s = afterSession(r);
    return s !== undefined && Math.abs(s.krHat - r.truth.kR) <= 2 * s.krSd;
  });
  rates.k_flow = passRate(L, (r) =>
    session(r)
      .filter((s) => s.slot !== null && !s.stalled)
      .every((s) => Math.abs(s.yTrue - s.sStarEff) <= RULES.betaRoute),
  );
  rates.k_shots = passRate(L, (r) => session(r).length <= 10);
  rates.k_done = passRate(L, (r) => r.runs[0]?.status === 'done');
  rates.k_delta_cover = passRate(L, (r) => {
    const s = afterSession(r);
    return s !== undefined && Math.abs(s.deltaHat - r.truth.delta) <= 2 * s.deltaSd;
  });
  // Fraction of all calibration shots (pooled) within β_route of the balanced flow at their RPM.
  let calShots = 0;
  let calIn = 0;
  for (const r of L) {
    for (const s of session(r)) {
      if (s.slot === null || s.stalled) continue;
      calShots++;
      if (Math.abs(s.yTrue - s.sStarEff) <= RULES.betaRoute) calIn++;
    }
  }
  rates.k_flow_shots = calShots > 0 ? calIn / calShots : 0;

  // ---- l: using RPM afterwards ----
  // From the last session shot on: its card is the "calibration done" move (row 14).
  const after = (r: SimRun) => r.steps.slice((r.marks.calEnd ?? 1) - 1);
  const isBodyMove = (s: SimStep) => s.rec.lever === 'rpm' && s.row === 9;
  const finalRpm = (r: SimRun) => {
    const last = r.steps[r.steps.length - 1];
    return last?.rec.next.grind.rpm ?? 1000;
  };
  const sensitive = L.filter((r) => r.truth.betaBody !== 0);
  const flat = L.filter((r) => r.truth.betaBody === 0);
  rates.l_regret = passRate(sensitive, (r) => -bodyUtility(r.truth, finalRpm(r)) <= 0.1);
  // Regret at 1000 RPM (what the app did before RPM calibration), for comparison.
  rates.l_regret_at_1000 = passRate(sensitive, (r) => -bodyUtility(r.truth, 1000) <= 0.1);
  let moves = 0;
  let held = 0;
  for (const r of L) {
    for (const s of after(r)) {
      if (s.rec.lever !== 'rpm') continue;
      moves++;
      if (Math.abs(s.yTrueNext - s.rec.predictedLnFlow) <= RULES.beta) held++;
    }
  }
  rates.l_moves = moves;
  rates.l_held = moves > 0 ? held / moves : 0;
  rates.l_moved = passRate(sensitive, (r) => after(r).some((s) => s.rec.lever === 'rpm'));
  rates.l_finished = passRate(L, (r) => after(r).some((s) => s.row === 14));
  // RPM-insensitive tasters: no body move, and the session hands back the pre-session RPM.
  rates.l_flat_no_move = passRate(flat, (r) => {
    // Fine trims (±100–200 RPM inside the band) are allowed; body moves are not.
    const finish = after(r).find((s) => s.row === 14);
    return !after(r).some(isBodyMove) && (finish?.rec.next.grind.rpm ?? 1000) === 1000;
  });
  rates.l_flat_pins = passRate(flat, (r) => {
    const last = r.steps[r.steps.length - 1];
    return (last?.pref.pInsensitive ?? 0) >= 0.6;
  });
  // RPM stays on the 100 grid and inside the range on every recommendation.
  rates.l_grid = passRate(L, (r) =>
    r.steps.every((s) => {
      const rpm = s.rec.next.grind.rpm;
      return rpm % 100 === 0 && rpm >= s.range[0] && rpm <= s.range[1];
    }),
  );
}, T);

afterAll(() => {
  if (process.env.CONVERGENCE_OUT) {
    writeFileSync(`${process.env.CONVERGENCE_OUT}.kl.json`, JSON.stringify(rates, null, 2));
  }
});

describe('RPM convergence k–l: targets met', () => {
  it('(k) after the session sd(k_r) ≤ 0.012 (≥ 95 %) and k_r is within 2 sd of the truth (≥ 90 %)', () => {
    expect(rates.k_sd, msg('k_sd', 0.95)).toBeGreaterThanOrEqual(0.95);
    expect(rates.k_cover, msg('k_cover', 0.9)).toBeGreaterThanOrEqual(0.9);
  });
  it('(l) body-sensitive tasters end within the body JND of their preferred RPM (≥ 75 %)', () => {
    expect(rates.l_regret, msg('l_regret', 0.75)).toBeGreaterThanOrEqual(0.75);
    // …which staying at 1000 RPM would not give.
    expect(rates.l_regret).toBeGreaterThan(rates.l_regret_at_1000 ?? 1);
  });
  it('(l) compensated RPM moves (session finish and body moves) hold flow within β (≥ 80 %)', () => {
    expect(rates.l_held, msg('l_held', 0.8)).toBeGreaterThanOrEqual(0.8);
  });
  it('(l) RPM-insensitive tasters: no body move and back to their RPM (≥ 90 %), insensitivity reported (≥ 70 %)', () => {
    expect(rates.l_flat_no_move, msg('l_flat_no_move', 0.9)).toBeGreaterThanOrEqual(0.9);
    expect(rates.l_flat_pins, msg('l_flat_pins', 0.7)).toBeGreaterThanOrEqual(0.7);
  });
  it('(l) every recommendation keeps RPM on the 100 grid and inside the range (100 %)', () => {
    expect(rates.l_grid, msg('l_grid', 1)).toBe(1);
  });
});

describe('RPM convergence k–l: regression floors (measured 2026-10-19, see README)', () => {
  it('(k) session length ≤ 10 shots: plan ≥ 95 %, measured ≈ 93.5 % (channelled slots repeat)', () => {
    expect(rates.k_shots, msg('k_shots', 0.95)).toBeGreaterThanOrEqual(0.9);
  });
  it('(k) every calibration shot within 0.14 of the balanced flow: plan ≥ 90 %, measured ≈ 15 % (≈ 72 % of shots)', () => {
    expect(rates.k_flow, msg('k_flow', 0.9)).toBeGreaterThanOrEqual(0.1);
    expect(rates.k_flow_shots, msg('k_flow_shots', 0.9, 'per shot')).toBeGreaterThanOrEqual(0.65);
  });
  it('(k) balance shift δ within 2 sd of the truth after the session (measured ≈ 96 %)', () => {
    expect(rates.k_delta_cover, msg('k_delta_cover', 0.9, 'floor')).toBeGreaterThanOrEqual(0.9);
  });
});

describe('RPM convergence k–l: plan targets', () => {
  it.fails('all k–l plan targets at once (remove the fails marker when this passes)', () => {
    expect(rates.k_shots, msg('k_shots', 0.95)).toBeGreaterThanOrEqual(0.95);
    expect(rates.k_flow, msg('k_flow', 0.9)).toBeGreaterThanOrEqual(0.9);
  });
});
