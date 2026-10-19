import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../../src/shot/ringBuffer';
import { doseNote, openWeigh, steadyDose, weighStep } from '../../src/shot/weigh';

function feed(ring: RingBuffer, t0: number, values: number[]): number {
  let t = t0;
  for (const g of values) {
    t += 100;
    ring.push({ tRxMs: t, grams: g, flowScale: 0, timerMs: 0 });
  }
  return t;
}

describe('bean weighing', () => {
  it('waits for the cup tare, then captures the steady bean weight to 0.1 g', () => {
    const ring = new RingBuffer();
    let st = openWeigh(1000);
    let t = feed(ring, 1000, Array(10).fill(0));
    st = weighStep(st, { connected: true, nowMs: t, tareAtMs: null, ring });
    expect(st.phase).toBe('place_cup');
    // Cup down, auto-tare at t + 1500.
    t = feed(ring, t, Array(15).fill(95));
    const tareAt = t;
    t = feed(ring, t, Array(10).fill(0));
    st = weighStep(st, { connected: true, nowMs: t, tareAtMs: tareAt, ring });
    expect(st.phase).toBe('add_beans');
    // Beans poured over 1 s, still settling: not captured yet.
    t = feed(ring, t, [2, 5, 8, 11, 14, 16, 17.5, 18.1, 18.3, 18.3]);
    st = weighStep(st, { connected: true, nowMs: t, tareAtMs: tareAt, ring });
    expect(st.phase).toBe('add_beans');
    // Steady with one-count jitter for 1.5 s.
    t = feed(
      ring,
      t,
      [
        18.3, 18.2, 18.3, 18.3, 18.2, 18.3, 18.3, 18.3, 18.2, 18.3, 18.3, 18.3, 18.3, 18.2, 18.3,
        18.3,
      ],
    );
    st = weighStep(st, { connected: true, nowMs: t, tareAtMs: tareAt, ring });
    expect(st.phase).toBe('captured');
    expect(st.doseG).toBe(18.3);
    // A few more beans re-open it.
    t = feed(ring, t, [18.9]);
    st = weighStep(st, { connected: true, nowMs: t, tareAtMs: tareAt, ring });
    expect(st.phase).toBe('add_beans');
  });

  it('ignores a tare from before the step and reports a lost scale', () => {
    const ring = new RingBuffer();
    const t = feed(ring, 5000, Array(20).fill(18));
    const st = openWeigh(5000);
    expect(weighStep(st, { connected: true, nowMs: t, tareAtMs: 4000, ring }).phase).toBe(
      'place_cup',
    );
    expect(weighStep(st, { connected: false, nowMs: t, tareAtMs: 6000, ring }).phase).toBe(
      'need_scale',
    );
    expect(steadyDose(ring, t)).toBe(18);
  });

  it('notes a dose more than 0.3 g off the plan and keeps the yield', () => {
    expect(doseNote(18.2, 18, 40)).toBeNull();
    expect(doseNote(18.5, 18, 40)).toMatch(
      /0\.5 g over the planned 18\.0 g: the yield stays 40 g, so the ratio becomes 1:2\.16/,
    );
    expect(doseNote(17.4, 18, 40)).toMatch(/under/);
  });
});
