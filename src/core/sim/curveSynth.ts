/**
 * Synthetic espresso curve: first drip, logistic ramp to a plateau, optional late rise,
 * optional spike and dips, stop at a target weight, drip tail, 0.05 g noise and 0.1 g
 * truncation. Statistics parameterised by cafeteca's and misch0n's published captures.
 * Used by the feature tests, the fake transport and the convergence simulator.
 */

import { type Rng, randn, uniform } from '../math/rng';
import { SIM } from '../params';

export interface CurveSpec {
  firstDripS: number;
  plateauGps: number;
  rampS: number;
  /** Fractional flow rise over the shot after the ramp (0.02 = +2 %). */
  lateRise: number;
  /** Stop fires when the (noise-free) weight reaches this. */
  stopAtG: number;
  tailG: number;
  tailS: number;
  noiseG: number;
  truncG: number;
  spike?: { atS: number; gps: number; durS: number };
  dips?: { atS: number; depth: number; durS: number }[];
  /** Hard cap on duration (s) so a choked shot still ends. */
  maxS?: number;
}

export interface SynthCurve {
  /** Seconds from pump start, 100 ms grid, through endAt + settle. */
  t: number[];
  g: number[];
  /** Noise-free true flow, for tests. */
  trueFlow: number[];
  endAt: number;
  finalYieldG: number;
}

export function trueFlowAt(spec: CurveSpec, tS: number): number {
  if (tS < spec.firstDripS) return 0;
  const x = (tS - spec.firstDripS) / Math.max(0.1, spec.rampS);
  const ramp = 1 / (1 + Math.exp(-8 * (x - 0.5)));
  let f = spec.plateauGps * ramp;
  const sinceRamp = tS - spec.firstDripS - spec.rampS;
  if (sinceRamp > 0) f *= 1 + (spec.lateRise * sinceRamp) / 30;
  if (spec.spike && tS >= spec.spike.atS && tS < spec.spike.atS + spec.spike.durS)
    f += spec.spike.gps;
  if (spec.dips) {
    for (const d of spec.dips) {
      if (tS >= d.atS && tS < d.atS + d.durS) f *= 1 - d.depth;
    }
  }
  return Math.max(0, f);
}

export function synthCurve(spec: CurveSpec, rng: Rng, dtMs = 100, settleS = 6): SynthCurve {
  const dt = dtMs / 1000;
  const t: number[] = [];
  const g: number[] = [];
  const trueFlow: number[] = [];
  let w = 0;
  let endAt = -1;
  const maxS = spec.maxS ?? 120;
  let k = 0;
  // Pull phase.
  for (;;) {
    const tk = k * dt;
    const f = trueFlowAt(spec, tk);
    if (k > 0) w += f * dt;
    t.push(tk);
    trueFlow.push(f);
    g.push(w);
    if (w >= spec.stopAtG || tk >= maxS) {
      endAt = tk;
      break;
    }
    k++;
  }
  // Tail: exponential delivery of tailG over ~tailS.
  const wStop = w;
  const tau = Math.max(0.2, spec.tailS / 4);
  const nSettle = Math.round(settleS / dt);
  for (let i = 1; i <= nSettle; i++) {
    const tk = endAt + i * dt;
    const delivered = spec.tailG * (1 - Math.exp(-(i * dt) / tau));
    t.push(tk);
    trueFlow.push((spec.tailG / tau) * Math.exp(-(i * dt) / tau));
    g.push(wStop + delivered);
  }
  const finalYieldG = wStop + spec.tailG * (1 - Math.exp(-settleS / tau));
  // Noise + truncation on the observed weight.
  const obs = g.map((v) => {
    const noisy = v + spec.noiseG * randn(rng);
    return Math.round(noisy / spec.truncG) * spec.truncG;
  });
  return { t, g: obs, trueFlow, endAt, finalYieldG };
}

/** A random but plausible spec around a plateau flow, for the fake transport / simulator. */
export function randomSpec(
  rng: Rng,
  plateauGps: number,
  stopAtG: number,
  opts: { channel?: boolean; lateRise?: number } = {},
): CurveSpec {
  const firstDripS = uniform(rng, SIM.firstDripS[0], SIM.firstDripS[1]);
  const spec: CurveSpec = {
    firstDripS,
    plateauGps,
    rampS: SIM.rampS,
    lateRise: opts.lateRise ?? uniform(rng, -SIM.lateRise, SIM.lateRise),
    stopAtG,
    tailG: uniform(rng, SIM.tailG[0], SIM.tailG[1]),
    tailS: uniform(rng, SIM.tailS[0], SIM.tailS[1]),
    noiseG: SIM.noiseG,
    truncG: SIM.truncG,
  };
  if (opts.channel) {
    const approxDur = stopAtG / plateauGps;
    spec.spike = {
      atS: firstDripS + SIM.rampS + uniform(rng, 2, Math.max(3, approxDur * 0.5)),
      gps: SIM.spikeGps,
      durS: SIM.spikeS,
    };
    const nDips = Math.round(uniform(rng, SIM.dips[0], SIM.dips[1]));
    spec.dips = [];
    for (let i = 0; i < nDips; i++) {
      spec.dips.push({
        atS: firstDripS + SIM.rampS + uniform(rng, 1, Math.max(2, approxDur * 0.6)),
        depth: uniform(rng, 0.4, 0.6),
        durS: uniform(rng, 0.6, 1.2),
      });
    }
  }
  return spec;
}
