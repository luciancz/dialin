import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/math/rng';
import { type CurveSpec, synthCurve } from '../../src/core/sim/curveSynth';
import { autoTareStep, initAutoTare } from '../../src/shot/autoTare';
import {
  type Effect,
  initialState,
  learnGate,
  pumpOnset,
  type RecorderEvent,
  type RecorderState,
  reduce,
  timerDriftPct,
} from '../../src/shot/machine';
import { RingBuffer } from '../../src/shot/ringBuffer';

/**
 * A scripted scale: the test controls time, the cup weight and whether the timer runs,
 * and feeds frames at 100 ms through the ring and the reducer.
 */
class Harness {
  state: RecorderState = initialState();
  ring = new RingBuffer();
  effects: Effect[] = [];
  now = 10_000;
  timerRunning = false;
  timerStartedAt = 0;
  timerFrozenMs = 0;
  cupG = 0;
  tareG = 0;
  connected = true;
  /** Scale persona: honour 04/07 (timer mode) or ignore them (auto mode). */
  mode: 'timer' | 'auto' = 'timer';

  dispatch(ev: RecorderEvent): Effect[] {
    const [s, fx] = reduce(this.state, ev, this.ring);
    this.state = s;
    this.effects.push(...fx);
    for (const f of fx) {
      if (f.type === 'send') this.onCommand(f.cmd);
    }
    return fx;
  }

  onCommand(cmd: string): void {
    if (this.mode === 'auto' && (cmd === 'tareStart' || cmd === 'start')) return;
    if (cmd === 'tareStart') {
      this.tareG = this.cupG;
      this.timerRunning = true;
      this.timerStartedAt = this.now;
      this.timerFrozenMs = 0;
    } else if (cmd === 'start') {
      if (!this.timerRunning && this.timerFrozenMs === 0) {
        this.timerRunning = true;
        this.timerStartedAt = this.now;
      }
    } else if (cmd === 'tare') {
      this.tareG = this.cupG;
    } else if (cmd === 'reset') {
      // 06 zeroes the timer only when it is stopped (docs/PROTOCOL.md).
      if (!this.timerRunning) this.timerFrozenMs = 0;
    } else if (cmd === 'stop') {
      if (this.timerRunning) {
        this.timerFrozenMs = this.timerMs();
        this.timerRunning = false;
      }
    }
  }

  timerMs(): number {
    return this.timerRunning
      ? Math.round((this.now - this.timerStartedAt) * 0.993)
      : this.timerFrozenMs;
  }

  /** Advance 100 ms and deliver one frame (unless disconnected). */
  step(cupG = this.cupG): void {
    this.now += 100;
    this.cupG = cupG;
    if (!this.connected) {
      this.dispatch({ type: 'tick', now: this.now });
      return;
    }
    const grams = Math.round((this.cupG - this.tareG) * 10) / 10;
    this.ring.push({ tRxMs: this.now, grams, flowScale: 0, timerMs: this.timerMs() });
    this.dispatch({
      type: 'frame',
      now: this.now,
      grams,
      flow: 0,
      timerMs: this.timerMs(),
      tRxMs: this.now,
    });
    if ((this.now / 100) % 3 === 0) this.dispatch({ type: 'tick', now: this.now });
    this.afterFrame();
  }

  idle(ms: number, cupG = this.cupG): void {
    for (let i = 0; i < ms / 100; i++) this.step(cupG);
  }

  /** Play a synthetic curve into the cup (cup weight = base + curve weight). */
  playCurve(
    curve: { t: number[]; g: number[] },
    base = this.cupG,
    untilS?: number,
    onStep?: (tS: number) => void,
  ): void {
    const end = untilS ?? curve.t[curve.t.length - 1] ?? 0;
    for (let i = 0; i < curve.t.length; i++) {
      const tS = curve.t[i] ?? 0;
      if (tS > end) break;
      if (this.state.phase === 'RATE' || this.state.phase === 'IDLE') break;
      this.step(base + (curve.g[i] ?? 0));
      onStep?.(tS);
    }
  }

  /** The app's auto-tare path: detector on every frame, 01 to the scale, then 'tared'. */
  autoTare = initAutoTare();
  autoTareOn = false;

  afterFrame(): void {
    if (!this.autoTareOn) return;
    const p = this.state.phase;
    const idle = p === 'IDLE' || p === 'ARMED' || p === 'SAVED' || p === 'ABORTED';
    const r = autoTareStep(this.autoTare, this.ring, this.now, idle);
    this.autoTare = r.state;
    if (r.tare) {
      this.onCommand('tare');
      this.effects.push({ type: 'send', cmd: 'tare' });
      this.dispatch({ type: 'tared', now: this.now });
    }
  }

  sent(cmd: string): number {
    return this.effects.filter((e) => e.type === 'send' && e.cmd === cmd).length;
  }

  has(type: Effect['type'], code?: string): boolean {
    return this.effects.some(
      (e) => e.type === type && (code === undefined || ('code' in e && e.code === code)),
    );
  }
}

const spec: CurveSpec = {
  firstDripS: 8,
  plateauGps: 1.9,
  rampS: 3,
  lateRise: 0,
  stopAtG: 36,
  tailG: 1.2,
  tailS: 4.5,
  noiseG: 0.03,
  truncG: 0.1,
};
const curve = synthCurve(spec, mulberry32(5));

function armed(h: Harness, target = 36): void {
  h.cupG = 120; // cup on the scale, scale shows 120 g (not yet tared)
  h.idle(2500);
  h.dispatch({ type: 'arm', now: h.now, targetYieldG: target });
  h.idle(500);
  expect(h.state.phase).toBe('ARMED');
  expect(h.state.armed?.stable).toBe(true);
}

describe('recorder: normal shot', () => {
  it('sends tare+start on the tap, anchors the scale timer, pre-alerts, ends on the stop tap, settles and finalizes', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    expect(h.state.phase).toBe('RUNNING');
    expect(h.sent('tareStart')).toBe(1);
    expect(h.sent('start')).toBe(0);
    expect(h.has('shot_running')).toBe(true);
    const stopAtIdx = curve.t.findIndex((t) => t >= curve.endAt);
    h.playCurve(curve, 120, curve.endAt);
    expect(h.state.draft?.modeHint).toBe('timer');
    expect(h.has('pre_alert')).toBe(true);
    expect(h.state.phase).toBe('RUNNING');
    // User taps stop at the target.
    h.dispatch({ type: 'tap', now: h.now });
    expect(h.state.phase).toBe('ENDING');
    expect(h.sent('stop')).toBe(1);
    const endAt = h.state.draft?.endAt ?? 0;
    expect(Math.abs(endAt - curve.endAt)).toBeLessThan(0.5);
    // Drip tail for 6 s.
    for (let i = stopAtIdx + 1; i < curve.t.length; i++) h.step(120 + (curve.g[i] ?? 0));
    h.idle(1000);
    expect(h.state.phase).toBe('RATE');
    const d = h.state.draft;
    expect(d?.status).toBe('ok');
    expect(d?.endedBy).toBe('tap');
    expect(Math.abs((d?.finalYieldG ?? 0) - curve.finalYieldG)).toBeLessThan(0.3);
    expect(d?.gaps.length).toBe(0);
    expect(d?.samples.length).toBeGreaterThan(200);
    // Scale timer authority: 0.7 % slow timer shows as a positive drift against the receive clock.
    expect(timerDriftPct(d as NonNullable<typeof d>)).toBeCloseTo(0.7, 0);
    expect(h.has('finalize')).toBe(true);
    expect(learnGate('ok', true)).toBe(true);
    expect(learnGate('ok', false)).toBe(false);
    expect(learnGate('partial_disconnect', true)).toBe(false);
  });

  it('auto-ends after 3 s below 0.15 g/s and on a +3 g overshoot', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    // Flow stops around 24 g (above half the target): hold the weight constant.
    h.playCurve(curve, 120, 22);
    const base = h.cupG;
    h.idle(5000, base);
    expect(h.state.draft?.endedBy).toBe('auto');
    expect(['ENDING', 'SETTLING']).toContain(h.state.phase);

    const h2 = new Harness();
    armed(h2, 20);
    h2.dispatch({ type: 'tap', now: h2.now });
    h2.playCurve(curve, 120, 40);
    expect(h2.state.draft?.endedBy).toBe('auto');
    expect(h2.state.draft?.endAt ?? 99).toBeLessThan(curve.endAt);
  });
});

describe('recorder: late and forgotten taps', () => {
  it('late tap sends 04 (not 07), tares in software and splices the pre-tap frames', () => {
    const h = new Harness();
    armed(h);
    // Pump started 2 s before the tap: weight already rising.
    const idx = curve.t.findIndex((t) => t >= 11);
    for (let i = 0; i <= idx; i++) h.step(120 + (curve.g[i] ?? 0));
    expect(h.state.phase).toBe('ARMED');
    h.dispatch({ type: 'tap', now: h.now });
    expect(h.state.phase).toBe('RUNNING');
    expect(h.sent('start')).toBe(1);
    expect(h.sent('tareStart')).toBe(0);
    const d = h.state.draft;
    expect(d?.status).toBe('late_tap');
    expect(d?.preTapSpliceS ?? 0).toBeGreaterThan(0.5);
    expect(d?.samples.length ?? 0).toBeGreaterThan(5);
    expect(Math.abs(d?.samples[0]?.g ?? 99)).toBeLessThan(0.5);
    expect(h.has('warn', 'late_tap')).toBe(true);
    h.playCurve(curve.t.map((t) => t).length ? curve : curve, 120, curve.endAt);
    expect(h.state.draft?.modeHint).toBe('timer');
    expect(learnGate('late_tap', true)).toBe(true);
  });

  it('forgot tap prompts in ARMED and recovers on accept', () => {
    const h = new Harness();
    armed(h);
    const idx = curve.t.findIndex((t) => t >= 14);
    for (let i = 0; i <= idx; i++) h.step(120 + (curve.g[i] ?? 0));
    expect(h.state.prompt).toBe('forgot_tap');
    expect(h.has('prompt')).toBe(true);
    h.dispatch({ type: 'accept_forgot_tap', now: h.now });
    expect(h.state.phase).toBe('RUNNING');
    expect(h.state.draft?.status).toBe('no_tap_recovered');
    expect(h.sent('start')).toBe(1);
    expect(learnGate('no_tap_recovered', true)).toBe(false);
  });
});

describe('recorder: Auto-mode persona', () => {
  it('flags not-in-Timer-mode after 5 frames with a zero timer and continues on the app clock', () => {
    const h = new Harness();
    h.mode = 'auto';
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    h.playCurve(curve, 120, 5);
    expect(h.state.draft?.modeHint).toBe('auto');
    expect(h.has('mode_hint')).toBe(true);
    expect(h.has('warn', 'not_timer_mode')).toBe(true);
    const last = h.state.draft?.samples[h.state.draft.samples.length - 1];
    expect(last?.t ?? 0).toBeGreaterThan(4);
  });
});

describe('recorder: disconnects', () => {
  it('recovers a link lost mid-shot and records the gap', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    h.playCurve(curve, 120, 12);
    h.connected = false;
    h.dispatch({ type: 'disconnected', now: h.now });
    expect(h.state.phase).toBe('RECOVERING');
    const idx12 = curve.t.findIndex((t) => t >= 12);
    const idx15 = curve.t.findIndex((t) => t >= 15);
    for (let i = idx12; i < idx15; i++) h.step(120 + (curve.g[i] ?? 0));
    h.connected = true;
    for (let i = idx15; i < curve.t.length; i++) {
      if (h.state.phase === 'RATE') break;
      h.step(120 + (curve.g[i] ?? 0));
      if ((curve.t[i] ?? 0) >= curve.endAt && h.state.phase === 'RUNNING')
        h.dispatch({ type: 'tap', now: h.now });
    }
    h.idle(1000);
    const d = h.state.draft;
    expect(d?.gaps.length).toBe(1);
    expect((d?.gaps[0]?.[1] ?? 0) - (d?.gaps[0]?.[0] ?? 0)).toBeGreaterThan(2.5);
    expect(d?.status).toBe('ok');
    expect(h.has('warn', 'reconnected')).toBe(true);
  });

  it('ends the shot after 20 s without the link; early loss is partial_disconnect with manual yield', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    h.playCurve(curve, 120, 12);
    h.connected = false;
    h.dispatch({ type: 'disconnected', now: h.now });
    h.idle(21_000);
    expect(h.state.phase).toBe('RATE');
    const d = h.state.draft;
    expect(d?.endedBy).toBe('disconnect');
    expect(d?.status).toBe('partial_disconnect');
    expect(learnGate('partial_disconnect', true)).toBe(false);
    h.dispatch({ type: 'manual_yield', now: h.now, grams: 36.4 });
    expect(h.state.draft?.status).toBe('manual_entry');
    expect(h.state.draft?.finalYieldG).toBe(36.4);
  });

  it('a late loss keeps status ok and ends with the last frame', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    h.playCurve(curve, 120, curve.endAt - 1);
    h.connected = false;
    h.dispatch({ type: 'disconnected', now: h.now });
    h.idle(21_000);
    expect(h.state.phase).toBe('RATE');
    expect(h.state.draft?.status).toBe('ok');
    expect(h.state.draft?.endedBy).toBe('disconnect');
  });

  it('a disconnect while settling finalizes with the last frame', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    h.playCurve(curve, 120, curve.endAt);
    h.dispatch({ type: 'tap', now: h.now });
    h.idle(300);
    expect(h.state.phase).toBe('SETTLING');
    h.connected = false;
    h.dispatch({ type: 'disconnected', now: h.now });
    h.idle(21_000);
    expect(h.state.phase).toBe('RATE');
    expect(h.state.draft?.status).toBe('ok');
  });

  it('a background event during RUNNING opens a gap immediately', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    h.playCurve(curve, 120, 12);
    h.dispatch({ type: 'background', now: h.now });
    expect(h.state.phase).toBe('RECOVERING');
    expect(h.has('warn', 'background')).toBe(true);
    h.playCurve(curve, 120, 14);
    expect(h.state.phase).toBe('RUNNING');
  });
});

describe('recorder: abort', () => {
  it('discards an aborted shot under 5 g and keeps a heavier one as aborted', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    h.playCurve(curve, 120, 9);
    h.dispatch({ type: 'abort', now: h.now });
    expect(h.state.phase).toBe('IDLE');
    expect(h.effects.some((e) => e.type === 'finalize' && e.discard)).toBe(true);

    const h2 = new Harness();
    armed(h2);
    h2.dispatch({ type: 'tap', now: h2.now });
    h2.playCurve(curve, 120, 20);
    h2.dispatch({ type: 'abort', now: h2.now });
    expect(h2.state.phase).toBe('RATE');
    expect(h2.state.draft?.status).toBe('aborted');
    expect(h2.effects.some((e) => e.type === 'finalize' && !e.discard)).toBe(true);
    expect(learnGate('aborted', true)).toBe(false);
  });

  it('ignores taps and frames when idle and resets cleanly', () => {
    const h = new Harness();
    h.dispatch({ type: 'tap', now: h.now });
    expect(h.state.phase).toBe('IDLE');
    h.idle(500);
    expect(h.state.phase).toBe('IDLE');
    armed(h);
    h.dispatch({ type: 'disarm', now: h.now });
    expect(h.state.phase).toBe('IDLE');
  });
});

describe('recorder: cup put down, auto-tare and restarts', () => {
  it('a cup put down while armed is tared once and never raises the forgot-tap prompt', () => {
    const h = new Harness();
    h.autoTareOn = true;
    h.idle(2500, 0);
    h.dispatch({ type: 'arm', now: h.now, targetYieldG: 36 });
    h.idle(300, 0);
    h.idle(3000, 210); // cup down
    expect(h.sent('tare')).toBe(1);
    expect(h.state.tareAtMs).not.toBeNull();
    expect(h.state.prompt).toBeNull();
    expect(h.ring.last()?.grams).toBe(0);
    // Tap: a normal start (07), not a late tap.
    h.dispatch({ type: 'tap', now: h.now });
    expect(h.sent('tareStart')).toBe(1);
    expect(h.state.draft?.status).toBe('ok');
    // The pour itself never auto-tares.
    h.playCurve(curve, 210, curve.endAt);
    expect(h.sent('tare')).toBe(1);
  });

  it('START one second after putting the cup down (no auto-tare) is not a late tap', () => {
    const h = new Harness();
    h.idle(2500, 0);
    h.dispatch({ type: 'arm', now: h.now, targetYieldG: 36 });
    h.idle(1000, 150);
    expect(h.state.prompt).toBeNull();
    h.dispatch({ type: 'tap', now: h.now });
    expect(h.state.draft?.status).toBe('ok');
    expect(h.sent('tareStart')).toBe(1);
    expect(h.state.draft?.samples.length).toBe(0);
  });

  it('a slow pour never auto-tares; taking the cup off re-arms it for the next cup', () => {
    const h = new Harness();
    h.autoTareOn = true;
    h.idle(2000, 0);
    // Coffee-like ramp onto an empty scale at 2 g/s for 20 s: no tare.
    for (let i = 0; i < 200; i++) h.step(i * 0.2);
    h.idle(2000);
    expect(h.sent('tare')).toBe(0);
    h.idle(2000, 0);
    // Dosing cup down → tare; beans poured in quickly (18 g over 1 s) → no second tare.
    h.idle(2500, 95);
    expect(h.sent('tare')).toBe(1);
    for (let i = 1; i <= 10; i++) h.step(95 + 1.8 * i);
    h.idle(3000);
    expect(h.sent('tare')).toBe(1);
    expect(h.ring.last()?.grams).toBeCloseTo(18, 1);
    // Cup off (reading −95 g), espresso cup on → tared again.
    h.idle(1500, 0);
    h.idle(3000, 180);
    expect(h.sent('tare')).toBe(2);
  });

  it('a late tap after a previous shot resets the frozen timer before starting it', () => {
    const h = new Harness();
    armed(h);
    h.dispatch({ type: 'tap', now: h.now });
    h.playCurve(curve, 120, curve.endAt);
    h.dispatch({ type: 'tap', now: h.now });
    h.idle(7000);
    expect(h.state.phase).toBe('RATE');
    expect(h.timerMs()).toBeGreaterThan(0); // frozen by 05
    h.dispatch({ type: 'rated', now: h.now });
    const base = h.cupG;
    h.idle(2500);
    h.dispatch({ type: 'arm', now: h.now, targetYieldG: 36 });
    h.idle(500);
    const idx = curve.t.findIndex((t) => t >= 11);
    for (let i = 0; i <= idx; i++) h.step(base + (curve.g[i] ?? 0));
    h.dispatch({ type: 'tap', now: h.now });
    expect(h.state.draft?.status).toBe('late_tap');
    const sends = h.effects
      .filter((e) => e.type === 'send')
      .map((e) => (e.type === 'send' ? e.cmd : ''));
    expect(sends.slice(-2)).toEqual(['reset', 'start']);
    h.idle(3000, base + 30);
    const xs = h.state.draft?.samples ?? [];
    const a = xs[xs.length - 20];
    const b = xs[xs.length - 1];
    // The clock keeps running (it would stall on a frozen timer).
    expect((b?.t ?? 0) - (a?.t ?? 0)).toBeGreaterThan(1.5);
  });
});

describe('recorder: hands-free start', () => {
  it('armed with autoStart, the first drops start the shot by itself and it is learned', () => {
    const h = new Harness();
    h.autoTareOn = true;
    h.idle(2500, 0);
    h.idle(3000, 175); // cup down, auto-tared
    h.dispatch({ type: 'arm', now: h.now, targetYieldG: 36, autoStart: true });
    h.idle(1500);
    expect(h.state.phase).toBe('ARMED');
    // Coffee into the cup: no tap at all.
    const idx = curve.t.findIndex((t) => t >= 12);
    for (let i = 0; i <= idx; i++) h.step(175 + (curve.g[i] ?? 0));
    expect(h.state.phase).toBe('RUNNING');
    expect(h.state.prompt).toBeNull();
    const d = h.state.draft;
    expect(d?.status).toBe('auto_start');
    expect(d?.samples[0]?.g ?? 99).toBeLessThan(0.5);
    expect(h.sent('reset')).toBe(1);
    expect(h.has('warn', 'late_tap')).toBe(false);
    expect(learnGate('auto_start', true)).toBe(true);
  });

  it('putting the cup down while armed for hands-free does not start a shot', () => {
    const h = new Harness();
    h.idle(2500, 0);
    h.dispatch({ type: 'arm', now: h.now, targetYieldG: 36, autoStart: true });
    h.idle(4000, 190);
    expect(h.state.phase).toBe('ARMED');
  });

  it('finds the pump vibration before the first drops when the scale shows it', () => {
    const ring = new RingBuffer();
    let t = 0;
    const push = (g: number) => {
      t += 100;
      ring.push({ tRxMs: t, grams: g, flowScale: 0, timerMs: 0 });
    };
    for (let i = 0; i < 60; i++) push(i % 7 === 0 ? 0.1 : 0); // armed, quiet
    const pumpAt = t;
    for (let i = 0; i < 70; i++) push(i % 2 === 0 ? 0.3 : -0.2); // pump buzzing, no coffee yet
    const onset = t;
    const found = pumpOnset(ring, onset, 0);
    expect(found).not.toBeNull();
    expect(Math.abs((found ?? 0) - pumpAt)).toBeLessThanOrEqual(1000);
    // A quiet scale reports nothing.
    const quiet = new RingBuffer();
    for (let i = 0; i < 120; i++)
      quiet.push({ tRxMs: i * 100, grams: 0, flowScale: 0, timerMs: 0 });
    expect(pumpOnset(quiet, 12_000, 0)).toBeNull();
  });
});
