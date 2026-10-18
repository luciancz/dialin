/**
 * Scenario runner: a seeded hidden truth, a simulated user who follows every
 * recommendation, curves synthesised and pushed through the real feature extractor, rows
 * built exactly as the app stores them, and the real replay() + recommend() in the loop.
 */
import { computeFeatures } from '../curve/features';
import { resample } from '../curve/resample';
import { predictAt } from '../flowmodel/invert';
import { kGrind, kRpm } from '../flowmodel/state';
import { randomBytesFrom, uuidv7 } from '../ids';
import { mulberry32, type Rng, randn, uniform } from '../math/rng';
import { MODEL, RULES, SIM } from '../params';
import { type RecommendationCore, recommend } from '../recommend';
import { bagContext, replay } from '../replay';
import { summary } from '../setpoint/grid';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Id,
  Meta,
  Rating,
  Recommendation,
  Shot,
  ShotQuality,
  ShotSettings,
} from '../types';
import { DEFAULT_DIAL_SPEC, fromLines, toLines } from '../units';
import { randomSpec, synthCurve } from './curveSynth';
import { tasteChips, tasteSlider, tasteThinHeavy, tasteVs } from './taste';
import { effectiveSetpoint, sampleTruth, type Truth, type TruthOptions, trueLnFlow } from './truth';

export type ScenarioName = 'a' | 'a_miscount' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'i';

export interface SimStep {
  k: number;
  bagIndex: number;
  settings: ShotSettings;
  lines: number;
  yTrue: number;
  yObs: number;
  channel: boolean;
  learn: boolean;
  skipped: boolean;
  /** Recommendation issued after this shot. */
  rec: RecommendationCore;
  row: number;
  /** True ln flow at the recommended next settings (what following it would give). */
  yTrueNext: number;
  kgHat: number;
  kgSd: number;
  krHat: number;
  krSd: number;
  setpointMean: number;
  setpointSd: number;
  /** Prediction error of the model at the current settings. */
  predErrCur: number;
  excludedByModel: boolean;
  /** Flow that tastes balanced at the shot's ratio (the setpoint the app should find). */
  sStarEff: number;
}

export interface SimRun {
  truth: Truth;
  steps: SimStep[];
}

export interface ScenarioConfig {
  seed: number;
  name: ScenarioName;
}

const START = Date.UTC(2026, 9, 1, 9);
const DAY = 86_400_000;

class RowFactory {
  private clock = START;
  private readonly bytes: (n: number) => Uint8Array;
  constructor(rng: Rng) {
    this.bytes = randomBytesFrom(rng);
  }
  meta(atMs: number): Meta {
    this.clock += 1;
    const iso = new Date(atMs).toISOString();
    return { id: uuidv7(this.clock, this.bytes), createdAt: iso, updatedAt: iso, deviceId: 'sim' };
  }
}

interface World {
  rng: Rng;
  rows: RowFactory;
  truth: Truth;
  beans: Bean[];
  bags: Bag[];
  epochs: CalibrationEpoch[];
  shots: Shot[];
  ratings: Rating[];
  quality: ShotQuality[];
  recommendations: Recommendation[];
  /** Days since the first shot per bag. */
  firstShotDay: number[];
  steps: SimStep[];
  rated: boolean;
  /** Override the next shot's RPM (scenario g). */
  rpmOverride: ((k: number) => number | null) | null;
  /** Truth shift applied by a washer epoch (scenario f). */
  aShift: number;
}

function makeWorld(seed: number, truthOpts: TruthOptions, rated: boolean): World {
  const rng = mulberry32(seed);
  const rows = new RowFactory(rng);
  const truth = sampleTruth(rng, truthOpts);
  const bean: Bean = {
    ...rows.meta(START),
    roaster: 'Sim',
    name: 'Bean',
    roastLevel: truth.roast,
    roastTarget: 'espresso',
    process: 'washed',
    decaf: false,
  };
  const epoch: CalibrationEpoch = {
    ...rows.meta(START - DAY),
    startedAt: new Date(START - DAY).toISOString(),
    kind: 'initial',
    dialSpec: { ...DEFAULT_DIAL_SPEC },
    burrSet: 'stock',
    washerCount: 0,
    springSet: 'stock',
    usualDial: fromLines(truth.LrefTrue, DEFAULT_DIAL_SPEC),
  };
  const w: World = {
    rng,
    rows,
    truth,
    beans: [bean],
    bags: [],
    epochs: [epoch],
    shots: [],
    ratings: [],
    quality: [],
    recommendations: [],
    firstShotDay: [],
    steps: [],
    rated,
    rpmOverride: null,
    aShift: 0,
  };
  for (let i = 0; i < truth.aBags.length; i++) addBagRow(w, 10);
  return w;
}

function addBagRow(w: World, ageAtStart: number): Bag {
  const bean = w.beans[0];
  if (!bean) throw new Error('no bean');
  const bag: Bag = {
    ...w.rows.meta(START),
    beanId: bean.id,
    roastDate: new Date(START - ageAtStart * DAY).toISOString().slice(0, 10),
    doseDefaultG: 18,
    targetYieldG: Math.round(18 * MODEL.roastDefaults[w.truth.roast].ratio),
    storage: [],
    rpm: 1000,
    tsSeed: Math.floor(w.rng() * 2 ** 31),
    archived: false,
  };
  w.bags.push(bag);
  w.firstShotDay.push(-1);
  return bag;
}

function currentSettingsFor(w: World, bagIndex: number, k: number): ShotSettings {
  const bag = w.bags[bagIndex];
  if (!bag) throw new Error('no bag');
  const prevRec = [...w.recommendations].reverse().find((r) => r.bagId === bag.id);
  if (prevRec) return { ...prevRec.next, grind: { ...prevRec.next.grind, rpmConfirmed: true } };
  // A new bag starts at the previous bag's last recommended line, else the usual dial.
  const lastAny = w.recommendations[w.recommendations.length - 1];
  const dial = lastAny
    ? lastAny.next.grind.dialPos
    : fromLines(w.truth.LrefTrue, DEFAULT_DIAL_SPEC);
  void k;
  return {
    grind: { dialPos: dial, rpm: bag.rpm, rpmConfirmed: true },
    doseG: bag.doseDefaultG,
    targetYieldG: bag.targetYieldG,
    tempSwitch: 1,
  };
}

/** Pull one shot on day `day` for bag `bagIndex`, then recommend. */
function pullShot(w: World, bagIndex: number, day: number, k: number): SimStep {
  const bag = w.bags[bagIndex];
  const bean = w.beans[0];
  const epoch = w.epochs[w.epochs.length - 1];
  if (!bag || !bean || !epoch) throw new Error('world incomplete');
  const settings = currentSettingsFor(w, bagIndex, k);
  const over = w.rpmOverride?.(k);
  if (over !== null && over !== undefined) settings.grind.rpm = over;
  if (w.firstShotDay[bagIndex] === -1) w.firstShotDay[bagIndex] = day;
  const dayOffset = day - (w.firstShotDay[bagIndex] ?? day);
  const lines = toLines(settings.grind.dialPos, epoch.dialSpec);
  const yTrue =
    trueLnFlow(w.truth, bagIndex, lines, settings.grind.rpm, settings.doseG, dayOffset) + w.aShift;
  const channel = w.rng() < w.truth.channelProb;
  const yObs =
    yTrue +
    (channel ? uniform(w.rng, w.truth.channelLn[0], w.truth.channelLn[1]) : 0) +
    MODEL.sigmaY * randn(w.rng);
  const atMs = START + day * DAY;
  const spec = randomSpec(w.rng, Math.exp(yObs), settings.targetYieldG, { channel });
  const curve = synthCurve(spec, w.rng, 100, 6);
  const grid = resample(
    curve.t.map((t, i) => ({ t, g: curve.g[i] ?? 0 })),
    curve.endAt + 6,
  );
  const features = computeFeatures({
    t: grid.t,
    g: grid.g,
    mask: grid.mask,
    endAt: curve.endAt,
    finalYieldG: curve.finalYieldG,
    firstDripKnown: true,
    roastLevel: bean.roastLevel,
  });
  const prevShot = [...w.shots].reverse().find((s) => s.bagId === bag.id) ?? null;
  const prevRec = [...w.recommendations].reverse().find((r) => r.bagId === bag.id) ?? null;
  const shot: Shot = {
    ...w.rows.meta(atMs),
    bagId: bag.id,
    epochId: epoch.id,
    at: new Date(atMs).toISOString(),
    settings,
    context: { shotIndexOfDay: 1, appVersion: 'sim' },
    features,
    endedBy: 'tap',
    recommendationId: prevRec?.id ?? null,
    deviation: prevRec ? 'followed' : null,
  };
  w.shots.push(shot);
  const learn = features.valid;
  w.quality.push({ ...w.rows.meta(atMs), shotId: shot.id, status: 'ok', learn, notes: [] });
  if (w.rated) {
    const prevY = prevShot?.features.plateauFlow ? Math.log(prevShot.features.plateauFlow) : null;
    const yCup = Math.log(Math.max(0.05, features.plateauFlow ?? Math.exp(yObs)));
    w.ratings.push({
      ...w.rows.meta(atMs),
      shotId: shot.id,
      comparedToShotId: prevShot?.id ?? null,
      vsPrevious:
        prevY === null || !prevShot
          ? null
          : tasteVs(
              w.truth,
              { y: prevY, ratio: prevShot.settings.targetYieldG / prevShot.settings.doseG },
              { y: yCup, ratio: settings.targetYieldG / settings.doseG },
              w.rng,
            ),
      sourBitter: tasteSlider(w.truth, yCup, settings.targetYieldG / settings.doseG, w.rng),
      thinHeavy: tasteThinHeavy(w.truth, w.rng),
      chips: tasteChips(channel, w.rng),
      drink: 'black',
    });
  }
  const result = replay({
    epochs: w.epochs,
    beans: w.beans,
    bags: w.bags,
    shots: w.shots,
    ratings: w.ratings,
    quality: w.quality,
    recommendations: w.recommendations,
  });
  const ctx = bagContext(result, bag.id);
  const out = recommend({
    bag,
    bean,
    epoch,
    allowLowRpm: false,
    shots: ctx.views,
    model: result.model,
    setpoint: ctx.setpoint,
    current: settings,
    now: new Date(atMs + 60_000).toISOString(),
    shotsSinceRpmChange: ctx.shotsSinceRpmChange,
    tempCardShown: ctx.tempCardShown,
  });
  w.recommendations.push({ ...w.rows.meta(atMs + 60_000), ...out.rec });
  const nextLines = toLines(out.rec.next.grind.dialPos, epoch.dialSpec);
  const yTrueNext =
    trueLnFlow(
      w.truth,
      bagIndex,
      nextLines,
      out.rec.next.grind.rpm,
      out.rec.next.doseG,
      dayOffset + 1,
    ) + w.aShift;
  const kg = kGrind(result.model);
  const kr = kRpm(result.model);
  const sp = summary(ctx.setpoint);
  const view = ctx.views[ctx.views.length - 1];
  const pred = predictAt(result.model, bag.id, lines, settings.grind.rpm, settings.doseG);
  const step: SimStep = {
    k,
    bagIndex,
    settings,
    lines,
    yTrue,
    yObs,
    channel,
    learn,
    skipped: view?.skipped ?? false,
    rec: out.rec,
    row: out.row,
    yTrueNext,
    kgHat: kg.mean,
    kgSd: kg.sd,
    krHat: kr.mean,
    krSd: kr.sd,
    setpointMean: sp.mean,
    setpointSd: sp.sd,
    predErrCur: pred ? pred.yHat - yTrue : Number.NaN,
    excludedByModel: !learn || (view?.skipped ?? false),
    sStarEff: effectiveSetpoint(w.truth, settings.targetYieldG / settings.doseG),
  };
  w.steps.push(step);
  return step;
}

/** Recompute the recommendation without a new shot (what the app does when an epoch opens). */
function recommendOnly(w: World, bagIndex: number, atMs: number): void {
  const bag = w.bags[bagIndex];
  const bean = w.beans[0];
  const epoch = w.epochs[w.epochs.length - 1];
  if (!bag || !bean || !epoch) return;
  const current = currentSettingsFor(w, bagIndex, 0);
  const result = replay({
    epochs: w.epochs,
    beans: w.beans,
    bags: w.bags,
    shots: w.shots,
    ratings: w.ratings,
    quality: w.quality,
    recommendations: w.recommendations,
  });
  const ctx = bagContext(result, bag.id);
  const out = recommend({
    bag,
    bean,
    epoch,
    allowLowRpm: false,
    shots: ctx.views,
    model: result.model,
    setpoint: ctx.setpoint,
    current,
    now: new Date(atMs).toISOString(),
    shotsSinceRpmChange: ctx.shotsSinceRpmChange,
    tempCardShown: ctx.tempCardShown,
  });
  w.recommendations.push({ ...w.rows.meta(atMs), ...out.rec });
}

export function runScenario(cfg: ScenarioConfig): SimRun {
  const { seed, name } = cfg;
  switch (name) {
    case 'a':
    case 'a_miscount': {
      const w = makeWorld(
        seed,
        { bags: 1, channelProb: 0.1, ...(name === 'a_miscount' ? { dialMiscount: 2 } : {}) },
        false,
      );
      for (let k = 0; k < 8; k++) pullShot(w, 0, k, k);
      return { truth: w.truth, steps: w.steps };
    }
    case 'b': {
      const w = makeWorld(seed, { bags: 2, channelProb: 0.1 }, false);
      let k = 0;
      for (; k < 10; k++) pullShot(w, 0, k, k);
      for (let j = 0; j < 4; j++, k++) pullShot(w, 1, k, k);
      return { truth: w.truth, steps: w.steps };
    }
    case 'c':
    case 'd': {
      const w = makeWorld(seed, { bags: 1, channelProb: name === 'c' ? 0 : 0.2 }, true);
      for (let k = 0; k < 14; k++) pullShot(w, 0, k, k);
      return { truth: w.truth, steps: w.steps };
    }
    case 'e': {
      const w = makeWorld(seed, { bags: 1, channelProb: 0.1 }, false);
      for (let k = 0; k < 30; k++) pullShot(w, 0, k, k);
      return { truth: w.truth, steps: w.steps };
    }
    case 'f': {
      const w = makeWorld(seed, { bags: 1, channelProb: 0.1 }, false);
      let k = 0;
      for (; k < 8; k++) pullShot(w, 0, k, k);
      // A 0.1 mm washer: finer at the same reading, −k_g·20 lines.
      const prev = w.epochs[w.epochs.length - 1];
      if (!prev) throw new Error('no epoch');
      const atMs = START + k * DAY - 3600_000;
      w.epochs.push({
        ...w.rows.meta(atMs),
        startedAt: new Date(atMs).toISOString(),
        kind: 'washer_change',
        parentEpochId: prev.id,
        dialSpec: { ...prev.dialSpec },
        burrSet: prev.burrSet,
        washerCount: prev.washerCount + 1,
        springSet: prev.springSet,
        deltaWashers: 1,
        ...(prev.usualDial ? { usualDial: prev.usualDial } : {}),
      });
      w.aShift = -w.truth.kG * MODEL.washerLinesPer;
      // The app recomputes the card when an epoch opens: the user starts from the shifted dial.
      recommendOnly(w, 0, atMs + 60_000);
      for (let j = 0; j < 3; j++, k++) pullShot(w, 0, k, k);
      return { truth: w.truth, steps: w.steps };
    }
    case 'g': {
      const w = makeWorld(seed, { bags: 1, channelProb: 0.1 }, true);
      let k = 0;
      for (; k < 8; k++) pullShot(w, 0, k, k);
      // Six shots alternating 1000/1200 RPM at the held grind: three pairs.
      w.rpmOverride = (kk) => (kk >= 8 ? (kk % 2 === 0 ? 1000 : 1200) : null);
      for (let j = 0; j < 6; j++, k++) {
        pullShot(w, 0, k, k);
        // Hold the grind: overwrite the last recommendation's dial with the current one.
        const last = w.recommendations[w.recommendations.length - 1];
        const lastShot = w.shots[w.shots.length - 1];
        if (last && lastShot)
          last.next = {
            ...last.next,
            grind: { ...last.next.grind, dialPos: lastShot.settings.grind.dialPos },
          };
      }
      return { truth: w.truth, steps: w.steps };
    }
    case 'i': {
      const w = makeWorld(seed, { bags: 1, channelProb: 0.1, nonlinear: true }, false);
      for (let k = 0; k < 7; k++) pullShot(w, 0, k, k);
      return { truth: w.truth, steps: w.steps };
    }
    default:
      throw new Error(`unknown scenario ${String(name)}`);
  }
}

/** Fraction of runs satisfying `ok`. */
export function passRate(runs: SimRun[], ok: (r: SimRun) => boolean): number {
  if (runs.length === 0) return 0;
  return runs.filter(ok).length / runs.length;
}

export function runMany(name: ScenarioName, seeds: number): SimRun[] {
  const out: SimRun[] = [];
  for (let s = 1; s <= seeds; s++) out.push(runScenario({ seed: s, name }));
  return out;
}

export const BAND = RULES.beta;
export const ROUTE_BAND = RULES.betaRoute;
export type { Id };
export { SIM };
