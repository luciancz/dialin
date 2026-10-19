/**
 * Auto-tare: tare once when a cup (or the dosing cup) is put on the scale and the reading
 * settles, so the display reads 0 before beans or coffee go in. Pure and DOM-free: the app
 * calls `autoTareStep` on every weight frame with the shared ring buffer and sends the tare.
 *
 * A placement is a rise of ≥ 20 g within the last 3 s that contains a frame-to-frame jump of
 * ≥ 8 g (a hand putting something down), then a reading steady within ±0.2 g for 1 s. A pour
 * never matches: coffee adds ≈ 0.4 g per frame and beans poured from a cup ≈ 2 g per frame,
 * and after a tare the detector stays off until something is taken off the scale (the reading
 * falls to −10 g or below), so the beans going into a tared dosing cup are never tared away.
 */
import { REC } from '../core/params';
import type { RingBuffer } from './ringBuffer';

export interface AutoTareState {
  /** Ready to tare the next placement. */
  armed: boolean;
  lastTareAtMs: number | null;
}

export function initAutoTare(): AutoTareState {
  return { armed: true, lastTareAtMs: null };
}

export interface AutoTareResult {
  state: AutoTareState;
  tare: boolean;
}

/**
 * One frame. `enabled` is false while a shot is recording or rated (and when the setting is
 * off); removal is still tracked so the detector re-arms after the shot.
 */
export function autoTareStep(
  st: AutoTareState,
  ring: RingBuffer,
  nowMs: number,
  enabled: boolean,
): AutoTareResult {
  const last = ring.last();
  if (!last) return { state: st, tare: false };
  let state = st;
  if (!state.armed && last.grams <= -REC.autoTareRemovedG) state = { ...state, armed: true };
  if (!enabled || !state.armed) return { state, tare: false };
  if (state.lastTareAtMs !== null && nowMs - state.lastTareAtMs < REC.autoTareCooldownMs) {
    return { state, tare: false };
  }
  if (Math.abs(last.grams) <= REC.autoTareBandG) return { state, tare: false };
  const settleFrom = nowMs - REC.autoTareSettleMs;
  if (ring.rangeOver(REC.autoTareSettleMs, nowMs) > 2 * REC.autoTareBandG) {
    return { state, tare: false };
  }
  // The settle window must be covered by samples (not one frame after a gap).
  const first = ring.samples[0];
  if (!first || first.tRxMs > settleFrom) return { state, tare: false };
  const from = settleFrom - REC.autoTareLookbackMs;
  const before = ring.at(from) ?? first;
  const step = last.grams - before.grams;
  const jump = ring.maxJumpBetween(from, nowMs);
  if (step < REC.autoTareStepG || jump < REC.placementJumpG) return { state, tare: false };
  return { state: { armed: false, lastTareAtMs: nowMs }, tare: true };
}
