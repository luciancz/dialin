/**
 * Predict step between consecutive shots of a bag separated by Δd days: bean-age drift on
 * the intercept, process noise by age (frozen bags barely move), a thaw/open kick, and a
 * tiny variance growth on the pooled gains.
 */
import { MODEL, RPM } from '../params';
import type { StorageEventKind } from '../types';
import { ageDays, type BagState, type FlowModelState, IDX_KG, IDX_KQ, IDX_KR } from './state';

export function driftPerDay(age: number, frozen: boolean): number {
  if (frozen) return 0;
  return age <= MODEL.driftAgeSplitDays ? MODEL.driftYoung : MODEL.driftOld;
}

export function processSd(age: number, frozen: boolean): number {
  if (frozen) return MODEL.qFrozen;
  if (age < MODEL.qAgeYoungDays) return MODEL.qYoung;
  if (age < MODEL.qAgeMidDays) return MODEL.qMid;
  return MODEL.qOld;
}

/**
 * Advance bag `b` to `atIso`. `events` are storage events that happened since the last
 * shot (frozen / thawed / opened). Mutates the state.
 */
export function predictBag(
  s: FlowModelState,
  b: BagState,
  atIso: string,
  events: StorageEventKind[] = [],
): void {
  const i = b.index;
  for (const e of events) {
    if (e === 'frozen') b.frozen = true;
    if (e === 'thawed' || e === 'opened') {
      b.frozen = false;
      (s.P[i] as number[])[i] = (s.P[i]?.[i] ?? 0) + MODEL.thawVar;
    }
  }
  if (b.lastAt !== null) {
    const dd = Math.max(0, (Date.parse(atIso) - Date.parse(b.lastAt)) / 86_400_000);
    if (dd > 0) {
      const age = ageDays(b.meta, atIso);
      s.m[i] = (s.m[i] ?? 0) + driftPerDay(age, b.frozen) * dd;
      (s.P[i] as number[])[i] = (s.P[i]?.[i] ?? 0) + processSd(age, b.frozen) ** 2 * dd;
    }
  }
  b.lastAt = atIso;
  // Shared gains: sd grows 0.010 → 0.012 over about a year.
  if (s.lastAt !== null) {
    const dd = Math.max(0, (Date.parse(atIso) - Date.parse(s.lastAt)) / 86_400_000);
    if (dd > 0) {
      (s.P[IDX_KG] as number[])[IDX_KG] = (s.P[IDX_KG]?.[IDX_KG] ?? 0) + MODEL.kDriftVarPerDay * dd;
      (s.P[IDX_KR] as number[])[IDX_KR] = (s.P[IDX_KR]?.[IDX_KR] ?? 0) + MODEL.kDriftVarPerDay * dd;
      (s.P[IDX_KQ] as number[])[IDX_KQ] =
        (s.P[IDX_KQ]?.[IDX_KQ] ?? 0) + RPM.curvDriftVarPerDay * dd;
    }
  }
  if (s.lastAt === null || atIso > s.lastAt) s.lastAt = atIso;
}
