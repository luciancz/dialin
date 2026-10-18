/** Taste oracle: better/same/worse from the true optimum, slider from the true offset, chips from channeling. */
import { type Rng, randn } from '../math/rng';
import { SETPOINT, SIM } from '../params';
import type { Chip, SliderValue, VsPrevious } from '../types';
import { perceivedOffset, type Truth } from './truth';

function utilityTrue(offset: number): number {
  return -(offset ** 2) / (2 * SETPOINT.utilityW ** 2);
}

export function tasteVs(
  t: Truth,
  prev: { y: number; ratio: number },
  cur: { y: number; ratio: number },
  rng: Rng,
): VsPrevious {
  if (rng() < t.lapse) {
    const u = rng();
    return u < 1 / 3 ? 'better' : u < 2 / 3 ? 'same' : 'worse';
  }
  const d =
    utilityTrue(perceivedOffset(t, cur.y, cur.ratio)) -
    utilityTrue(perceivedOffset(t, prev.y, prev.ratio)) +
    t.tau * randn(rng);
  if (d > SETPOINT.jnd) return 'better';
  if (d < -SETPOINT.jnd) return 'worse';
  return 'same';
}

function clampSlider(v: number): SliderValue {
  return Math.max(-3, Math.min(3, Math.round(v))) as SliderValue;
}

/** Faster than the optimum (y > s*) tastes sour (negative), slower tastes bitter. */
export function tasteSlider(t: Truth, y: number, ratio: number, rng: Rng): SliderValue {
  const base = (3 * perceivedOffset(t, y, ratio)) / SIM.sliderScale;
  const noise = rng() < 0.3 ? (rng() < 0.5 ? -1 : 1) : 0;
  return clampSlider(base + noise);
}

export function tasteThinHeavy(t: Truth, rng: Rng): SliderValue {
  const base = t.rpmTexture === 'thin' ? -2 : t.rpmTexture === 'heavy' ? 2 : 0;
  const noise = rng() < 0.3 ? (rng() < 0.5 ? -1 : 1) : 0;
  return clampSlider(base + noise);
}

export function tasteChips(channel: boolean, rng: Rng): Chip[] {
  if (channel) return rng() < 0.6 ? ['channelled'] : ['astringent'];
  return rng() < 0.3 ? ['balanced'] : [];
}
