/**
 * Resample raw scale samples onto a 100 ms grid from the tap (t = 0) by linear
 * interpolation. Cells inside a gap longer than `gapMs` are masked (mask = 0) and the
 * gaps are reported in seconds for storage on the Curve row.
 */

export interface RawSample {
  /** Seconds from the tap. */
  t: number;
  g: number;
  /** Scale's own EMA flow (display only). */
  flow?: number;
}

export interface Grid {
  t: Float32Array;
  g: Float32Array;
  flowScale: Float32Array;
  /** 1 = valid cell, 0 = inside a gap or outside the sampled span. */
  mask: Uint8Array;
  gaps: [number, number][];
  /** Fraction of cells up to endS that are valid. */
  present: number;
}

export function resample(
  samples: readonly RawSample[],
  endS: number,
  dtMs = 100,
  gapMs = 400,
): Grid {
  const sorted = [...samples].filter((s) => Number.isFinite(s.t) && Number.isFinite(s.g));
  sorted.sort((a, b) => a.t - b.t);
  const dt = dtMs / 1000;
  const n = Math.max(1, Math.floor(endS / dt + 1e-9) + 1);
  const t = new Float32Array(n);
  const g = new Float32Array(n);
  const flow = new Float32Array(n);
  const mask = new Uint8Array(n);
  const gaps: [number, number][] = [];
  for (let k = 0; k < n; k++) t[k] = k * dt;
  if (sorted.length === 0) return { t, g, flowScale: flow, mask, gaps, present: 0 };

  // Collect gaps between consecutive samples.
  const gapS = gapMs / 1000;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a && b && b.t - a.t > gapS) gaps.push([a.t, b.t]);
  }

  let j = 0;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return { t, g, flowScale: flow, mask, gaps, present: 0 };
  for (let k = 0; k < n; k++) {
    const tk = k * dt;
    if (tk < first.t - dt || tk > last.t + dt) {
      mask[k] = 0;
      continue;
    }
    while (j + 1 < sorted.length && (sorted[j + 1]?.t ?? Number.POSITIVE_INFINITY) <= tk) j++;
    const a = sorted[j];
    const b = sorted[j + 1];
    if (!a) continue;
    if (!b || tk <= a.t) {
      g[k] = a.g;
      flow[k] = a.flow ?? 0;
      mask[k] = 1;
      continue;
    }
    const span = b.t - a.t;
    const f = span > 0 ? (tk - a.t) / span : 0;
    g[k] = a.g + (b.g - a.g) * f;
    flow[k] = (a.flow ?? 0) + ((b.flow ?? 0) - (a.flow ?? 0)) * f;
    mask[k] = span > gapS ? 0 : 1;
  }
  let valid = 0;
  for (let k = 0; k < n; k++) if (mask[k] === 1) valid++;
  return { t, g, flowScale: flow, mask, gaps, present: valid / n };
}
