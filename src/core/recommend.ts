/**
 * Arbitration: rule rows → one lever → next settings, a sentence, a confidence built from
 * parameter uncertainty only (Φ(β/s_p) − Φ(−β/s_p)), the predicted band (which does include
 * σ_y), the why-not list and a snapshot of the model numbers.
 *
 * RPM (plan "RPM calibration"): an active calibration run takes the next slot (row 13); a
 * calibrated grinder lets the body move (row 9) change RPM with a compensated dial; the grind
 * path uses RPM as a backup lever when the dial is clamped and as a fine trim below one line.
 */
import { predictAt } from './flowmodel/invert';
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
  kRpmCurv,
} from './flowmodel/state';
import { phi } from './math/normal';
import { MODEL, RULES } from './params';
import { type Balance, balanceSd, initBalance, sStarAt } from './rpm/balance';
import {
  CALIBRATION_SLOTS,
  type CalibrationProgress,
  isCalibrated,
  offerBlocker,
  planCalibration,
} from './rpm/calibration';
import { backupRpm, bodyMoveTarget, compensatedDial, type LeverCtx, trimRpm } from './rpm/levers';
import {
  initPreference,
  probImprove,
  type RpmPreference,
  summarizePreference,
} from './rpm/preference';
import { allowedRpmRange, clampRpm, e006Guidance, uOf } from './rpm/range';
import {
  backupSentence,
  bodySentence,
  calibrationSentence,
  firstShotSentence,
  grindSentence,
  noneSentence,
  outlierSentence,
  prepSentence,
  temperatureSentence,
  trimSentence,
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
  RpmCalibrationRun,
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
  /** u = (RPM − 1000)/100 of the shot. */
  u: number;
  /** y referenced to 1000 RPM through the balance shift: y − δ̂·u (null when y is). */
  yRef: number | null;
  /** Huber weight the flow model gave the shot (0 when skipped or not learnable). */
  w: number;
}

export type RecommendationCore = Omit<Recommendation, keyof Meta>;

export interface RecommendInput {
  bag: Bag;
  bean: Bean;
  epoch: CalibrationEpoch;
  shots: ShotView[];
  model: FlowModelState;
  setpoint: SetpointPosterior;
  current: ShotSettings;
  now: string;
  /** Shots pulled since the last followed body (rpm) move. */
  shotsSinceBodyMove: number;
  tempCardShown: boolean;
  /** Balance shift δ (s* moves by δ·u with RPM); none = no shift. */
  balance?: Balance;
  /** Preferred-RPM posterior for this bean; none = population prior. */
  pref?: RpmPreference;
  /** Settings RPM range (stalls on the bag raise its floor); none = 500–1600. */
  rpmRange?: readonly [number, number] | undefined;
  /** RPM calibration runs (any epoch/bag; filtered here). */
  rpmRuns?: readonly RpmCalibrationRun[];
}

export interface RecommendOutput {
  rec: RecommendationCore;
  /** Setpoint after a probe side flip (unchanged otherwise). */
  setpoint: SetpointPosterior;
  row: number;
  /** Progress of the active calibration run on this bag, if any. */
  calibration: CalibrationProgress | null;
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
  if (lever === 'calibrate') return 'probe';
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
  const curRpm = current.grind.rpm;
  const model = cloneState(input.model);
  const meta = bagMetaOf(bean, bag);
  const hadBag = bagOf(model, bag.id) !== undefined;
  if (!hadBag) addBag(model, bag.id, meta, curLines, input.now);
  const learnable = shots.filter((s) => s.learn && s.y !== null);
  const fromPrior = learnable.length === 0;

  const pred = predictAt(model, bag.id, curLines, curRpm, current.doseG);
  const yHatCur = pred?.yHat ?? null;
  const sp = summary(input.setpoint);
  // The setpoint posterior is for 1000 RPM; the balanced flow at an RPM is shifted by δ̂·u.
  const balance = input.balance ?? initBalance();
  const targetAt = (rpm: number) => sStarAt(sp.mean, balance, uOf(rpm));
  const sStar = targetAt(curRpm);
  const betaB = activeBand(sp.sd);
  const kg = kGrind(model);
  const ageDays = Math.max(0, (Date.parse(input.now) - Date.parse(bag.roastDate)) / 86_400_000);
  const last = shots[shots.length - 1] ?? null;
  const lastRating = last?.rating ?? null;
  const v = lastRating?.sourBitter ?? null;

  // ---- RPM context ----
  const range = allowedRpmRange(input.rpmRange, [bag]);
  const pref = input.pref ?? initPreference();
  const prefSummary = summarizePreference(pref, range);
  const calibrated = isCalibrated(model);
  const runsThisEpoch = (input.rpmRuns ?? []).filter((r) => r.epochId === epoch.id && !r.deleted);
  const activeRun = runsThisEpoch.find((r) => r.status === 'active' && r.bagId === bag.id) ?? null;
  const progress = activeRun
    ? planCalibration({
        run: activeRun,
        views: shots,
        model,
        bagId: bag.id,
        pref,
        range,
        currentRpm: curRpm,
        doseG: current.doseG,
        doseDefaultG: bag.doseDefaultG,
      })
    : null;
  const bodyTarget = bodyMoveTarget(curRpm, prefSummary.bayesRpm, range);
  const ctx: LeverCtx = {
    model,
    bagId: bag.id,
    doseG: current.doseG,
    spec,
    chirpLines: chirp,
    curLines,
    range,
    targetAt,
  };

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
    rpm: curRpm,
    rpmFacts: {
      calibrated,
      krSd: kRpm(model).sd,
      pref: pref.ratings > 0 ? prefSummary : null,
      shotsSinceBodyMove: input.shotsSinceBodyMove,
      bodyTarget,
      probImprove: probImprove(pref, curRpm, bodyTarget),
    },
    calibration: progress?.next ?? null,
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
  let calibrationTag: RecommendationCore['calibration'];
  let bodyConfidence: number | undefined;

  const setRpmAndDial = (rpm: number, lines: number): void => {
    const toPos = fromLines(lines, spec);
    next = { ...next, grind: { ...next.grind, dialPos: toPos, rpm, rpmConfirmed: false } };
    const dl = toLines(toPos, spec) - curLines;
    if (dl !== 0) delta.lines = dl;
    if (rpm !== curRpm) delta.rpm = rpm - curRpm;
  };

  /** Fine trim when the dial step rounds to zero; returns true when it produced the card. */
  const tryTrim = (): boolean => {
    if (!calibrated) return false;
    const t = trimRpm(ctx, curLines, curRpm, prefSummary.band);
    if (!t) return false;
    lever = 'grind';
    source = 'rpmModel';
    setRpmAndDial(t.rpm, curLines);
    targetY = targetAt(t.rpm);
    sentence = trimSentence({
      rpm: t.rpm,
      prevRpm: curRpm,
      dial: current.grind.dialPos,
      before: t.before,
      after: t.after,
    });
    return true;
  };

  const grindTo = (yTarget: number, halfStep = false): void => {
    targetY = yTarget;
    const inv = compensatedDial({ ...ctx, targetAt: () => yTarget }, curRpm);
    let d = inv?.deltaLines ?? 0;
    if (halfStep) d = Math.round(d / 2);
    const cv = compassVeto({ v, offset: yHatCur === null ? 0 : yHatCur - sStar, deltaLines: d });
    d = cv.deltaLines;
    if (cv.veto) vetoes.push(cv.veto);
    if (inv) vetoes.push(...inv.vetoes);
    if (inv?.probeStep && Math.abs((inv.raw ?? 0) - curLines) > MODEL.probeStepLines) probe = true;
    if (d === 0) {
      if (!halfStep && tryTrim()) return;
      lever = 'none';
      sentence = noneSentence({
        yHat: yHatCur ?? sStar,
        targetY: yTarget,
        lastRating: lastRating?.vsPrevious ?? 'unrated',
      });
      return;
    }
    const toLinesN = Math.max(0, curLines + d);
    setRpmAndDial(curRpm, toLinesN);
    sentence = grindSentence({
      deltaLines: toLines(next.grind.dialPos, spec) - curLines,
      from: current.grind.dialPos,
      to: next.grind.dialPos,
      rpm: curRpm,
      yieldG: next.targetYieldG,
      lastY: last?.y ?? null,
      targetY: yTarget,
      secPerLine,
      secPerLineSd,
      learning,
    });
    // Backup flow lever: the dial hit a limit; let a calibrated RPM cover the rest.
    if (inv?.clamped && !halfStep) {
      if (!calibrated) {
        whyNot.push('not backup RPM: RPM not calibrated yet');
      } else {
        const b = backupRpm(
          { ...ctx, targetAt: (r) => yTarget + (targetAt(r) - targetAt(curRpm)) },
          toLines(next.grind.dialPos, spec),
          curRpm,
          prefSummary.band,
        );
        if (b) {
          setRpmAndDial(b.rpm, toLines(next.grind.dialPos, spec));
          source = 'rpmModel';
          sentence += backupSentence({ rpm: b.rpm, prevRpm: curRpm, limit: inv.clamped });
        } else
          whyNot.push(
            'not backup RPM: no RPM in reach closes the gap (direction unknown or too small)',
          );
      }
    }
  };

  switch (decision.row) {
    case 13: {
      // Calibration slot: the planner's RPM at a compensated dial (moved toward 1000 if clamped).
      lever = 'calibrate';
      source = 'rpmModel';
      stage = 'F_rpm';
      let rpm = clampRpm(decision.rpm, range);
      let inv = compensatedDial(ctx, rpm);
      for (let i = 0; i < 6 && inv?.clamped && rpm !== 1000; i++) {
        rpm = rpm > 1000 ? rpm - 100 : rpm + 100;
        inv = compensatedDial(ctx, rpm);
      }
      if (inv) vetoes.push(...inv.vetoes);
      setRpmAndDial(rpm, inv?.lines ?? curLines);
      targetY = targetAt(rpm);
      const slotState = progress?.slots[decision.slot];
      calibrationTag = { runId: activeRun?.id ?? '', slot: decision.slot, plannedRpm: rpm };
      sentence = calibrationSentence({
        slot: decision.slot,
        total: CALIBRATION_SLOTS,
        rpm,
        prevRpm: curRpm,
        from: current.grind.dialPos,
        to: next.grind.dialPos,
        deltaLines: toLines(next.grind.dialPos, spec) - curLines,
        targetY,
        prep: decision.prep,
        repeat: (slotState?.tries ?? 0) > 0,
      });
      break;
    }
    case 1:
      sentence = prepSentence({
        signs: decision.signs,
        dial: current.grind.dialPos,
        rpm: curRpm,
      });
      break;
    case 2:
      if (decision.lever === 'wait') {
        sentence = waitSentence({
          ageDays: Math.floor(ageDays),
          dial: current.grind.dialPos,
          rpm: curRpm,
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
    case 9: {
      // Body move: RPM toward the preferred body, dial compensated so flow and balance hold.
      stage = 'F_rpm';
      source = 'rpmModel';
      const rpm = decision.newRpm;
      const inv = compensatedDial(ctx, rpm);
      if (inv) vetoes.push(...inv.vetoes);
      setRpmAndDial(rpm, inv?.lines ?? curLines);
      targetY = targetAt(rpm);
      bodyConfidence = probImprove(pref, curRpm, rpm);
      sentence = bodySentence({
        rpm,
        prevRpm: curRpm,
        from: current.grind.dialPos,
        to: next.grind.dialPos,
        deltaLines: toLines(next.grind.dialPos, spec) - curLines,
        thetaMean: decision.thetaMean,
        band: decision.band,
        targetY,
      });
      break;
    }
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
      if (!tryTrim()) {
        sentence = noneSentence({
          yHat: yHatCur ?? sStar,
          targetY: sStar,
          lastRating: lastRating?.vsPrevious ?? 'unrated',
        });
      }
      break;
    case 12: {
      source = 'setpoint';
      stage = stage === 'B_grind' ? 'B_grind' : 'D_hone';
      const choice = chooseTarget(input.setpoint, (bag.tsSeed + shots.length) >>> 0);
      if (choice.mode === 'probe') setpointOut = afterProbe(input.setpoint);
      if (choice.mode !== 'mean') probe = probe || sp.sd > RULES.setpointSdConverged;
      // The search runs on the 1000-RPM setpoint; shift the drawn target to the RPM in use.
      grindTo(choice.yStar + (sStar - sp.mean));
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

  // The RPM in use is outside the allowed range (a stall raised the floor): move it back in,
  // with the dial compensated.
  if (lever !== 'calibrate' && clampRpm(next.grind.rpm, range) !== next.grind.rpm) {
    const rpm = clampRpm(next.grind.rpm, range);
    const inv = compensatedDial(ctx, rpm);
    setRpmAndDial(rpm, inv?.lines ?? toLines(next.grind.dialPos, spec));
    vetoes.push(`RPM moved into the allowed ${range[0]}–${range[1]} RPM range`);
    sentence += ` Set ${rpm} RPM: ${range[0]} RPM is the lowest safe speed for this bean.`;
  }

  if (fromPrior && shots.length === 0) {
    sentence = firstShotSentence({
      dial: next.grind.dialPos,
      rpm: next.grind.rpm,
      yieldG: next.targetYieldG,
      fromPrior: hadBag || model.pooled.length > 0 || model.bags.length > 1,
    });
  }

  // Calibration offer (a card, not a lever) and the RPM status in "why not".
  let offer: RecommendationCore['offer'];
  if (!activeRun && lever !== 'calibrate') {
    const blocker = offerBlocker({
      model,
      views: shots,
      balancedAt: targetAt,
      setpointSd: sp.sd,
      ageDays,
      gateDays: freshnessGateDays(bean.roastLevel),
      runsThisEpoch,
      now: input.now,
    });
    if (blocker === null) offer = 'rpm_calibration';
    else if (!calibrated) whyNot.push(`not RPM calibration yet: ${blocker}`);
  }

  const nextLines = toLines(next.grind.dialPos, spec);
  const uNext = uOf(next.grind.rpm);
  const predNext = predictAt(model, bag.id, nextLines, next.grind.rpm, next.doseG);
  // Parameter uncertainty of the predicted mean, plus the uncertain balance shift at this RPM.
  const sP = Math.sqrt((predNext?.sP ?? 1) ** 2 + (balanceSd(balance) * uNext) ** 2);
  const sPred = Math.sqrt(sP ** 2 + MODEL.sigmaY ** 2);
  const yHatNext = predNext?.yHat ?? sStar;
  const confidence = Math.max(0, Math.min(1, 2 * phi(RULES.beta / Math.max(1e-9, sP)) - 1));
  const word = confidenceWord(confidence, lever, probe);
  const a = aBag(model, bag.id);
  const guidance = e006Guidance(next.grind.rpm);
  const kq = kRpmCurv(model);
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
      kRpmCurv: [kq.mean, kq.sd],
      delta: [balance.mean, balanceSd(balance)],
      rpmPref: [prefSummary.thetaMean, prefSummary.thetaSd, prefSummary.pInsensitive],
    },
    ...(offer ? { offer } : {}),
    ...(calibrationTag ? { calibration: calibrationTag } : {}),
    ...(guidance.length > 0 ? { guidance } : {}),
    ...(bodyConfidence !== undefined ? { bodyConfidence } : {}),
  };
  return { rec, setpoint: setpointOut, row: decision.row, calibration: progress };
}
