/**
 * Rule table (plan "Rule layer"), evaluated top to bottom; the first matching row wins.
 * Pure: takes the facts the arbitration layer computed and returns the lever decision.
 */
import { MODEL, RULES } from '../params';
import type { Chip, Lever, SliderValue, VsPrevious } from '../types';
import { ratioBounds } from './stages';

export interface RuleShot {
  y: number | null;
  learn: boolean;
  channelFlag: boolean;
  predictedY: number | null;
  skipped: boolean;
  r: number | null;
  rating: {
    vs: VsPrevious | null;
    v: SliderValue | null;
    h: SliderValue | null;
    chips: Chip[];
  } | null;
  rpm: number;
  inBandAtRating: boolean;
}

export interface RuleFacts {
  shots: RuleShot[];
  /** ŷ at the current settings and the setpoint summary. */
  yHatCur: number | null;
  sStar: number;
  setpointSd: number;
  betaB: number;
  kGrindSd: number;
  ageDays: number;
  gateDays: number;
  roastLevel: Parameters<typeof ratioBounds>[0];
  doseG: number;
  targetYieldG: number;
  rpm: number;
  shotsSinceRpmChange: number;
  allowLowRpm: boolean;
  tempCardShown: boolean;
  /** Last shot skipped as an outlier and not yet re-anchored. */
  outlierPending: boolean;
  learnableCount: number;
}

export type RuleDecision =
  | { row: 1; lever: 'prep'; signs: string[] }
  | { row: 2; lever: 'wait' | 'grind'; halfStep: boolean }
  | { row: 3; lever: 'none'; reason: 'outlier' }
  | { row: 4; lever: 'grind'; target: number }
  | { row: 5 | 7; lever: 'yield'; newYieldG: number; taste: 'sour' | 'bitter' }
  | { row: 6 | 8; lever: 'grind'; target: number; taste: 'sour' | 'bitter' }
  | { row: 9; lever: 'rpm'; newRpm: number; texture: 'thin' | 'heavy'; k: number }
  | { row: 10; lever: 'temperature'; taste: 'sour' | 'bitter'; k: number; n: number }
  | { row: 11; lever: 'none'; reason: 'dialled_in' }
  | { row: 12; lever: 'grind'; target: 'setpoint_search' };

export function lastRated(shots: RuleShot[]): RuleShot | null {
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    if (s?.rating) return s;
  }
  return null;
}

export function evaluateRules(f: RuleFacts): { decision: RuleDecision; whyNot: string[] } {
  const whyNot: string[] = [];
  const last = f.shots[f.shots.length - 1] ?? null;
  const lastRating = last?.rating ?? null;
  const chips = lastRating?.chips ?? [];
  const off = f.yHatCur === null ? Number.POSITIVE_INFINITY : f.yHatCur - f.sStar;
  const inBand = Math.abs(off) <= f.betaB;
  const { cap, floor } = ratioBounds(f.roastLevel);
  const ratio = f.targetYieldG / Math.max(1, f.doseG);

  // 1. Channeling on the last shot.
  if (
    last &&
    (last.channelFlag ||
      chips.includes('channelled') ||
      (chips.includes('astringent') && chips.includes('harsh')))
  ) {
    const signs: string[] = [];
    if (last.channelFlag) signs.push('spike or dips in the flow');
    if (chips.includes('channelled')) signs.push('the channelled chip');
    if (chips.includes('astringent')) signs.push('astringency');
    return { decision: { row: 1, lever: 'prep', signs }, whyNot };
  }
  whyNot.push('not prep: no channeling signs on the last shot');

  // 2. Freshness gate.
  if (f.ageDays < f.gateDays) {
    const far = Math.abs(off) > RULES.freshnessOverrideLn;
    return { decision: { row: 2, lever: far ? 'grind' : 'wait', halfStep: true }, whyNot };
  }

  // 3. Outlier pending.
  if (f.outlierPending) return { decision: { row: 3, lever: 'none', reason: 'outlier' }, whyNot };

  // 4. Off band: grind to the setpoint.
  if (!inBand) {
    whyNot.push(`not yield: flow is ${(Math.abs(off) * 100).toFixed(0)} % off band`);
    return { decision: { row: 4, lever: 'grind', target: f.sStar }, whyNot };
  }
  whyNot.push('not grind to band: predicted flow is in band');

  // 5–8. Taste in band: ratio first, then nudge the setpoint.
  const v = lastRating?.v ?? null;
  if (v !== null && v <= -1) {
    if (ratio < cap - 1e-9) {
      const step = v <= -2 ? RULES.yieldBigStepG : RULES.yieldStepG;
      const newYield = Math.min(f.doseG * cap, f.targetYieldG + step);
      return { decision: { row: 5, lever: 'yield', newYieldG: newYield, taste: 'sour' }, whyNot };
    }
    whyNot.push(`not yield: ratio already at the ${cap.toFixed(1)} cap`);
    return {
      decision: {
        row: 6,
        lever: 'grind',
        target: Math.min(f.sStar, (f.yHatCur ?? f.sStar) - RULES.beta),
        taste: 'sour',
      },
      whyNot,
    };
  }
  if (v !== null && v >= 1) {
    if (ratio > floor + 1e-9) {
      const step = v >= 2 ? RULES.yieldBigStepG : RULES.yieldStepG;
      const newYield = Math.max(f.doseG * floor, f.targetYieldG - step);
      return { decision: { row: 7, lever: 'yield', newYieldG: newYield, taste: 'bitter' }, whyNot };
    }
    whyNot.push(`not yield: ratio already at the ${floor.toFixed(1)} floor`);
    return {
      decision: {
        row: 8,
        lever: 'grind',
        target: Math.max(f.sStar, (f.yHatCur ?? f.sStar) + RULES.beta),
        taste: 'bitter',
      },
      whyNot,
    };
  }
  whyNot.push(
    v === null ? 'not yield: last shot unrated or slider at 0' : 'not yield: slider at 0',
  );

  // 9. RPM as the texture lever.
  const last3 = f.shots.filter((s) => s.learn).slice(-3);
  const converged =
    last3.filter((s) => s.predictedY !== null && Math.abs(s.predictedY - f.sStar) <= RULES.beta)
      .length >= 2;
  const rated3 = f.shots.filter((s) => s.rating).slice(-3);
  const thin = rated3.filter(
    (s) => (s.rating?.h ?? 0) <= -RULES.rpmTextureSlider || s.rating?.chips.includes('hollow'),
  ).length;
  const heavy = rated3.filter((s) => (s.rating?.h ?? 0) >= RULES.rpmTextureSlider).length;
  if (f.setpointSd <= RULES.setpointSdConverged) {
    if (
      converged &&
      f.shotsSinceRpmChange >= RULES.rpmMinShotsBetween &&
      (thin >= 2 || heavy >= 2)
    ) {
      const dir = thin >= 2 ? 1 : -1;
      const lo = f.allowLowRpm ? RULES.rpmOptInMin : RULES.rpmMin;
      const newRpm = Math.max(lo, Math.min(RULES.rpmMax, f.rpm + dir * RULES.rpmStep));
      if (newRpm !== f.rpm) {
        return {
          decision: {
            row: 9,
            lever: 'rpm',
            newRpm,
            texture: dir > 0 ? 'thin' : 'heavy',
            k: dir > 0 ? thin : heavy,
          },
          whyNot,
        };
      }
      whyNot.push(`not RPM: already at the ${newRpm} RPM limit`);
    } else if (!converged)
      whyNot.push('not RPM: flow not yet converged (2 of the last 3 shots predicted in band)');
    else if (f.shotsSinceRpmChange < RULES.rpmMinShotsBetween)
      whyNot.push(`not RPM: only ${f.shotsSinceRpmChange} shots since the last RPM change`);
    else whyNot.push('not RPM: texture chips do not agree on 2 of the last 3 rated shots');
  } else whyNot.push(`not RPM: setpoint not yet found (±${(f.setpointSd * 100).toFixed(0)} %)`);

  // 10. Temperature suggestion, once per bag.
  const ratedInBand = f.shots.filter((s) => s.rating && s.rating.v !== null && s.inBandAtRating);
  if (!f.tempCardShown && ratedInBand.length >= RULES.tempMinRated) {
    const recent = ratedInBand.slice(-RULES.tempMinRated);
    const meanV = recent.reduce((a, s) => a + (s.rating?.v ?? 0), 0) / recent.length;
    if (meanV <= -RULES.tempMeanSlider) {
      return {
        decision: {
          row: 10,
          lever: 'temperature',
          taste: 'sour',
          k: recent.filter((s) => (s.rating?.v ?? 0) <= -1).length,
          n: recent.length,
        },
        whyNot,
      };
    }
    if (meanV >= RULES.tempMeanSlider && ratio <= floor + 1e-9) {
      return {
        decision: {
          row: 10,
          lever: 'temperature',
          taste: 'bitter',
          k: recent.filter((s) => (s.rating?.v ?? 0) >= 1).length,
          n: recent.length,
        },
        whyNot,
      };
    }
    whyNot.push('not temperature: rated in-band shots do not lean sour or bitter on average');
  } else
    whyNot.push(
      f.tempCardShown
        ? 'not temperature: already suggested for this bag'
        : `not temperature: ${ratedInBand.length} rated in-band shots so far (need ${RULES.tempMinRated})`,
    );

  // 11. Dialled in.
  if (f.setpointSd <= RULES.setpointSdConverged && Math.abs(off) <= RULES.beta) {
    return { decision: { row: 11, lever: 'none', reason: 'dialled_in' }, whyNot };
  }

  // 12. Setpoint search.
  return { decision: { row: 12, lever: 'grind', target: 'setpoint_search' }, whyNot };
}

export const RULE_NAMES: Record<number, string> = {
  1: 'channeling → prep',
  2: 'freshness gate',
  3: 'outlier → repeat',
  4: 'off band → grind',
  5: 'sour → longer ratio',
  6: 'sour at ratio cap → finer',
  7: 'bitter → shorter ratio',
  8: 'bitter at ratio floor → coarser',
  9: 'texture → RPM',
  10: 'temperature suggestion',
  11: 'dialled in',
  12: 'setpoint search',
};

export function leverOf(d: RuleDecision): Lever {
  return d.lever;
}

export { MODEL };
