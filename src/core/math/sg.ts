/**
 * Savitzky–Golay first derivative on a uniform grid.
 *
 * For a symmetric window of odd length n = 2h+1 the order-2 first-derivative
 * coefficients are c_i = i / Σi² (i = −h..h); window 11 gives i/110. The derivative
 * of a quadratic is reproduced exactly. Edges and the neighbourhood of masked cells
 * use a one-sided linear regression over the available points of the same window.
 */

export function sgDerivCoeffs(window: number): number[] {
  if (window < 3 || window % 2 === 0) throw new Error('window must be odd and ≥ 3');
  const h = (window - 1) / 2;
  let s2 = 0;
  for (let i = -h; i <= h; i++) s2 += i * i;
  const c: number[] = [];
  for (let i = -h; i <= h; i++) c.push(i / s2);
  return c;
}

function regressionSlope(
  y: ArrayLike<number>,
  mask: Uint8Array | undefined,
  from: number,
  to: number,
  dt: number,
): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let k = from; k <= to; k++) {
    if (mask && mask[k] !== 1) continue;
    n++;
    sx += k;
    sy += y[k] ?? 0;
  }
  if (n < 2) return Number.NaN;
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let k = from; k <= to; k++) {
    if (mask && mask[k] !== 1) continue;
    const dx = k - mx;
    sxx += dx * dx;
    sxy += dx * ((y[k] ?? 0) - my);
  }
  return sxx > 0 ? sxy / sxx / dt : Number.NaN;
}

/**
 * Derivative of `y` sampled every `dt` seconds. `mask[k] === 1` marks valid cells;
 * cells whose centred window touches an invalid cell fall back to a one-sided
 * regression over the valid cells in that window, or NaN when fewer than two exist.
 */
export function sgDerivative(
  y: ArrayLike<number>,
  dt: number,
  window = 11,
  mask?: Uint8Array,
): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  const c = sgDerivCoeffs(window);
  const h = (window - 1) / 2;
  for (let k = 0; k < n; k++) {
    let centredOk = k - h >= 0 && k + h < n;
    if (centredOk && mask) {
      for (let i = -h; i <= h; i++) {
        if (mask[k + i] !== 1) {
          centredOk = false;
          break;
        }
      }
    }
    if (centredOk) {
      let s = 0;
      for (let i = -h; i <= h; i++) s += (c[i + h] ?? 0) * (y[k + i] ?? 0);
      out[k] = s / dt;
    } else {
      const from = Math.max(0, k - h);
      const to = Math.min(n - 1, k + h);
      out[k] = regressionSlope(y, mask, from, to, dt);
    }
  }
  return out;
}

/**
 * Order-2 Savitzky–Golay smoothing coefficients (fitted value at the window centre):
 * c_i = [3(3h²+3h−1) − 15i²] / [(2h+3)(2h+1)(2h−1)]. Window 11 gives (−36, 9, 44, 69, 84, 89, …)/429.
 */
export function sgSmoothCoeffs(window: number): number[] {
  if (window < 5 || window % 2 === 0) throw new Error('window must be odd and ≥ 5');
  const h = (window - 1) / 2;
  const den = (2 * h + 3) * (2 * h + 1) * (2 * h - 1);
  const c: number[] = [];
  for (let i = -h; i <= h; i++) c.push((3 * (3 * h * h + 3 * h - 1) - 15 * i * i) / den);
  return c;
}

/** Locally quadratic smoothing of `y`; NaN where the centred window is incomplete or masked. */
export function sgSmooth(y: ArrayLike<number>, window = 11, mask?: Uint8Array): Float64Array {
  const n = y.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const c = sgSmoothCoeffs(window);
  const h = (window - 1) / 2;
  for (let k = h; k < n - h; k++) {
    let ok = true;
    let s = 0;
    for (let i = -h; i <= h; i++) {
      if (mask && mask[k + i] !== 1) {
        ok = false;
        break;
      }
      s += (c[i + h] ?? 0) * (y[k + i] ?? 0);
    }
    if (ok) out[k] = s;
  }
  return out;
}

/** Running median over a centred window of `window` samples (odd), NaN-aware. */
export function runningMedian(x: ArrayLike<number>, window: number): Float64Array {
  const n = x.length;
  const h = (window - 1) / 2;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const vals: number[] = [];
    for (let i = Math.max(0, k - h); i <= Math.min(n - 1, k + h); i++) {
      const v = x[i] ?? Number.NaN;
      if (!Number.isNaN(v)) vals.push(v);
    }
    if (vals.length === 0) {
      out[k] = Number.NaN;
      continue;
    }
    vals.sort((a, b) => a - b);
    const m = vals.length >> 1;
    out[k] = vals.length % 2 ? (vals[m] ?? 0) : ((vals[m - 1] ?? 0) + (vals[m] ?? 0)) / 2;
  }
  return out;
}
