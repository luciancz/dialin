import { describe, expect, it } from 'vitest';
import { DEFAULT_DIAL_SPEC } from '../../src/core/units';
import {
  approach,
  beanCount,
  brewPressureBar,
  cremaFraction,
  grindRateGps,
  hopperAngle,
  liquidHeightMm,
  pumpNeedleAngle,
  steamBarAt,
  steamNeedleAngle,
  streamRadiusMm,
} from '../../src/ui/three/anim';

describe('3D animation math', () => {
  it('streams thicken with flow (√flow) and vanish when it stops', () => {
    expect(streamRadiusMm(0)).toBe(0);
    expect(streamRadiusMm(Number.NaN)).toBe(0);
    expect(streamRadiusMm(2)).toBeCloseTo(1.6, 6);
    expect(streamRadiusMm(4) / streamRadiusMm(1)).toBeCloseTo(2, 6);
    expect(streamRadiusMm(0.05)).toBeGreaterThanOrEqual(0.35);
    expect(streamRadiusMm(50)).toBe(3.2);
  });

  it('the cup fills by volume and never overflows the model', () => {
    // 36 g in a 31 mm cup: 36 ml / (π·3.1² cm²) ≈ 1.19 cm.
    expect(liquidHeightMm(36, 31, 66)).toBeCloseTo(11.92, 1);
    expect(liquidHeightMm(0, 31, 66)).toBe(0);
    expect(liquidHeightMm(5000, 31, 66)).toBe(66);
    expect(cremaFraction(5)).toBeGreaterThan(cremaFraction(36));
    expect(cremaFraction(100)).toBe(0.1);
  });

  it('the hopper turns one full revolution per 100 lines and repeats each revolution', () => {
    const a = hopperAngle({ rev: 1, number: 0, line: 0 }, DEFAULT_DIAL_SPEC);
    const b = hopperAngle({ rev: 1, number: 5, line: 0 }, DEFAULT_DIAL_SPEC);
    const c = hopperAngle({ rev: 2, number: 5, line: 0 }, DEFAULT_DIAL_SPEC);
    expect(a).toBe(0);
    expect(b).toBeCloseTo(Math.PI, 9);
    expect(c).toBeCloseTo(b, 9);
  });

  it('gauges, pressure ramp, grind rate, beans and smoothing', () => {
    // Dual gauge: both needles rest at nine o'clock; steam goes over the top, pump under.
    expect(steamNeedleAngle(0)).toBeCloseTo(Math.PI, 9);
    expect(steamNeedleAngle(1.5)).toBeCloseTo(Math.PI / 2, 9); // straight up
    expect(steamNeedleAngle(9)).toBeCloseTo(0, 9);
    expect(pumpNeedleAngle(0)).toBeCloseTo(Math.PI, 9);
    expect(pumpNeedleAngle(8)).toBeCloseTo(1.5 * Math.PI, 9); // straight down
    expect(pumpNeedleAngle(16)).toBeCloseTo(2 * Math.PI, 9);
    expect(steamBarAt(2)).toBeGreaterThan(steamBarAt(0));
    expect(brewPressureBar(10, true)).toBe(9);
    expect(brewPressureBar(10, false)).toBe(0);
    expect(brewPressureBar(2, true)).toBeLessThan(brewPressureBar(6, true));
    expect(grindRateGps(1000)).toBeCloseTo(1.6, 9);
    expect(grindRateGps(500)).toBeCloseTo(0.8, 9);
    expect(grindRateGps(100)).toBe(0.6);
    expect(beanCount(18)).toBe(129);
    expect(beanCount(100)).toBe(260);
    expect(approach(0, 10, 1, 0)).toBe(10);
    expect(approach(0, 10, 0.1, 1)).toBeGreaterThan(0);
    expect(approach(0, 10, 0.1, 1)).toBeLessThan(10);
  });
});
