/**
 * ScaleClient: connection lifecycle over any Transport, with an injected Clock.
 * DOM-free; emits plain events that app/state.ts adapts to signals.
 *
 * States: disconnected → connecting → connected → reconnecting → lost.
 * On connect: smoothing off, 150 ms, auto-off (30 min), then verify both from the frames
 * and wait ≤ 2 s for a weight frame. Stale stream: 1.5 s → warning, 5 s → disconnect.
 * Reconnect backoff 0.5, 1, 2, 4, 8 s (cap 15 s), give up after 60 s unless a shot is
 * running. App-side auto-off clock: autoOffAt = max(connectAt, lastWeightChange, lastCommand)
 * + standby minutes; banner 3 min before; "re-arm" re-sends the auto-off command.
 */
import { CLIENT } from '../core/params';
import { commands, type ParsedFrame, parseFrame, type WeightFrame } from './protocol';
import { type Clock, Emitter, type FrameSource, type Transport } from './transport';

export type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'lost';
export type ModeHint = 'unknown' | 'timer' | 'auto';
export type WarningCode =
  | 'stale'
  | 'no_frames'
  | 'battery'
  | 'auto_off_soon'
  | 'not_timer_mode'
  | 'reconnect_failed'
  | 'checksum'
  | 'reconnected';

export interface WeightEvent {
  frame: WeightFrame;
  tRxMs: number;
}

export interface RawEvent {
  src: FrameSource;
  bytes: Uint8Array;
  tRxMs: number;
  parsed: ParsedFrame;
}

export interface Warning {
  code: WarningCode;
  msg: string;
}

export interface AutoOffInfo {
  at: number | null;
  soon: boolean;
  rearms: number;
}

export interface ScaleClientOptions {
  autoOffMinutes?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class ScaleClient {
  state: ClientState = 'disconnected';
  lastFrame: WeightFrame | null = null;
  lastFrameAt = 0;
  batteryPct: number | null = null;
  /** Standby minutes as reported in the frames (the scale's setting). */
  standbyMin: number | null = null;
  modeHint: ModeHint = 'unknown';
  smoothingVerified: boolean | null = null;
  autoOffVerified: boolean | null = null;
  autoOffAt: number | null = null;
  rearms = 0;
  readonly stats = { frames: 0, bad: 0, reconnects: 0 };

  readonly onState = new Emitter<ClientState>();
  readonly onWeight = new Emitter<WeightEvent>();
  readonly onRaw = new Emitter<RawEvent>();
  readonly onWarning = new Emitter<Warning>();
  readonly onAutoOff = new Emitter<AutoOffInfo>();

  private offFrame: (() => void) | null = null;
  private offDisc: (() => void) | null = null;
  private cancelWatchdog: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private connectAt = 0;
  private lastWeightChangeAt = 0;
  private lastWeightForActivity = Number.NaN;
  private lastCommandAt = 0;
  private reconnectStartedAt = 0;
  private attempt = 0;
  private bannerShown = false;
  private staleWarned = false;
  private batteryWarned = false;
  private checksumWarned = false;
  private modeWarned = false;
  private intentionalClose = false;
  private shotRunning = false;
  private shotEndedAt: number | null = null;
  private frameWaiters: ((f: WeightFrame) => void)[] = [];
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;

  constructor(
    public transport: Transport,
    readonly clock: Clock,
    private readonly opts: ScaleClientOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
  }

  get autoOffMinutes(): number {
    return this.opts.autoOffMinutes ?? CLIENT.autoOffMinutes;
  }

  async setTransport(t: Transport): Promise<void> {
    if (this.state !== 'disconnected' && this.state !== 'lost') await this.disconnect();
    this.transport = t;
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    this.setState('connecting');
    this.subscribe();
    try {
      await this.transport.connect();
      await this.setup();
    } catch (err) {
      this.unsubscribe();
      this.setState('disconnected');
      throw err;
    }
    this.attempt = 0;
    this.setState('connected');
    this.startWatchdog();
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.stopWatchdog();
    this.unsubscribe();
    try {
      await this.transport.disconnect();
    } catch (err) {
      this.log('warn', `disconnect: ${String(err)}`);
    }
    this.autoOffAt = null;
    this.setState('disconnected');
  }

  /** Write a command; counts as activity for the auto-off clock. */
  async send(bytes: Uint8Array): Promise<void> {
    await this.transport.write(bytes);
    this.lastCommandAt = this.clock.now();
    this.recomputeAutoOff();
  }

  async rearmAutoOff(): Promise<void> {
    await this.send(commands.autoOff(this.autoOffMinutes));
    this.rearms += 1;
    this.bannerShown = false;
    this.emitAutoOff();
  }

  /** The recorder tells the client when a shot is in flight (reconnects persist longer). */
  setShotRunning(running: boolean): void {
    if (this.shotRunning && !running) this.shotEndedAt = this.clock.now();
    this.shotRunning = running;
  }

  setModeHint(hint: ModeHint): void {
    this.modeHint = hint;
  }

  // ---- internals ----

  private setState(s: ClientState): void {
    if (this.state === s) return;
    this.state = s;
    this.onState.emit(s);
  }

  private subscribe(): void {
    this.unsubscribe();
    this.offFrame = this.transport.onFrame((src, bytes, tRxMs) =>
      this.handleFrame(src, bytes, tRxMs),
    );
    this.offDisc = this.transport.onDisconnect((reason) => this.handleDisconnect(reason));
  }

  private unsubscribe(): void {
    this.offFrame?.();
    this.offDisc?.();
    this.offFrame = null;
    this.offDisc = null;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  private nextWeightFrame(timeoutMs: number): Promise<WeightFrame | null> {
    return new Promise((resolve) => {
      let done = false;
      const cancel = this.clock.setTimeout(() => {
        if (done) return;
        done = true;
        this.frameWaiters = this.frameWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      const waiter = (f: WeightFrame) => {
        if (done) return;
        done = true;
        cancel();
        resolve(f);
      };
      this.frameWaiters.push(waiter);
    });
  }

  private async setup(): Promise<void> {
    const now = this.clock.now();
    this.connectAt = now;
    this.lastFrameAt = now;
    this.lastCommandAt = now;
    this.lastWeightChangeAt = now;
    this.bannerShown = false;
    this.staleWarned = false;
    await this.transport.write(commands.smoothing(false));
    await this.wait(CLIENT.commandGapMs);
    await this.transport.write(commands.autoOff(this.autoOffMinutes));
    this.lastCommandAt = this.clock.now();
    const first = await this.nextWeightFrame(CLIENT.firstFrameMs);
    if (!first) {
      try {
        await this.transport.disconnect();
      } catch {
        /* ignore */
      }
      this.warn('no_frames', 'no frames from the scale (is the BOOKOO N app connected?)');
      throw new Error('no frames (is BOOKOO N connected?)');
    }
    // Verify smoothing and auto-off from the next few frames.
    let verified: WeightFrame | null = first;
    for (let i = 0; i < 3; i++) {
      const f = await this.nextWeightFrame(500);
      if (f) verified = f;
    }
    this.smoothingVerified = verified.smoothing === false;
    this.autoOffVerified = Math.abs(verified.standbyMin - this.autoOffMinutes) < 0.05;
    this.standbyMin = verified.standbyMin;
    this.log(
      'info',
      `scale setup: smoothing ${this.smoothingVerified ? 'off' : 'NOT off'}, standby ${verified.standbyMin} min (${this.autoOffVerified ? 'auto-off applied' : 'auto-off NOT applied'})`,
    );
    this.recomputeAutoOff();
  }

  private handleFrame(src: FrameSource, bytes: Uint8Array, tRxMs: number): void {
    const parsed = parseFrame(bytes);
    this.onRaw.emit({ src, bytes, tRxMs, parsed });
    if (parsed.kind === 'bad') {
      this.stats.bad += 1;
      if (
        !this.checksumWarned &&
        this.stats.frames > 50 &&
        this.stats.bad / this.stats.frames > 0.01
      ) {
        this.checksumWarned = true;
        this.warn('checksum', `${this.stats.bad} bad frames of ${this.stats.frames}`);
      }
      return;
    }
    this.stats.frames += 1;
    if (parsed.kind === 'weight') {
      // Only the weight stream counts as liveness; FF12 serial frames arrive sporadically.
      this.lastFrameAt = tRxMs;
      this.staleWarned = false;
      const f = parsed.frame;
      this.lastFrame = f;
      this.batteryPct = f.batteryPct;
      this.standbyMin = f.standbyMin;
      if (
        Number.isNaN(this.lastWeightForActivity) ||
        Math.abs(f.grams - this.lastWeightForActivity) > CLIENT.activityDeltaG
      ) {
        this.lastWeightForActivity = f.grams;
        this.lastWeightChangeAt = tRxMs;
        this.recomputeAutoOff();
      }
      if (!this.batteryWarned && f.batteryPct > 0 && f.batteryPct < CLIENT.batteryWarnPct) {
        this.batteryWarned = true;
        this.warn('battery', `scale battery ${f.batteryPct} %`);
      }
      const waiters = this.frameWaiters;
      this.frameWaiters = [];
      for (const w of waiters) w(f);
      this.onWeight.emit({ frame: f, tRxMs });
    } else if (parsed.kind === 'other' && parsed.type === 0x0d) {
      this.modeHint = 'auto';
      if (!this.modeWarned) {
        this.modeWarned = true;
        this.warn('not_timer_mode', 'scale sent an Auto-mode event (03 0D): is it in Timer mode?');
      }
    }
  }

  private handleDisconnect(reason: string): void {
    if (this.intentionalClose) return;
    if (this.state === 'reconnecting') return;
    this.log('warn', `link lost (${reason})`);
    this.stopWatchdog();
    this.reconnectStartedAt = this.clock.now();
    this.attempt = 0;
    this.setState('reconnecting');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const idx = Math.min(this.attempt, CLIENT.backoffMs.length - 1);
    const delay = Math.min(CLIENT.backoffMs[idx] ?? CLIENT.backoffCapMs, CLIENT.backoffCapMs);
    this.cancelRetry = this.clock.setTimeout(() => void this.tryReconnect(), delay);
  }

  private async tryReconnect(): Promise<void> {
    if (this.intentionalClose) return;
    this.attempt += 1;
    this.stats.reconnects += 1;
    try {
      this.subscribe();
      await this.transport.connect();
      await this.setup();
      this.attempt = 0;
      this.setState('connected');
      this.startWatchdog();
      this.warn('reconnected', 'reconnected to the scale');
      return;
    } catch (err) {
      this.log('warn', `reconnect attempt ${this.attempt} failed: ${String(err)}`);
    }
    const now = this.clock.now();
    const since =
      this.shotEndedAt !== null
        ? Math.max(this.reconnectStartedAt, this.shotEndedAt)
        : this.reconnectStartedAt;
    const limit =
      this.shotEndedAt !== null && this.shotEndedAt > this.reconnectStartedAt
        ? CLIENT.runningExtraMs
        : CLIENT.giveUpMs;
    if (!this.shotRunning && now - since > limit) {
      this.unsubscribe();
      this.setState('lost');
      this.warn('reconnect_failed', 'could not reconnect to the scale; tap Connect to retry');
      return;
    }
    this.scheduleRetry();
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const tick = () => {
      if (this.state !== 'connected') return;
      const now = this.clock.now();
      const silent = now - this.lastFrameAt;
      if (silent > CLIENT.lostMs) {
        this.log('warn', `no frames for ${Math.round(silent)} ms: treating as disconnect`);
        void this.transport.disconnect().catch(() => {});
        this.handleDisconnect('stale');
        return;
      }
      if (silent > CLIENT.staleMs && !this.staleWarned) {
        this.staleWarned = true;
        this.warn('stale', `no frames for ${(silent / 1000).toFixed(1)} s`);
      }
      if (
        this.autoOffAt !== null &&
        !this.bannerShown &&
        now >= this.autoOffAt - CLIENT.autoOffBannerMs
      ) {
        this.bannerShown = true;
        this.warn(
          'auto_off_soon',
          'scale may switch off in under 3 minutes: re-arm or touch the scale',
        );
        this.emitAutoOff();
      }
      this.cancelWatchdog = this.clock.setTimeout(tick, 500);
    };
    this.cancelWatchdog = this.clock.setTimeout(tick, 500);
  }

  private stopWatchdog(): void {
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
  }

  private recomputeAutoOff(): void {
    const standby = this.standbyMin ?? this.autoOffMinutes;
    const base = Math.max(this.connectAt, this.lastWeightChangeAt, this.lastCommandAt);
    const next = base + standby * 60_000;
    if (this.autoOffAt !== null && next > this.autoOffAt) this.bannerShown = false;
    this.autoOffAt = next;
    this.emitAutoOff();
  }

  private emitAutoOff(): void {
    const soon =
      this.autoOffAt !== null && this.clock.now() >= this.autoOffAt - CLIENT.autoOffBannerMs;
    this.onAutoOff.emit({ at: this.autoOffAt, soon, rearms: this.rearms });
  }

  private warn(code: WarningCode, msg: string): void {
    this.log(code === 'reconnected' ? 'info' : 'warn', msg);
    this.onWarning.emit({ code, msg });
  }
}
