/**
 * Scenario runner: a seeded hidden truth, a simulated user who follows every
 * recommendation, curves synthesised and pushed through the real feature extractor, rows
 * built exactly as the app stores them, and the real replay() + recommend() in the loop.
 * RPM calibration (scenarios k–n): the user starts a run, pulls the tagged slots minutes
 * apart, reports E006 stalls, and the run ends when the planner says so (as the app does).
 */
import { computeFeatures } from '../curve/features';
import { resample } from '../curve/resample';
import { predictAt } from '../flowmodel/invert';
import { kGrind, kRpm, kRpmCurv } from '../flowmodel/state';
import { randomBytesFrom, uuidv7 } from '../ids';
import { mulberry32, type Rng, randn, uniform } from '../math/rng';
import { MODEL, RPM, RULES, SIM } from '../params';
import { type RecommendationCore, recommend } from '../recommend';
import { bagContext, replay } from '../replay';
import { balanceSd } from '../rpm/balance';
import type { CalibrationProgress } from '../rpm/calibration';
import { initPreference, type PreferenceSummary, summarizePreference } from '../rpm/preference';
import { allowedRpmRange } from '../rpm/range';
import { summary } from '../setpoint/grid';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Id,
  Meta,
  Rating,
  Recommendation,
  RpmCalibrationRun,
  Shot,
  ShotQuality,
  ShotSettings,
} from '../types';
import { DEFAULT_DIAL_SPEC, fromLines, toLines } from '../units';
import { randomSpec, synthCurve } from './curveSynth';
import { tasteChips, tasteSlider, tasteThinHeavy, tasteVs } from './taste';
import { effectiveSetpoint, sampleTruth, type Truth, type TruthOptions, trueLnFlow } from './truth';

export type ScenarioName =
  | 'a'
  | 'a_miscount'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'i'
  | 'k'
  | 'l'
  | 'm'
  | 'n';

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
  /** Huber weight the flow model gave the shot. */
  weight: number;
  /** Feature flags and curve channel score of the extracted shot. */
  flags: string[];
  channelScore: number;
  /** The grinder stalled (E006): saved as `stalled`, not learned from, floor raised. */
  stalled: boolean;
  /** The simulated tasting of this shot (null when unrated or stalled). */
  rating: Rating | null;
  /** Recommendation issued after this shot. */
  rec: RecommendationCore;
  row: number;
  /** True ln flow at the recommended next settings (what following it would give). */
  yTrueNext: number;
  kgHat: number;
  kgSd: number;
  krHat: number;
  krSd: number;
  kqHat: number;
  deltaHat: number;
  deltaSd: number;
  setpointMean: number;
  setpointSd: number;
  /** Prediction error of the model at the current settings. */
  predErrCur: number;
  excludedByModel: boolean;
  /** Flow that tastes balanced at the shot's ratio and RPM (the setpoint the app should find). */
  sStarEff: number;
  /** Target ln flow of the recommendation this shot followed (null for the first shot). */
  aimLn: number | null;
  /** Calibration slot the shot was pulled for, if any. */
  slot: number | null;
  /** Planner state after this shot (null when no run is active). */
  calibration: CalibrationProgress | null;
  /** Preferred-RPM posterior summary after this shot. */
  pref: PreferenceSummary;
  /** RPM range in force for this bag when recommending (stalls raise the floor). */
  range: [number, number];
}

export interface SimRun {
  truth: Truth;
  steps: SimStep[];
  /** Step indices where scenario phases begin (calibration start/end, second bag). */
  marks: Record<string, number>;
  runs: RpmCalibrationRun[];
}

export interface ScenarioConfig {
  seed: number;
  name: ScenarioName;
}

const START = Date.UTC(2026, 9, 1, 9);
const DAY = 86_400_000;
/** Calibration shots are pulled ten minutes apart. */
const CAL_GAP_DAYS = 10 / 1440;

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
  rpmRuns: RpmCalibrationRun[];
  rpmRange: [number, number];
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
    rpmRuns: [],
    rpmRange: [RPM.rangeDefault[0], RPM.rangeDefault[1]],
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

function activeRunOf(w: World, bagId: Id): RpmCalibrationRun | null {
  const epoch = w.epochs[w.epochs.length - 1];
  return (
    w.rpmRuns.find((r) => r.status === 'active' && r.bagId === bagId && r.epochId === epoch?.id) ??
    null
  );
}

interface Recommended {
  out: ReturnType<typeof recommend>;
  result: ReturnType<typeof replay>;
  ctx: ReturnType<typeof bagContext>;
}

/** replay() + recommend() as the app runs them; ends the active run when the planner stops. */
function recommendFor(
  w: World,
  bagIndex: number,
  current: ShotSettings,
  nowMs: number,
): Recommended {
  const bag = w.bags[bagIndex];
  const bean = w.beans[0];
  const epoch = w.epochs[w.epochs.length - 1];
  if (!bag || !bean || !epoch) throw new Error('world incomplete');
  const result = replay({
    epochs: w.epochs,
    beans: w.beans,
    bags: w.bags,
    shots: w.shots,
    ratings: w.ratings,
    quality: w.quality,
    recommendations: w.recommendations,
    rpmRuns: w.rpmRuns,
  });
  const ctx = bagContext(result, bag.id);
  const out = recommend({
    bag,
    bean,
    epoch,
    pref: result.prefByBean.get(bean.id) ?? initPreference(),
    shots: ctx.views,
    model: result.model,
    setpoint: ctx.setpoint,
    current,
    now: new Date(nowMs).toISOString(),
    shotsSinceBodyMove: ctx.shotsSinceBodyMove,
    balance: result.balance,
    tempCardShown: ctx.tempCardShown,
    rpmRange: w.rpmRange,
    rpmRuns: w.rpmRuns,
  });
  const run = activeRunOf(w, bag.id);
  if (run && out.calibration && out.calibration.next === null) {
    const r = out.calibration.stopReason;
    run.status = r === 'complete' || r === 'early' ? 'done' : 'stopped';
    run.endedAt = new Date(nowMs).toISOString();
    run.updatedAt = run.endedAt;
    if (r) run.note = r;
  }
  w.recommendations.push({ ...w.rows.meta(nowMs), ...out.rec });
  return { out, result, ctx };
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
  const rpm = settings.grind.rpm;
  const yTrue = trueLnFlow(w.truth, bagIndex, lines, rpm, settings.doseG, dayOffset) + w.aShift;
  const channel = w.rng() < w.truth.channelProb;
  const yObs =
    yTrue +
    (channel ? uniform(w.rng, w.truth.channelLn[0], w.truth.channelLn[1]) : 0) +
    MODEL.sigmaY * randn(w.rng);
  const atMs = START + Math.round(day * DAY);
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
  const stalledIds = new Set(w.quality.filter((q) => q.status === 'stalled').map((q) => q.shotId));
  const prevShot =
    [...w.shots].reverse().find((s) => s.bagId === bag.id && !stalledIds.has(s.id)) ?? null;
  const prevRec = [...w.recommendations].reverse().find((r) => r.bagId === bag.id) ?? null;
  const stalled = w.truth.stallBelow !== null && rpm < w.truth.stallBelow;
  const tag = prevRec?.calibration && prevRec.next.grind.rpm === rpm ? prevRec.calibration : null;
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
    ...(tag ? { calibration: { ...tag } } : {}),
  };
  w.shots.push(shot);
  const learn = features.valid && !stalled;
  w.quality.push({
    ...w.rows.meta(atMs),
    shotId: shot.id,
    status: stalled ? 'stalled' : 'ok',
    learn,
    notes: stalled ? ['E006'] : [],
  });
  if (stalled) {
    bag.stalls = [...(bag.stalls ?? []), { at: shot.at, rpm, shotId: shot.id }];
  } else if (w.rated) {
    const prevY = prevShot?.features.plateauFlow ? Math.log(prevShot.features.plateauFlow) : null;
    const yCup = Math.log(Math.max(0.05, features.plateauFlow ?? Math.exp(yObs)));
    const ratio = settings.targetYieldG / settings.doseG;
    w.ratings.push({
      ...w.rows.meta(atMs),
      shotId: shot.id,
      comparedToShotId: prevShot?.id ?? null,
      vsPrevious:
        prevY === null || !prevShot
          ? null
          : tasteVs(
              w.truth,
              {
                y: prevY,
                ratio: prevShot.settings.targetYieldG / prevShot.settings.doseG,
                rpm: prevShot.settings.grind.rpm,
              },
              { y: yCup, ratio, rpm },
              w.rng,
            ),
      sourBitter: tasteSlider(w.truth, yCup, ratio, w.rng, rpm),
      thinHeavy: tasteThinHeavy(w.truth, w.rng, rpm),
      chips: tasteChips(channel, w.rng),
      drink: 'black',
    });
  }
  const { out, result, ctx } = recommendFor(w, bagIndex, settings, atMs + 60_000);
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
  const kq = kRpmCurv(result.model);
  const sp = summary(ctx.setpoint);
  const view = ctx.views[ctx.views.length - 1];
  const pred = predictAt(result.model, bag.id, lines, rpm, settings.doseG);
  const range = allowedRpmRange(w.rpmRange, [bag]);
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
    weight: view?.w ?? 0,
    flags: [...features.flags],
    channelScore: features.curveChannelScore,
    stalled,
    rating: !stalled && w.rated ? (w.ratings[w.ratings.length - 1] ?? null) : null,
    rec: out.rec,
    row: out.row,
    yTrueNext,
    kgHat: kg.mean,
    kgSd: kg.sd,
    krHat: kr.mean,
    krSd: kr.sd,
    kqHat: kq.mean,
    deltaHat: result.balance.mean,
    deltaSd: balanceSd(result.balance),
    setpointMean: sp.mean,
    setpointSd: sp.sd,
    predErrCur: pred ? pred.yHat - yTrue : Number.NaN,
    excludedByModel: !learn || (view?.skipped ?? false),
    sStarEff: effectiveSetpoint(w.truth, settings.targetYieldG / settings.doseG, rpm),
    aimLn: prevRec?.targetLnFlow ?? null,
    slot: tag?.slot ?? null,
    calibration: out.calibration,
    pref: summarizePreference(result.prefByBean.get(bean.id) ?? initPreference(), range),
    range: [range[0], range[1]],
  };
  w.steps.push(step);
  return step;
}

/** Recompute the recommendation without a new shot (what the app does when an epoch opens). */
function recommendOnly(w: World, bagIndex: number, atMs: number): void {
  if (!w.bags[bagIndex] || !w.beans[0] || !w.epochs[w.epochs.length - 1]) return;
  recommendFor(w, bagIndex, currentSettingsFor(w, bagIndex, 0), atMs);
}

/** The user accepts the calibration offer: a run row, then the card for slot 0 at once. */
function startRun(w: World, bagIndex: number, atMs: number): RpmCalibrationRun {
  const bag = w.bags[bagIndex];
  const epoch = w.epochs[w.epochs.length - 1];
  if (!bag || !epoch) throw new Error('world incomplete');
  const run: RpmCalibrationRun = {
    ...w.rows.meta(atMs),
    epochId: epoch.id,
    bagId: bag.id,
    startedAt: new Date(atMs).toISOString(),
    status: 'active',
  };
  w.rpmRuns.push(run);
  recommendOnly(w, bagIndex, atMs + 1000);
  return run;
}

/**
 * Pull the calibration session minutes apart, starting on day `day`; stops when the run ends
 * or after `cap` shots. Returns the next free shot index.
 */
function pullSession(w: World, bagIndex: number, day: number, k0: number, cap = 14): number {
  const bag = w.bags[bagIndex];
  if (!bag) throw new Error('no bag');
  let k = k0;
  for (let j = 0; j < cap && activeRunOf(w, bag.id); j++, k++) {
    pullShot(w, bagIndex, day + j * CAL_GAP_DAYS, k);
  }
  return k;
}

function finish(w: World, marks: Record<string, number> = {}): SimRun {
  return { truth: w.truth, steps: w.steps, marks, runs: w.rpmRuns };
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
      return finish(w);
    }
    case 'b': {
      const w = makeWorld(seed, { bags: 2, channelProb: 0.1 }, false);
      let k = 0;
      for (; k < 10; k++) pullShot(w, 0, k, k);
      for (let j = 0; j < 4; j++, k++) pullShot(w, 1, k, k);
      return finish(w);
    }
    case 'c':
    case 'd': {
      const w = makeWorld(seed, { bags: 1, channelProb: name === 'c' ? 0 : 0.2 }, true);
      for (let k = 0; k < 14; k++) pullShot(w, 0, k, k);
      return finish(w);
    }
    case 'e': {
      const w = makeWorld(seed, { bags: 1, channelProb: 0.1 }, false);
      for (let k = 0; k < 30; k++) pullShot(w, 0, k, k);
      return finish(w);
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
      return finish(w);
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
      return finish(w);
    }
    case 'i': {
      const w = makeWorld(seed, { bags: 1, channelProb: 0.1, nonlinear: true }, false);
      for (let k = 0; k < 7; k++) pullShot(w, 0, k, k);
      return finish(w);
    }
    case 'k':
    case 'l':
    case 'n': {
      // k: a calibration session after 8 rated shots; l: then 10 daily shots (body moves);
      // n: the grinder stalls below 750 RPM, so block 1's low level (700) hits E006.
      const w = makeWorld(
        seed,
        { bags: 1, channelProb: 0.1, ...(name === 'n' ? { stallBelow: 750 } : {}) },
        true,
      );
      let k = 0;
      for (; k < 8; k++) pullShot(w, 0, k, k);
      const marks: Record<string, number> = { calStart: w.steps.length };
      startRun(w, 0, START + 8 * DAY - 600_000);
      k = pullSession(w, 0, 8, k, name === 'n' ? 16 : 14);
      marks.calEnd = w.steps.length;
      if (name === 'l') for (let j = 0; j < 10; j++, k++) pullShot(w, 0, 9 + j, k);
      return finish(w, marks);
    }
    case 'm': {
      // A calibrated grinder with |k_r| ≥ 0.03, then a bag 0.3 ln faster (≈ 35 %) whose
      // balanced dial sits a few lines below chirp + 5: only the backup RPM lever reaches the band.
      const sign = seed % 2 === 0 ? 1 : -1;
      const mag = 0.03 + (0.03 * ((seed * 7919) % 101)) / 100;
      const w = makeWorld(seed, { bags: 2, channelProb: 0.1, kR: sign * mag }, true);
      const t = w.truth;
      t.aBags[1] = (t.aBags[0] ?? 0) + 0.3;
      const ratio1 = (w.bags[1]?.targetYieldG ?? 36) / (w.bags[1]?.doseDefaultG ?? 18);
      const L1 = t.LrefTrue + (effectiveSetpoint(t, ratio1) - (t.aBags[1] ?? 0)) / t.kG;
      const gapLines = Math.ceil((RULES.beta + 0.04) / t.kG);
      const chirpLines = Math.round(L1) + gapLines - MODEL.chirpMarginLines;
      const epoch0 = w.epochs[0];
      if (epoch0) epoch0.chirp = fromLines(chirpLines, DEFAULT_DIAL_SPEC);
      let k = 0;
      for (; k < 8; k++) pullShot(w, 0, k, k);
      const marks: Record<string, number> = { calStart: w.steps.length };
      startRun(w, 0, START + 8 * DAY - 600_000);
      k = pullSession(w, 0, 8, k);
      marks.calEnd = w.steps.length;
      marks.bag1 = w.steps.length;
      marks.floorLines = chirpLines + MODEL.chirpMarginLines;
      for (let j = 0; j < 8; j++, k++) pullShot(w, 1, 9 + j, k);
      return finish(w, marks);
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
