import { describe, expect, it } from 'vitest';
import {
  type HfAction,
  type HfInput,
  type HfState,
  handsFreeStep,
  initHandsFree,
} from '../../src/shot/handsFree';
import type { Phase } from '../../src/shot/machine';
import { RingBuffer } from '../../src/shot/ringBuffer';

/** Drives the controller frame by frame the way the app does. */
class Rig {
  ring = new RingBuffer();
  now = 1000;
  st: HfState = initHandsFree(1000);
  phase: Phase = 'IDLE';
  pending = false;
  dosingCupG: number | null = null;
  actions: HfAction[] = [];

  frame(g: number, tare: { placedG: number } | null = null): void {
    this.now += 100;
    this.ring.push({ tRxMs: this.now, grams: g, flowScale: 0, timerMs: 0 });
    const inp: HfInput = {
      nowMs: this.now,
      connected: true,
      phase: this.phase,
      pending: this.pending,
      ring: this.ring,
      tare,
      plannedDoseG: 18,
      dosingCupG: this.dosingCupG,
    };
    const r = handsFreeStep(this.st, inp);
    this.st = r.state;
    this.actions.push(...r.actions);
    for (const a of r.actions) {
      if (a.type === 'arm') this.phase = 'ARMED';
      if (a.type === 'useDose' && a.dosingCupG !== null) this.dosingCupG = a.dosingCupG;
    }
  }

  hold(g: number, ms: number): void {
    for (let i = 0; i < ms / 100; i++) this.frame(g);
  }

  types(): string[] {
    return this.actions.map((a) => (a.type === 'cue' ? `cue:${a.cue}` : a.type));
  }
}

describe('hands-free flow', () => {
  it('runs a whole cycle with no taps: weigh, grind, arm, pour, rate, ready', () => {
    const r = new Rig();
    r.hold(0, 1000);
    r.frame(0, { placedG: 92.4 }); // dosing cup down, auto-tared
    expect(r.st.step).toBe('weigh');
    // Beans in over 2 s, then steady at 18.2 g (one-count jitter).
    for (let i = 1; i <= 20; i++) r.frame((18.2 * i) / 20);
    r.hold(18.2, 1200);
    expect(r.st.step).toBe('weigh'); // steady for 1.5 s first, then held 1 s
    r.hold(18.2, 1500);
    expect(r.st.step).toBe('grind');
    const use = r.actions.find((a) => a.type === 'useDose');
    expect(use?.type === 'useDose' && use.g).toBe(18.2);
    expect(r.dosingCupG).toBe(92.4);
    // Dosing cup off (to the hopper), then back with the grounds: ignored.
    r.hold(-110.6, 2000);
    r.frame(0, { placedG: 92.4 + 18.1 });
    expect(r.st.step).toBe('grind');
    // Espresso cup down: armed.
    r.hold(-110.5, 1500);
    r.frame(0, { placedG: 168 });
    expect(r.st.step).toBe('armed');
    expect(r.phase).toBe('ARMED');
    // The recorder pours, then the rating sheet opens, then it is saved.
    r.phase = 'RUNNING';
    r.hold(20, 500);
    expect(r.st.step).toBe('pour');
    r.phase = 'RATE';
    r.pending = true;
    r.frame(36);
    expect(r.st.step).toBe('rate');
    r.phase = 'SAVED';
    r.pending = false;
    r.frame(36);
    expect(r.st.step).toBe('ready');
    expect(r.types()).toEqual([
      'openWeigh',
      'cue:weigh',
      'useDose',
      'cue:dose',
      'arm',
      'cue:armed',
      'cue:rate',
      'toPlan',
    ]);
  });

  it('with the dosing cup learned, another cup arms straight away (no weighing)', () => {
    const r = new Rig();
    r.dosingCupG = 92.4;
    r.hold(0, 500);
    r.frame(0, { placedG: 168 });
    expect(r.st.step).toBe('armed');
    expect(r.types()).toEqual(['arm', 'cue:armed']);
  });

  it('coffee arriving while weighing arms the recorder (the cup went under the spout)', () => {
    const r = new Rig();
    r.hold(0, 500);
    r.frame(0, { placedG: 175 }); // first time: taken for the dosing cup
    expect(r.st.step).toBe('weigh');
    // Coffee at 2 g/s: past 27 g and rising.
    for (let i = 1; i <= 160; i++) r.frame(i * 0.2);
    expect(r.st.step).toBe('armed');
    expect(r.types()).toContain('arm');
    expect(r.types()).not.toContain('useDose');
  });

  it('an implausible steady reading is not a dose; lifting the cup starts over', () => {
    const r = new Rig();
    r.hold(0, 500);
    r.frame(0, { placedG: 92 });
    r.hold(4.2, 4000); // a few beans only
    expect(r.st.step).toBe('weigh');
    r.hold(-92, 500);
    expect(r.st.step).toBe('ready');
    expect(r.types()).toEqual(['openWeigh', 'cue:weigh', 'toPlan']);
  });
});
