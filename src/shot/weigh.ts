/**
 * Bean weighing (before grinding): dosing cup on the scale → auto-tare → beans in → the
 * steady reading is the dose, to the scale's 0.1 g. Pure and DOM-free; the Shot screen
 * feeds it the connection state, the shared ring buffer and the last tare time.
 */
import { REC } from '../core/params';
import type { RingBuffer } from './ringBuffer';

export type WeighPhase = 'need_scale' | 'place_cup' | 'add_beans' | 'captured';

export interface WeighState {
  phase: WeighPhase;
  /** When the step was opened; a tare after this means the dosing cup is zeroed. */
  openedAtMs: number;
  /** Captured dose (g, one decimal) or null. */
  doseG: number | null;
}

export function openWeigh(nowMs: number): WeighState {
  return { phase: 'place_cup', openedAtMs: nowMs, doseG: null };
}

export interface WeighInput {
  connected: boolean;
  nowMs: number;
  /** Last plain tare (auto-tare or the "Tare now" button), receive time. */
  tareAtMs: number | null;
  ring: RingBuffer;
}

const round1 = (g: number) => Math.round(g * 10) / 10;

/** The steady reading over the last 1.5 s, or null while it still moves. */
export function steadyDose(ring: RingBuffer, nowMs: number): number | null {
  const last = ring.last();
  if (!last || last.grams < REC.weighMinG) return null;
  const first = ring.samples[0];
  if (!first || first.tRxMs > nowMs - REC.weighStableMs) return null;
  if (ring.rangeOver(REC.weighStableMs, nowMs) > REC.weighStableRangeG + 1e-9) return null;
  const med = ring.medianBetween(nowMs - REC.weighStableMs, nowMs);
  return Number.isNaN(med) ? null : round1(med);
}

export function weighStep(st: WeighState, inp: WeighInput): WeighState {
  if (!inp.connected) return { ...st, phase: 'need_scale' };
  const tared = inp.tareAtMs !== null && inp.tareAtMs >= st.openedAtMs;
  if (!tared) return { ...st, phase: 'place_cup', doseG: null };
  const last = inp.ring.last()?.grams ?? 0;
  if (st.phase === 'captured' && st.doseG !== null) {
    // More beans or some taken out: capture again.
    if (Math.abs(last - st.doseG) >= REC.weighReopenG)
      return { ...st, phase: 'add_beans', doseG: null };
    return st;
  }
  const dose = steadyDose(inp.ring, inp.nowMs);
  if (dose !== null && inp.nowMs - (inp.tareAtMs ?? 0) >= REC.tareApplyMs) {
    return { ...st, phase: 'captured', doseG: dose };
  }
  return { ...st, phase: 'add_beans', doseG: null };
}

/** The note shown when the weighed dose is off the plan (null when within 0.3 g). */
export function doseNote(doseG: number, plannedG: number, targetYieldG: number): string | null {
  const diff = doseG - plannedG;
  if (Math.abs(diff) <= REC.weighNoteG + 1e-9) return null;
  const ratio = targetYieldG / doseG;
  return `${Math.abs(diff).toFixed(1)} g ${diff > 0 ? 'over' : 'under'} the planned ${plannedG.toFixed(1)} g: the yield stays ${targetYieldG.toFixed(0)} g, so the ratio becomes 1:${ratio.toFixed(2)}.`;
}
