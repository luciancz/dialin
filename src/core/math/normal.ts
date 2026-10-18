/** Standard normal CDF Φ, pdf, and a few helpers. */

/** Φ(x) via erfc with the Abramowitz–Stegun 7.1.26 approximation refined (|err| < 1.2e-7). */
export function phi(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > 8) return 1;
  if (x < -8) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const tau =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  const erfcAbs = tau;
  return x >= 0 ? 1 - erfcAbs / 2 : erfcAbs / 2;
}

export function normalPdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? (a[m] ?? Number.NaN) : ((a[m - 1] ?? 0) + (a[m] ?? 0)) / 2;
}

export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** p-th quantile (0..1) by linear interpolation. */
export function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const a = [...xs].sort((x, y) => x - y);
  const pos = clamp(p, 0, 1) * (a.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const vlo = a[lo] ?? Number.NaN;
  const vhi = a[hi] ?? vlo;
  return vlo + (vhi - vlo) * (pos - lo);
}
