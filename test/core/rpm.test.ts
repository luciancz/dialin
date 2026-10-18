import { describe, expect, it } from 'vitest';
import {
  allowedRpmRange,
  clampRpm,
  e006Guidance,
  quantRpm,
  settingsRange,
  uOf,
} from '../../src/core/rpm/range';

describe('RPM range and E006', () => {
  it('quantises to the VS6 100 RPM step and clamps to the range', () => {
    expect(quantRpm(1249)).toBe(1200);
    expect(quantRpm(1250)).toBe(1300);
    expect(clampRpm(450, [500, 1600])).toBe(500);
    expect(clampRpm(1720, [500, 1600])).toBe(1600);
    expect(uOf(1300)).toBe(3);
  });

  it('sanitises the settings range to the hardware limits', () => {
    expect(settingsRange(undefined)).toEqual([500, 1600]);
    expect(settingsRange([400, 2000])).toEqual([500, 1600]);
    expect(settingsRange([740, 1260])).toEqual([700, 1300]);
    expect(settingsRange([1400, 800])).toEqual([500, 1600]);
  });

  it('raises the floor above reported stalls for that bean', () => {
    expect(allowedRpmRange([500, 1600], [])).toEqual([500, 1600]);
    expect(
      allowedRpmRange([500, 1600], [{ stalls: [{ at: 'x', rpm: 600 }] }, { stalls: [] }]),
    ).toEqual([700, 1600]);
    expect(allowedRpmRange([500, 1000], [{ stalls: [{ at: 'x', rpm: 1100 }] }])).toEqual([
      1000, 1000,
    ]);
  });

  it('gives E006 guidance at 600 RPM and below only', () => {
    expect(e006Guidance(600).length).toBeGreaterThan(0);
    expect(e006Guidance(500)[0]).toMatch(/start the motor/);
    expect(e006Guidance(700)).toEqual([]);
  });
});
