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
  /** Legacy texture draw (kept so seeds keep their values); the body model below replaces it. */
  rpmTexture: 'thin' | 'heavy' | 'ok';
  /** Optimal brew ratio; a shorter ratio reads sour, a longer one bitter (κ ln-flow per ratio unit). */
  rStar: number;
  ratioKappa: number;
  // ---- RPM (appended 2026-10-19 so earlier draws keep their values) ----
  /** Curvature of the RPM flow effect per (100 RPM)². */
  kQ: number;
  /** Balance shift: the balanced flow moves by δ per 100 RPM. */
  delta: number;
  /** Preferred RPM for body. */
  thetaRpm: number;
  /** Body sensitivity, slider steps per 100 RPM (0 = RPM doesn't change body). */
  betaBody: number;
  /** The grinder stalls (E006) below this RPM; null = never. */
  stallBelow: number | null;
}

export interface TruthOptions {
  bags?: number;
  nonlinear?: boolean;
  dialMiscount?: number;
  channelProb?: number;
  roast?: RoastLevel;
  driftRange?: readonly [number, number];
  LrefTrue?: number;
  /** Force a stall threshold (scenario n); default: never stalls. */
  stallBelow?: number | null;
  /** Force the RPM slope (scenario m needs |k_r| ≥ 0.03). */
  kR?: number;
}

function mu0Ratio(roast: RoastLevel): number {
  return MODEL.roastDefaults[roast].ratio;
}

/**
 * Perceived balance of a cup: 0 is balanced, negative sour, positive bitter, the app's
 * slider convention (sour = under-extracted = too fast or too short; the compass veto and
 * rule rows 5–8 assume it). Flow faster than the optimum reads sour; a ratio shorter than
 * the optimum reads sour (a longer ratio compensates a slightly fast shot, which is what the
 * yield rule relies on). Until 2026-10-18 the sign was inverted, so both taste levers pushed
 * the simulated cup away from balance and the setpoint could only learn from preferences.
 */
export function perceivedOffset(t: Truth, y: number, ratio: number, rpm = 1000): number {
  return t.sStar + t.delta * ((rpm - 1000) / 100) - y + t.ratioKappa * (ratio - t.rStar);
}

/** The flow that tastes balanced at the given ratio (and RPM, through δ). */
export function effectiveSetpoint(t: Truth, ratio: number, rpm = 1000): number {
  return t.sStar + t.delta * ((rpm - 1000) / 100) - t.ratioKappa * (t.rStar - ratio);
}

/** Body utility of pulling at `rpm`: −β²(u − θ_u)²/18, the app's own utility form. */
export function bodyUtility(t: Truth, rpm: number): number {
  const d = (rpm - t.thetaRpm) / 100;
  return (-(t.betaBody * t.betaBody) * d * d) / 18;
}

export function sampleTruth(rng: Rng, o: TruthOptions = {}): Truth {
  const roast = o.roast ?? 'light';
  const mu0 = mu0Roast(roast);
  const bags = o.bags ?? 1;
  const aBags: number[] = [];
  for (let i = 0; i < bags; i++) aBags.push(mu0 + SIM.aSd * randn(rng));
  const kG = uniform(rng, SIM.kGrind[0], SIM.kGrind[1]) * (o.dialMiscount ?? 1);
  const texture = rng();
  const t: Truth = {
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
    kQ: 0,
    delta: 0,
    thetaRpm: 1000,
    betaBody: 0,
    stallBelow: null,
  };
  // RPM draws, appended. k_r is redrawn from the research prior N(−0.015, 0.035²) (the uniform
  // draw above only keeps the random stream aligned for the earlier fields).
  t.kR = o.kR ?? Math.max(-0.08, Math.min(0.08, -0.015 + 0.035 * randn(rng)));
  t.kQ = 0.004 * randn(rng);
  t.delta = 0.02 * randn(rng);
  t.thetaRpm = uniform(rng, 700, 1400);
  const b = rng();
  t.betaBody = b < 0.3 ? 0 : b < 0.9 ? uniform(rng, 0.3, 1.2) : -0.5;
  t.stallBelow = o.stallBelow ?? null;
  return t;
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
  const u = (rpm - 1000) / 100;
  return (
    a +
    grind +
    t.kR * u +
    t.kQ * u * u +
    t.kD * (doseG - doseDefaultG) +
    t.drift * daysSinceFirstShot
  );
}
