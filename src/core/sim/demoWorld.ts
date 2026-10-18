/**
 * Demo world: a hidden "true" grinder, machine and palate for the simulation mode.
 * Pure and seeded (no DOM, no clock). The app's demo controller (src/app/demo.ts) keeps one
 * world per demo database and turns its simulated shots into ordinary rows, so the real
 * features → flow model → setpoint → rules → recommendation path runs unchanged.
 *
 * Hidden truth:
 *   ln plateau flow  y = a + k_g·(L − L0) + k_r·(RPM − 1000)/100 + k_d·(dose − dose0)
 *   balanced flow    s(ratio) = s* − κ·(r* − ratio)      (a longer ratio tolerates a faster shot)
 *   taste            faster than balanced or a shorter ratio = under-extracted = sour;
 *                    slower or longer = over-extracted = bitter (the app's convention)
 *   body             thin below rpm*, heavy above it
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
  version: 1;
  seed: number;
  shotCount: number;
  roast: RoastLevel;
  /** ln plateau flow per dial line (higher dial = coarser = faster). */
  kG: number;
  /** ln flow per 100 RPM. */
  kR: number;
  /** ln flow per gram of dose. */
  kD: number;
  /** Reference line (the "usual" dial) and the true ln flow there at 1000 RPM, default dose. */
  L0: number;
  a: number;
  /** ln plateau flow that tastes balanced at the optimal ratio r*. */
  sStar: number;
  rStar: number;
  /** RPM that gives the preferred body. */
  rpmStar: number;
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
  return {
    version: 1,
    seed: o.seed >>> 0,
    shotCount: 0,
    roast,
    kG: uniform(rng, 0.03, 0.07),
    kR: uniform(rng, -0.06, 0.06),
    kD: uniform(rng, -0.08, -0.04),
    L0: o.L0,
    a: mu0 + 0.25 * randn(rng),
    sStar: mu0 + 0.12 * randn(rng),
    rStar: 2.3 + 0.2 * randn(rng),
    rpmStar: Math.round(uniform(rng, 800, 1200) / 100) * 100,
    channelProb: o.channelProb ?? 0.15,
    tasteNoise: o.tasteNoise ?? 0.4,
    doseDefaultG: o.doseDefaultG ?? 18,
  };
}

export function ratioOf(s: ShotSettings): number {
  return s.targetYieldG / Math.max(1, s.doseG);
}

/** Noise-free ln plateau flow at the settings. */
export function trueLnFlow(w: DemoWorld, s: ShotSettings, spec: DialSpec): number {
  const L = toLines(s.grind.dialPos, spec);
  return (
    w.a +
    w.kG * (L - w.L0) +
    w.kR * ((s.grind.rpm - 1000) / 100) +
    w.kD * (s.doseG - w.doseDefaultG)
  );
}

/** ln plateau flow that tastes balanced at this ratio. */
export function balancedLnFlow(w: DemoWorld, ratio: number): number {
  return w.sStar - KAPPA_RATIO * (w.rStar - ratio);
}

/**
 * Under-extraction score: positive = faster than balanced for this ratio (or the ratio is too
 * short) = sour; negative = bitter. Same convention as the app (sour → grind finer).
 */
export function perceivedOffset(w: DemoWorld, y: number, ratio: number): number {
  return y - balancedLnFlow(w, ratio);
}

/** The (fractional) dial line that would taste balanced at these RPM, dose and ratio. */
export function bestLines(w: DemoWorld, s: ShotSettings): number {
  const target = balancedLnFlow(w, ratioOf(s));
  const u = (s.grind.rpm - 1000) / 100;
  const d = s.doseG - w.doseDefaultG;
  return w.L0 + (target - w.a - w.kR * u - w.kD * d) / w.kG;
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
  return Math.max(-3, Math.min(3, Math.round(v))) as SliderValue;
}

function utility(offset: number): number {
  return -(offset ** 2) / (2 * UTILITY_W ** 2);
}

/** How the simulated you tastes a cup (and compares it with the previous one). */
export function tasteDemoShot(
  w: DemoWorld,
  cur: { y: number; ratio: number; rpm: number; channel: boolean },
  prev: { y: number; ratio: number } | null,
  rng: Rng,
): DemoTasting {
  const off = perceivedOffset(w, cur.y, cur.ratio);
  let vs: VsPrevious | null = null;
  if (prev) {
    const d =
      utility(off) - utility(perceivedOffset(w, prev.y, prev.ratio)) + w.tasteNoise * randn(rng);
    vs = d > JND ? 'better' : d < -JND ? 'worse' : 'same';
  }
  const chips: Chip[] = [];
  if (cur.channel) chips.push(rng() < 0.7 ? 'channelled' : 'astringent');
  else if (Math.abs(off) < 0.05 && rng() < 0.5) chips.push('balanced');
  const overall = Math.max(
    1,
    Math.min(9, Math.round(8 - 12 * Math.abs(off) - (cur.channel ? 2 : 0))),
  );
  return {
    vs,
    // Under-extracted (off > 0) reads sour, which is the negative end of the slider.
    sourBitter: slider((-3 * off) / SLIDER_SCALE + w.tasteNoise * randn(rng)),
    thinHeavy: slider((cur.rpm - w.rpmStar) / 100 + w.tasteNoise * randn(rng)),
    chips,
    overall,
  };
}
