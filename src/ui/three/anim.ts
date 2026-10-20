/**
 * Animation math for the 3D views, kept free of three.js so the node-only tests can check it.
 * Lengths in mm, mass in g, flow in g/s.
 */
import type { DialPosition, DialSpec } from '../../core/types';
import { toLines } from '../../core/units';

/** Espresso is ≈ 1 g/ml; crema makes the column look taller. */
const ESPRESSO_G_PER_ML = 1.0;

/**
 * Radius of one of the two spout streams for a total flow (g/s). A free-falling stream of
 * cross-section A at speed v carries ρ·A·v; v ≈ √(2·g·h) over the last few cm, so the radius
 * goes as √flow. Calibrated so 2 g/s reads as two ≈ 1.6 mm streams; clamped to stay visible.
 */
export function streamRadiusMm(flowGps: number): number {
  if (!(flowGps > 0.02)) return 0;
  const perStream = flowGps / 2;
  return Math.min(3.2, Math.max(0.35, 1.6 * Math.sqrt(perStream / 1)));
}

/** Liquid height (mm) in a cylindrical cup of inner radius r for `grams` of espresso. */
export function liquidHeightMm(grams: number, innerR: number, maxH: number): number {
  if (!(grams > 0)) return 0;
  const ml = grams / ESPRESSO_G_PER_ML;
  const h = (ml * 1000) / (Math.PI * innerR * innerR);
  return Math.min(maxH, h);
}

/** Crema share of the column: thick early in the shot, settling to ≈ 10 %. */
export function cremaFraction(grams: number): number {
  if (!(grams > 0)) return 0;
  return Math.max(0.1, 0.45 - 0.012 * grams);
}

/**
 * Hopper rotation (radians about the vertical axis) that brings the marking for `pos` to the
 * index at the front. The VS6 is turned clockwise (seen from above) to go coarser, so a
 * higher line count rotates the ring the other way to bring its mark round to the index.
 */
export function hopperAngle(pos: DialPosition, spec: DialSpec): number {
  const perRev = spec.numbersPerRev * spec.linesPerNumber;
  const lines = toLines(pos, spec);
  const frac = (((lines % perRev) + perRev) % perRev) / perRev;
  return frac * 2 * Math.PI;
}

/**
 * Needle angles on the Mara X dual gauge (three.js, counter-clockwise from +x, the needle
 * modelled pointing along +x): both scales start at nine o'clock; steam (0–3 bar) sweeps
 * clockwise over the top to three o'clock, pump (0–16 bar) counter-clockwise under the bottom.
 */
export function steamNeedleAngle(bar: number): number {
  const f = Math.max(0, Math.min(1, bar / 3));
  return Math.PI - f * Math.PI;
}

export function pumpNeedleAngle(bar: number): number {
  const f = Math.max(0, Math.min(1, bar / 16));
  return Math.PI + f * Math.PI;
}

/** Heat-exchanger boiler pressure at the temperature switch (0 / I / II ≈ 0.9 / 1.1 / 1.4 bar). */
export function steamBarAt(tempSwitch: 0 | 1 | 2): number {
  return tempSwitch === 0 ? 0.9 : tempSwitch === 1 ? 1.1 : 1.4;
}

/** Brew pressure shown on the gauge t seconds into the pull (E61 pre-infusion, then ≈ 9 bar). */
export function brewPressureBar(tS: number, running: boolean): number {
  if (!running) return 0;
  if (tS < 0) return 0;
  if (tS < 4) return 1.5 + (tS / 4) * 2;
  if (tS < 7) return 3.5 + ((tS - 4) / 3) * 5.5;
  return 9;
}

/**
 * Grinding rate (g/s) on the VS6 by RPM: about 1.6 g/s at 1000 RPM, roughly in proportion to
 * speed (single-dose flat burrs), never below 0.6 g/s.
 */
export function grindRateGps(rpm: number): number {
  return Math.max(0.6, 1.6 * (rpm / 1000));
}

/** Coffee beans visible in a dosing cup for `grams` (≈ 0.14 g per bean), capped for speed. */
export function beanCount(grams: number, cap = 260): number {
  if (!(grams > 0)) return 0;
  return Math.min(cap, Math.round(grams / 0.14));
}

/** Smoothly move `cur` toward `target` with time constant `tauS` over `dtS`. */
export function approach(cur: number, target: number, dtS: number, tauS: number): number {
  if (tauS <= 0) return target;
  const k = 1 - Math.exp(-dtS / tauS);
  return cur + (target - cur) * k;
}
