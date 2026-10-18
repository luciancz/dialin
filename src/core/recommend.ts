/**
 * Arbitration: rule rows → one lever → next settings, a sentence, a confidence built from
 * parameter uncertainty only (Φ(β/s_p) − Φ(−β/s_p)), the predicted band (which does include
 * σ_y), the why-not list and a snapshot of the model numbers.
 */
import { invert, predictAt } from './flowmodel/invert';
import {
  aBag,
  addBag,
  type BagMeta,
  bagOf,
  cloneState,
  type FlowModelState,
  kDose,
  kGrind,
  kRpm,
} from './flowmodel/state';
import { phi } from './math/normal';
import { MODEL, RULES } from './params';
import {
  firstShotSentence,
  grindSentence,
  noneSentence,
  outlierSentence,
  prepSentence,
  rpmSentence,
  temperatureSentence,
  waitSentence,
  yieldSentence,
} from './rules/explain';
import { activeBand, deriveStage, freshnessGateDays } from './rules/stages';
import { evaluateRules, type RuleShot } from './rules/table';
import { compassVeto } from './rules/veto';
import { afterProbe, chooseTarget, type SetpointPosterior, summary } from './setpoint/grid';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  ConfidenceWord,
  Meta,
  Rating,
  Recommendation,
  Shot,
  ShotQuality,
  ShotSettings,
  Stage,
  TempSwitch,
} from './types';
import { fromLines, toLines } from './units';

export interface ShotView {
  shot: Shot;
  rating: Rating | null;
  quality: ShotQuality | null;
  lines: number;
  /** ln(plateauFlow) or null. */
  y: number | null;
  learn: boolean;
  channelFlag: boolean;
  /** Model prediction at the shot's settings before it was observed. */
  predictedY: number | null;
  r: number | null;
  skipped: boolean;
  /** Realised flow within β of the setpoint when it was rated (temperature rule). */
  inBandAtRating: boolean;
}

export type RecommendationCore = Omit<Recommendation, keyof Meta>;

export interface RecommendInput {
  bag: Bag;
  bean: Bean;
  epoch: CalibrationEpoch;
  allowLowRpm: boolean;
  shots: ShotView[];
  model: FlowModelState;
  setpoint: SetpointPosterior;
  current: ShotSettings;
  now: string;
  shotsSinceRpmChange: number;
  tempCardShown: boolean;
}

export interface RecommendOutput {
  rec: RecommendationCore;
  /** Setpoint after a probe side flip (unchanged otherwise). */
  setpoint: SetpointPosterior;
  row: number;
}

export function bagMetaOf(bean: Bean, bag: Bag): BagMeta {
  const recipe =
    bag.roasterRecipe?.yieldG !== undefined || bag.roasterRecipe?.timeS !== undefined
      ? {
          ...(bag.roasterRecipe.yieldG !== undefined ? { yieldG: bag.roasterRecipe.yieldG } : {}),
          ...(bag.roasterRecipe.timeS !== undefined ? { timeS: bag.roasterRecipe.timeS } : {}),
        }
      : undefined;
  return {
    roastLevel: bean.roastLevel,
    process: bean.process,
    decaf: bean.decaf,
    roastTarget: bean.roastTarget,
    roastDate: bag.roastDate,
    doseDefaultG: bag.doseDefaultG,
    recipe,
  };
}

export function confidenceWord(
  c: number,
  lever: RecommendationCore['lever'],
  probe: boolean,
): ConfidenceWord {
  if (lever === 'none' || lever === 'wait' || lever === 'prep') return 'insufficient';
  if (probe) return 'probe';
  if (c >= RULES.firm) return 'firm';
  if (c >= RULES.probable) return 'probable';
  return 'probe';
}

export function recommend(input: RecommendInput): RecommendOutput {
  const { bag, bean, epoch, current, shots } = input;
  const spec = epoch.dialSpec;
  const chirp = epoch.chirp ? toLines(epoch.chirp, spec) : null;
  const curLines = toLines(current.grind.dialPos, spec);
  const model = cloneState(input.model);
  const meta = bagMetaOf(bean, bag);
  const hadBag = bagOf(model, bag.id) !== undefined;
  if (!hadBag) addBag(model, bag.id, meta, curLines, input.now);
  const learnable = shots.filter((s) => s.learn && s.y !== null);
  const fromPrior = learnable.length === 0;

  const pred = predictAt(model, bag.id, curLines, current.grind.rpm, current.doseG);
  const yHatCur = pred?.yHat ?? null;
  const sp = summary(input.setpoint);
  const sStar = sp.mean;
  const betaB = activeBand(sp.sd);
  const kg = kGrind(model);
  const ageDays = Math.max(0, (Date.parse(input.now) - Date.parse(bag.roastDate)) / 86_400_000);
  const last = shots[shots.length - 1] ?? null;
  const lastRating = last?.rating ?? null;
  const v = lastRating?.sourBitter ?? null;
  const ruleShots: RuleShot[] = shots.map((s) => ({
    y: s.y,
    learn: s.learn,
    channelFlag: s.channelFlag,
    predictedY: s.predictedY,
    skipped: s.skipped,
    r: s.r,
    rating: s.rating
      ? {
          vs: s.rating.vsPrevious,
          v: s.rating.sourBitter,
          h: s.rating.thinHeavy,
          chips: s.rating.chips,
        }
      : null,
    rpm: s.shot.settings.grind.rpm,
    inBandAtRating: s.inBandAtRating,
  }));
  const outlierPending = model.lastOutlier?.bagId === bag.id;
  const { decision, whyNot } = evaluateRules({
    shots: ruleShots,
    yHatCur,
    sStar,
    setpointSd: sp.sd,
    betaB,
    kGrindSd: kg.sd,
    ageDays,
    gateDays: freshnessGateDays(bean.roastLevel),
    roastLevel: bean.roastLevel,
    doseG: current.doseG,
    targetYieldG: current.targetYieldG,
    rpm: current.grind.rpm,
    shotsSinceRpmChange: input.shotsSinceRpmChange,
    allowLowRpm: input.allowLowRpm,
    tempCardShown: input.tempCardShown,
    outlierPending,
    learnableCount: learnable.length,
  });

  let next: ShotSettings = {
    ...current,
    grind: { ...current.grind, rpmConfirmed: false },
  };
  const vetoes: string[] = [];
  let lever: RecommendationCore['lever'] = decision.lever;
  let targetY = sStar;
  let sentence = '';
  let probe = false;
  let source: RecommendationCore['source'] = 'rules';
  let setpointOut = input.setpoint;
  let stage: Stage = deriveStage({
    offBand: yHatCur === null ? Number.POSITIVE_INFINITY : Math.abs(yHatCur - sStar),
    kGrindSd: kg.sd,
    predictedInBand: shots.filter(
      (s) => s.learn && s.predictedY !== null && Math.abs(s.predictedY - sStar) <= RULES.beta,
    ).length,
    setpointSd: sp.sd,
  });
  const delta: RecommendationCore['delta'] = {};
  const tLast = last?.shot.features.totalTimeS ?? 30;
  const secPerLine = tLast * kg.mean;
  const secPerLineSd = tLast * kg.sd;
  const learning = kg.sd > MODEL.kGrindSdConverged;

  const grindTo = (yTarget: number, halfStep = false): void => {
    targetY = yTarget;
    const inv = invert(model, bag.id, yTarget, next.grind.rpm, next.doseG, curLines, spec, chirp);
    let d = inv?.deltaLines ?? 0;
    if (halfStep) d = Math.round(d / 2);
    const cv = compassVeto({ v, offset: yHatCur === null ? 0 : yHatCur - sStar, deltaLines: d });
    d = cv.deltaLines;
    if (cv.veto) vetoes.push(cv.veto);
    if (inv) vetoes.push(...inv.vetoes);
    if (inv?.probeStep && Math.abs((inv.raw ?? 0) - curLines) > MODEL.probeStepLines) probe = true;
    if (d === 0) {
      lever = 'none';
      sentence = noneSentence({
        yHat: yHatCur ?? sStar,
        targetY: yTarget,
        lastRating: lastRating?.vsPrevious ?? 'unrated',
      });
      return;
    }
    const toLinesN = Math.max(0, curLines + d);
    const toPos = fromLines(toLinesN, spec);
    next = { ...next, grind: { ...next.grind, dialPos: toPos } };
    delta.lines = toLines(toPos, spec) - curLines;
    sentence = grindSentence({
      deltaLines: delta.lines,
      from: current.grind.dialPos,
      to: toPos,
      rpm: next.grind.rpm,
      yieldG: next.targetYieldG,
      lastY: last?.y ?? null,
      targetY: yTarget,
      secPerLine,
      secPerLineSd,
      learning,
    });
  };

  switch (decision.row) {
    case 1:
      sentence = prepSentence({
        signs: decision.signs,
        dial: current.grind.dialPos,
        rpm: current.grind.rpm,
      });
      break;
    case 2:
      if (decision.lever === 'wait') {
        sentence = waitSentence({
          ageDays: Math.floor(ageDays),
          dial: current.grind.dialPos,
          rpm: current.grind.rpm,
          yieldG: current.targetYieldG,
          gateDay: freshnessGateDays(bean.roastLevel),
        });
      } else {
        source = 'flowModel';
        grindTo(sStar, true);
        vetoes.push('freshness gate: half step only while the bean is this young');
      }
      break;
    case 3: {
      const z = model.lastOutlier?.r ?? 0;
      sentence = outlierSentence({ lastY: last?.y ?? sStar, z, dial: current.grind.dialPos });
      break;
    }
    case 4:
      source = 'flowModel';
      stage = 'B_grind';
      grindTo(sStar);
      break;
    case 5:
    case 7:
      stage = 'C_ratio';
      next = { ...next, targetYieldG: Math.round(decision.newYieldG * 2) / 2 };
      delta.yieldG = next.targetYieldG - current.targetYieldG;
      sentence = yieldSentence({
        dial: current.grind.dialPos,
        yieldG: next.targetYieldG,
        prevYieldG: current.targetYieldG,
        lastY: last?.y ?? null,
        taste: decision.taste,
      });
      break;
    case 6:
    case 8:
      source = 'flowModel';
      stage = 'D_hone';
      grindTo(decision.target);
      break;
    case 9:
      stage = 'F_rpm';
      next = { ...next, grind: { ...next.grind, rpm: decision.newRpm, rpmConfirmed: false } };
      delta.rpm = decision.newRpm - current.grind.rpm;
      sentence = rpmSentence({
        dial: current.grind.dialPos,
        rpm: decision.newRpm,
        prevRpm: current.grind.rpm,
        texture: decision.texture,
        k: decision.k,
      });
      setpointOut = input.setpoint;
      break;
    case 10: {
      stage = 'E_temp';
      const dir = decision.taste === 'sour' ? 1 : -1;
      const to = (current.tempSwitch + dir) as number;
      const toSwitch: TempSwitch | null = to >= 0 && to <= 2 ? (to as TempSwitch) : null;
      sentence = temperatureSentence({
        from: current.tempSwitch,
        to: toSwitch,
        nudge: decision.taste === 'sour' ? 'flush 5 s before' : 'wait 2 min after flush',
        k: decision.k,
        n: decision.n,
        taste: decision.taste,
      });
      break;
    }
    case 11:
      sentence = noneSentence({
        yHat: yHatCur ?? sStar,
        targetY: sStar,
        lastRating: lastRating?.vsPrevious ?? 'unrated',
      });
      break;
    case 12: {
      source = 'setpoint';
      stage = stage === 'B_grind' ? 'B_grind' : 'D_hone';
      const choice = chooseTarget(input.setpoint, (bag.tsSeed + shots.length) >>> 0);
      if (choice.mode === 'probe') setpointOut = afterProbe(input.setpoint);
      if (choice.mode !== 'mean') probe = probe || sp.sd > RULES.setpointSdConverged;
      grindTo(choice.yStar);
      if (lever === 'grind' && choice.mode !== 'mean') {
        sentence +=
          choice.mode === 'thompson'
            ? ' Target drawn from the taste posterior.'
            : ' Deliberate probe to one side of the setpoint.';
      }
      break;
    }
    default:
      break;
  }

  if (fromPrior && shots.length === 0) {
    sentence = firstShotSentence({
      dial: next.grind.dialPos,
      rpm: next.grind.rpm,
      yieldG: next.targetYieldG,
      fromPrior: hadBag || model.pooled.length > 0 || model.bags.length > 1,
    });
  }

  const nextLines = toLines(next.grind.dialPos, spec);
  const predNext = predictAt(model, bag.id, nextLines, next.grind.rpm, next.doseG);
  const sP = predNext?.sP ?? 1;
  const sPred = predNext?.sPred ?? 1;
  const yHatNext = predNext?.yHat ?? sStar;
  const confidence = Math.max(0, Math.min(1, 2 * phi(RULES.beta / Math.max(1e-9, sP)) - 1));
  const word = confidenceWord(confidence, lever, probe);
  const a = aBag(model, bag.id);
  const rec: RecommendationCore = {
    bagId: bag.id,
    afterShotId: last?.shot.id ?? null,
    lever,
    stage,
    next,
    delta,
    targetLnFlow: targetY,
    predictedLnFlow: yHatNext,
    predictedBand: [Math.exp(yHatNext - sPred), Math.exp(yHatNext + sPred)],
    confidence,
    confidenceWord: word,
    sentence,
    whyNot,
    vetoes,
    source,
    snapshot: {
      kGrind: [kg.mean, kg.sd],
      kRpm: [kRpm(model).mean, kRpm(model).sd],
      kDose: [kDose(model).mean, kDose(model).sd],
      aBag: [a?.mean ?? Number.NaN, a?.sd ?? Number.NaN],
      setpoint: [sp.mean, sp.sd],
    },
  };
  return { rec, setpoint: setpointOut, row: decision.row };
}
