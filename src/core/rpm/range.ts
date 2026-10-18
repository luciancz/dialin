/**
 * RPM range, quantisation and E006 handling. The VS6 runs 500–1600 RPM in 100 RPM steps;
 * owners report the undocumented E006 error with motor stalls at 500–600 RPM, mostly with
 * dense beans and cold starts, so a reported stall raises that bean's floor.
 */
import { RPM } from '../params';
import type { Bag } from '../types';

export type RpmRange = readonly [number, number];

/** Round to the VS6's 100 RPM step. */
export function quantRpm(rpm: number): number {
  return Math.round(rpm / RPM.step) * RPM.step;
}

export function clampRpm(rpm: number, range: RpmRange): number {
  const [lo, hi] = range;
  return Math.max(lo, Math.min(hi, quantRpm(rpm)));
}

/** Settings range (or the hardware default), sanitised to steps of 100 inside 500–1600. */
export function settingsRange(r: readonly [number, number] | undefined): RpmRange {
  const [hwLo, hwHi] = RPM.rangeDefault;
  const lo = Math.max(hwLo, quantRpm(r?.[0] ?? hwLo));
  const hi = Math.min(hwHi, quantRpm(r?.[1] ?? hwHi));
  return lo <= hi ? [lo, hi] : [hwLo, hwHi];
}

/** Allowed range for a bag: the settings range with the floor raised above any reported stall. */
export function allowedRpmRange(
  range: readonly [number, number] | undefined,
  bags: readonly Pick<Bag, 'stalls'>[] = [],
): RpmRange {
  const [lo, hi] = settingsRange(range);
  let floor = lo;
  for (const b of bags) {
    for (const s of b.stalls ?? []) floor = Math.max(floor, quantRpm(s.rpm) + RPM.stallMargin);
  }
  return [Math.min(floor, hi), hi];
}

/** Practical guidance for low RPM on the VS6 (empty above 600 RPM). */
export function e006Guidance(rpm: number): string[] {
  if (rpm > RPM.e006Rpm) return [];
  return [
    `At ${rpm} RPM the VS6 can stall (E006) with dense beans: start the motor before pouring the beans in and feed them slowly.`,
    'If it stalls, tap "Grinder stalled (E006)" so the app stops recommending this speed for this bean.',
  ];
}

/** u = (RPM − 1000)/100 */
export function uOf(rpm: number): number {
  return (rpm - RPM.reference) / 100;
}
