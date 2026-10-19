/** Taste oracle: better/same/worse from the true optimum, slider from the true offset, chips from channeling. */
import { type Rng, randn } from '../math/rng';
import { SETPOINT, SIM } from '../params';
import type { Chip, SliderValue, VsPrevious } from '../types';
import { bodyUtility, perceivedOffset, type Truth } from './truth';

function utilityTrue(offset: number): number {
  return -(offset ** 2) / (2 * SETPOINT.utilityW ** 2);
}

/** Overall cup utility: balance (flow vs the balanced flow at this ratio and RPM) plus body. */
function cupUtility(t: Truth, c: { y: number; ratio: number; rpm?: number }): number {
  const rpm = c.rpm ?? 1000;
  return utilityTrue(perceivedOffset(t, c.y, c.ratio, rpm)) + bodyUtility(t, rpm);
}

export function tasteVs(
  t: Truth,
  prev: { y: number; ratio: number; rpm?: number },
  cur: { y: number; ratio: number; rpm?: number },
  rng: Rng,
): VsPrevious {
  if (rng() < t.lapse) {
    const u = rng();
    return u < 1 / 3 ? 'better' : u < 2 / 3 ? 'same' : 'worse';
  }
  const d = cupUtility(t, cur) - cupUtility(t, prev) + t.tau * randn(rng);
  if (d > SETPOINT.jnd) return 'better';
  if (d < -SETPOINT.jnd) return 'worse';
  return 'same';
}

function clampSlider(v: number): SliderValue {
  // `|| 0` turns −0 into 0 (a rating of −0 would read as a negative slider).
  return (Math.max(-3, Math.min(3, Math.round(v))) || 0) as SliderValue;
}

/** Faster than the optimum (y > s*) tastes sour (negative), slower tastes bitter. */
export function tasteSlider(t: Truth, y: number, ratio: number, rng: Rng, rpm = 1000): SliderValue {
  const base = (3 * perceivedOffset(t, y, ratio, rpm)) / SIM.sliderScale;
  const noise = rng() < 0.3 ? (rng() < 0.5 ? -1 : 1) : 0;
  return clampSlider(base + noise);
}

/** Body: heavier above the preferred RPM when β > 0, h = round(β·(u − θ_u) + 0.8·N(0, 1)). */
export function tasteThinHeavy(t: Truth, rng: Rng, rpm = 1000): SliderValue {
  return clampSlider(t.betaBody * ((rpm - t.thetaRpm) / 100) + 0.8 * randn(rng));
}

export function tasteChips(channel: boolean, rng: Rng): Chip[] {
  if (channel) return rng() < 0.6 ? ['channelled'] : ['astringent'];
  return rng() < 0.3 ? ['balanced'] : [];
}
