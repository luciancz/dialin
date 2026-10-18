/**
 * Fold stored rows into model state. The estimator is never persisted: the app calls this
 * on load and after every save, and the tests call it directly, so model changes need no
 * migrations. Epochs are folded in order with the epoch-event transforms between them;
 * only learn === true shots update the flow model, and shots never cross epochs.
 */
import { applyEpochEvent } from './flowmodel/epoch';
import { predictAt } from './flowmodel/invert';
import {
  addBag,
  bagOf,
  type FlowModelState,
  initFlowModel,
  kGrind,
  mu0Roast,
} from './flowmodel/state';
import { baseWeight, update } from './flowmodel/update';
import { MODEL, RULES } from './params';
import { bagMetaOf, type ShotView } from './recommend';
import { activeBand, freshnessGateDays, ratioBounds } from './rules/stages';
import {
  applyTasting,
  comparisonValidity,
  forgetDays,
  forgetLeverChange,
  initSetpoint,
  recipeMu0,
  type SetpointPosterior,
  summary,
} from './setpoint/grid';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Features,
  Id,
  Rating,
  Recommendation,
  Shot,
  ShotQuality,
} from './types';
import { toLines } from './units';

export interface ReplayInput {
  epochs: CalibrationEpoch[];
  beans: Bean[];
  bags: Bag[];
  shots: Shot[];
  ratings: Rating[];
  quality: ShotQuality[];
  recommendations: Recommendation[];
}

export interface BagReplay {
  views: ShotView[];
  setpoint: SetpointPosterior;
  shotsSinceRpmChange: number;
  tempCardShown: boolean;
  lastRatedAt: string | null;
}

export interface ReplayResult {
  model: FlowModelState;
  epochId: Id;
  bags: Map<Id, BagReplay>;
}

export function channelFlagOf(f: Features, r: Rating | null): boolean {
  const chips = r?.chips ?? [];
  return (
    f.curveChannelScore >= 0.5 ||
    chips.includes('channelled') ||
    (chips.includes('astringent') && chips.includes('harsh'))
  );
}

function chirpLines(e: CalibrationEpoch): number | null {
  if (e.chirp) return toLines(e.chirp, e.dialSpec);
  if (e.usualDial) return toLines(e.usualDial, e.dialSpec);
  return null;
}

export function replay(input: ReplayInput): ReplayResult {
  const epochs = [...input.epochs]
    .filter((e) => !e.deleted)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const first = epochs[0];
  if (!first) throw new Error('no calibration epoch');
  const beansById = new Map(input.beans.map((b) => [b.id, b]));
  const bagsById = new Map(input.bags.map((b) => [b.id, b]));
  const ratingByShot = new Map(input.ratings.filter((r) => !r.deleted).map((r) => [r.shotId, r]));
  const qualityByShot = new Map(input.quality.filter((q) => !q.deleted).map((q) => [q.shotId, q]));
  const shotsById = new Map(input.shots.map((s) => [s.id, s]));
  const tempShown = new Set(
    input.recommendations
      .filter((r) => r.lever === 'temperature' && !r.deleted)
      .map((r) => r.bagId),
  );

  let model = initFlowModel(first.id, chirpLines(first));
  const bagsOut = new Map<Id, BagReplay>();
  const viewsById = new Map<Id, ShotView>();
  const learnableCountByBag = new Map<Id, number>();
  const predictedInBandByBag = new Map<Id, number>();

  for (let ei = 0; ei < epochs.length; ei++) {
    const epoch = epochs[ei];
    if (!epoch) continue;
    if (ei > 0) {
      const prev = epochs[ei - 1];
      if (prev) {
        model = applyEpochEvent(model, {
          newEpochId: epoch.id,
          kind: epoch.kind,
          oldSpec: prev.dialSpec,
          newSpec: epoch.dialSpec,
          newChirpLines: chirpLines(epoch),
          ...(epoch.deltaWashers !== undefined ? { deltaWashers: epoch.deltaWashers } : {}),
        });
      }
      // Views are per epoch: a new epoch starts the rule lookback afresh.
      for (const b of bagsOut.values()) b.views = [];
      predictedInBandByBag.clear();
    }
    const shots = input.shots
      .filter((s) => !s.deleted && s.epochId === epoch.id)
      .sort((a, b) => a.at.localeCompare(b.at));
    for (const shot of shots) {
      const bag = bagsById.get(shot.bagId);
      const bean = bag ? beansById.get(bag.beanId) : undefined;
      if (!bag || !bean) continue;
      const rating = ratingByShot.get(shot.id) ?? null;
      const quality = qualityByShot.get(shot.id) ?? null;
      const f = shot.features;
      const lines = toLines(shot.settings.grind.dialPos, epoch.dialSpec);
      const y = f.plateauFlow !== null && f.plateauFlow > 0 ? Math.log(f.plateauFlow) : null;
      const learn = (quality ? quality.learn : f.valid) && y !== null;
      const channelFlag = channelFlagOf(f, rating);
      const prevCount = learnableCountByBag.get(bag.id) ?? 0;
      const age = Math.max(0, (Date.parse(shot.at) - Date.parse(bag.roastDate)) / 86_400_000);
      let entry = bagsOut.get(bag.id);
      if (!entry) {
        const recipe =
          bag.roasterRecipe?.yieldG !== undefined && bag.roasterRecipe.timeS !== undefined
            ? recipeMu0(bag.roasterRecipe.yieldG, bag.roasterRecipe.timeS)
            : undefined;
        entry = {
          views: [],
          setpoint: initSetpoint(mu0Roast(bean.roastLevel), recipe),
          shotsSinceRpmChange: 0,
          tempCardShown: tempShown.has(bag.id),
          lastRatedAt: null,
        };
        bagsOut.set(bag.id, entry);
      }
      const prevView = entry.views[entry.views.length - 1] ?? null;
      let predictedY: number | null = null;
      let r: number | null = null;
      let skipped = false;
      if (learn && y !== null) {
        if (!bagOf(model, bag.id)) addBag(model, bag.id, bagMetaOf(bean, bag), lines, shot.at);
        predictedY =
          predictAt(model, bag.id, lines, shot.settings.grind.rpm, shot.settings.doseG)?.yHat ??
          null;
        const w0 = baseWeight({
          channelFlag,
          freshnessGate: age < freshnessGateDays(bean.roastLevel),
          lowInfo: f.flags.includes('low_info'),
          earlyChannel:
            f.curveChannelScore >= MODEL.earlyChannelScore && prevCount < MODEL.earlyChannelShots,
        });
        const events = bag.storage
          .filter(
            (e) =>
              (e.event === 'frozen' || e.event === 'thawed' || e.event === 'opened') &&
              (!prevView || e.at > prevView.shot.at) &&
              e.at <= shot.at,
          )
          .map((e) => e.event);
        const res = update(model, {
          bagId: bag.id,
          shotId: shot.id,
          lines,
          rpm: shot.settings.grind.rpm,
          doseG: shot.settings.doseG,
          y,
          w0,
          at: shot.at,
          storageEvents: events,
        });
        r = res.r;
        skipped = !res.accepted;
        if (res.accepted) learnableCountByBag.set(bag.id, prevCount + 1);
      }
      // Setpoint: forgetting, then one update per tasting.
      const sNow = summary(entry.setpoint);
      let sp = entry.setpoint;
      if (
        prevView &&
        (prevView.shot.settings.grind.rpm !== shot.settings.grind.rpm ||
          prevView.shot.settings.tempSwitch !== shot.settings.tempSwitch)
      ) {
        sp = forgetLeverChange(sp);
      }
      let inBandAtRating = false;
      if (rating && y !== null) {
        if (entry.lastRatedAt)
          sp = forgetDays(sp, (Date.parse(shot.at) - Date.parse(entry.lastRatedAt)) / 86_400_000);
        const cmpShotId = rating.comparedToShotId ?? prevView?.shot.id ?? null;
        const cmpView = cmpShotId ? (viewsById.get(cmpShotId) ?? null) : null;
        const cmpShot = cmpShotId ? (shotsById.get(cmpShotId) ?? null) : null;
        let valid = false;
        if (cmpView && cmpShot) {
          valid =
            comparisonValidity({
              learnJ: learn,
              learnI: cmpView.learn,
              channelJ: channelFlag,
              channelI: cmpView.channelFlag,
              yieldJ: f.finalYieldG,
              yieldI: cmpShot.features.finalYieldG,
              rpmJ: shot.settings.grind.rpm,
              rpmI: cmpShot.settings.grind.rpm,
              tempJ: shot.settings.tempSwitch,
              tempI: cmpShot.settings.tempSwitch,
              doseJ: shot.settings.doseG,
              doseI: cmpShot.settings.doseG,
              yj: y,
              yi: cmpView.y,
            }) === null;
        }
        const betaB = activeBand(sNow.sd);
        const inBand = Math.abs((predictedY ?? y) - sNow.mean) <= betaB;
        inBandAtRating = Math.abs(y - sNow.mean) <= RULES.beta;
        const { cap, floor } = ratioBounds(bean.roastLevel);
        const ratio = shot.settings.targetYieldG / Math.max(1, shot.settings.doseG);
        const stageC =
          (predictedInBandByBag.get(bag.id) ?? 0) >= 2 &&
          kGrind(model).sd <= MODEL.kGrindSdConverged;
        const v = rating.sourBitter ?? 0;
        const sliderDrovesYield =
          stageC && inBand && v !== 0 && ratio < cap - 1e-9 && ratio > floor + 1e-9;
        const dDays = cmpShot ? (Date.parse(shot.at) - Date.parse(cmpShot.at)) / 86_400_000 : 0;
        sp = applyTasting(sp, {
          yj: y,
          yi: cmpView?.y ?? null,
          vs: rating.vsPrevious,
          comparisonValid: valid,
          dDays,
          sourBitter: rating.sourBitter,
          chips: rating.chips,
          overall: rating.overall1to9 ?? null,
          sliderDrovesYield,
        }).sp;
        entry.lastRatedAt = shot.at;
      }
      entry.setpoint = sp;
      if (predictedY !== null && Math.abs(predictedY - sNow.mean) <= RULES.beta) {
        predictedInBandByBag.set(bag.id, (predictedInBandByBag.get(bag.id) ?? 0) + 1);
      }
      entry.shotsSinceRpmChange =
        prevView && prevView.shot.settings.grind.rpm !== shot.settings.grind.rpm
          ? 0
          : entry.shotsSinceRpmChange + 1;
      const view: ShotView = {
        shot,
        rating,
        quality,
        lines,
        y,
        learn,
        channelFlag,
        predictedY,
        r,
        skipped,
        inBandAtRating,
      };
      entry.views.push(view);
      viewsById.set(shot.id, view);
    }
  }
  const lastEpoch = epochs[epochs.length - 1] ?? first;
  return { model, epochId: lastEpoch.id, bags: bagsOut };
}

/** Convenience: the inputs recommend() needs for one bag, from a replay result. */
export function bagContext(result: ReplayResult, bagId: Id): BagReplay {
  return (
    result.bags.get(bagId) ?? {
      views: [],
      setpoint: initSetpoint(0.65),
      shotsSinceRpmChange: 0,
      tempCardShown: false,
      lastRatedAt: null,
    }
  );
}
