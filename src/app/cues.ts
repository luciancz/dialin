/**
 * Cues for a shot without looking at the phone: the scale beeps (command 02, "beep n").
 * Speech and navigator.vibrate are unreliable in Bluefy, so the scale is the only voice.
 *
 *   1  the dosing cup was tared (add the beans)
 *   2  the dose was taken (grind it)
 *   1  armed (lever up and press the scale's timer)
 *   3  pre-alert: the target minus the drip tail is in the cup (lever down)
 *
 * Settings → "Beep cues" turns them off (default on).
 */
import type { Settings } from '../core/types';
import { diag } from '../diag/log';
import { commands } from '../scale/protocol';
import type { HfCue } from '../shot/handsFree';

export type Cue = HfCue | 'pre_alert';

export const CUE_BEEPS: Readonly<Record<Cue, number>> = {
  weigh: 1,
  dose: 2,
  armed: 1,
  rate: 0,
  pre_alert: 3,
};

/** How many beeps a cue gets with these settings (0 = silent). */
export function beepsFor(cue: Cue, settings: Pick<Settings, 'beepCues'> | null): number {
  return settings?.beepCues === false ? 0 : CUE_BEEPS[cue];
}

/** Beep the cue on the scale; a failed write is logged, never thrown. */
export function playCue(
  cue: Cue,
  settings: Pick<Settings, 'beepCues'> | null,
  send: (bytes: Uint8Array) => Promise<void>,
): void {
  const n = beepsFor(cue, settings);
  if (n === 0) return;
  void send(commands.beep(n)).catch((err) => diag.log('warn', `cue ${cue} failed: ${String(err)}`));
}
