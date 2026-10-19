import { describe, expect, it } from 'vitest';
import { addBag, type BagMeta, IDX_KR, initFlowModel } from '../../src/core/flowmodel/state';
import { update } from '../../src/core/flowmodel/update';
import type { ShotView } from '../../src/core/recommend';
import {
  block1Levels,
  chooseBlock2,
  isCalibrated,
  miFlow,
  miTheta,
  offerBlocker,
  planCalibration,
  stopSd,
} from '../../src/core/rpm/calibration';
import { backupRpm, bodyMoveTarget, type LeverCtx, trimRpm } from '../../src/core/rpm/levers';
import { initPreference, updateBody } from '../../src/core/rpm/preference';
import type { RpmCalibrationRun, Shot } from '../../src/core/types';
import { DEFAULT_DIAL_SPEC, fromLines } from '../../src/core/units';

const FULL: [number, number] = [500, 1600];
const meta: BagMeta = {
  roastLevel: 'light',
  process: 'washed',
  decaf: false,
  roastTarget: 'espresso',
  roastDate: '2026-09-20',
  doseDefaultG: 18,
};
const run: RpmCalibrationRun = {
  id: 'run',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  deviceId: 'd',
  epochId: 'e1',
  bagId: 'bag',
  startedAt: '2026-10-10T00:00:00.000Z',
  status: 'active',
};

let seq = 0;
function view(
  slot: number | null,
  rpm: number,
  over: Partial<Pick<ShotView, 'learn' | 'skipped' | 'w' | 'predictedY'>> = {},
): ShotView {
  seq += 1;
  const shot = {
    id: `s${seq}`,
    settings: {
      grind: { dialPos: fromLines(180, DEFAULT_DIAL_SPEC), rpm, rpmConfirmed: true },
      doseG: 18,
      targetYieldG: 40,
      tempSwitch: 1,
    },
    ...(slot !== null ? { calibration: { runId: 'run', slot, plannedRpm: rpm } } : {}),
  } as unknown as Shot;
  return {
    shot,
    rating: null,
    quality: null,
    lines: 180,
    y: 0.6,
    learn: true,
    channelFlag: false,
    predictedY: 0.6,
    r: 0,
    skipped: false,
    inBandAtRating: true,
    u: (rpm - 1000) / 100,
    yRef: 0.6,
    w: 1,
    ...over,
  };
}

function model() {
  const s = initFlowModel('e1', 180);
  addBag(s, 'bag', meta, 180, '2026-10-01T00:00:00.000Z');
  for (let i = 0; i < 6; i++) {
    const lines = 180 + (i % 3) * 5;
    update(s, {
      bagId: 'bag',
      shotId: `w${i}`,
      lines,
      rpm: 1000,
      doseG: 18,
      y: 0.6 + 0.05 * (lines - 180),
      w0: 1,
      at: '2026-10-01T00:00:00.000Z',
    });
  }
  return s;
}

function plan(views: ShotView[], over: Partial<Parameters<typeof planCalibration>[0]> = {}) {
  return planCalibration({
    run,
    views,
    model: model(),
    bagId: 'bag',
    pref: initPreference(),
    range: FULL,
    currentRpm: 1000,
    doseG: 18,
    doseDefaultG: 18,
    ...over,
  });
}

describe('calibration planner', () => {
  it('block 1 is L H H L at 700/1300, starting at the level nearer the current RPM', () => {
    expect(block1Levels(FULL, 1000)).toEqual([700, 1300]);
    expect(block1Levels(FULL, 1300)).toEqual([1300, 700]);
    expect(block1Levels([800, 1600], 1000)).toEqual([800, 1400]);
    expect(block1Levels([500, 900], 1000)).toEqual([900, 500]);
    expect(block1Levels([1100, 1300], 1000)).toBeNull();
    expect(plan([]).next).toEqual({ slot: 0, rpm: 700 });
    const p = plan([view(0, 700), view(1, 1300)]);
    expect(p.next).toEqual({ slot: 2, rpm: 1300 });
    expect(p.slots.slice(0, 4).map((s) => s.plannedRpm)).toEqual([700, 1300, 1300, 700]);
  });

  it('repeats a slot whose shot was excluded or down-weighted, and stops after 2 repeats', () => {
    const excluded = plan([view(0, 700), view(1, 1300, { learn: false })]);
    expect(excluded.next).toEqual({ slot: 1, rpm: 1300 });
    const weak = plan([view(0, 700), view(1, 1300, { w: 0.3 })]);
    expect(weak.next?.slot).toBe(1);
    const noisy = plan([
      view(0, 700),
      view(1, 1300, { skipped: true }),
      view(1, 1300, { skipped: true }),
      view(1, 1300, { skipped: true }),
    ]);
    expect(noisy.next).toBeNull();
    expect(noisy.stopReason).toBe('too_noisy');
  });

  it('chooses block 2 after block 1: span ≥ 300, X then Y Y X, stable once slot 4 is pulled', () => {
    const b1 = [view(0, 700), view(1, 1300), view(2, 1300), view(3, 700)];
    const p = plan(b1);
    expect(p.next?.slot).toBe(4);
    const X = p.slots[4]?.plannedRpm ?? 0;
    const Y = p.slots[5]?.plannedRpm ?? 0;
    expect(Math.abs(X - Y)).toBeGreaterThanOrEqual(300);
    expect(X % 100).toBe(0);
    expect(p.slots.slice(4).map((s) => s.plannedRpm)).toEqual([X, Y, Y, X]);
    // Deterministic.
    expect(plan(b1).slots[5]?.plannedRpm).toBe(Y);
    // After slot 4 the X level is frozen from its tag.
    const p2 = plan([...b1, view(4, X)]);
    expect(p2.slots[4]?.plannedRpm).toBe(X);
    expect(p2.next?.slot).toBe(5);
    // All 8 done → complete.
    const done = plan([...b1, view(4, X), view(5, Y), view(6, Y), view(7, X)]);
    expect(done.next).toBeNull();
    expect(done.stopReason).toBe('complete');
  });

  it('stops early after block 1 when k_r is pinned and θ would barely move', () => {
    const m = model();
    (m.P[IDX_KR] as number[])[IDX_KR] = 0.002 ** 2;
    let flat = initPreference();
    for (const r of [700, 1300, 1300, 700, 700, 1300, 1300, 700, 1000, 1000])
      flat = updateBody(flat, r, 0);
    const b1 = [view(0, 700), view(1, 1300), view(2, 1300), view(3, 700)];
    const p = plan(b1, { model: m, pref: flat });
    expect(p.stopReason).toBe('early');
    expect(isCalibrated(m)).toBe(true);
    expect(stopSd(FULL)).toBeCloseTo(0.05 / 6, 9);
  });

  it('ended runs plan nothing', () => {
    expect(plan([], { run: { ...run, status: 'abandoned' } }).next).toBeNull();
  });

  it('information measures behave: wider RPM spans teach more about the flow effect', () => {
    const m = model();
    const idx = m.bags[0]?.index ?? null;
    expect(miFlow(m, idx, 700, 1300, 18, 18)).toBeGreaterThan(miFlow(m, idx, 900, 1100, 18, 18));
    expect(miTheta(initPreference(), 700, 1300)).toBeGreaterThan(0);
    const choice = chooseBlock2({
      pref: initPreference(),
      model: m,
      bagId: 'bag',
      range: FULL,
      lastRpm: 700,
      doseG: 18,
      doseDefaultG: 18,
    });
    expect(choice).not.toBeNull();
    expect(Math.abs((choice?.pair[0] ?? 0) - 700)).toBeLessThanOrEqual(
      Math.abs((choice?.pair[1] ?? 0) - 700),
    );
  });
});

describe('calibration offer', () => {
  const base = {
    views: [view(null, 1000), view(null, 1000), view(null, 1000)],
    balancedAt: () => 0.6,
    setpointSd: 0.08,
    ageDays: 12,
    gateDays: 5,
    runsThisEpoch: [] as RpmCalibrationRun[],
    now: '2026-10-20T00:00:00.000Z',
  };
  it('offers once the grind and taste have settled and RPM is not calibrated', () => {
    expect(offerBlocker({ ...base, model: model() })).toBeNull();
  });
  it('lists why it is not offered', () => {
    const m = model();
    expect(offerBlocker({ ...base, model: m, setpointSd: 0.2 })).toMatch(/setpoint/);
    expect(offerBlocker({ ...base, model: m, ageDays: 2 })).toMatch(/resting/);
    expect(offerBlocker({ ...base, model: m, balancedAt: () => 1.2 })).toMatch(/settled/);
    expect(offerBlocker({ ...base, model: m, runsThisEpoch: [run] })).toMatch(/running/);
    const declined = { ...run, status: 'declined' as const, updatedAt: '2026-10-18T00:00:00.000Z' };
    expect(offerBlocker({ ...base, model: m, runsThisEpoch: [declined] })).toMatch(/7 days/);
    const fresh = initFlowModel('e1', 180);
    addBag(fresh, 'bag', meta, 180, '2026-10-01T00:00:00.000Z');
    expect(offerBlocker({ ...base, model: fresh })).toMatch(/grind gain/);
  });
});

describe('RPM levers', () => {
  function ctx(kr: number, over: Partial<LeverCtx> = {}): LeverCtx {
    const m = model();
    m.m[IDX_KR] = kr;
    (m.P[IDX_KR] as number[])[IDX_KR] = 0.004 ** 2;
    return {
      model: m,
      bagId: 'bag',
      doseG: 18,
      spec: DEFAULT_DIAL_SPEC,
      chirpLines: 100,
      curLines: 180,
      range: FULL,
      targetAt: () => 0.6,
      ...over,
    };
  }

  it('body move steps toward the Bayes RPM by at most 300', () => {
    expect(bodyMoveTarget(1000, 1500, FULL)).toBe(1300);
    expect(bodyMoveTarget(1000, 800, FULL)).toBe(800);
    expect(bodyMoveTarget(700, 400, [600, 1600])).toBe(600);
  });

  it('backup lever: with the dial stuck, an RPM change closes the flow gap', () => {
    // Shot runs 0.06 ln fast at the clamped dial; higher RPM slows it (k_r < 0).
    const c = ctx(-0.03, { targetAt: () => 0.54 });
    const b = backupRpm(c, 180, 1000, null);
    expect(b).not.toBeNull();
    expect(b?.rpm).toBeGreaterThan(1000);
    expect(Math.abs(b?.residual ?? 1)).toBeLessThan(0.03);
    // The body band only has RPMs that make it worse: an RPM outside the band still wins.
    const outside = backupRpm(c, 180, 1000, [500, 1000]);
    expect(outside?.rpm).toBeGreaterThan(1000);
    // Inside the band wins when it is nearly as good.
    const near = backupRpm(c, 180, 1000, [1000, 1600]);
    expect(near?.rpm).toBeGreaterThan(1000);
    // Unknown direction: no backup.
    const unsure = ctx(-0.002);
    (unsure.model.P[IDX_KR] as number[])[IDX_KR] = 0.03 ** 2;
    expect(backupRpm({ ...unsure, targetAt: () => 0.54 }, 180, 1000, null)).toBeNull();
  });

  it('fine trim: below one dial line, stays inside the body band', () => {
    // 0.02 ln off with k_g ≈ 0.05/line (less than half a line); k_r = −0.02 per 100 RPM.
    const c = ctx(-0.02, { targetAt: () => 0.58 });
    const t = trimRpm(c, 180, 1000, [900, 1100]);
    expect(t?.rpm).toBe(1100);
    expect(Math.abs(t?.after ?? 1)).toBeLessThan(Math.abs(t?.before ?? 0));
    // Outside the band it refuses.
    expect(trimRpm(c, 180, 1000, [800, 1000])).toBeNull();
    // Already on target: nothing to trim.
    expect(trimRpm(ctx(-0.02, { targetAt: () => 0.6 }), 180, 1000, null)).toBeNull();
  });
});
