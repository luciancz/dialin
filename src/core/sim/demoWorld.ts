/**
 * Demo world: a hidden "true" grinder, machine and palate for the simulation mode.
 * Pure and seeded (no DOM, no clock). The app's demo controller (src/app/demo.ts) keeps one
 * world per demo database and turns its simulated shots into ordinary rows, so the real
 * features → flow model → setpoint → rules → recommendation path runs unchanged.
 *
 * Hidden truth (v2, 2026-10-19: RPM calibration):
 *   ln plateau flow  y = a + k_g·(L − L0) + k_r·u + κ·u² + k_d·(dose − dose0),  u = (RPM − 1000)/100
 *   balanced flow    s(ratio, RPM) = s* + δ·u − κ_ratio·(r* − ratio)
 *   taste            faster than balanced or a shorter ratio = under-extracted = sour;
 *                    slower or longer = over-extracted = bitter (the app's convention)
 *   body             thin–heavy = β·(u − u*): heavier above the preferred RPM when β > 0;
 *                    β = 0 means RPM doesn't change body for this palate
 *   E006             the grinder stalls below `stallBelow` RPM (null = never)
 * The v2 draws come after the v1 draws, so an existing demo bag keeps its v1 truth.
 */
import { computeFeatures } from '../curve/features';
import { type Grid, resample } from '../curve/resample';
import { mu0Roast } from '../flowmodel/state';
import { mulberry32, type Rng, randn, uniform } from '../math/rng';
import type {
  Chip,
  DialSpec,
  Features,
  RoastLevel,
  ShotSettings,
  SliderValue,
  VsPrevious,
} from '../types';
import { toLines } from '../units';
import { randomSpec, synthCurve } from './curveSynth';

export interface DemoWorld {
  version: 2;
  seed: number;
  shotCount: number;
  roast: RoastLevel;
  /** ln plateau flow per dial line (higher dial = coarser = faster). */
  kG: number;
  /** ln flow per 100 RPM (at 1000 RPM). */
  kR: number;
  /** Curvature of the RPM effect, ln flow per (100 RPM)². */
  kQ: number;
  /** ln flow per gram of dose. */
  kD: number;
  /** Reference line (the "usual" dial) and the true ln flow there at 1000 RPM, default dose. */
  L0: number;
  a: number;
  /** ln plateau flow that tastes balanced at the optimal ratio r* and 1000 RPM. */
  sStar: number;
  rStar: number;
  /** The balanced flow moves by δ per 100 RPM (lower RPM extracts more at the same flow). */
  delta: number;
  /** RPM that gives the preferred body. */
  rpmStar: number;
  /** Body sensitivity: thin–heavy slider steps per 100 RPM (0 = RPM doesn't change body). */
  betaBody: number;
  /** The grinder stalls (E006) below this RPM; null = never. */
  stallBelow: number | null;
  channelProb: number;
  /** Taste noise in slider steps (and in utility units for better/same/worse). */
  tasteNoise: number;
  doseDefaultG: number;
}

export interface DemoWorldOptions {
  seed: number;
  L0: number;
  roast?: RoastLevel;
  channelProb?: number;
  tasteNoise?: number;
  doseDefaultG?: number;
}

/** ln-flow equivalent of one ratio unit in perceived sour–bitter balance. */
export const KAPPA_RATIO = 0.15;
/** Perceived offset (ln flow) that maps to three slider steps. */
const SLIDER_SCALE = 0.25;
const UTILITY_W = 0.15;
const JND = 0.1;
/** Shot-to-shot puck-prep noise on the realised ln flow (the model assumes σ_y = 0.07). */
const PREP_NOISE = 0.06;

export function createDemoWorld(o: DemoWorldOptions): DemoWorld {
  const rng = mulberry32(o.seed >>> 0);
  const roast = o.roast ?? 'light';
  const mu0 = mu0Roast(roast);
  // v1 draws, in their original order.
  const kG = uniform(rng, 0.03, 0.07);
  const kR = uniform(rng, -0.06, 0.06);
  const kD = uniform(rng, -0.08, -0.04);
  const a = mu0 + 0.25 * randn(rng);
  const sStar = mu0 + 0.12 * randn(rng);
  const rStar = 2.3 + 0.2 * randn(rng);
  const rpmStar = Math.round(uniform(rng, 800, 1200) / 100) * 100;
  // v2 draws.
  const kQ = 0.004 * randn(rng);
  const delta = 0.02 * randn(rng);
  const b = rng();
  const betaBody = b < 0.3 ? 0 : b < 0.9 ? Math.round(uniform(rng, 0.3, 1.2) * 100) / 100 : -0.5;
  const stallBelow = rng() < 0.3 ? Math.round(uniform(rng, 550, 650)) : null;
  return {
    version: 2,
    seed: o.seed >>> 0,
    shotCount: 0,
    roast,
    kG,
    kR,
    kQ,
    kD,
    L0: o.L0,
    a,
    sStar,
    rStar,
    delta,
    rpmStar,
    betaBody,
    stallBelow,
    channelProb: o.channelProb ?? 0.15,
    tasteNoise: o.tasteNoise ?? 0.4,
    doseDefaultG: o.doseDefaultG ?? 18,
  };
}

export function ratioOf(s: ShotSettings): number {
  return s.targetYieldG / Math.max(1, s.doseG);
}

function uOf(rpm: number): number {
  return (rpm - 1000) / 100;
}

/** True RPM effect on ln flow relative to 1000 RPM. */
export function rpmEffect(w: DemoWorld, rpm: number): number {
  const u = uOf(rpm);
  return w.kR * u + w.kQ * u * u;
}

/** Noise-free ln plateau flow at the settings. */
export function trueLnFlow(w: DemoWorld, s: ShotSettings, spec: DialSpec): number {
  const L = toLines(s.grind.dialPos, spec);
  return w.a + w.kG * (L - w.L0) + rpmEffect(w, s.grind.rpm) + w.kD * (s.doseG - w.doseDefaultG);
}

/** ln plateau flow that tastes balanced at this ratio (and RPM, through δ). */
export function balancedLnFlow(w: DemoWorld, ratio: number, rpm = 1000): number {
  return w.sStar + w.delta * uOf(rpm) - KAPPA_RATIO * (w.rStar - ratio);
}

/**
 * Under-extraction score: positive = faster than balanced for this ratio (or the ratio is too
 * short) = sour; negative = bitter. Same convention as the app (sour → grind finer).
 */
export function perceivedOffset(w: DemoWorld, y: number, ratio: number, rpm = 1000): number {
  return y - balancedLnFlow(w, ratio, rpm);
}

/** The (fractional) dial line that would taste balanced at these RPM, dose and ratio. */
export function bestLines(w: DemoWorld, s: ShotSettings): number {
  const target = balancedLnFlow(w, ratioOf(s), s.grind.rpm);
  const d = s.doseG - w.doseDefaultG;
  return w.L0 + (target - w.a - rpmEffect(w, s.grind.rpm) - w.kD * d) / w.kG;
}

/** Body regret of pulling at `rpm` (0 at the preferred RPM, in the app's utility units). */
export function bodyRegret(w: DemoWorld, rpm: number): number {
  const d = uOf(rpm) - uOf(w.rpmStar);
  return (w.betaBody * w.betaBody * d * d) / 18;
}

/** True when the grinder stalls (E006) at this RPM. */
export function stallsAt(w: DemoWorld, rpm: number): boolean {
  return w.stallBelow !== null && rpm < w.stallBelow;
}

/** Seconds per dial line on a shot of `shotS` seconds (Δt/t ≈ k_g per line). */
export function secondsPerLine(w: DemoWorld, shotS = 30): number {
  return shotS * w.kG;
}

export interface DemoShot {
  /** Raw weight samples (100 ms) from pump start through the drip window. */
  t: number[];
  g: number[];
  endAt: number;
  finalYieldG: number;
  yTrue: number;
  /** Realised ln flow including prep noise and channeling. */
  yObs: number;
  channel: boolean;
  grid: Grid;
  features: Features;
}

/** Pull one simulated shot at `s`: a synthetic curve through the real feature extractor. */
export function simulateDemoShot(
  w: DemoWorld,
  s: ShotSettings,
  spec: DialSpec,
  rng: Rng,
): DemoShot {
  const yTrue = trueLnFlow(w, s, spec);
  const channel = rng() < w.channelProb;
  const yObs = yTrue + (channel ? uniform(rng, 0.15, 0.35) : 0) + PREP_NOISE * randn(rng);
  const cs = randomSpec(rng, Math.exp(yObs), Math.max(10, s.targetYieldG - 1), { channel });
  cs.maxS = 90;
  const c = synthCurve(cs, rng, 100, 6);
  const grid = resample(
    c.t.map((t, i) => ({ t, g: c.g[i] ?? 0 })),
    c.endAt + 6,
  );
  const features = computeFeatures({
    t: grid.t,
    g: grid.g,
    mask: grid.mask,
    endAt: c.endAt,
    finalYieldG: c.finalYieldG,
    firstDripKnown: true,
    roastLevel: w.roast,
  });
  return {
    t: c.t,
    g: c.g,
    endAt: c.endAt,
    finalYieldG: c.finalYieldG,
    yTrue,
    yObs,
    channel,
    grid,
    features,
  };
}

export interface DemoTasting {
  vs: VsPrevious | null;
  sourBitter: SliderValue;
  thinHeavy: SliderValue;
  chips: Chip[];
  overall: number;
}

function slider(v: number): SliderValue {
  // `|| 0` turns −0 into 0 (a rating of −0 would read as a negative slider).
  return (Math.max(-3, Math.min(3, Math.round(v))) || 0) as SliderValue;
}

function utility(offset: number): number {
  return -(offset ** 2) / (2 * UTILITY_W ** 2);
}

/** Overall cup utility: sour–bitter balance at this RPM plus body. */
function cupUtility(w: DemoWorld, y: number, ratio: number, rpm: number): number {
  return utility(perceivedOffset(w, y, ratio, rpm)) - bodyRegret(w, rpm);
}

/** How the simulated you tastes a cup (and compares it with the previous one). */
export function tasteDemoShot(
  w: DemoWorld,
  cur: { y: number; ratio: number; rpm: number; channel: boolean },
  prev: { y: number; ratio: number; rpm?: number } | null,
  rng: Rng,
): DemoTasting {
  const off = perceivedOffset(w, cur.y, cur.ratio, cur.rpm);
  let vs: VsPrevious | null = null;
  if (prev) {
    const d =
      cupUtility(w, cur.y, cur.ratio, cur.rpm) -
      cupUtility(w, prev.y, prev.ratio, prev.rpm ?? cur.rpm) +
      w.tasteNoise * randn(rng);
    vs = d > JND ? 'better' : d < -JND ? 'worse' : 'same';
  }
  const chips: Chip[] = [];
  if (cur.channel) chips.push(rng() < 0.7 ? 'channelled' : 'astringent');
  else if (Math.abs(off) < 0.05 && rng() < 0.5) chips.push('balanced');
  const overall = Math.max(
    1,
    Math.min(
      9,
      Math.round(8 - 12 * Math.abs(off) - 3 * bodyRegret(w, cur.rpm) - (cur.channel ? 2 : 0)),
    ),
  );
  return {
    vs,
    // Under-extracted (off > 0) reads sour, which is the negative end of the slider.
    sourBitter: slider((-3 * off) / SLIDER_SCALE + w.tasteNoise * randn(rng)),
    thinHeavy: slider(w.betaBody * (uOf(cur.rpm) - uOf(w.rpmStar)) + w.tasteNoise * randn(rng)),
    chips,
    overall,
  };
}
