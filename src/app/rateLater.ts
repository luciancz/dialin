/**
 * Rating without the phone in hand: the rate sheet saves the shot unrated when it is left
 * untouched for 2 minutes, and Home lists the shots of the last days still to rate, with the
 * same one-tap buttons (src/core/quickRating.ts).
 */
import { effect, signal } from '@preact/signals';
import { previousShot, type QuickTaste, quickRating } from '../core/quickRating';
import type { Rating, Shot } from '../core/types';
import { newId, newMeta, nowIso } from '../data/repo';
import { diag } from '../diag/log';
import { realClock } from '../scale/clock';
import { isDemo } from './mode';
import { recommendAfterRating } from './recommender';
import { navigate, route } from './router';
import { backToPlan } from './shotFlow';
import { app, type PendingShot } from './state';

/** The rate sheet saves unrated after this long untouched. */
export const UNTOUCHED_SAVE_MS = 120_000;

/** When the open rate sheet saves unrated (realClock ms); null once touched or closed. */
export const autoSaveAt = signal<number | null>(null);
/** Ticks every second while the countdown runs (re-renders the sheet). */
export const countdownTick = signal(0);

let watched: PendingShot | null = null;
let cancels: (() => void)[] = [];

function stop(): void {
  for (const c of cancels) c();
  cancels = [];
}

effect(() => {
  const p = app.pending.value;
  if (p === watched) return;
  watched = p;
  stop();
  if (!p) {
    autoSaveAt.value = null;
    return;
  }
  autoSaveAt.value = realClock.now() + UNTOUCHED_SAVE_MS;
  cancels.push(realClock.setTimeout(() => void saveUnrated(p), UNTOUCHED_SAVE_MS));
  const tick = () => {
    countdownTick.value += 1;
    cancels.push(realClock.setTimeout(tick, 1000));
  };
  cancels.push(realClock.setTimeout(tick, 1000));
});

/** Any touch on the rate sheet: the user rates by hand, nothing is saved by itself. */
export function touchRating(): void {
  if (autoSaveAt.value === null) return;
  autoSaveAt.value = null;
  stop();
}

async function saveUnrated(p: PendingShot): Promise<void> {
  if (app.pending.value !== p || autoSaveAt.value === null) return;
  autoSaveAt.value = null;
  stop();
  const shot = await app.saveShot(null);
  if (!shot) return;
  backToPlan();
  app.toast('info', 'Saved unrated: rate it later on Home.');
  if (route.value.path === '/shot') navigate(isDemo() ? '/demo' : '/');
}

/** Rate a saved shot (Home → Rate earlier shots), then recompute the card with it. */
export async function rateEarlier(shot: Shot, taste: QuickTaste): Promise<void> {
  const repo = app.repo;
  const settings = app.settings.value;
  if (!repo || !settings) return;
  const at = nowIso();
  const prev = previousShot(app.shotsOfBag.value, shot);
  const row: Rating = {
    ...newMeta(settings.deviceId, newId(), at),
    shotId: shot.id,
    ...quickRating(taste, prev?.id ?? null, (Date.parse(at) - Date.parse(shot.at)) / 1000),
  };
  await repo.putRating(row);
  try {
    await recommendAfterRating();
  } catch (err) {
    diag.log('error', `recommend after a late rating failed: ${String(err)}`);
    await app.loadBagRows(shot.bagId);
  }
}
