/**
 * RPM calibration controller (plan "RPM calibration" §5): the run rows and the stall reports.
 * Only intent and status are stored; slots, repeats and results are derived in replay from
 * the tagged shots (src/core/rpm/calibration.ts). Ending a run when the planner stops is done
 * by the recommender after each shot (`finishRunIfPlannerStopped`).
 */
import type { Bag, Id, RpmCalibrationRun, RpmRunStatus } from '../core/types';
import { newMeta, nowIso } from '../data/repo';
import { diag } from '../diag/log';
import { recommendAfterEpoch, replayAll, rpmRuns } from './recommender';
import { app } from './state';

/** The active run on the current bag and epoch, if any. */
export function activeRun(): RpmCalibrationRun | null {
  const bag = app.currentBag.value;
  const epoch = app.currentEpoch.value;
  if (!bag || !epoch) return null;
  return (
    rpmRuns.value.find(
      (r) => r.status === 'active' && r.bagId === bag.id && r.epochId === epoch.id && !r.deleted,
    ) ?? null
  );
}

/** Runs of the current epoch, newest first. */
export function runsThisEpoch(): RpmCalibrationRun[] {
  const epoch = app.currentEpoch.value;
  if (!epoch) return [];
  return rpmRuns.value
    .filter((r) => r.epochId === epoch.id && !r.deleted)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Recompute and persist the card from the current pre-shot settings (no new shot). */
export async function recommendNow(): Promise<void> {
  try {
    await recommendAfterEpoch();
  } catch (err) {
    diag.log('error', `recommend after calibration change failed: ${String(err)}`);
  }
}

async function putRun(run: RpmCalibrationRun): Promise<void> {
  const repo = app.mustRepo();
  await repo.putRpmRun(run);
  await replayAll();
}

/** Start a session on the current bag; the next card is slot 1 of 8. */
export async function startRun(): Promise<RpmCalibrationRun | null> {
  const bag = app.currentBag.value;
  const epoch = app.currentEpoch.value;
  const settings = app.settings.value;
  if (!bag || !epoch || !settings) {
    app.toast('error', 'Select a bag first.');
    return null;
  }
  const existing = activeRun();
  if (existing) return existing;
  const at = nowIso();
  const run: RpmCalibrationRun = {
    ...newMeta(settings.deviceId),
    epochId: epoch.id,
    bagId: bag.id,
    startedAt: at,
    status: 'active',
  };
  await putRun(run);
  await recommendNow();
  app.toast('info', 'RPM calibration started: the next card is slot 1 of 8.');
  return run;
}

async function endRun(status: RpmRunStatus, note?: string): Promise<void> {
  const run = activeRun();
  if (!run) return;
  const at = nowIso();
  await putRun({ ...run, status, endedAt: at, updatedAt: at, ...(note ? { note } : {}) });
  await recommendNow();
}

/** Stop early and keep what was learned (the shots stay in the model either way). */
export async function stopRun(): Promise<void> {
  await endRun('stopped', 'stopped by you');
}

/** Give up on this session (for example the wrong beans); the shots still teach the flow. */
export async function abandonRun(): Promise<void> {
  await endRun('abandoned', 'abandoned');
}

/** "Not now" on the offer card: it comes back after 7 days. */
export async function declineOffer(): Promise<void> {
  const bag = app.currentBag.value;
  const epoch = app.currentEpoch.value;
  const settings = app.settings.value;
  if (!bag || !epoch || !settings) return;
  const at = nowIso();
  await putRun({
    ...newMeta(settings.deviceId),
    epochId: epoch.id,
    bagId: bag.id,
    startedAt: at,
    status: 'declined',
    endedAt: at,
  });
  await recommendNow();
}

/**
 * The grinder stalled (VS6 E006) at `rpm`. Recorded on the bag: the RPM floor rises to the
 * stall + 100 for this bag. When a shot is pending (pulled after a restart at another RPM),
 * it is saved as `stalled` and not learned from.
 */
export async function reportStall(rpm: number): Promise<void> {
  const bag = app.currentBag.value;
  if (!bag) return;
  const pending = app.pending.value;
  const at = nowIso();
  let shotId: Id | undefined;
  if (pending) {
    app.pending.value = { ...pending, status: 'stalled', learn: false };
    const shot = await app.saveShot(null);
    shotId = shot?.id;
  }
  const fresh = app.bags.value.find((b) => b.id === bag.id) ?? bag;
  const next: Bag = {
    ...fresh,
    updatedAt: at,
    stalls: [...(fresh.stalls ?? []), { at, rpm, ...(shotId ? { shotId } : {}) }],
  };
  await app.updateBag(next);
  await app.selectBag(bag.id);
  await recommendNow();
  app.toast(
    'info',
    `Stall at ${rpm} RPM recorded: this bag now stays at ${rpm + 100} RPM or above.`,
  );
}

/** Forget a reported stall (Settings). */
export async function forgetStall(bagId: Id, index: number): Promise<void> {
  const bag = app.bags.value.find((b) => b.id === bagId);
  if (!bag?.stalls) return;
  const stalls = bag.stalls.filter((_, i) => i !== index);
  await app.updateBag({ ...bag, updatedAt: nowIso(), stalls });
  if (app.currentBagId.value === bagId) await recommendNow();
}
