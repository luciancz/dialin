/**
 * Simulated Themis Mini behind the Transport interface. Honours commands the way the
 * hardware tests describe (07 tares and starts, 04 starts from zero, 05 freezes, 06 zeroes
 * only when stopped, 08 smoothing, 03 auto-off), emits 20-byte frames at 100.7 ± 30 ms with
 * the timer 0.7 % slow, and takes scripted faults: disconnect at t = 12 s into a shot,
 * auto-off, and an Auto-mode persona that ignores 04/07 and emits 03 0D on FF12.
 */

import { mulberry32, type Rng, uniform } from '../core/math/rng';
import { SIM } from '../core/params';
import { realClock } from './clock';
import { otherFrameBytes, weightFrameBytes } from './frameSynth';
import { Cmd, parseFrame } from './protocol';
import {
  type Clock,
  Emitter,
  type FrameSource,
  type Transport,
  type TransportInfo,
} from './transport';

export interface FakePersona {
  /** Scale mode set on the device. */
  mode: 'timer' | 'auto';
  /** Drop the link this many seconds after the shot playback starts. */
  disconnectAtS?: number | undefined;
  /** Whether the scale accepts reconnection after a drop (default true). */
  reconnectable: boolean;
  /** Power off after this long without activity (ms). Undefined = never. */
  autoOffAfterMs?: number;
  /** Whether weight changes reset the scale's own auto-off timer (a probe item). */
  weightChangeResetsAutoOff: boolean;
  /** Whether re-sending the auto-off command extends the timer. */
  autoOffCommandExtends: boolean;
  frameMs: number;
  frameJitterMs: number;
  timerSlow: number;
  standbyMin: number;
  batteryPct: number;
  /** Emit an FF12 0x0C/0x0E serial frame ~6 s after connect, as misch0n observed. */
  serialFramesOnFf12: boolean;
}

export const defaultPersona: FakePersona = {
  mode: 'timer',
  reconnectable: true,
  weightChangeResetsAutoOff: false,
  autoOffCommandExtends: true,
  frameMs: SIM.frameMs,
  frameJitterMs: SIM.frameJitterMs,
  timerSlow: SIM.timerSlow,
  standbyMin: 15,
  batteryPct: 82,
  serialFramesOnFf12: true,
};

export interface Playback {
  /** Seconds from pump start. */
  t: readonly number[];
  /** Grams in the cup (tared at the pump start). */
  g: readonly number[];
}

interface FrameEvent {
  src: FrameSource;
  bytes: Uint8Array;
  tRxMs: number;
}

export class FakeTransport implements Transport {
  readonly info: TransportInfo = { kind: 'fake', name: 'BOOKOO_SC fake', caps: { fake: true } };
  readonly persona: FakePersona;
  readonly commands: { tMs: number; bytes: Uint8Array }[] = [];
  readonly clock: Clock;

  private readonly rng: Rng;
  private readonly frames = new Emitter<FrameEvent>();
  private readonly disconnects = new Emitter<string>();
  private readonly commandSeen = new Emitter<Uint8Array>();
  private connected = false;
  private poweredOn = true;
  private cancelFrame: (() => void) | null = null;
  private cancelSerial: (() => void) | null = null;

  // Scale state.
  private cupWeightG = 0;
  private tareOffsetG = 0;
  private timerRunning = false;
  private timerStartedAt = 0;
  private timerFrozenMs = 0;
  private smoothing = false;
  private standbyMin: number;
  private lastActivityAt = 0;
  private emaFlow = 0;
  private lastWeightG = 0;
  private lastWeightAt = 0;

  // Shot playback.
  private playback: Playback | null = null;
  private playbackStartAt = 0;
  private playbackBaseG = 0;
  private autoModeStarted = false;
  private autoQuietSince: number | null = null;

  constructor(opts: { clock?: Clock; seed?: number; persona?: Partial<FakePersona> } = {}) {
    this.clock = opts.clock ?? realClock;
    this.rng = mulberry32(opts.seed ?? 42);
    this.persona = { ...defaultPersona, ...(opts.persona ?? {}) };
    this.standbyMin = this.persona.standbyMin;
    this.lastActivityAt = this.clock.now();
  }

  // ---- Transport ----

  async connect(): Promise<void> {
    if (!this.poweredOn) throw new Error('fake scale is powered off');
    if (this.clock.now() < this.refuseUntil) throw new Error('fake scale out of range');
    if (this.connected) return;
    this.connected = true;
    this.lastActivityAt = this.clock.now();
    this.scheduleFrame();
    if (this.persona.serialFramesOnFf12) {
      this.cancelSerial = this.clock.setTimeout(() => {
        if (this.connected) this.emit('ff12', otherFrameBytes(0x0c, [0x01]));
      }, 6000);
    }
  }

  async disconnect(): Promise<void> {
    this.dropLink('local');
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error('not connected');
    const now = this.clock.now();
    this.commands.push({ tMs: now, bytes: bytes.slice() });
    this.commandSeen.emit(bytes);
    if (bytes.length !== 6 || bytes[0] !== 0x03 || bytes[1] !== 0x0a) return;
    const cmd = bytes[2] ?? 0;
    const d1 = bytes[3] ?? 0;
    const d2 = bytes[4] ?? 0;
    this.lastActivityAt = now;
    switch (cmd) {
      case Cmd.tare:
        this.tareOffsetG = this.cupWeightG;
        break;
      case Cmd.start:
        if (this.persona.mode === 'timer' && !this.timerRunning && this.timerFrozenMs === 0) {
          this.timerRunning = true;
          this.timerStartedAt = now;
        }
        break;
      case Cmd.stop:
        if (this.timerRunning) {
          this.timerFrozenMs = this.timerMs(now);
          this.timerRunning = false;
        }
        break;
      case Cmd.reset:
        if (!this.timerRunning) this.timerFrozenMs = 0;
        break;
      case Cmd.tareStart:
        if (this.persona.mode === 'timer') {
          this.tareOffsetG = this.cupWeightG;
          this.timerFrozenMs = 0;
          this.timerRunning = true;
          this.timerStartedAt = now;
        }
        break;
      case Cmd.smoothing:
        this.smoothing = d1 === 1;
        break;
      case Cmd.autoOff:
        if (this.persona.autoOffCommandExtends) this.standbyMin = Math.max(5, Math.min(30, d2));
        break;
      default:
        break;
    }
  }

  onFrame(cb: (src: FrameSource, bytes: Uint8Array, tRxMs: number) => void): () => void {
    return this.frames.on((e) => cb(e.src, e.bytes, e.tRxMs));
  }

  onDisconnect(cb: (reason: string) => void): () => void {
    return this.disconnects.on(cb);
  }

  // ---- World control ----

  onCommand(cb: (bytes: Uint8Array) => void): () => void {
    return this.commandSeen.on(cb);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Put something on the scale (absolute cup weight). */
  setCupWeight(g: number): void {
    this.cupWeightG = g;
  }

  /** Begin delivering a shot curve into the cup, starting now. */
  startShot(playback: Playback): void {
    this.playback = playback;
    this.playbackStartAt = this.clock.now();
    this.playbackBaseG = this.cupWeightG;
    this.autoModeStarted = false;
    this.autoQuietSince = null;
  }

  /** Lever down: freeze the pour, optionally with a drip tail (grams over seconds). */
  stopShot(tail?: { g: number; s: number }): void {
    if (!this.playback) return;
    const w = this.currentPlaybackWeight();
    this.cupWeightG = w;
    this.playback = null;
    if (tail && tail.g > 0) {
      const tau = Math.max(0.2, tail.s / 4);
      const t: number[] = [];
      const g: number[] = [];
      for (let i = 0; i <= Math.round(tail.s * 20); i++) {
        const tS = i * 0.1;
        t.push(tS);
        g.push(tail.g * (1 - Math.exp(-tS / tau)));
      }
      this.playback = { t, g };
      this.playbackStartAt = this.clock.now();
      this.playbackBaseG = w;
    }
  }

  forceDisconnect(reason = 'forced'): void {
    this.dropLink(reason);
  }

  /** Stop emitting frames without dropping the link (stale-stream tests). */
  pauseFrames(): void {
    this.framesPaused = true;
  }

  resumeFrames(): void {
    this.framesPaused = false;
  }

  /** Make connect() throw until the given clock time (backoff tests). */
  refuseConnectUntil(tMs: number): void {
    this.refuseUntil = tMs;
  }

  private framesPaused = false;
  private refuseUntil = -1;

  powerOff(): void {
    this.poweredOn = false;
    this.dropLink('auto-off');
  }

  powerOn(): void {
    this.poweredOn = true;
    this.timerRunning = false;
    this.timerFrozenMs = 0;
    this.tareOffsetG = this.cupWeightG;
    this.standbyMin = this.persona.standbyMin;
  }

  get timerIsRunning(): boolean {
    return this.timerRunning;
  }

  get standby(): number {
    return this.standbyMin;
  }

  // ---- Internals ----

  private timerMs(now: number): number {
    if (!this.timerRunning) return this.timerFrozenMs;
    return Math.max(0, Math.round((now - this.timerStartedAt) * (1 - this.persona.timerSlow)));
  }

  private currentPlaybackWeight(): number {
    const pb = this.playback;
    if (!pb) return this.cupWeightG;
    const tS = (this.clock.now() - this.playbackStartAt) / 1000;
    const n = pb.t.length;
    if (n === 0) return this.playbackBaseG;
    const last = pb.t[n - 1] ?? 0;
    if (tS >= last) return this.playbackBaseG + (pb.g[n - 1] ?? 0);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((pb.t[mid] ?? 0) <= tS) lo = mid;
      else hi = mid;
    }
    const t0 = pb.t[lo] ?? 0;
    const t1 = pb.t[hi] ?? t0;
    const g0 = pb.g[lo] ?? 0;
    const g1 = pb.g[hi] ?? g0;
    const f = t1 > t0 ? (tS - t0) / (t1 - t0) : 0;
    return this.playbackBaseG + g0 + (g1 - g0) * f;
  }

  private scheduleFrame(): void {
    const wait = this.persona.frameMs + uniform(this.rng, -1, 1) * this.persona.frameJitterMs;
    this.cancelFrame = this.clock.setTimeout(() => this.tick(), Math.max(10, wait));
  }

  private tick(): void {
    if (!this.connected) return;
    if (this.framesPaused) {
      this.scheduleFrame();
      return;
    }
    const now = this.clock.now();
    const w = this.playback ? this.currentPlaybackWeight() : this.cupWeightG;
    if (this.playback) this.cupWeightG = w;

    // Auto-mode persona: timer starts itself on flow and stops ~4.5 s after flow ends.
    if (this.persona.mode === 'auto') this.autoModeStep(now, w);

    // Activity bookkeeping for auto-off.
    if (Math.abs(w - this.lastWeightG) > 0.2) {
      if (this.persona.weightChangeResetsAutoOff) this.lastActivityAt = now;
      this.lastWeightG = w;
      this.lastWeightAt = now;
    }
    if (
      this.persona.autoOffAfterMs !== undefined &&
      now - this.lastActivityAt > this.persona.autoOffAfterMs
    ) {
      this.powerOff();
      return;
    }
    if (this.persona.disconnectAtS !== undefined && this.playback) {
      if ((now - this.playbackStartAt) / 1000 >= this.persona.disconnectAtS) {
        this.persona.disconnectAtS = undefined;
        this.dropLink('fault');
        return;
      }
    }

    // Flow EMA like the scale's own.
    const dt = Math.max(1, now - (this.lastWeightAt || now - 100)) / 1000;
    const inst = this.playback ? (w - this.emaAnchor) / dt : 0;
    this.emaAnchor = w;
    this.lastWeightAt = now;
    this.emaFlow = 0.8 * this.emaFlow + 0.2 * Math.max(0, inst);

    const grams = Math.round((w - this.tareOffsetG) * 10) / 10;
    const bytes = weightFrameBytes(this.timerMs(now), grams, Math.round(this.emaFlow * 100) / 100, {
      batteryPct: this.persona.batteryPct,
      standbyMin: this.standbyMin,
      smoothing: this.smoothing,
    });
    this.emit('ff11', bytes);
    this.scheduleFrame();
  }

  private emaAnchor = 0;

  private autoModeStep(now: number, w: number): void {
    const rising = this.playback !== null && w - this.playbackBaseG > 0.5;
    if (rising && !this.autoModeStarted) {
      this.autoModeStarted = true;
      this.tareOffsetG = this.playbackBaseG;
      this.timerFrozenMs = 0;
      this.timerRunning = true;
      this.timerStartedAt = now - 1100; // back-dated start
      this.emit('ff12', otherFrameBytes(0x0d, [0x01]));
    }
    if (this.autoModeStarted && this.timerRunning) {
      const flowing = Math.abs(w - this.lastWeightG) > 0.05;
      if (flowing) this.autoQuietSince = null;
      else if (this.autoQuietSince === null) this.autoQuietSince = now;
      else if (now - this.autoQuietSince > 4500) {
        this.timerFrozenMs = this.timerMs(now);
        this.timerRunning = false;
        this.emit('ff12', otherFrameBytes(0x0d, [0x00]));
      }
    }
  }

  private emit(src: FrameSource, bytes: Uint8Array): void {
    if (!this.connected) return;
    this.frames.emit({ src, bytes, tRxMs: this.clock.now() });
  }

  private dropLink(reason: string): void {
    if (!this.connected) return;
    this.connected = false;
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.cancelSerial?.();
    this.cancelSerial = null;
    if (!this.persona.reconnectable) this.poweredOn = false;
    this.disconnects.emit(reason);
  }
}

/** Parse helper for tests: the last weight frame emitted. */
export function lastWeight(bytesList: Uint8Array[]): number | null {
  for (let i = bytesList.length - 1; i >= 0; i--) {
    const b = bytesList[i];
    if (!b) continue;
    const p = parseFrame(b);
    if (p.kind === 'weight') return p.frame.grams;
  }
  return null;
}
