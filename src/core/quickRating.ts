/**
 * One-tap rating: sour, balanced or bitter, from the rate sheet or later from Home. Sour and
 * bitter are ±2 on the sour–bitter slider (a clear lean, not the extreme); balanced is 0 with
 * the `balanced` chip. Pure; the app stores the row.
 */
import type { Chip, Id, Rating, Shot, ShotQuality, SliderValue } from './types';

export type QuickTaste = 'sour' | 'balanced' | 'bitter';

export const QUICK_TASTES: readonly { taste: QuickTaste; label: string; v: SliderValue }[] = [
  { taste: 'sour', label: 'Sour', v: -2 },
  { taste: 'balanced', label: 'Balanced', v: 0 },
  { taste: 'bitter', label: 'Bitter', v: 2 },
];

/** Shots older than this are not offered for a late rating (the taste is forgotten). */
export const RATE_LATER_DAYS = 3;

export type RatingFields = Omit<Rating, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'shotId'>;

export function quickRating(
  taste: QuickTaste,
  comparedToShotId: Id | null,
  secondsSincePull?: number,
): RatingFields {
  const v = QUICK_TASTES.find((q) => q.taste === taste)?.v ?? 0;
  const chips: Chip[] = taste === 'balanced' ? ['balanced'] : [];
  return {
    comparedToShotId,
    vsPrevious: null,
    sourBitter: v,
    thinHeavy: null,
    chips,
    drink: 'black',
    ...(secondsSincePull !== undefined ? { secondsSincePull: Math.round(secondsSincePull) } : {}),
  };
}

/**
 * Shots of the last `days` without a rating, newest first. Aborted shots and grinder stalls
 * are left out: there is nothing to taste.
 */
export function unratedRecent(
  shots: readonly Shot[],
  ratings: readonly Rating[],
  quality: readonly ShotQuality[],
  nowMs: number,
  days = RATE_LATER_DAYS,
): Shot[] {
  const rated = new Set(ratings.map((r) => r.shotId));
  const skip = new Set(
    quality.filter((q) => q.status === 'aborted' || q.status === 'stalled').map((q) => q.shotId),
  );
  const since = nowMs - days * 86_400_000;
  return shots
    .filter((s) => !rated.has(s.id) && !skip.has(s.id) && Date.parse(s.at) >= since)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The shot of the same bag pulled just before `shot` (what a rating compares to). */
export function previousShot(shots: readonly Shot[], shot: Shot): Shot | null {
  let prev: Shot | null = null;
  for (const s of shots) {
    if (s.bagId === shot.bagId && s.at < shot.at && (!prev || s.at > prev.at)) prev = s;
  }
  return prev;
}
