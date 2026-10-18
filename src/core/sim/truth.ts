/**
 * Hidden truth for the simulator (plan "Simulator"): gains, intercepts, drift, taste optimum,
 * taste noise, channeling. Includes a 1/x (Cameron) non-linear flow law and a mis-counted
 * dial (the app's line is physically two lines).
 */

import { mu0Roast } from '../flowmodel/state';
import { type Rng, randn, uniform } from '../math/rng';
import { MODEL, SIM } from '../params';
import type { RoastLevel } from '../types';

export interface Truth {
  kG: number;
  kR: number;
  kD: number;
  /** Intercepts per bag at LrefTrue, 1000 RPM, default dose, at the bag's first-shot age. */
  aBags: number[];
  drift: number;
  sStar: number;
  tau: number;
  lapse: number;
  channelProb: number;
  channelLn: [number, number];
  nonlinear: 'none' | 'inverse';
  lambda: number;
  LrefTrue: number;
  roast: RoastLevel;
  /** Texture the taster reports at the held RPM: drives the thin–heavy slider. */
  rpmTexture: 'thin' | 'heavy' | 'ok';
  /** Optimal brew ratio; a shorter ratio reads sour, a longer one bitter (κ ln-flow per ratio unit). */
  rStar: number;
  ratioKappa: number;
}

export interface TruthOptions {
  bags?: number;
  nonlinear?: boolean;
  dialMiscount?: number;
  channelProb?: number;
  roast?: RoastLevel;
  driftRange?: readonly [number, number];
  LrefTrue?: number;
}

function mu0Ratio(roast: RoastLevel): number {
  return MODEL.roastDefaults[roast].ratio;
}

/**
 * Perceived balance of a cup: 0 is balanced, negative sour, positive bitter. Flow faster than
 * the optimum reads bitter; a ratio shorter than the optimum reads sour (a longer ratio
 * compensates a slightly fast shot, which is what the yield rule relies on).
 */
export function perceivedOffset(t: Truth, y: number, ratio: number): number {
  return y - t.sStar + t.ratioKappa * (t.rStar - ratio);
}

/** The flow that tastes balanced at the given ratio. */
export function effectiveSetpoint(t: Truth, ratio: number): number {
  return t.sStar - t.ratioKappa * (t.rStar - ratio);
}

export function sampleTruth(rng: Rng, o: TruthOptions = {}): Truth {
  const roast = o.roast ?? 'light';
  const mu0 = mu0Roast(roast);
  const bags = o.bags ?? 1;
  const aBags: number[] = [];
  for (let i = 0; i < bags; i++) aBags.push(mu0 + SIM.aSd * randn(rng));
  const kG = uniform(rng, SIM.kGrind[0], SIM.kGrind[1]) * (o.dialMiscount ?? 1);
  const texture = rng();
  return {
    kG,
    kR: uniform(rng, SIM.kRpm[0], SIM.kRpm[1]),
    kD: uniform(rng, SIM.kDose[0], SIM.kDose[1]),
    aBags,
    drift: uniform(rng, o.driftRange?.[0] ?? SIM.drift[0], o.driftRange?.[1] ?? SIM.drift[1]),
    sStar: mu0 + SIM.setpointSd * randn(rng),
    tau: uniform(rng, SIM.tasteTau[0], SIM.tasteTau[1]),
    lapse: SIM.tasteLapse,
    channelProb: o.channelProb ?? uniform(rng, SIM.channelProb[0], SIM.channelProb[1]),
    channelLn: [SIM.channelLn[0], SIM.channelLn[1]],
    nonlinear: o.nonlinear ? 'inverse' : 'none',
    lambda: uniform(rng, 20, 40),
    LrefTrue: o.LrefTrue ?? 250,
    roast,
    rpmTexture: texture < 0.33 ? 'thin' : texture < 0.66 ? 'heavy' : 'ok',
    rStar: mu0Ratio(roast) + 0.25 * randn(rng),
    ratioKappa: 0.15,
  };
}

/** True ln plateau flow at the settings, without channeling or measurement noise. */
export function trueLnFlow(
  t: Truth,
  bagIndex: number,
  lines: number,
  rpm: number,
  doseG: number,
  daysSinceFirstShot: number,
  doseDefaultG = 18,
): number {
  const a = t.aBags[bagIndex] ?? t.aBags[0] ?? 0;
  const dL = lines - t.LrefTrue;
  let grind: number;
  if (t.nonlinear === 'inverse') {
    // Flow ∝ gap: y = a + ln(1 + ΔL/λ), slope 1/λ near the anchor, curving away from it.
    const arg = 1 + dL / t.lambda;
    grind = Math.log(Math.max(0.05, arg));
  } else grind = t.kG * dL;
  return (
    a +
    grind +
    t.kR * ((rpm - 1000) / 100) +
    t.kD * (doseG - doseDefaultG) +
    t.drift * daysSinceFirstShot
  );
}
