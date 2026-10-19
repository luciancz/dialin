/**
 * Always-on ring of recent weight frames (last 120 s while connected). The recorder
 * reads it for the stability check, late-tap and forgot-tap recovery and the software tare.
 * DOM-free; the app pushes frames, the reducer only reads.
 */
import { REC } from '../core/params';

export interface RingSample {
  tRxMs: number;
  grams: number;
  flowScale: number;
  timerMs: number;
}

export class RingBuffer {
  private buf: RingSample[] = [];

  constructor(private readonly windowMs: number = REC.ringMs) {}

  push(s: RingSample): void {
    this.buf.push(s);
    const cutoff = s.tRxMs - this.windowMs;
    let drop = 0;
    while (drop < this.buf.length && (this.buf[drop]?.tRxMs ?? 0) < cutoff) drop++;
    if (drop > 0) this.buf.splice(0, drop);
  }

  clear(): void {
    this.buf = [];
  }

  get samples(): readonly RingSample[] {
    return this.buf;
  }

  get size(): number {
    return this.buf.length;
  }

  last(): RingSample | undefined {
    return this.buf[this.buf.length - 1];
  }

  between(fromMs: number, toMs: number): RingSample[] {
    return this.buf.filter((s) => s.tRxMs >= fromMs && s.tRxMs <= toMs);
  }

  /** Sample at or just before `tMs`. */
  at(tMs: number): RingSample | undefined {
    let best: RingSample | undefined;
    for (const s of this.buf) {
      if (s.tRxMs <= tMs) best = s;
      else break;
    }
    return best;
  }

  /** last.grams − grams `ms` ago (0 when there is no earlier sample). */
  riseOver(ms: number, nowMs: number): number {
    const last = this.last();
    const earlier = this.at(nowMs - ms);
    if (!last || !earlier || earlier === last) return 0;
    return last.grams - earlier.grams;
  }

  /** last.grams − grams at `fromMs` (0 when there is no sample at or before it). */
  riseSince(fromMs: number): number {
    const last = this.last();
    const earlier = this.at(fromMs);
    if (!last || !earlier || earlier === last) return 0;
    return last.grams - earlier.grams;
  }

  /** Largest |Δgrams| between consecutive samples in [fromMs, toMs] (0 with < 2 samples). */
  maxJumpBetween(fromMs: number, toMs: number): number {
    const xs = this.between(fromMs, toMs);
    let m = 0;
    for (let i = 1; i < xs.length; i++) {
      m = Math.max(m, Math.abs((xs[i]?.grams ?? 0) - (xs[i - 1]?.grams ?? 0)));
    }
    return m;
  }

  /** max − min of grams over the last `ms`. */
  rangeOver(ms: number, nowMs: number): number {
    const xs = this.between(nowMs - ms, nowMs);
    if (xs.length < 2) return Number.POSITIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const s of xs) {
      lo = Math.min(lo, s.grams);
      hi = Math.max(hi, s.grams);
    }
    return hi - lo;
  }

  /** Least-squares flow (g/s) over the last `ms`; NaN with fewer than 3 samples. */
  flowOver(ms: number, nowMs: number): number {
    const xs = this.between(nowMs - ms, nowMs);
    return regressionFlow(xs.map((s) => [s.tRxMs / 1000, s.grams]));
  }

  medianBetween(fromMs: number, toMs: number): number {
    const xs = this.between(fromMs, toMs)
      .map((s) => s.grams)
      .sort((a, b) => a - b);
    if (xs.length === 0) return Number.NaN;
    const m = xs.length >> 1;
    return xs.length % 2 ? (xs[m] ?? 0) : ((xs[m - 1] ?? 0) + (xs[m] ?? 0)) / 2;
  }

  /**
   * Estimate when the current rise began: scanning back from the last sample, the first
   * time the weight was within `thresholdG` of the pre-rise level. Returns the receive time
   * of that sample, or null when no rise is visible.
   */
  riseOnset(nowMs: number, thresholdG = 0.3, lookbackMs = 20_000): number | null {
    const xs = this.between(nowMs - lookbackMs, nowMs);
    const last = xs[xs.length - 1];
    if (!last || xs.length < 3) return null;
    // Walk back until the weight stops decreasing (within threshold) going backwards.
    let onset: RingSample | null = null;
    for (let i = xs.length - 2; i >= 0; i--) {
      const s = xs[i];
      const next = xs[i + 1];
      if (!s || !next) break;
      if (next.grams - s.grams < 0.02 && last.grams - s.grams < thresholdG) {
        onset = s;
        break;
      }
      onset = s;
      // Stop once we are back on a flat stretch at least `thresholdG` below the current weight.
      const prev = xs[i - 1];
      if (prev && Math.abs(s.grams - prev.grams) < 0.05 && last.grams - s.grams > thresholdG) {
        onset = s;
        break;
      }
    }
    if (!onset || last.grams - onset.grams < thresholdG) return null;
    return onset.tRxMs;
  }
}

export function regressionFlow(points: readonly (readonly [number, number])[]): number {
  const n = points.length;
  if (n < 3) return Number.NaN;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  return sxx > 0 ? sxy / sxx : Number.NaN;
}
