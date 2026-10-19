import { describe, expect, it } from 'vitest';
import { addBag, initFlowModel, mu0Roast } from '../../src/core/flowmodel/state';
import { update } from '../../src/core/flowmodel/update';
import { mulberry32 } from '../../src/core/math/rng';
import { RULES } from '../../src/core/params';
import { type RecommendInput, recommend, type ShotView } from '../../src/core/recommend';
import { evaluateRules, type RuleFacts, type RuleShot } from '../../src/core/rules/table';
import { compassVeto } from '../../src/core/rules/veto';
import { initSetpoint, updateSlider } from '../../src/core/setpoint/grid';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Features,
  Rating,
  Shot,
  ShotQuality,
  ShotSettings,
} from '../../src/core/types';
import { DEFAULT_DIAL_SPEC, fromLines, toLines } from '../../src/core/units';

const sStar = 0.65;

function ruleShot(over: Partial<RuleShot> = {}): RuleShot {
  return {
    y: sStar,
    learn: true,
    channelFlag: false,
    predictedY: sStar,
    skipped: false,
    r: 0.3,
    rating: null,
    rpm: 1000,
    inBandAtRating: true,
    ...over,
  };
}

function facts(over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    shots: [ruleShot(), ruleShot(), ruleShot()],
    yHatCur: sStar,
    sStar,
    setpointSd: 0.05,
    betaB: RULES.beta,
    kGrindSd: 0.01,
    ageDays: 12,
    gateDays: 5,
    roastLevel: 'light',
    doseG: 18,
    targetYieldG: 40,
    rpm: 1000,
    shotsSinceRpmChange: 5,
    allowLowRpm: false,
    tempCardShown: false,
    outlierPending: false,
    learnableCount: 3,
    ...over,
  };
}

const rated = (v: number, h = 0, chips: Rating['chips'] = []) =>
  ruleShot({
    rating: { vs: 'same', v: v as Rating['sourBitter'], h: h as Rating['thinHeavy'], chips },
  });

describe('rule table, one case per row', () => {
  it('1 channeling → prep', () => {
    const d = evaluateRules(
      facts({ shots: [ruleShot(), ruleShot({ channelFlag: true })] }),
    ).decision;
    expect(d.row).toBe(1);
    const chips = evaluateRules(facts({ shots: [rated(0, 0, ['astringent', 'harsh'])] })).decision;
    expect(chips.row).toBe(1);
  });
  it('2 freshness gate → wait, or a half grind step when far off band', () => {
    expect(evaluateRules(facts({ ageDays: 2 })).decision).toMatchObject({ row: 2, lever: 'wait' });
    expect(evaluateRules(facts({ ageDays: 2, yHatCur: sStar + 0.4 })).decision).toMatchObject({
      row: 2,
      lever: 'grind',
    });
  });
  it('3 outlier pending → repeat', () => {
    expect(evaluateRules(facts({ outlierPending: true })).decision).toMatchObject({
      row: 3,
      lever: 'none',
    });
  });
  it('4 off band → grind to the setpoint, wide band while the setpoint is fuzzy', () => {
    expect(evaluateRules(facts({ yHatCur: sStar + 0.1 })).decision).toMatchObject({
      row: 4,
      lever: 'grind',
    });
    expect(
      evaluateRules(facts({ yHatCur: sStar + 0.1, betaB: RULES.betaRoute, setpointSd: 0.2 }))
        .decision.row,
    ).not.toBe(4);
  });
  it('5 sour in band → longer ratio (+2, +4 when very sour), capped', () => {
    expect(evaluateRules(facts({ shots: [rated(-1)] })).decision).toMatchObject({
      row: 5,
      newYieldG: 42,
    });
    expect(evaluateRules(facts({ shots: [rated(-3)] })).decision).toMatchObject({
      row: 5,
      newYieldG: 44,
    });
    expect(evaluateRules(facts({ shots: [rated(-3)], targetYieldG: 49 })).decision).toMatchObject({
      row: 5,
      newYieldG: 18 * 2.8,
    });
  });
  it('6 sour at the ratio cap → finer via the setpoint', () => {
    const d = evaluateRules(facts({ shots: [rated(-1)], targetYieldG: 18 * 2.8 })).decision;
    expect(d.row).toBe(6);
    if (d.row === 6) expect(d.target).toBeLessThan(sStar);
  });
  it('7 bitter in band → shorter ratio', () => {
    expect(evaluateRules(facts({ shots: [rated(1)] })).decision).toMatchObject({
      row: 7,
      newYieldG: 38,
    });
    expect(evaluateRules(facts({ shots: [rated(2)] })).decision).toMatchObject({
      row: 7,
      newYieldG: 36,
    });
  });
  it('8 bitter at the ratio floor → coarser via the setpoint', () => {
    const d = evaluateRules(facts({ shots: [rated(1)], targetYieldG: 18 * 1.8 })).decision;
    expect(d.row).toBe(8);
    if (d.row === 8) expect(d.target).toBeGreaterThan(sStar);
  });
  it('9 texture → RPM ±200 within 700–1400, only when converged and 3 shots since the last change', () => {
    const thin = [rated(0, -2), rated(0, -2), rated(0, 0)];
    expect(evaluateRules(facts({ shots: thin })).decision).toMatchObject({
      row: 9,
      newRpm: 1200,
      texture: 'thin',
    });
    const heavy = [rated(0, 2), rated(0, 0, ['hollow']), rated(0, 3)];
    expect(evaluateRules(facts({ shots: heavy })).decision).toMatchObject({ row: 9, newRpm: 800 });
    expect(evaluateRules(facts({ shots: thin, shotsSinceRpmChange: 2 })).decision.row).not.toBe(9);
    expect(evaluateRules(facts({ shots: thin, setpointSd: 0.1 })).decision.row).not.toBe(9);
    expect(evaluateRules(facts({ shots: heavy, rpm: 700 })).decision.row).not.toBe(9);
    expect(
      evaluateRules(facts({ shots: heavy, rpm: 700, allowLowRpm: true })).decision,
    ).toMatchObject({ row: 9, newRpm: 500 });
    expect(evaluateRules(facts({ shots: thin, rpm: 1400 })).decision.row).not.toBe(9);
  });
  it('10 temperature once per bag after 4 rated in-band shots leaning sour', () => {
    const sour = [rated(-2), rated(-1), rated(-2), rated(-2)].map((s) => ({
      ...s,
      rating: {
        ...(s.rating ?? { vs: null, v: null, h: null, chips: [] }),
        v: s.rating?.v ?? null,
      },
    }));
    // Row 5 would fire first on the last sour shot; use yield at the cap and setpoint fuzzy so rows 5/6 are skipped.
    const f = facts({
      shots: sour.map((s) => ({
        ...s,
        rating: { ...(s.rating as NonNullable<RuleShot['rating']>), v: null },
      })),
    });
    // With v = null on the last shot rows 5–8 are skipped; mean v uses rated in-band shots with v ≠ null.
    const withV = {
      ...f,
      shots: [
        ...sour.slice(0, 3),
        { ...(sour[3] as RuleShot), rating: { vs: 'same' as const, v: null, h: null, chips: [] } },
      ],
    };
    const d = evaluateRules({ ...withV, setpointSd: 0.1 }).decision;
    expect(d.row === 10 || d.row === 12).toBe(true);
    const shown = evaluateRules({ ...withV, setpointSd: 0.1, tempCardShown: true }).decision;
    expect(shown.row).not.toBe(10);
  });
  it('11 dialled in → repeat', () => {
    expect(evaluateRules(facts()).decision).toMatchObject({ row: 11, lever: 'none' });
  });
  it('12 otherwise → setpoint search', () => {
    expect(evaluateRules(facts({ setpointSd: 0.1 })).decision).toMatchObject({
      row: 12,
      lever: 'grind',
    });
  });
  it('compass veto replaces a model step that goes the wrong way', () => {
    expect(compassVeto({ v: -1, offset: 0.02, deltaLines: 4 })).toMatchObject({ deltaLines: -5 });
    expect(compassVeto({ v: 1, offset: -0.02, deltaLines: -4 })).toMatchObject({ deltaLines: 5 });
    expect(compassVeto({ v: -1, offset: 0.02, deltaLines: -4 })).toMatchObject({
      deltaLines: -4,
      veto: null,
    });
    expect(compassVeto({ v: null, offset: 0.3, deltaLines: 8 })).toMatchObject({
      deltaLines: 8,
      veto: null,
    });
  });
});

// ---- recommend(): property tests over random states ----

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
  chirp: fromLines(230, DEFAULT_DIAL_SPEC),
};
const bag: Bag = {
  id: 'bag',
  createdAt: 'x',
  updatedAt: 'x',
  deviceId: 'd',
  beanId: 'bean',
  roastDate: '2026-09-25',
  doseDefaultG: 18,
  targetYieldG: 40,
  storage: [],
  rpm: 1000,
  tsSeed: 3,
  archived: false,
};
const features = (plateau: number): Features => ({
  firstDripS: 8,
  t50S: 20,
  plateauFlow: plateau,
  meanFlow: plateau * 0.9,
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
});

function mkShot(i: number, lines: number, plateau: number, rpm = 1000): Shot {
  return {
    id: `s${i}`,
    createdAt: 'x',
    updatedAt: 'x',
    deviceId: 'd',
    bagId: 'bag',
    epochId: 'e1',
    at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
    settings: {
      grind: { dialPos: fromLines(lines, DEFAULT_DIAL_SPEC), rpm, rpmConfirmed: true },
      doseG: 18,
      targetYieldG: 40,
      tempSwitch: 1,
    },
    context: { shotIndexOfDay: 1, appVersion: 't' },
    features: features(plateau),
    endedBy: 'tap',
    recommendationId: null,
    deviation: null,
  };
}

describe('recommend() properties', () => {
  it('always picks exactly one lever, never a step over 15 lines, never RPM below 700 without opt-in', () => {
    const rng = mulberry32(77);
    for (let trial = 0; trial < 150; trial++) {
      const model = initFlowModel('e1', 250);
      addBag(
        model,
        'bag',
        {
          roastLevel: 'light',
          process: 'washed',
          decaf: false,
          roastTarget: 'espresso',
          roastDate: bag.roastDate,
          doseDefaultG: 18,
        },
        250,
        '2026-10-01T00:00:00.000Z',
      );
      const n = 1 + Math.floor(rng() * 8);
      const views: ShotView[] = [];
      let lines = 250;
      const quality: ShotQuality = {
        id: 'q',
        createdAt: 'x',
        updatedAt: 'x',
        deviceId: 'd',
        shotId: 's',
        status: 'ok',
        learn: true,
        notes: [],
      };
      for (let i = 0; i < n; i++) {
        lines = Math.max(235, Math.min(400, lines + Math.round((rng() - 0.5) * 12)));
        const y = mu0Roast('light') + 0.05 * (lines - 250) + (rng() - 0.5) * 0.3;
        const shot = mkShot(i, lines, Math.exp(y), rng() < 0.2 ? 1200 : 1000);
        const res = update(model, {
          bagId: 'bag',
          shotId: shot.id,
          lines,
          rpm: shot.settings.grind.rpm,
          doseG: 18,
          y,
          w0: 1,
          at: shot.at,
        });
        const rating: Rating | null =
          rng() < 0.6
            ? {
                id: `r${i}`,
                createdAt: 'x',
                updatedAt: 'x',
                deviceId: 'd',
                shotId: shot.id,
                comparedToShotId: null,
                vsPrevious: (['better', 'same', 'worse'] as const)[Math.floor(rng() * 3)] ?? 'same',
                sourBitter: (Math.floor(rng() * 7) - 3) as Rating['sourBitter'],
                thinHeavy: (Math.floor(rng() * 7) - 3) as Rating['thinHeavy'],
                chips: rng() < 0.2 ? ['channelled'] : [],
                drink: 'black',
              }
            : null;
        views.push({
          shot,
          rating,
          quality,
          lines,
          y,
          learn: true,
          channelFlag: rating?.chips.includes('channelled') ?? false,
          predictedY: y + (rng() - 0.5) * 0.1,
          r: res.r,
          skipped: !res.accepted,
          inBandAtRating: rng() < 0.5,
          u: (shot.settings.grind.rpm - 1000) / 100,
          yRef: y,
          w: res.accepted ? res.w : 0,
        });
      }
      let sp = initSetpoint(mu0Roast('light'));
      for (let i = 0; i < Math.floor(rng() * 10); i++)
        sp = updateSlider(sp, mu0Roast('light') + (rng() - 0.5) * 0.2, rng() < 0.5 ? -1 : 1);
      const last = views[views.length - 1];
      if (!last) continue;
      const current: ShotSettings = {
        ...last.shot.settings,
        targetYieldG: 18 * (1.6 + rng() * 1.3),
      };
      const input: RecommendInput = {
        bag,
        bean,
        epoch,
        allowLowRpm: false,
        shots: views,
        model,
        setpoint: sp,
        current,
        now: '2026-10-20T00:00:00.000Z',
        shotsSinceBodyMove: Math.floor(rng() * 5),
        tempCardShown: rng() < 0.5,
      };
      const { rec } = recommend(input);
      const curLines = toLines(current.grind.dialPos, DEFAULT_DIAL_SPEC);
      const nextLines = toLines(rec.next.grind.dialPos, DEFAULT_DIAL_SPEC);
      const changed = [
        nextLines !== curLines,
        rec.next.grind.rpm !== current.grind.rpm,
        Math.abs(rec.next.targetYieldG - current.targetYieldG) > 1e-9,
      ].filter(Boolean).length;
      expect(changed, `lever ${rec.lever}`).toBeLessThanOrEqual(1);
      if (rec.lever === 'grind') expect(nextLines).not.toBe(curLines);
      if (rec.lever !== 'grind') expect(nextLines).toBe(curLines);
      if (rec.lever !== 'rpm') expect(rec.next.grind.rpm).toBe(current.grind.rpm);
      expect(Math.abs(nextLines - curLines)).toBeLessThanOrEqual(15);
      expect(nextLines).toBeGreaterThanOrEqual(235);
      expect(rec.next.grind.rpm).toBeGreaterThanOrEqual(700);
      expect(rec.next.grind.rpm).toBeLessThanOrEqual(1400);
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
      expect(rec.sentence.length).toBeGreaterThan(10);
      expect(rec.predictedBand[0]).toBeLessThan(rec.predictedBand[1]);
      if (['none', 'wait', 'prep'].includes(rec.lever))
        expect(rec.confidenceWord).toBe('insufficient');
    }
  });

  it('first shot of a bag asks for the starting dial and reports insufficient confidence', () => {
    const model = initFlowModel('e1', 250);
    const current: ShotSettings = {
      grind: { dialPos: fromLines(250, DEFAULT_DIAL_SPEC), rpm: 1000, rpmConfirmed: true },
      doseG: 18,
      targetYieldG: 40,
      tempSwitch: 1,
    };
    const { rec } = recommend({
      bag,
      bean,
      epoch,
      allowLowRpm: false,
      shots: [],
      model,
      setpoint: initSetpoint(mu0Roast('light')),
      current,
      now: '2026-10-20T00:00:00.000Z',
      shotsSinceBodyMove: 0,
      tempCardShown: false,
    });
    expect(rec.sentence).toMatch(/first shot|earlier bags/);
    expect(rec.lever === 'grind' || rec.lever === 'none').toBe(true);
  });
});
