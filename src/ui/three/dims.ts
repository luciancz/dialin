/**
 * Real dimensions (mm) the 3D models are built from. Sources (2026-10-19):
 * - Varia VS6: 191.6 × 130.0 × 403.7 mm (L × W × H), 10.7 kg, 58 mm magnetic dosing cup
 *   (holds 35 g), hopper 80 g that turns to set the grind — crema.fi product page,
 *   dailycoffeenews.com (2024-07-25).
 * - Lelit Mara X V1 (PL62X): ≈ 220 × 410 × 350 mm (W × D × H); retailers list the width as
 *   200–270 mm, so the width is the least certain figure. E61-style 58 mm group, twin gauges,
 *   drip tray with grate, cup-warmer rail — espressocoffeeshop.com, wholelattelove.com.
 * - Bookoo Themis Mini: a small square scale, modelled at 100 × 100 × 22 mm.
 * Shapes follow product photos; there is no logo artwork.
 */
export const VS6 = {
  depth: 191.6,
  width: 130.0,
  height: 403.7,
  baseH: 16,
  /** Column (behind the cup bay). */
  columnDepth: 112,
  /** Burr housing and hopper on top. */
  headR: 62,
  headH: 64,
  hopperR: 57,
  hopperH: 26,
  /** Chute exit height above the table, and its forward offset from the centre. */
  chuteY: 150,
  chuteZ: 48,
  /** 58 mm dosing cup. */
  cupInnerR: 29,
  cupOuterR: 31.5,
  cupH: 52,
  cupCapacityG: 35,
} as const;

export const MARAX = {
  width: 220,
  depth: 410,
  height: 350,
  feetH: 18,
  /** Group head centre above the table and forward of the front face. */
  groupY: 238,
  groupOut: 62,
  /** Spout outlets below the portafilter. */
  spoutY: 150,
  spoutGap: 22,
  trayH: 26,
  trayDepth: 120,
} as const;

export const THEMIS = {
  size: 100,
  height: 22,
} as const;

/** Glass espresso cup on the scale. */
export const CUP = {
  innerR: 31,
  outerR: 34,
  height: 72,
  baseT: 6,
} as const;
