import { describe, expect, it } from 'vitest';
import { addBag, initFlowModel, mu0Roast } from '../../src/core/flowmodel/state';
import { update } from '../../src/core/flowmodel/update';
import { mulberry32 } from '../../src/core/math/rng';
import { RULES } from '../../src/core/params';
import { type RecommendInput, recommend, type ShotView } from '../../src/core/recommend';
import { initPreference, type PreferenceSummary, updateBody } from '../../src/core/rpm/preference';
import { evaluateRules, type RuleFacts, type RuleShot } from '../../src/core/rules/table';
import { compassVeto } from '../../src/core/rules/veto';
import { initSetpoint, updateSlider } from '../../src/core/setpoint/grid';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Features,
  Rating,
  RpmCalibrationRun,
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
    rpmFacts: {
      calibrated: true,
      krSd: 0.01,
      pref: null,
      shotsSinceBodyMove: 5,
      bodyTarget: 1000,
      probImprove: 0,
    },
    calibration: null,
    tempCardShown: false,
    outlierPending: false,
    learnableCount: 3,
    ...over,
  };
}

const prefSummary = (over: Partial<PreferenceSummary> = {}): PreferenceSummary => ({
  thetaMean: 800,
  thetaSd: 80,
  pInsensitive: 0.1,
  bayesRpm: 800,
  band: [700, 900],
  ratings: 6,
  ...over,
});

/** Facts where a body move toward 800 RPM should fire from 1100 RPM. */
const bodyReady = (over: Partial<RuleFacts['rpmFacts']> = {}): Partial<RuleFacts> => ({
  rpm: 1100,
  rpmFacts: {
    calibrated: true,
    krSd: 0.01,
    pref: prefSummary(),
    shotsSinceBodyMove: 5,
    bodyTarget: 800,
    probImprove: 0.9,
    ...over,
  },
});

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
  it('9 body move toward the preferred RPM once calibrated, settled and outside the band', () => {
    expect(evaluateRules(facts(bodyReady())).decision).toMatchObject({
      row: 9,
      lever: 'rpm',
      newRpm: 800,
    });
    const blocked: [Partial<RuleFacts>, RegExp][] = [
      [{ ...bodyReady(), setpointSd: 0.1 }, /setpoint/],
      [bodyReady({ calibrated: false }), /not calibrated/],
      [bodyReady({ pref: null }), /no body ratings/],
      [bodyReady({ shotsSinceBodyMove: 2 }), /since the last body move/],
      [bodyReady({ pref: prefSummary({ pInsensitive: 0.85 }) }), /barely changes body/],
      [{ ...bodyReady(), rpm: 900 }, /already within/],
      [bodyReady({ probImprove: 0.5 }), /not clearly better/],
    ];
    for (const [over, why] of blocked) {
      const r = evaluateRules(facts(over));
      expect(r.decision.row, String(why)).not.toBe(9);
      expect(r.whyNot.join(' | ')).toMatch(why);
    }
  });
  it('13 an active calibration run takes the slot first, with prep advice after a channelled shot', () => {
    const cal = { slot: 2, rpm: 1300 };
    expect(evaluateRules(facts({ calibration: cal, ageDays: 1 })).decision).toMatchObject({
      row: 13,
      lever: 'calibrate',
      slot: 2,
      rpm: 1300,
      prep: null,
    });
    const d = evaluateRules(
      facts({ calibration: cal, shots: [ruleShot({ channelFlag: true })] }),
    ).decision;
    expect(d.row).toBe(13);
    if (d.row === 13) expect(d.prep?.length).toBeGreaterThan(0);
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
  it('one lever per card; RPM moves are compensated, in range, in 100s, with E006 guidance at ≤ 600', () => {
    const rng = mulberry32(77);
    const levels = [500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600];
    for (let trial = 0; trial < 150; trial++) {
      const krTrue = (rng() - 0.5) * 0.08;
      const rpmOf = () =>
        rng() < 0.4 ? (levels[Math.floor(rng() * levels.length)] ?? 1000) : 1000;
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
      const n = 1 + Math.floor(rng() * 14);
      const views: ShotView[] = [];
      let lines = 250;
      let pref = initPreference();
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
        const rpmI = rpmOf();
        const y =
          mu0Roast('light') +
          0.05 * (lines - 250) +
          krTrue * ((rpmI - 1000) / 100) +
          (rng() - 0.5) * 0.3;
        const shot = mkShot(i, lines, Math.exp(y), rpmI);
        if (rng() < 0.5) pref = updateBody(pref, rpmI, Math.floor(rng() * 7) - 3);
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
      const run: RpmCalibrationRun | null =
        rng() < 0.25
          ? {
              id: 'run1',
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
              deviceId: 'd',
              epochId: 'e1',
              bagId: 'bag',
              startedAt: '2026-10-01T00:00:00.000Z',
              status: 'active',
            }
          : null;
      const input: RecommendInput = {
        bag,
        bean,
        epoch,
        shots: views,
        model,
        setpoint: sp,
        current,
        now: '2026-10-20T00:00:00.000Z',
        shotsSinceBodyMove: Math.floor(rng() * 5),
        tempCardShown: rng() < 0.5,
        pref,
        rpmRange: [500, 1600],
        rpmRuns: run ? [run] : [],
      };
      const { rec } = recommend(input);
      const curLines = toLines(current.grind.dialPos, DEFAULT_DIAL_SPEC);
      const nextLines = toLines(rec.next.grind.dialPos, DEFAULT_DIAL_SPEC);
      const rpmChanged = rec.next.grind.rpm !== current.grind.rpm;
      const changed = [
        nextLines !== curLines,
        rpmChanged,
        Math.abs(rec.next.targetYieldG - current.targetYieldG) > 1e-9,
      ].filter(Boolean).length;
      // RPM levers move RPM and dial together; every other lever changes at most one field.
      if (rec.lever === 'rpm' || rec.lever === 'calibrate' || rec.lever === 'grind') {
        expect(Math.abs(rec.next.targetYieldG - current.targetYieldG)).toBeLessThan(1e-9);
      } else {
        expect(changed, `lever ${rec.lever}`).toBeLessThanOrEqual(1);
        expect(rpmChanged, `lever ${rec.lever}`).toBe(false);
      }
      if (rec.lever === 'yield' || rec.lever === 'none' || rec.lever === 'wait')
        expect(nextLines).toBe(curLines);
      if (rec.lever === 'grind') expect(nextLines !== curLines || rpmChanged).toBe(true);
      // Compensated moves hold the flow at the target unless the dial hit a limit.
      if (
        (rec.lever === 'rpm' || rec.lever === 'calibrate') &&
        !rec.vetoes.some((x) => /clamped/.test(x))
      )
        expect(Math.abs(rec.predictedLnFlow - rec.targetLnFlow)).toBeLessThanOrEqual(RULES.beta);
      if (rec.lever === 'calibrate') {
        expect(run).not.toBeNull();
        expect(rec.calibration?.plannedRpm).toBe(rec.next.grind.rpm);
      }
      if (rec.lever === 'rpm') expect(rec.bodyConfidence ?? 0).toBeGreaterThanOrEqual(0.7);
      expect(Math.abs(nextLines - curLines)).toBeLessThanOrEqual(15);
      expect(nextLines).toBeGreaterThanOrEqual(235);
      expect(rec.next.grind.rpm).toBeGreaterThanOrEqual(500);
      expect(rec.next.grind.rpm).toBeLessThanOrEqual(1600);
      expect(rec.next.grind.rpm % 100).toBe(0);
      if (rec.next.grind.rpm <= 600) expect(rec.guidance?.join(' ') ?? '').toMatch(/E006/);
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
