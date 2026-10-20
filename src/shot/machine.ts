/**
 * Shot recorder: a pure reducer (state, event, ring) → [state, effects]. Time comes in on
 * the events; nothing here reads a clock. The app feeds every weight frame and a 250 ms
 * tick, performs the effects (send commands, warn, prompt, finalize), and persists.
 *
 * Phases: IDLE → ARMED → RUNNING → ENDING → SETTLING → RATE → SAVED, with RECOVERING
 * (link lost mid-shot) and ABORTED on the side. See docs/ALGORITHM.md "Recorder".
 *
 * A shot starts on the START tap, on the scale's own timer button (the timer starts rising
 * while armed) or, armed hands-free, by itself at the first drops.
 */
import { REC } from '../core/params';
import type { EndedBy, ShotStatus } from '../core/types';
import { type RingBuffer, regressionFlow } from './ringBuffer';

export type Phase =
  | 'IDLE'
  | 'ARMED'
  | 'RUNNING'
  | 'ENDING'
  | 'SETTLING'
  | 'RATE'
  | 'SAVED'
  | 'RECOVERING'
  | 'ABORTED';

export type ModeHint = 'unknown' | 'timer' | 'auto';

export interface ShotSample {
  /** Seconds from t0 (the tap, or the estimated rise onset after a late/forgotten tap). */
  t: number;
  g: number;
  /** Scale EMA flow (display only). */
  flow: number;
  tRxMs: number;
  timerMs: number;
}

export interface ShotDraft {
  t0Ms: number;
  tapMs: number | null;
  status: ShotStatus;
  /** What started the scale timer: the app's 07 or 04, the scale's own button, or nothing. */
  startCmd: 'tareStart' | 'start' | 'button' | 'none';
  samples: ShotSample[];
  gaps: [number, number][];
  openGapStartS: number | null;
  endAt: number | null;
  endAtRxMs: number | null;
  endedBy: EndedBy | null;
  finalYieldG: number | null;
  manualYieldG: number | null;
  tareOffsetG: number;
  anchorOffsetS: number | null;
  firstTimer: { tRxMs: number; timerMs: number } | null;
  lastTimer: { tRxMs: number; timerMs: number } | null;
  modeHint: ModeHint;
  framesSinceStart: number;
  preTapSpliceS: number | null;
  targetYieldG: number;
  tailEstimateG: number;
  quietSinceS: number | null;
  lastFrameRxMs: number | null;
  lastG: number;
  maxG: number;
  disconnectedAtMs: number | null;
  settleUntilMs: number | null;
  alertFired: boolean;
  /** Median weight over the 2 s before the tap: the software tare if 07 did not zero the scale. */
  preTapMedianG: number;
  tareDecided: boolean;
  /**
   * Pump vibration seen on the scale before the first drip (hands-free start): ms before t0,
   * null when none was detected. Measurement only, for the field test (FIELD_TEST C).
   */
  pumpLeadMs: number | null;
  notes: string[];
  /** Phase at which the link dropped, to resume correctly. */
  recoveringFrom: 'RUNNING' | 'ENDING' | 'SETTLING' | null;
}

export interface RecorderState {
  phase: Phase;
  draft: ShotDraft | null;
  armed: {
    targetYieldG: number;
    tailEstimateG: number;
    stable: boolean;
    sinceMs: number;
    /** Hands-free: start by itself when coffee starts to rise in the cup (no START tap). */
    autoStart: boolean;
    /** Scale timer value last seen and since when (receive time), to spot its button. */
    timer: { ms: number; sinceMs: number } | null;
  } | null;
  prompt: 'forgot_tap' | null;
  /** Live flow estimate (g/s) for the UI. */
  liveFlow: number;
  /** Receive time of the last plain tare (auto-tare on cup placement); null = none. */
  tareAtMs: number | null;
}

export type RecorderEvent =
  | { type: 'arm'; now: number; targetYieldG: number; tailEstimateG?: number; autoStart?: boolean }
  | { type: 'disarm'; now: number }
  | { type: 'tap'; now: number }
  | { type: 'frame'; now: number; grams: number; flow: number; timerMs: number; tRxMs: number }
  | { type: 'tick'; now: number }
  | { type: 'disconnected'; now: number }
  | { type: 'background'; now: number }
  | { type: 'abort'; now: number }
  | { type: 'accept_forgot_tap'; now: number }
  | { type: 'dismiss_forgot_tap'; now: number }
  | { type: 'manual_yield'; now: number; grams: number }
  | { type: 'rated'; now: number }
  | { type: 'reset'; now: number }
  /** The app sent a plain tare (01), e.g. auto-tare when the cup was put down. */
  | { type: 'tared'; now: number };

export type Effect =
  | { type: 'send'; cmd: 'tareStart' | 'start' | 'stop' | 'beep' | 'tare' | 'reset'; n?: number }
  | { type: 'warn'; code: string; msg: string }
  | { type: 'prompt'; kind: 'forgot_tap' }
  | { type: 'pre_alert' }
  | { type: 'shot_running'; running: boolean }
  | { type: 'mode_hint'; hint: ModeHint }
  | { type: 'finalize'; discard: boolean };

export function initialState(): RecorderState {
  return { phase: 'IDLE', draft: null, armed: null, prompt: null, liveFlow: 0, tareAtMs: null };
}

/**
 * Learned: a normal tap, a late tap and a hands-free start (all timed from the first drops at
 * worst, which plateau flow does not depend on). Not learned: a forgotten tap accepted from
 * the prompt, aborted and partial shots.
 */
export function learnGate(status: ShotStatus, featuresValid: boolean): boolean {
  return (status === 'ok' || status === 'late_tap' || status === 'auto_start') && featuresValid;
}

/**
 * When the Mara X's vibration pump started, from the scale (on the drip tray it picks up the
 * pump's buzz as frame-to-frame jitter): the earliest time before `onsetMs` from which the
 * jitter stays above 3× the armed baseline (and above 0.06 g). Null when the scale shows no
 * such step (no buzz, a damped tray, or too little armed history). Measurement only.
 */
export function pumpOnset(ring: RingBuffer, onsetMs: number, armedAtMs: number): number | null {
  const xs = ring.between(Math.max(armedAtMs, onsetMs - 20_000), onsetMs);
  if (xs.length < 30) return null;
  const jit: { t: number; d: number }[] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1];
    const b = xs[i];
    if (a && b) jit.push({ t: b.tRxMs, d: Math.abs(b.grams - a.grams) });
  }
  const meanBetween = (t0: number, t1: number) => {
    const w = jit.filter((j) => j.t >= t0 && j.t < t1);
    return w.length < 4 ? Number.NaN : w.reduce((s, j) => s + j.d, 0) / w.length;
  };
  const first = jit[0];
  if (!first) return null;
  const baseline = meanBetween(first.t, first.t + 3000);
  if (Number.isNaN(baseline)) return null;
  const threshold = Math.max(0.06, 3 * baseline);
  // Walk back from the onset in 0.5 s steps while each 1 s window stays above the threshold.
  let start: number | null = null;
  for (let t = onsetMs - 1000; t >= first.t + 3000; t -= 500) {
    const m = meanBetween(t, t + 1000);
    if (Number.isNaN(m) || m < threshold) break;
    start = t;
  }
  return start;
}

function newDraft(now: number, armed: NonNullable<RecorderState['armed']>): ShotDraft {
  return {
    t0Ms: now,
    tapMs: now,
    status: 'ok',
    startCmd: 'none',
    samples: [],
    gaps: [],
    openGapStartS: null,
    endAt: null,
    endAtRxMs: null,
    endedBy: null,
    finalYieldG: null,
    manualYieldG: null,
    tareOffsetG: 0,
    anchorOffsetS: null,
    firstTimer: null,
    lastTimer: null,
    modeHint: 'unknown',
    framesSinceStart: 0,
    preTapSpliceS: null,
    targetYieldG: armed.targetYieldG,
    tailEstimateG: armed.tailEstimateG,
    quietSinceS: null,
    lastFrameRxMs: null,
    lastG: 0,
    maxG: 0,
    disconnectedAtMs: null,
    settleUntilMs: null,
    alertFired: false,
    preTapMedianG: 0,
    tareDecided: false,
    pumpLeadMs: null,
    notes: [],
    recoveringFrom: null,
  };
}

/** Sample time for a frame during the pull (timer authority once anchored). */
function sampleTime(d: ShotDraft, timerMs: number, tRxMs: number): number {
  const arrival = (tRxMs - d.t0Ms) / 1000;
  if (d.endAt !== null && d.endAtRxMs !== null) return d.endAt + (tRxMs - d.endAtRxMs) / 1000;
  if (d.modeHint === 'auto' || timerMs <= 0) return arrival;
  if (d.anchorOffsetS === null) d.anchorOffsetS = arrival - timerMs / 1000;
  return timerMs / 1000 + d.anchorOffsetS;
}

function liveFlowOf(samples: readonly ShotSample[], windowS: number): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const pts: [number, number][] = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (!s || last.t - s.t > windowS) break;
    pts.push([s.t, s.g]);
  }
  const f = regressionFlow(pts);
  return Number.isNaN(f) ? 0 : f;
}

/** Start of a rise window of `ms`, never before the last plain tare had been applied. */
function riseWindowStart(state: RecorderState, now: number, ms: number): number {
  const afterTare =
    state.tareAtMs === null ? Number.NEGATIVE_INFINITY : state.tareAtMs + REC.tareApplyMs;
  return Math.max(now - ms, afterTare);
}

/** The scale's timer button: the timer value it started from and the frame that showed it. */
interface ButtonStart {
  baseMs: number;
  timerMs: number;
  tRxMs: number;
}

/**
 * Start the pull from a tap, an accepted forgot-tap prompt, the first drops (hands-free) or
 * the scale's timer button.
 */
function startShot(
  state: RecorderState,
  now: number,
  ring: RingBuffer,
  mode: 'tap' | 'forgot' | 'auto' | 'button',
  button?: ButtonStart,
): [RecorderState, Effect[]] {
  const armed = state.armed;
  if (!armed) return [state, []];
  const d = newDraft(now, armed);
  const effects: Effect[] = [{ type: 'shot_running', running: true }];
  // The timer button: the shot began when the timer did (t0 = receive time − timer).
  const startMs = button ? button.tRxMs - (button.timerMs - button.baseMs) : now;
  // Rise window: the last 2 s, but never before the last tare had settled. A window with a
  // placement jump is a cup put down (not coffee): that is never a late tap.
  const from = riseWindowStart(state, startMs, REC.lateTapWindowMs);
  const rise = ring.riseSince(from);
  const placed = ring.maxJumpBetween(from, now) >= REC.placementJumpG;
  const late = mode === 'forgot' || mode === 'auto' || (rise > REC.lateTapRiseG && !placed);
  if (!late && button) {
    // Lever up and the scale's timer pressed together: first drip known, nothing to send
    // (auto-tare zeroed the cup). An untared cup is decided on the first frames, as for 07:
    // the button may tare (FIELD_TEST), else the reading before the press is the tare.
    d.t0Ms = startMs;
    d.startCmd = 'button';
    d.modeHint = 'timer';
    d.anchorOffsetS = -button.baseMs / 1000;
    const med = ring.medianBetween(from, startMs);
    d.preTapMedianG = Number.isNaN(med) ? 0 : med;
    d.tareDecided = Math.abs(d.preTapMedianG) <= REC.tareSettleG;
    d.notes.push('started by the scale timer button');
  } else if (!late) {
    d.startCmd = 'tareStart';
    const med = ring.medianBetween(from, now);
    d.preTapMedianG = Number.isNaN(med) ? (ring.last()?.grams ?? 0) : med;
    effects.push({ type: 'send', cmd: 'tareStart' });
  } else {
    d.tareDecided = true;
    // Weight already rising: start the timer only, tare in software, splice the pre-tap frames.
    const onsetRx = ring.riseOnset(now) ?? now - REC.lateTapWindowMs;
    const tare = ring.medianBetween(onsetRx - REC.lateTapWindowMs, onsetRx);
    d.tareOffsetG = Number.isNaN(tare) ? (ring.at(onsetRx)?.grams ?? 0) : tare;
    d.t0Ms = onsetRx;
    d.status = mode === 'forgot' ? 'no_tap_recovered' : mode === 'auto' ? 'auto_start' : 'late_tap';
    if (mode === 'auto') {
      const pump = pumpOnset(ring, onsetRx, state.armed?.sinceMs ?? onsetRx - 15_000);
      d.pumpLeadMs = pump === null ? null : onsetRx - pump;
    }
    d.startCmd = button ? 'button' : 'start';
    if (button) d.modeHint = 'timer';
    d.preTapSpliceS = (now - onsetRx) / 1000;
    for (const s of ring.between(onsetRx, now)) {
      d.samples.push({
        t: (s.tRxMs - onsetRx) / 1000,
        g: s.grams - d.tareOffsetG,
        flow: s.flowScale,
        tRxMs: s.tRxMs,
        timerMs: 0,
      });
    }
    const last = d.samples[d.samples.length - 1];
    if (last) {
      d.lastG = last.g;
      d.maxG = Math.max(...d.samples.map((s) => s.g));
      d.lastFrameRxMs = last.tRxMs;
    }
    d.notes.push(
      mode === 'forgot'
        ? `no tap: start estimated from the weight rise, ${d.preTapSpliceS.toFixed(1)} s recovered`
        : mode === 'auto'
          ? `hands-free: started at the first drops, ${d.preTapSpliceS.toFixed(1)} s spliced in${d.pumpLeadMs !== null ? `; pump vibration ${(d.pumpLeadMs / 1000).toFixed(1)} s before` : ''}`
          : mode === 'button'
            ? `late scale timer: ${d.preTapSpliceS.toFixed(1)} s of earlier frames spliced in`
            : `late tap: ${d.preTapSpliceS.toFixed(1)} s of pre-tap frames spliced in`,
    );
    // 06 first: after the previous shot's 05 the timer is frozen and 04 alone is ignored
    // (docs/PROTOCOL.md), which would stall the scale timer the samples are anchored to.
    // The timer button already started it.
    if (!button) {
      effects.push({ type: 'send', cmd: 'reset' });
      effects.push({ type: 'send', cmd: 'start' });
    }
    if (mode !== 'auto')
      effects.push({
        type: 'warn',
        code: mode === 'forgot' ? 'no_tap_recovered' : 'late_tap',
        msg:
          mode === 'forgot'
            ? 'Shot start estimated from the weight rise.'
            : mode === 'button'
              ? 'Scale timer started after the first drops: first-drip time unknown.'
              : 'Late tap: pre-tap frames recovered, first-drip time unknown.',
      });
  }
  return [{ ...state, phase: 'RUNNING', draft: d, prompt: null, liveFlow: 0 }, effects];
}

/**
 * The scale's timer started on this frame: it rises from 0, or moves off a value it had
 * stood at (frozen by the last 05). Base is where it counts from (resumed, or restarted).
 */
function buttonStart(
  held: { ms: number; sinceMs: number },
  timerMs: number,
  tRxMs: number,
): ButtonStart | null {
  if (timerMs <= 0 || timerMs === held.ms) return null;
  if (held.ms !== 0 && tRxMs - held.sinceMs < REC.timerStillMs) return null;
  if (held.ms !== 0 && timerMs < held.ms && timerMs > REC.timerFreshMs) return null;
  return { baseMs: timerMs > held.ms ? held.ms : 0, timerMs, tRxMs };
}

function endShot(
  state: RecorderState,
  now: number,
  by: EndedBy,
  tRxMs?: number,
  sendStop = true,
): [RecorderState, Effect[]] {
  const d = state.draft;
  if (!d) return [state, []];
  const rx = tRxMs ?? now;
  // The last frame at or before the end (a stop seen late, like the timer button, is earlier).
  const last = d.samples.findLast((s) => s.tRxMs <= rx) ?? d.samples[d.samples.length - 1];
  d.endAt = last ? last.t + Math.max(0, (rx - last.tRxMs) / 1000) : (rx - d.t0Ms) / 1000;
  d.endAtRxMs = rx;
  d.endedBy = by;
  d.settleUntilMs = now + REC.settleMs;
  const effects: Effect[] = [];
  if (sendStop && (by === 'tap' || by === 'auto')) effects.push({ type: 'send', cmd: 'stop' });
  return [{ ...state, phase: 'ENDING', draft: d }, effects];
}

function finalize(state: RecorderState, now: number, reason?: string): [RecorderState, Effect[]] {
  const d = state.draft;
  if (!d) return [state, []];
  if (reason) d.notes.push(reason);
  if (d.finalYieldG === null) {
    const last = d.samples[d.samples.length - 1];
    if (last) {
      const xs = d.samples
        .filter((s) => last.t - s.t <= REC.finalYieldMedianMs / 1000)
        .map((s) => s.g)
        .sort((a, b) => a - b);
      const m = xs.length >> 1;
      d.finalYieldG = xs.length % 2 ? (xs[m] ?? 0) : ((xs[m - 1] ?? 0) + (xs[m] ?? 0)) / 2;
    } else d.finalYieldG = 0;
  }
  if (d.endAt === null) {
    const last = d.samples[d.samples.length - 1];
    d.endAt = last ? last.t : (now - d.t0Ms) / 1000;
    d.endAtRxMs = last ? last.tRxMs : now;
  }
  const discard = d.status === 'aborted' && d.maxG < REC.abortDiscardG;
  return [
    {
      ...state,
      phase: discard ? 'IDLE' : 'RATE',
      draft: discard ? null : d,
      armed: null,
      prompt: null,
    },
    [
      { type: 'shot_running', running: false },
      { type: 'finalize', discard },
    ],
  ];
}

export function reduce(
  state: RecorderState,
  ev: RecorderEvent,
  ring: RingBuffer,
): [RecorderState, Effect[]] {
  switch (ev.type) {
    case 'arm': {
      if (state.phase !== 'IDLE' && state.phase !== 'SAVED' && state.phase !== 'ABORTED')
        return [state, []];
      const timerMs = ring.last()?.timerMs;
      return [
        {
          phase: 'ARMED',
          draft: null,
          armed: {
            targetYieldG: ev.targetYieldG,
            tailEstimateG: ev.tailEstimateG ?? REC.tailEstimateDefaultG,
            autoStart: ev.autoStart === true,
            stable: ring.rangeOver(REC.stableWindowMs, ev.now) < REC.stableDeltaG,
            sinceMs: ev.now,
            timer: timerMs === undefined ? null : { ms: timerMs, sinceMs: ev.now },
          },
          prompt: null,
          liveFlow: 0,
          tareAtMs: state.tareAtMs,
        },
        // 06: a timer the last shot's 05 froze reads 0 again, so the scale's own timer button
        // starts it from zero (06 is ignored while the timer runs; docs/PROTOCOL.md).
        [{ type: 'send', cmd: 'reset' }],
      ];
    }
    case 'disarm': {
      if (state.phase !== 'ARMED') return [state, []];
      return [{ ...initialState(), tareAtMs: state.tareAtMs }, []];
    }
    case 'reset':
      return [{ ...initialState(), tareAtMs: state.tareAtMs }, []];
    case 'tared':
      return [{ ...state, tareAtMs: ev.now }, []];
    case 'tap': {
      if (state.phase === 'ARMED') return startShot(state, ev.now, ring, 'tap');
      if (state.phase === 'RUNNING') {
        // START tapped just after the shot started by itself: the screen had already turned
        // into STOP under the finger.
        const d = state.draft;
        const untapped = d?.startCmd === 'button' || d?.status === 'auto_start';
        if (d && untapped && ev.now - (d.tapMs ?? 0) < REC.stopGuardMs) return [state, []];
        return endShot(state, ev.now, 'tap');
      }
      if (state.phase === 'RECOVERING') {
        // User ends a shot the link lost: close it with what we have.
        const d = state.draft;
        if (d) {
          d.endedBy = 'disconnect';
          if (d.openGapStartS !== null) d.gaps.push([d.openGapStartS, d.openGapStartS]);
        }
        return finalize(state, ev.now, 'ended by tap while the link was down');
      }
      return [state, []];
    }
    case 'accept_forgot_tap': {
      if (state.phase !== 'ARMED' || state.prompt !== 'forgot_tap') return [state, []];
      return startShot(state, ev.now, ring, 'forgot');
    }
    case 'dismiss_forgot_tap':
      return [{ ...state, prompt: null }, []];
    case 'abort': {
      if (!['ARMED', 'RUNNING', 'ENDING', 'SETTLING', 'RECOVERING'].includes(state.phase))
        return [state, []];
      if (!state.draft) return [initialState(), [{ type: 'shot_running', running: false }]];
      state.draft.status = 'aborted';
      state.draft.endedBy = 'abort';
      return finalize({ ...state, phase: 'ABORTED' }, ev.now, 'aborted by user');
    }
    case 'manual_yield': {
      const d = state.draft;
      if (!d || state.phase !== 'RATE') return [state, []];
      d.manualYieldG = ev.grams;
      d.finalYieldG = ev.grams;
      if (d.status === 'partial_disconnect') d.status = 'manual_entry';
      d.notes.push(`final yield entered by hand: ${ev.grams.toFixed(1)} g`);
      return [{ ...state, draft: d }, []];
    }
    case 'rated': {
      if (state.phase !== 'RATE') return [state, []];
      return [{ ...state, phase: 'SAVED' }, []];
    }
    case 'disconnected':
    case 'background': {
      if (state.phase === 'RUNNING' || state.phase === 'ENDING' || state.phase === 'SETTLING') {
        const d = state.draft;
        if (!d) return [state, []];
        const last = d.samples[d.samples.length - 1];
        d.openGapStartS = last ? last.t : (ev.now - d.t0Ms) / 1000;
        d.disconnectedAtMs = ev.now;
        d.recoveringFrom = state.phase;
        d.notes.push(
          ev.type === 'background'
            ? 'app went to the background during the shot'
            : 'link lost during the shot',
        );
        return [
          { ...state, phase: 'RECOVERING', draft: d },
          [
            {
              type: 'warn',
              code: ev.type,
              msg:
                ev.type === 'background'
                  ? 'Return to Bluefy: the shot is recording blind.'
                  : 'Scale link lost: reconnecting while the shot runs.',
            },
          ],
        ];
      }
      return [state, []];
    }
    case 'tick':
      return onTick(state, ev.now);
    case 'frame':
      return onFrame(state, ev, ring);
    default:
      return [state, []];
  }
}

function onTick(state: RecorderState, now: number): [RecorderState, Effect[]] {
  const d = state.draft;
  switch (state.phase) {
    case 'ENDING':
      return [{ ...state, phase: 'SETTLING' }, []];
    case 'SETTLING': {
      if (d && d.settleUntilMs !== null && now >= d.settleUntilMs) return finalize(state, now);
      return [state, []];
    }
    case 'RECOVERING': {
      if (!d || d.disconnectedAtMs === null) return [state, []];
      if (now - d.disconnectedAtMs >= REC.recoverGiveUpMs) {
        d.endedBy = 'disconnect';
        if (d.recoveringFrom === 'RUNNING' || d.recoveringFrom === 'ENDING') {
          if (d.lastG < 0.75 * d.targetYieldG) d.status = 'partial_disconnect';
          d.notes.push('link not recovered within 20 s; shot ended at the last frame');
        } else {
          d.notes.push('link lost during the drip window; final yield from the last frame');
        }
        if (d.openGapStartS !== null) {
          d.gaps.push([d.openGapStartS, d.openGapStartS]);
          d.openGapStartS = null;
        }
        return finalize(state, now);
      }
      return [state, []];
    }
    default:
      return [state, []];
  }
}

function onFrame(
  state: RecorderState,
  ev: Extract<RecorderEvent, { type: 'frame' }>,
  ring: RingBuffer,
): [RecorderState, Effect[]] {
  const effects: Effect[] = [];
  switch (state.phase) {
    case 'ARMED': {
      const armed = state.armed;
      if (!armed) return [state, []];
      const stable = ring.rangeOver(REC.stableWindowMs, ev.now) < REC.stableDeltaG;
      let prompt = state.prompt;
      // A cup put down (a placement jump) or the tare that follows is not a running shot.
      const from = riseWindowStart(state, ev.now, REC.forgotTapWindowMs);
      const pouring =
        ring.riseSince(from) > REC.forgotTapRiseG &&
        ring.maxJumpBetween(from, ev.now) < REC.placementJumpG &&
        ring.flowOver(Math.min(REC.liveFlowWindowMs, ev.now - from), ev.now) > REC.forgotTapFlowGps;
      // The scale's own timer button (pressed as the lever goes up) starts the shot; this
      // frame is its first sample.
      const button = armed.timer ? buttonStart(armed.timer, ev.timerMs, ev.tRxMs) : null;
      if (button) {
        const [s1, e1] = startShot(state, ev.now, ring, 'button', button);
        const [s2, e2] = onFrame(s1, ev, ring);
        return [s2, [...e1, ...e2]];
      }
      const timer =
        armed.timer?.ms === ev.timerMs ? armed.timer : { ms: ev.timerMs, sinceMs: ev.tRxMs };
      // Hands-free: coffee is rising in the cup, so the shot starts by itself.
      if (pouring && armed.autoStart) return startShot(state, ev.now, ring, 'auto');
      if (prompt === null && pouring) {
        prompt = 'forgot_tap';
        effects.push({ type: 'prompt', kind: 'forgot_tap' });
      }
      return [{ ...state, armed: { ...armed, stable, timer }, prompt }, effects];
    }
    case 'RUNNING':
    case 'RECOVERING':
    case 'ENDING':
    case 'SETTLING': {
      const d = state.draft;
      if (!d) return [state, []];
      let phase = state.phase;
      if (phase === 'RECOVERING') {
        // Link back: resume where we were and close the gap.
        phase = d.recoveringFrom ?? 'RUNNING';
        d.recoveringFrom = null;
        d.disconnectedAtMs = null;
        effects.push({ type: 'warn', code: 'reconnected', msg: 'Scale link back; gap recorded.' });
      }
      // Timer-mode verification after 07/04.
      if (phase === 'RUNNING' && d.startCmd !== 'none' && d.modeHint === 'unknown') {
        d.framesSinceStart += 1;
        if (ev.timerMs > 0) d.modeHint = 'timer';
        else if (d.framesSinceStart >= REC.timerVerifyFrames) {
          d.modeHint = 'auto';
          d.notes.push('scale timer did not start: not in Timer mode, app clock used');
          effects.push({ type: 'mode_hint', hint: 'auto' });
          effects.push({
            type: 'warn',
            code: 'not_timer_mode',
            msg: 'Scale is not in Timer mode: using the app clock.',
          });
        }
      }
      // Tare settling after a scale tare (07, or the timer button if it tares).
      const scaleTare = d.startCmd === 'tareStart' || (d.startCmd === 'button' && !d.tareDecided);
      if (
        scaleTare &&
        d.tapMs !== null &&
        ev.tRxMs - d.tapMs < REC.tareSettleMs &&
        Math.abs(ev.grams) > REC.tareSettleG
      ) {
        return [{ ...state, phase }, effects];
      }
      // Did the scale actually tare on 07? If the stream still shows the pre-tap weight after
      // the settle window (Auto mode ignores 07), tare in software instead.
      if (!d.tareDecided && scaleTare) {
        d.tareDecided = true;
        if (Math.abs(ev.grams) > REC.tareSettleG && Math.abs(ev.grams - d.preTapMedianG) < 1.0) {
          d.tareOffsetG = d.preTapMedianG;
          d.notes.push('scale did not tare on tare+start; software tare applied');
          effects.push({
            type: 'warn',
            code: 'software_tare',
            msg: 'Scale did not tare: using a software tare.',
          });
        }
      }
      const g = ev.grams - d.tareOffsetG;
      const t = sampleTime(d, ev.timerMs, ev.tRxMs);
      // Each timer value is kept with the frame that first showed it (drift, and a timer
      // that stops).
      if (ev.timerMs > 0 && d.modeHint !== 'auto' && d.endAt === null) {
        if (!d.firstTimer) d.firstTimer = { tRxMs: ev.tRxMs, timerMs: ev.timerMs };
        if (d.lastTimer?.timerMs !== ev.timerMs)
          d.lastTimer = { tRxMs: ev.tRxMs, timerMs: ev.timerMs };
      }
      if (d.openGapStartS !== null) {
        d.gaps.push([d.openGapStartS, t]);
        d.openGapStartS = null;
      } else if (d.lastFrameRxMs !== null && ev.tRxMs - d.lastFrameRxMs > REC.gapMs) {
        const prev = d.samples[d.samples.length - 1];
        if (prev) d.gaps.push([prev.t, t]);
      }
      d.samples.push({ t, g, flow: ev.flow, tRxMs: ev.tRxMs, timerMs: ev.timerMs });
      d.lastFrameRxMs = ev.tRxMs;
      d.lastG = g;
      d.maxG = Math.max(d.maxG, g);
      const liveFlow = liveFlowOf(d.samples, REC.liveFlowWindowMs / 1000);

      if (phase === 'RUNNING') {
        // The scale's timer stopped (its button pressed as the lever came down): the shot
        // ended when the timer did; frames since then go on the receive clock.
        const stoppedAt = timerStoppedAt(d, ev.timerMs, ev.tRxMs);
        if (stoppedAt !== null) {
          const freezeT = d.samples.find((s) => s.tRxMs >= stoppedAt)?.t ?? t;
          for (const s of d.samples) {
            if (s.tRxMs > stoppedAt) s.t = freezeT + (s.tRxMs - stoppedAt) / 1000;
          }
          d.notes.push('ended by the scale timer button');
          const [s2, e2] = endShot(
            { ...state, phase, draft: d, liveFlow },
            ev.now,
            'tap',
            stoppedAt,
            false,
          );
          return [s2, [...effects, ...e2]];
        }
        if (!d.alertFired && g >= d.targetYieldG - d.tailEstimateG) {
          d.alertFired = true;
          // The app beeps the scale for it (src/app/cues.ts).
          effects.push({ type: 'pre_alert' });
        }
        let end = false;
        if (g >= d.targetYieldG + REC.autoEndOvershootG) end = true;
        else if (t >= REC.autoEndMinS && g >= REC.autoEndMinYieldFrac * d.targetYieldG) {
          if (liveFlow < REC.autoEndFlowGps) {
            if (d.quietSinceS === null) d.quietSinceS = t;
            else if (t - d.quietSinceS >= REC.autoEndQuietMs / 1000) end = true;
          } else d.quietSinceS = null;
        }
        if (end) {
          const [s2, e2] = endShot(
            { ...state, phase, draft: d, liveFlow },
            ev.now,
            'auto',
            ev.tRxMs,
          );
          return [s2, [...effects, ...e2]];
        }
      }
      if (phase === 'ENDING') phase = 'SETTLING';
      if (phase === 'SETTLING' && d.settleUntilMs !== null && ev.now >= d.settleUntilMs) {
        const [s2, e2] = finalize({ ...state, phase, draft: d, liveFlow }, ev.now);
        return [s2, [...effects, ...e2]];
      }
      return [{ ...state, phase, draft: d, liveFlow }, effects];
    }
    default:
      return [state, []];
  }
}

/**
 * Receive time at which a running scale timer stopped (its value has stood still for
 * `timerStillMs` after advancing in this shot), or null while it runs.
 */
function timerStoppedAt(d: ShotDraft, timerMs: number, tRxMs: number): number | null {
  if (d.modeHint !== 'timer' || !d.firstTimer || !d.lastTimer) return null;
  if (d.lastTimer.timerMs <= d.firstTimer.timerMs || timerMs !== d.lastTimer.timerMs) return null;
  return tRxMs - d.lastTimer.tRxMs >= REC.timerStillMs ? d.lastTimer.tRxMs : null;
}

/** Timer drift of the scale against the receive clock, in percent (NaN when unknown). */
export function timerDriftPct(d: ShotDraft): number {
  if (!d.firstTimer || !d.lastTimer) return Number.NaN;
  const dTimer = d.lastTimer.timerMs - d.firstTimer.timerMs;
  const dRx = d.lastTimer.tRxMs - d.firstTimer.tRxMs;
  if (dTimer < 5000) return Number.NaN;
  return (dRx / dTimer - 1) * 100;
}
