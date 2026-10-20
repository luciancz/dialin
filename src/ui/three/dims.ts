/**
 * Real dimensions (mm) the 3D models are built from. Published figures first, then estimates
 * from photos and drawings (marked ≈). Sources (2026-10-20):
 * - Varia VS6: 191.6 × 130.0 × 403.7 mm (D × W × H), 10.7 kg — variabrewing.com product page,
 *   Whole Latte Love (W 5.1", D 7.5"). The body leans forward 13.5° (76.5° to the table) —
 *   kaffeemacher.de. A C-shaped frame of square-section blocks: a level base with the cup
 *   seat and the RPM knob on its right side, a column at the back, a head over the cup with
 *   the RPM display on its top face; on top a stepped index collar, the hopper with the scale
 *   and a feed ring with six screws. The proportions (≈) come from Varia's product photos,
 *   scaled by the 58 mm cup rim and the head width.
 * - Lelit Mara X V1 (PL62X): 220–225 × 410 × 350–355 mm (W × D × H), 18.5 kg — lelit.com,
 *   CoffeeGeek, Seattle Coffee Gear (8.7" × 16.25" × 13.75"); 52 cm deep with the portafilter.
 *   Layout from Lelit's V1 manual (EN/7800052 REV01, Pic 4): one dual gauge (steam 0–3 bar,
 *   pump 0–16 bar, MC593, 65 mm) left of the group, six-lobed knobs on valve bodies at the
 *   top front corners (steam left, hot water right), the brew lever on the right of the group
 *   (hangs down, lifts towards you), the lit round I/O button and the red LELIT badge under
 *   the gauge, the 0/I/II rocker in the drip-tray bay, a wire cup grate and the tank lid on
 *   top. Drip tray ≈ 210 deep (Lelit part 1000201); cup clearance ≈ 114 mm (SCG).
 * - Portafilter: the owner's Normcore 58 mm All Stainless Steel Bottomless (unibody handle,
 *   180° lay-flat base; ≈ 225 × 80 × 30 mm — Normcore's listing and product photos). The
 *   handle is a straight polished bar, ≈ 21 mm square with rounded edges, its underside level
 *   with the ring's base; a thin neck plate joins it to the ring. No spout: the coffee leaves
 *   the basket's perforated bottom as one stream.
 * - Bookoo Themis Mini: a small square scale, modelled at 100 × 100 × 22 mm.
 */
export const VS6 = {
  depth: 191.6,
  width: 130.0,
  height: 403.7,
  /** Body (base, column, head) width; the RPM knob makes up the rest of the 130 mm. */
  bodyW: 116,
  leanDeg: 13.5,
  /** Rubber pads under the base, then the level base block. */
  feetH: 1.5,
  baseH: 42,
  baseD: 190,
  /** Column depth and head depth across the lean; the head's top and bottom along the lean. */
  columnD: 72,
  headD: 124,
  headTopS: 281,
  headH: 98,
  /** Stepped index collar, the hopper's scale band and the feed ring on top. */
  collarR: 48.5,
  collarH: 12,
  hopperR: 44,
  hopperH: 58,
  feedR: 45.5,
  feedH: 17,
  throatR: 21,
  /** RPM / power knob on the right side of the base. */
  knobR: 14.5,
  knobOut: 14,
  /** Vertical chute tube and the cup under it (z from the base centre). */
  chuteR: 14,
  cupZ: 38,
  /** Dosing cup: 58 mm portafilter rim, magnetic, ≈ 35 g. */
  cupOuterR: 30,
  cupLipR: 28.5,
  cupInnerR: 26.5,
  cupH: 78,
  cupFloor: 4,
  cupCapacityG: 35,
  seatR: 33,
} as const;

export const MARAX = {
  width: 220,
  height: 355,
  /** Body shell depth; the drip tray adds ≈ 115 mm in front. */
  shellD: 300,
  feetH: 11,
  /** Drip-tray bay: its roof above the table and its back wall behind the front panel. */
  bayTop: 78,
  bayDepth: 100,
  /** Drip tray: top of the grate rods, depth, and how far it reaches past the front panel. */
  trayTop: 59,
  trayD: 213,
  trayOut: 115,
  /** E61-style group: axis in front of the panel, the gasket plane and the cap top. */
  groupOut: 70,
  gasketY: 205,
  capTopY: 330,
  collarR: 48,
  /** Normcore bottomless: the ring's radius and height, and where the basket bottom sits. */
  pfRingR: 36.5,
  pfH: 30,
  basketBottomY: 178,
  /** Dual gauge (65 mm) and the corner valves (knob axes ≈ 15 mm in from the sides). */
  gaugeR: 32.5,
  gauge: [-60, 207] as const,
  valveX: 95,
  valveY: 300,
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
