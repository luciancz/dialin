/** Stage derivation (never persisted) and the roast groups used by the ratio rules. */
import { MODEL, RULES } from '../params';
import type { RoastLevel, Stage } from '../types';

export type RoastGroup = 'light' | 'medium' | 'dark';

export function roastGroup(r: RoastLevel): RoastGroup {
  if (r === 'light' || r === 'medium_light') return 'light';
  if (r === 'dark' || r === 'medium_dark') return 'dark';
  return 'medium';
}

export function ratioBounds(r: RoastLevel): { cap: number; floor: number } {
  const g = roastGroup(r);
  return { cap: RULES.ratioCap[g], floor: RULES.ratioFloor[g] };
}

export function freshnessGateDays(r: RoastLevel): number {
  return RULES.freshnessDays[r];
}

export interface StageFacts {
  /** |ŷ_cur − s*| */
  offBand: number;
  kGrindSd: number;
  /** Learnable shots whose pre-observation prediction was within β of s*. */
  predictedInBand: number;
  setpointSd: number;
}

/** B while off band or the gain is unsure; C once two shots were predicted in band; D once σ_s ≤ 0.10. */
export function deriveStage(f: StageFacts): Stage {
  if (f.offBand > RULES.beta || f.kGrindSd > MODEL.kGrindSdConverged) return 'B_grind';
  if (f.predictedInBand < 2) return 'B_grind';
  if (f.setpointSd <= RULES.setpointSdRoute) return 'D_hone';
  return 'C_ratio';
}

/** Routing band: wide while the taste setpoint is still fuzzy. */
export function activeBand(setpointSd: number): number {
  return setpointSd > RULES.setpointSdRoute ? RULES.betaRoute : RULES.beta;
}
