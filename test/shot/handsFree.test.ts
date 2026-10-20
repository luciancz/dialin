import { describe, expect, it } from 'vitest';
import type { ShotSettings } from '../../src/core/types';
import {
  deviationFromCard,
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
  /** The pre-shot step on screen, moved by the actions as the app does. */
  preStep: HfInput['preStep'] = 'plan';
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
      preStep: this.preStep,
    };
    const r = handsFreeStep(this.st, inp);
    this.st = r.state;
    this.actions.push(...r.actions);
    for (const a of r.actions) {
      if (a.type === 'arm') this.phase = 'ARMED';
      if (a.type === 'openWeigh') this.preStep = 'weigh';
      if (a.type === 'useDose') this.preStep = 'grind';
      if (a.type === 'toPlan') this.preStep = 'plan';
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

  it('follows the manual buttons: armed by hand, dose taken by hand, weighing opened by hand', () => {
    const r = new Rig();
    r.hold(0, 500);
    r.phase = 'ARMED'; // the Arm button
    r.frame(0);
    expect(r.st.step).toBe('armed');
    expect(r.actions).toEqual([]);

    const w = new Rig();
    w.dosingCupG = 92.4;
    w.hold(0, 500);
    w.preStep = 'weigh'; // "Weigh beans" tapped, then a different cup put down
    w.frame(0, { placedG: 60 });
    expect(w.st.step).toBe('weigh');
    for (let i = 1; i <= 10; i++) w.frame(1.8 * i);
    w.preStep = 'grind'; // "Use 18.0 g" tapped before the controller took it
    w.hold(18, 300);
    expect(w.st.step).toBe('grind');
    expect(w.types()).not.toContain('useDose');
    // That cup back with the grounds (dose from the plan) is still not the espresso cup.
    w.hold(-78, 1500);
    w.frame(0, { placedG: 60 + 17.9 });
    expect(w.st.step).toBe('grind');
    w.hold(-78, 1500);
    w.frame(0, { placedG: 168 });
    expect(w.st.step).toBe('armed');
  });

  it('back to weighing from the grind step re-opens the weighing', () => {
    const r = new Rig();
    r.hold(0, 500);
    r.frame(0, { placedG: 92.4 });
    for (let i = 1; i <= 20; i++) r.frame((18 * i) / 20);
    r.hold(18, 3000);
    expect(r.st.step).toBe('grind');
    r.preStep = 'weigh';
    r.frame(18);
    expect(r.st.step).toBe('weigh');
  });
});

describe('hands-free: deviation from the card', () => {
  const card: ShotSettings = {
    grind: { dialPos: { rev: 1, number: 8, line: 2 }, rpm: 1100, rpmConfirmed: false },
    doseG: 18,
    targetYieldG: 40,
    tempSwitch: 1,
  };
  it('a weighed dose still follows the card; a hand edit is partly', () => {
    expect(deviationFromCard(card, card, null)).toBe('followed');
    expect(deviationFromCard({ ...card, doseG: 18.3 }, card, 18.3)).toBe('followed');
    expect(deviationFromCard({ ...card, doseG: 18.5 }, card, null)).toBe('partly');
    expect(deviationFromCard({ ...card, targetYieldG: 38 }, card, null)).toBe('partly');
    expect(
      deviationFromCard({ ...card, grind: { ...card.grind, rpmConfirmed: true } }, card, null),
    ).toBe('followed');
    expect(
      deviationFromCard(
        { ...card, grind: { ...card.grind, dialPos: { rev: 1, number: 8, line: 3 } } },
        card,
        null,
      ),
    ).toBe('partly');
  });
});
