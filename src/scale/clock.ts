/** Clock implementations: the real one for the app, a controllable one for tests and the simulator. */
import type { Clock } from './transport';

export const realClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

interface Timer {
  at: number;
  fn: () => void;
  id: number;
}

/** Deterministic clock: time only moves when advance() is called; due timers fire in order. */
export class FakeClock implements Clock {
  private t: number;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id);
    };
  }

  /** Advance by `ms`, firing every timer that falls due (in time order). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((x) => x.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = target;
  }

  /** Advance in steps, letting promise callbacks run between steps. */
  async advanceAsync(ms: number, stepMs = 50): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(stepMs, left);
      this.advance(step);
      left -= step;
      await flushPromises();
    }
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}

export async function flushPromises(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
