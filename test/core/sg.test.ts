import { describe, expect, it } from 'vitest';
import { runningMedian, sgDerivative, sgDerivCoeffs } from '../../src/core/math/sg';

describe('Savitzky–Golay derivative', () => {
  it('window 11 coefficients are i/110', () => {
    const c = sgDerivCoeffs(11);
    expect(c.length).toBe(11);
    expect(c[0]).toBeCloseTo(-5 / 110, 12);
    expect(c[5]).toBe(0);
    expect(c[10]).toBeCloseTo(5 / 110, 12);
  });

  it('reproduces the derivative of a·t² + b·t exactly in the interior', () => {
    const a = 0.37;
    const b = -1.9;
    const dt = 0.1;
    const n = 60;
    const y = Array.from({ length: n }, (_, k) => a * (k * dt) ** 2 + b * (k * dt));
    const d = sgDerivative(y, dt, 11);
    for (let k = 5; k < n - 5; k++) {
      expect(Math.abs((d[k] ?? 0) - (2 * a * k * dt + b))).toBeLessThan(1e-9);
    }
  });

  it('edges use a one-sided regression and stay finite', () => {
    const y = Array.from({ length: 20 }, (_, k) => 2 * k * 0.1);
    const d = sgDerivative(y, 0.1, 11);
    for (let k = 0; k < 20; k++) expect(d[k]).toBeCloseTo(2, 9);
  });

  it('masked cells produce one-sided estimates or NaN, never garbage', () => {
    const y = Array.from({ length: 40 }, (_, k) => 1.5 * k * 0.1);
    const mask = new Uint8Array(40).fill(1);
    for (let k = 18; k < 22; k++) mask[k] = 0;
    const d = sgDerivative(y, 0.1, 11, mask);
    for (let k = 0; k < 40; k++) {
      const v = d[k] ?? Number.NaN;
      if (!Number.isNaN(v)) expect(v).toBeCloseTo(1.5, 6);
    }
  });

  it('a 1.1 s dip is preserved at 10 Hz and smeared at 5 Hz', () => {
    // Flow 2 g/s with a dip to 0.6 g/s for 1.1 s, integrated to weight.
    function weights(hz: number): number[] {
      const dt = 1 / hz;
      const out: number[] = [];
      let w = 0;
      for (let k = 0; k < 20 * hz; k++) {
        const t = k * dt;
        const f = t >= 10 && t < 11.1 ? 0.6 : 2;
        out.push(w);
        w += f * dt;
      }
      return out;
    }
    const d10 = sgDerivative(weights(10), 0.1, 11);
    const d5 = sgDerivative(weights(5), 0.2, 11);
    const min10 = Math.min(...Array.from(d10.slice(90, 115)));
    const min5 = Math.min(...Array.from(d5.slice(45, 58)));
    expect(min10).toBeLessThan(1.0);
    expect(min5).toBeGreaterThan(min10);
  });

  it('running median ignores NaN', () => {
    const m = runningMedian([1, Number.NaN, 3, 100, 3, 3, 3], 3);
    expect(m[1]).toBe(2);
    expect(m[3]).toBe(3);
  });
});
