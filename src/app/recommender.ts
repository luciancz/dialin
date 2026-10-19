/**
 * Glue between storage and the pure core: replay every stored row into model state,
 * recommend for the current bag, persist the recommendation, and expose summaries for
 * the UI. The estimator is never persisted.
 */
import { signal } from '@preact/signals';
import { aBag, kDose, kGrind, kRpm } from '../core/flowmodel/state';
import { type RecommendationCore, recommend } from '../core/recommend';
import { bagContext, channelFlagOf, type ReplayResult, replay } from '../core/replay';
import { comparisonValidity, type SetpointPosterior, summary } from '../core/setpoint/grid';
import type { Id, Recommendation, Shot, ShotSettings } from '../core/types';
import { newMeta, nowIso } from '../data/repo';
import { diag } from '../diag/log';
import { app, type PendingShot } from './state';

export interface ModelSummary {
  epochId: Id;
  kGrind: [number, number];
  kRpm: [number, number];
  kDose: [number, number];
  aBag: [number, number] | null;
  setpoint: [number, number];
  learnableShots: number;
  predictedInBand: number;
  /** Seconds per line at the last shot's time, with sd. */
  secPerLine: [number, number] | null;
}

export const modelSummary = signal<ModelSummary | null>(null);
export const lastReplay = signal<ReplayResult | null>(null);

export async function replayAll(): Promise<ReplayResult | null> {
  const repo = app.repo;
  if (!repo) return null;
  const [epochs, beans, bags, shots, ratings, quality, recs] = await Promise.all([
    repo.listEpochs(),
    repo.listBeans(true),
    repo.listBags(true),
    repo.listShots(),
    repo.listRatings(),
    repo.listQuality(),
    repo.db.getAll('recommendations'),
  ]);
  if (epochs.length === 0) return null;
  const t0 = performance.now();
  const result = replay({ epochs, beans, bags, shots, ratings, quality, recommendations: recs });
  diag.log('info', `replay: ${shots.length} shots in ${(performance.now() - t0).toFixed(0)} ms`);
  lastReplay.value = result;
  return result;
}

export function summarise(result: ReplayResult, bagId: Id | null): ModelSummary {
  const ctx = bagId ? bagContext(result, bagId) : null;
  const sp = ctx ? summary(ctx.setpoint) : { mean: Number.NaN, sd: Number.NaN };
  const kg = kGrind(result.model);
  const views = ctx?.views ?? [];
  const last = views[views.length - 1];
  const t = last?.shot.features.totalTimeS ?? 30;
  const a = bagId ? aBag(result.model, bagId) : null;
  return {
    epochId: result.epochId,
    kGrind: [kg.mean, kg.sd],
    kRpm: [kRpm(result.model).mean, kRpm(result.model).sd],
    kDose: [kDose(result.model).mean, kDose(result.model).sd],
    aBag: a ? [a.mean, a.sd] : null,
    setpoint: [sp.mean, sp.sd],
    learnableShots: views.filter((v) => v.learn && !v.skipped).length,
    predictedInBand: views.filter(
      (v) => v.learn && v.predictedY !== null && Math.abs(v.predictedY - sp.mean) <= 0.07,
    ).length,
    secPerLine: [t * kg.mean, t * kg.sd],
  };
}

/** Recommend for the current bag from the current settings; returns the core (not persisted). */
export async function computeRecommendation(
  current: ShotSettings,
  result?: ReplayResult | null,
): Promise<RecommendationCore | null> {
  const bag = app.currentBag.value;
  const bean = app.currentBean.value;
  const epoch = app.currentEpoch.value;
  const settings = app.settings.value;
  const r = result ?? (await replayAll());
  if (!bag || !bean || !epoch || !settings || !r) return null;
  const ctx = bagContext(r, bag.id);
  const out = recommend({
    bag,
    bean,
    epoch,
    allowLowRpm: settings.allowLowRpm,
    shots: ctx.views,
    model: r.model,
    setpoint: ctx.setpoint,
    current,
    now: nowIso(),
    shotsSinceBodyMove: ctx.shotsSinceBodyMove,
    balance: r.balance,
    tempCardShown: ctx.tempCardShown,
  });
  return out.rec;
}

/** After a shot is saved: replay, recommend, persist, refresh signals. */
export async function recommendAfterShot(shot: Shot): Promise<Recommendation | null> {
  const repo = app.repo;
  const settings = app.settings.value;
  if (!repo || !settings) return null;
  const result = await replayAll();
  if (!result) return null;
  const core = await computeRecommendation(shot.settings, result);
  if (!core) return null;
  const rec: Recommendation = { ...newMeta(settings.deviceId), ...core, afterShotId: shot.id };
  await repo.putRecommendation(rec);
  modelSummary.value = summarise(result, shot.bagId);
  await app.loadBagRows(shot.bagId);
  return rec;
}

/** When an epoch opens: recompute the card from the transformed model, without a new shot. */
export async function recommendAfterEpoch(): Promise<Recommendation | null> {
  const repo = app.repo;
  const settings = app.settings.value;
  const bag = app.currentBag.value;
  if (!repo || !settings || !bag) return null;
  const result = await replayAll();
  if (!result) return null;
  const core = await computeRecommendation(app.nextSettings.value, result);
  if (!core) return null;
  const last = app.shotsOfBag.value[app.shotsOfBag.value.length - 1];
  const rec: Recommendation = {
    ...newMeta(settings.deviceId),
    ...core,
    afterShotId: last?.id ?? null,
  };
  await repo.putRecommendation(rec);
  modelSummary.value = summarise(result, bag.id);
  await app.loadBagRows(bag.id);
  return rec;
}

/** Refresh the model summary for the current bag (on load / bag change). */
export async function refreshModelSummary(): Promise<void> {
  const result = await replayAll();
  if (!result) {
    modelSummary.value = null;
    return;
  }
  modelSummary.value = summarise(result, app.currentBagId.value);
}

export interface RerunRow {
  shotId: Id;
  at: string;
  stored: Recommendation | null;
  recomputed: RecommendationCore | null;
  identical: boolean;
}

/**
 * Dev check: for every stored shot of the current bag, recompute the recommendation that
 * followed it from the rows up to that shot and compare with the stored one.
 */
export async function rerunRecommendations(): Promise<RerunRow[]> {
  const repo = app.repo;
  const bag = app.currentBag.value;
  const bean = app.currentBean.value;
  const settings = app.settings.value;
  if (!repo || !bag || !bean || !settings) return [];
  const [epochs, beans, bags, allShots, ratings, quality, recs] = await Promise.all([
    repo.listEpochs(),
    repo.listBeans(true),
    repo.listBags(true),
    repo.listShots(),
    repo.listRatings(),
    repo.listQuality(),
    repo.db.getAll('recommendations'),
  ]);
  const rows: RerunRow[] = [];
  const bagShots = allShots.filter((s) => s.bagId === bag.id);
  for (const shot of bagShots) {
    const upTo = allShots.filter((s) => s.at <= shot.at);
    const stored = recs.find((r) => r.afterShotId === shot.id) ?? null;
    const recsUpTo = recs.filter(
      (r) => r.createdAt <= (stored?.createdAt ?? shot.at) && r.id !== stored?.id,
    );
    const epoch = epochs.find((e) => e.id === shot.epochId) ?? epochs[epochs.length - 1];
    if (!epoch) continue;
    const result = replay({
      epochs: epochs.filter((e) => e.startedAt <= shot.at || e.id === epoch.id),
      beans,
      bags,
      shots: upTo,
      ratings,
      quality,
      recommendations: recsUpTo,
    });
    const ctx = bagContext(result, bag.id);
    const out = recommend({
      bag,
      bean,
      epoch,
      allowLowRpm: settings.allowLowRpm,
      shots: ctx.views,
      model: result.model,
      setpoint: ctx.setpoint,
      current: shot.settings,
      now: stored?.createdAt ?? shot.at,
      shotsSinceBodyMove: ctx.shotsSinceBodyMove,
      balance: result.balance,
      tempCardShown: ctx.tempCardShown,
    });
    const identical =
      stored !== null &&
      stored.lever === out.rec.lever &&
      JSON.stringify(stored.next) === JSON.stringify(out.rec.next) &&
      Math.abs(stored.confidence - out.rec.confidence) < 1e-6;
    rows.push({ shotId: shot.id, at: shot.at, stored, recomputed: out.rec, identical });
  }
  return rows;
}

/** Why a better/worse comparison of the pending shot with the previous one would be invalid. */
export function comparisonReasonFor(p: PendingShot): string | null {
  const bagId = app.currentBagId.value;
  const result = lastReplay.value;
  const prev = app.shotsOfBag.value[app.shotsOfBag.value.length - 1];
  if (!bagId || !prev) return 'no previous shot of this bag';
  const views = result ? bagContext(result, bagId).views : [];
  const prevView = views.find((v) => v.shot.id === prev.id) ?? null;
  const prevRating = app.ratingsOfBag.value.find((r) => r.shotId === prev.id) ?? null;
  const settings = app.nextSettings.value;
  const yj =
    p.features.plateauFlow !== null && p.features.plateauFlow > 0
      ? Math.log(p.features.plateauFlow)
      : null;
  return comparisonValidity({
    learnJ: p.learn,
    learnI:
      prevView?.learn ??
      app.qualityOfBag.value.find((q) => q.shotId === prev.id)?.learn ??
      prev.features.valid,
    channelJ: channelFlagOf(p.features, null),
    channelI: prevView?.channelFlag ?? channelFlagOf(prev.features, prevRating),
    yieldJ: p.features.finalYieldG,
    yieldI: prev.features.finalYieldG,
    rpmJ: settings.grind.rpm,
    rpmI: prev.settings.grind.rpm,
    tempJ: settings.tempSwitch,
    tempI: prev.settings.tempSwitch,
    doseJ: settings.doseG,
    doseI: prev.settings.doseG,
    yj,
    yi:
      prevView?.y ??
      (prev.features.plateauFlow !== null && prev.features.plateauFlow > 0
        ? Math.log(prev.features.plateauFlow)
        : null),
  });
}

/** Current bag's setpoint posterior and the rated shots' flows, for the posterior bar. */
export function setpointView(): {
  posterior: SetpointPosterior;
  rated: { y: number; v: number | null }[];
} | null {
  const bagId = app.currentBagId.value;
  const result = lastReplay.value;
  if (!bagId || !result) return null;
  const ctx = bagContext(result, bagId);
  const rated = ctx.views
    .filter((v) => v.rating && v.y !== null)
    .map((v) => ({ y: v.y as number, v: v.rating?.sourBitter ?? null }));
  return { posterior: ctx.setpoint, rated };
}

// Wire the hooks once.
app.comparisonReason = comparisonReasonFor;
app.afterEpochChanged = async () => {
  try {
    await recommendAfterEpoch();
  } catch (err) {
    diag.log('error', `recommend after epoch failed: ${String(err)}`);
  }
};
app.onBagLoaded = async () => {
  try {
    await refreshModelSummary();
  } catch (err) {
    diag.log('error', `model summary failed: ${String(err)}`);
  }
};
app.afterShotSaved = async (shot) => {
  try {
    await recommendAfterShot(shot);
  } catch (err) {
    diag.log('error', `recommend failed: ${String(err)}`);
  }
};
