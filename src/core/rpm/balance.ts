/**
 * Balance shift δ: how the balanced (taste-setpoint) flow moves with RPM, per calibration epoch:
 *   s*(rpm) = s* + δ·u,  u = (RPM − 1000)/100,  δ ~ N(0, 0.02²) per 100 RPM.
 * Evidence: Mythos 2 data shows lower RPM extracting more at the same shot time; other matched-
 * flow tests find no difference, hence the shrinkage prior.
 *
 * Observation from two rated shots of the same bag at different RPMs (app convention: a shot
 * faster than balanced reads sour, i.e. negative): v ≈ c·(s*(u) − y), c slider steps per ln.
 *   z = (v_j − v_i)/c + (y_j − y_i) ~ N(δ·(u_j − u_i), 2σ_v²/c²)
 */
import { RPM } from '../params';

export interface Balance {
  mean: number;
  variance: number;
  /** Pairs absorbed. */
  n: number;
}

/** Slider noise (steps) in the δ observation model. */
const SLIDER_NOISE = 1;

export function initBalance(): Balance {
  return { mean: 0, variance: RPM.deltaPriorSd ** 2, n: 0 };
}

export interface BalancePair {
  uI: number;
  uJ: number;
  vI: number;
  vJ: number;
  yI: number;
  yJ: number;
}

/** Scalar Kalman update from one matched pair. */
export function updateBalance(b: Balance, p: BalancePair): Balance {
  const du = p.uJ - p.uI;
  if (Math.abs(du) < 1) return b;
  const c = RPM.sliderPerLn;
  const z = (p.vJ - p.vI) / c + (p.yJ - p.yI);
  const R = (2 * SLIDER_NOISE ** 2) / (c * c);
  const S = du * du * b.variance + R;
  const K = (b.variance * du) / S;
  return { mean: b.mean + K * (z - du * b.mean), variance: (1 - K * du) * b.variance, n: b.n + 1 };
}

export function balanceSd(b: Balance): number {
  return Math.sqrt(Math.max(0, b.variance));
}

/** Balanced flow at RPM u from the reference-RPM setpoint mean. */
export function sStarAt(setpointMean: number, b: Balance, u: number): number {
  return setpointMean + b.mean * u;
}

/** Flow referenced to 1000 RPM for the setpoint layer: y_ref = y − δ̂·u. */
export function yRef(y: number, b: Balance, u: number): number {
  return y - b.mean * u;
}

/** Extra slider-likelihood width from the uncertain shift at RPM u: sd(δ)·|u|. */
export function refSd(b: Balance, u: number): number {
  return balanceSd(b) * Math.abs(u);
}
