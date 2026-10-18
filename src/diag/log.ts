/**
 * Diagnostics ring: the last 2,000 raw frames and 500 log lines, frame-rate and
 * checksum counters. "Save last 2 min as fixture" reads from here.
 */
import type { FrameSource, RawFrameRow } from '../core/types';
import { toHex } from '../scale/protocol';
import { Emitter } from '../scale/transport';

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogLine {
  t: number;
  level: LogLevel;
  msg: string;
}

const MAX_FRAMES = 2000;
const MAX_LINES = 500;

class DiagLog {
  readonly frames: RawFrameRow[] = [];
  readonly lines: LogLine[] = [];
  readonly counters = { frames: 0, bad: 0, ff12: 0, writes: 0 };
  readonly changed = new Emitter<void>();
  private seq = 0;
  private notifyPending = false;

  pushFrame(src: FrameSource, bytes: Uint8Array, tRxMs: number): void {
    this.seq += 1;
    this.frames.push([this.seq, Math.round(tRxMs), src, toHex(bytes)]);
    if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);
    this.counters.frames += 1;
    if (src === 'ff12') this.counters.ff12 += 1;
    this.schedule();
  }

  countBad(): void {
    this.counters.bad += 1;
  }

  log(level: LogLevel, msg: string): void {
    this.lines.push({ t: Date.now(), level, msg });
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    else console.info(msg);
    this.schedule();
  }

  /** Frames per second over the last `windowMs` of received FF11 frames. */
  frameHz(windowMs = 5000): number {
    const ff11 = this.frames.filter((r) => r[2] === 'ff11');
    const last = ff11[ff11.length - 1];
    if (!last) return 0;
    const start = last[1] - windowMs;
    const inWindow = ff11.filter((r) => r[1] >= start);
    if (inWindow.length < 2) return 0;
    const first = inWindow[0];
    if (!first) return 0;
    const span = last[1] - first[1];
    return span > 0 ? ((inWindow.length - 1) * 1000) / span : 0;
  }

  checksumFailRate(): number {
    const total = this.counters.frames + this.counters.bad;
    return total === 0 ? 0 : this.counters.bad / total;
  }

  /** Rows received in the last `ms` milliseconds (default 2 min). */
  lastWindow(ms = 120_000): RawFrameRow[] {
    const last = this.frames[this.frames.length - 1];
    if (!last) return [];
    const start = last[1] - ms;
    return this.frames.filter((r) => r[1] >= start);
  }

  private schedule(): void {
    if (this.notifyPending) return;
    this.notifyPending = true;
    const fire = () => {
      this.notifyPending = false;
      this.changed.emit();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(fire);
    else fire();
  }
}

export const diag = new DiagLog();
