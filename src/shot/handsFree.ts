/**
 * Hands-free shot flow: the scale moves the steps on, so a shot needs no taps.
 *
 *   ready  ──dosing cup down (auto-tare)──▶ weigh ──dose steady 1 s──▶ grind
 *   grind  ──espresso cup down (auto-tare)──▶ armed ──first drops──▶ pour (recorder)
 *   pour   ──flow stops, drip window──▶ rate ──saved──▶ ready
 *
 * - The dosing cup is told apart from the espresso cup by weight once it has been learned
 *   (the first weighing teaches it): from ready, any other cup arms straight away, so a shot
 *   without weighing still needs no taps.
 * - While weighing, a reading far past the planned dose that keeps rising is coffee, not
 *   beans (the cup went under the spout without weighing): the controller arms and the
 *   recorder's hands-free start splices the shot back to its first drops.
 * - Putting the dosing cup back after grinding (empty, or with the grounds to check
 *   retention) is ignored; only the espresso cup arms.
 * Pure and DOM-free: the app feeds it every frame with the tare that frame produced, and runs
 * the actions it returns.
 */
import { REC } from '../core/params';
import type { Phase } from './machine';
import type { RingBuffer } from './ringBuffer';
import { steadyDose } from './weigh';

export type HfStep = 'ready' | 'weigh' | 'grind' | 'armed' | 'pour' | 'rate';

export interface HfState {
  step: HfStep;
  sinceMs: number;
  /** Weight of the dosing cup put down for the current weighing (learned on capture). */
  cupCandidateG: number | null;
  /** When the current steady dose was first seen (it must hold for 1 s). */
  steadySinceMs: number | null;
  /** The dose captured in this cycle (to recognise the dosing cup with its grounds). */
  doseG: number | null;
}

export interface HfInput {
  nowMs: number;
  connected: boolean;
  phase: Phase;
  /** A shot is waiting for its rating (the rate sheet is open). */
  pending: boolean;
  ring: RingBuffer;
  /** An auto-tare fired on this frame, with the weight that was put down. */
  tare: { placedG: number } | null;
  plannedDoseG: number;
  /** Learned weight of the dosing cup (Settings), null until the first weighing. */
  dosingCupG: number | null;
}

export type HfCue = 'weigh' | 'dose' | 'armed' | 'rate';

export type HfAction =
  | { type: 'openWeigh' }
  | { type: 'useDose'; g: number; dosingCupG: number | null }
  | { type: 'arm' }
  | { type: 'toPlan' }
  | { type: 'cue'; cue: HfCue; doseG?: number };

export const HF = {
  /** A dose must hold steady this long before the flow moves on. */
  holdMs: 1000,
  /** Plausible dose as a fraction of the plan (beans, not a cup or coffee). */
  doseMinFrac: 0.6,
  doseMaxFrac: 1.4,
  /** Same object if its weight is within this of the learned one. */
  cupMatchG: 4,
  /** While weighing: past this fraction of the plan and still rising = coffee, not beans. */
  coffeeFrac: 1.5,
} as const;

export function initHandsFree(nowMs = 0): HfState {
  return { step: 'ready', sinceMs: nowMs, cupCandidateG: null, steadySinceMs: null, doseG: null };
}

function go(st: HfState, step: HfStep, nowMs: number, patch: Partial<HfState> = {}): HfState {
  return { ...st, step, sinceMs: nowMs, steadySinceMs: null, ...patch };
}

export function handsFreeStep(st: HfState, inp: HfInput): { state: HfState; actions: HfAction[] } {
  const actions: HfAction[] = [];
  const now = inp.nowMs;
  // The recorder owns the shot itself; follow it.
  const recording =
    inp.phase === 'RUNNING' ||
    inp.phase === 'ENDING' ||
    inp.phase === 'SETTLING' ||
    inp.phase === 'RECOVERING';
  if (recording) {
    return { state: st.step === 'pour' ? st : go(st, 'pour', now), actions };
  }
  if (inp.pending || inp.phase === 'RATE') {
    if (st.step !== 'rate') actions.push({ type: 'cue', cue: 'rate' });
    return { state: st.step === 'rate' ? st : go(st, 'rate', now), actions };
  }
  if (st.step === 'rate' || st.step === 'pour') {
    // Saved (or discarded): back to the start for the next shot.
    actions.push({ type: 'toPlan' });
    return { state: go(st, 'ready', now, { cupCandidateG: null, doseG: null }), actions };
  }
  if (!inp.connected) return { state: st, actions };
  const last = inp.ring.last()?.grams ?? 0;
  // The dosing cup: the learned weight, or (before it is learned) this cycle's own weighing;
  // empty, or carrying the grounds.
  const cupG = inp.dosingCupG ?? st.cupCandidateG;
  const isDosingCup = (g: number) =>
    cupG !== null &&
    (Math.abs(g - cupG) <= HF.cupMatchG ||
      (st.doseG !== null && Math.abs(g - cupG - st.doseG) <= HF.cupMatchG));

  switch (st.step) {
    case 'ready': {
      if (!inp.tare) break;
      // A cup that is not the (learned) dosing cup: no weighing this time, arm straight away.
      if (inp.dosingCupG !== null && !isDosingCup(inp.tare.placedG)) {
        actions.push({ type: 'arm' }, { type: 'cue', cue: 'armed' });
        return { state: go(st, 'armed', now), actions };
      }
      actions.push({ type: 'openWeigh' }, { type: 'cue', cue: 'weigh' });
      return { state: go(st, 'weigh', now, { cupCandidateG: inp.tare.placedG }), actions };
    }
    case 'weigh': {
      // Cup taken off before a dose was taken: start over.
      if (last <= -REC.autoTareRemovedG) {
        actions.push({ type: 'toPlan' });
        return { state: go(st, 'ready', now, { cupCandidateG: null }), actions };
      }
      // Coffee, not beans: the cup went under the spout without weighing.
      const flow = inp.ring.flowOver(REC.liveFlowWindowMs, now);
      if (last > HF.coffeeFrac * inp.plannedDoseG && flow > REC.forgotTapFlowGps) {
        actions.push({ type: 'arm' });
        return { state: go(st, 'armed', now, { cupCandidateG: null }), actions };
      }
      const dose = steadyDose(inp.ring, now);
      const plausible =
        dose !== null &&
        dose >= HF.doseMinFrac * inp.plannedDoseG &&
        dose <= HF.doseMaxFrac * inp.plannedDoseG;
      if (!plausible || dose === null) return { state: { ...st, steadySinceMs: null }, actions };
      const since = st.steadySinceMs ?? now;
      if (now - since < HF.holdMs) return { state: { ...st, steadySinceMs: since }, actions };
      actions.push(
        { type: 'useDose', g: dose, dosingCupG: st.cupCandidateG },
        { type: 'cue', cue: 'dose', doseG: dose },
      );
      return { state: go(st, 'grind', now, { doseG: dose }), actions };
    }
    case 'grind': {
      if (!inp.tare) break;
      // The dosing cup back on the scale (empty or with the grounds) is not the espresso cup.
      if (isDosingCup(inp.tare.placedG)) break;
      actions.push({ type: 'arm' }, { type: 'cue', cue: 'armed' });
      return { state: go(st, 'armed', now), actions };
    }
    case 'armed': {
      // Disarmed by hand (or never armed): back to ready.
      if (inp.phase !== 'ARMED' && now - st.sinceMs > 2000) {
        return { state: go(st, 'ready', now, { cupCandidateG: null, doseG: null }), actions };
      }
      break;
    }
    default:
      break;
  }
  return { state: st, actions };
}
