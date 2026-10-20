import { describe, expect, it } from 'vitest';
import { previousShot, quickRating, unratedRecent } from '../../src/core/quickRating';
import type { Rating, Shot, ShotQuality } from '../../src/core/types';

const day = 86_400_000;
const now = Date.parse('2026-10-20T12:00:00Z');
const shot = (id: string, hoursAgo: number, bagId = 'b1') =>
  ({ id, bagId, at: new Date(now - hoursAgo * 3_600_000).toISOString() }) as Shot;

describe('one-tap rating', () => {
  it('maps sour / balanced / bitter to −2 / 0 / +2 (balanced with its chip)', () => {
    expect(quickRating('sour', 'p').sourBitter).toBe(-2);
    expect(quickRating('bitter', null).sourBitter).toBe(2);
    const b = quickRating('balanced', 'p', 41.6);
    expect(b).toMatchObject({ sourBitter: 0, chips: ['balanced'], vsPrevious: null });
    expect(b.secondsSincePull).toBe(42);
    expect(b.thinHeavy).toBeNull();
    expect('secondsSincePull' in quickRating('sour', null)).toBe(false);
  });

  it('lists unrated shots of the last 3 days, newest first, without aborted or stalled', () => {
    const shots = [shot('a', 80), shot('b', 50), shot('c', 5), shot('d', 3), shot('e', 1)];
    const ratings = [{ shotId: 'c' } as Rating];
    const quality = [
      { shotId: 'd', status: 'aborted' } as ShotQuality,
      { shotId: 'e', status: 'auto_start' } as ShotQuality,
    ];
    expect(unratedRecent(shots, ratings, quality, now).map((s) => s.id)).toEqual(['e', 'b']);
    expect(unratedRecent(shots, [], [], now + 2 * day).map((s) => s.id)).toEqual(['e', 'd', 'c']);
  });

  it('compares a late rating with the shot of the same bag pulled just before', () => {
    const shots = [shot('a', 30), shot('x', 20, 'b2'), shot('b', 10), shot('c', 2)];
    expect(previousShot(shots, shots[2] as Shot)?.id).toBe('a');
    expect(previousShot(shots, shots[0] as Shot)).toBeNull();
  });
});
