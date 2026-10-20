import { describe, expect, it } from 'vitest';
import { CUE_BEEPS } from '../../src/app/cues';
import { mulberry32 } from '../../src/core/math/rng';
import { type CurveSpec, synthCurve } from '../../src/core/sim/curveSynth';
import { FakeClock } from '../../src/scale/clock';
import { FakeTransport } from '../../src/scale/fakeTransport';
import { Cmd, commands, parseFrame } from '../../src/scale/protocol';
import { autoTareStep, initAutoTare } from '../../src/shot/autoTare';
import { type HfInput, handsFreeStep, initHandsFree } from '../../src/shot/handsFree';
import { type Effect, initialState, reduce } from '../../src/shot/machine';
import { RingBuffer } from '../../src/shot/ringBuffer';

/**
 * A whole hands-free shot on the simulated Themis Mini, wired the way src/app/state.ts and
 * src/app/handsFree.ts wire it: frames → ring → recorder → auto-tare → controller → actions.
 * Only the scale is scripted (cups, beans, lever, the timer button), as the demo does.
 */
class Kitchen {
  clock = new FakeClock(1000);
  fake = new FakeTransport({ clock: this.clock, seed: 11 });
  ring = new RingBuffer();
  rec = initialState();
  tare = initAutoTare();
  hf = initHandsFree(1000);
  preStep: HfInput['preStep'] = 'plan';
  dosingCupG: number | null = null;
  doseG: number | null = null;
  log: string[] = [];

  async start(): Promise<void> {
    this.fake.onFrame((src, bytes, tRxMs) => {
      const p = parseFrame(bytes);
      if (src === 'ff11' && p.kind === 'weight') this.onWeight(p.frame, tRxMs);
    });
    await this.fake.connect();
  }

  send(bytes: Uint8Array): void {
    void this.fake.write(bytes);
  }

  run(effects: Effect[]): void {
    for (const e of effects) {
      if (e.type === 'send') {
        this.send(e.cmd === 'beep' ? commands.beep(e.n ?? 1) : commands[e.cmd]());
        this.log.push(e.cmd);
      }
      if (e.type === 'pre_alert') this.beep(CUE_BEEPS.pre_alert);
    }
  }

  beep(n: number): void {
    if (n > 0) this.send(commands.beep(n));
  }

  dispatch(ev: Parameters<typeof reduce>[1]): void {
    const [s, fx] = reduce(this.rec, ev, this.ring);
    this.rec = s;
    this.run(fx);
  }

  onWeight(f: { grams: number; flowGps: number; timerMs: number }, tRxMs: number): void {
    this.ring.push({ tRxMs, grams: f.grams, flowScale: f.flowGps, timerMs: f.timerMs });
    this.dispatch({
      type: 'frame',
      now: tRxMs,
      grams: f.grams,
      flow: 0,
      timerMs: f.timerMs,
      tRxMs,
    });
    const p = this.rec.phase;
    const idle = p === 'IDLE' || p === 'ARMED' || p === 'SAVED' || p === 'ABORTED';
    const t = autoTareStep(this.tare, this.ring, tRxMs, idle);
    this.tare = t.state;
    const r = handsFreeStep(this.hf, {
      nowMs: tRxMs,
      connected: true,
      phase: this.rec.phase,
      pending: this.rec.phase === 'RATE',
      ring: this.ring,
      tare: t.tare ? { placedG: t.placedG } : null,
      plannedDoseG: 18,
      dosingCupG: this.dosingCupG,
      preStep: this.preStep,
    });
    this.hf = r.state;
    for (const a of r.actions) {
      this.log.push(a.type === 'cue' ? `cue:${a.cue}` : a.type);
      if (a.type === 'openWeigh') this.preStep = 'weigh';
      if (a.type === 'useDose') {
        this.preStep = 'grind';
        this.doseG = a.g;
        this.dosingCupG = a.dosingCupG;
      }
      if (a.type === 'toPlan') this.preStep = 'plan';
      if (a.type === 'cue') this.beep(CUE_BEEPS[a.cue]);
      if (a.type === 'arm')
        this.dispatch({ type: 'arm', now: tRxMs, targetYieldG: 36, autoStart: true });
    }
    if (t.tare) {
      this.send(commands.tare());
      this.dispatch({ type: 'tared', now: tRxMs });
    }
  }

  async wait(ms: number): Promise<void> {
    await this.clock.advanceAsync(ms, 50);
  }

  async until(ok: () => boolean, ms: number): Promise<boolean> {
    for (let left = ms; left > 0 && !ok(); left -= 100) await this.wait(100);
    return ok();
  }

  sentCmds(): number[] {
    return this.fake.commands.map((c) => c.bytes[2] ?? 0);
  }
}

const spec: CurveSpec = {
  firstDripS: 7,
  plateauGps: 1.8,
  rampS: 3,
  lateRise: 0,
  stopAtG: 50,
  tailG: 1.2,
  tailS: 4.5,
  noiseG: 0.03,
  truncG: 0.1,
};

describe('hands-free on the simulated scale', () => {
  it('cups, beans, lever and the timer button: a whole shot with no app taps', async () => {
    const k = new Kitchen();
    await k.start();
    await k.wait(2000);
    // Dosing cup down: tared by itself, the weighing opens.
    k.fake.setCupWeight(92.4);
    expect(await k.until(() => k.preStep === 'weigh', 4000)).toBe(true);
    // Beans in over 2 s; the steady dose is taken.
    for (let i = 1; i <= 20; i++) {
      k.fake.setCupWeight(92.4 + (18.2 * i) / 20);
      await k.wait(100);
    }
    expect(await k.until(() => k.preStep === 'grind', 6000)).toBe(true);
    expect(k.doseG).toBeCloseTo(18.2, 1);
    expect(k.dosingCupG).toBeCloseTo(92.4, 0);
    // Cup off (beans to the hopper), grind, espresso cup down: armed.
    k.fake.setCupWeight(0);
    await k.wait(5000);
    k.fake.setCupWeight(168);
    expect(await k.until(() => k.rec.phase === 'ARMED', 4000)).toBe(true);
    await k.wait(1500);
    // Lever up and the scale's timer pressed.
    const curve = synthCurve(spec, mulberry32(3), 100, 8);
    k.fake.startShot({ t: curve.t, g: curve.g });
    k.fake.pressTimerButton();
    const pressedAt = k.clock.now();
    expect(await k.until(() => k.rec.phase === 'RUNNING', 1000)).toBe(true);
    // Lever down at the pre-alert.
    expect(await k.until(() => k.rec.draft?.alertFired === true, 60_000)).toBe(true);
    k.fake.stopShot({ g: 1.2, s: 4.5 });
    expect(await k.until(() => k.rec.phase === 'RATE', 30_000)).toBe(true);
    const d = k.rec.draft;
    expect(d?.status).toBe('ok');
    expect(d?.startCmd).toBe('button');
    expect(d?.endedBy).toBe('auto');
    expect(Math.abs((d?.t0Ms ?? 0) - pressedAt)).toBeLessThan(150);
    const drip = d?.samples.find((s) => s.g >= 0.5);
    const want = curve.t[curve.g.findIndex((g) => g >= 0.5)] ?? 0;
    expect(Math.abs((drip?.t ?? 99) - want)).toBeLessThan(0.3);
    expect(d?.finalYieldG ?? 0).toBeGreaterThan(34);
    // What the scale was sent: two tares, 06 on arm, the cue beeps, 05 at the end; no 07/04.
    const cmds = k.sentCmds();
    expect(cmds.filter((c) => c === Cmd.tare).length).toBe(2);
    expect(cmds.filter((c) => c === Cmd.reset).length).toBe(1);
    expect(cmds.filter((c) => c === Cmd.tareStart || c === Cmd.start).length).toBe(0);
    const beeps = k.fake.commands.filter((c) => c.bytes[2] === Cmd.beep).map((c) => c.bytes[4]);
    expect(beeps).toEqual([1, 2, 1, 3]);
    expect(k.log.filter((x) => x.startsWith('cue:') || x === 'arm')).toEqual([
      'cue:weigh',
      'cue:dose',
      'arm',
      'cue:armed',
      'cue:rate',
    ]);
  });

  it('the fake: the timer button starts and stops the timer; a running pour is reported', async () => {
    const clock = new FakeClock(0);
    const fake = new FakeTransport({ clock, seed: 1 });
    const timers: number[] = [];
    fake.onFrame((_src, bytes) => {
      const p = parseFrame(bytes);
      if (p.kind === 'weight') timers.push(p.frame.timerMs);
    });
    await fake.connect();
    await clock.advanceAsync(500);
    expect(timers.at(-1)).toBe(0);
    fake.pressTimerButton();
    await clock.advanceAsync(2000);
    expect(timers.at(-1) ?? 0).toBeGreaterThan(1700);
    fake.pressTimerButton();
    await clock.advanceAsync(300);
    const frozen = timers.at(-1);
    await clock.advanceAsync(1000);
    expect(timers.at(-1)).toBe(frozen);
    expect(fake.isPouring).toBe(false);
    fake.startShot({ t: [0, 10], g: [0, 20] });
    await clock.advanceAsync(1000);
    expect(fake.isPouring).toBe(true);
    fake.stopShot({ g: 1, s: 2 });
    expect(fake.isPouring).toBe(false);
    fake.startShot({ t: [0, 1], g: [0, 2] });
    await clock.advanceAsync(1500);
    expect(fake.isPouring).toBe(false); // played to its end
  });
});
