import { describe, expect, it } from 'vitest';
import { beepsFor, CUE_BEEPS, playCue } from '../../src/app/cues';
import { commands } from '../../src/scale/protocol';

describe('beep cues', () => {
  it('beeps 1 for the tared dosing cup, 2 for the dose, 1 armed, 3 at the pre-alert', () => {
    expect(CUE_BEEPS).toEqual({ weigh: 1, dose: 2, armed: 1, rate: 0, pre_alert: 3 });
    expect(beepsFor('pre_alert', null)).toBe(3);
    expect(beepsFor('dose', { beepCues: true })).toBe(2);
    expect(beepsFor('dose', { beepCues: false })).toBe(0);
  });

  it('sends 02 with the count, and nothing when off or silent', async () => {
    const sent: Uint8Array[] = [];
    const send = async (b: Uint8Array) => {
      sent.push(b);
    };
    playCue('pre_alert', {}, send);
    playCue('rate', {}, send);
    playCue('armed', { beepCues: false }, send);
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual(commands.beep(3));
    // A failed write is swallowed.
    playCue('dose', {}, () => Promise.reject(new Error('gatt busy')));
    await Promise.resolve();
  });
});
