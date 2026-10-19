/**
 * Rule table (plan "Rule layer"), evaluated top to bottom; the first matching row wins.
 * Pure: takes the facts the arbitration layer computed and returns the lever decision.
 */
import { MODEL, RPM, RULES } from '../params';
import type { PreferenceSummary } from '../rpm/preference';
import type { Chip, Lever, SliderValue, VsPrevious } from '../types';
import { ratioBounds } from './stages';

/** RPM facts the arbitration layer computed for rows 9 and 13. */
export interface RpmFacts {
  /** sd(k_r) ≤ 0.015: the RPM flow effect is known well enough to compensate. */
  calibrated: boolean;
  krSd: number;
  /** Preferred-RPM summary for this bean (null before any model). */
  pref: PreferenceSummary | null;
  shotsSinceBodyMove: number;
  /** Where a body move would go (Bayes RPM, step-capped, inside the range). */
  bodyTarget: number;
  /** P(the body move improves the cup). */
  probImprove: number;
}

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
  rpmFacts: RpmFacts;
  /** Next slot of an active RPM calibration run, if any. */
  calibration: { slot: number; rpm: number } | null;
  /** The calibration session just ended on the last shot: where RPM should go now. */
  calibrationFinish: { rpm: number; reason: 'preferred' | 'previous' } | null;
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
  | { row: 9; lever: 'rpm'; newRpm: number; thetaMean: number; band: [number, number] }
  | { row: 10; lever: 'temperature'; taste: 'sour' | 'bitter'; k: number; n: number }
  | { row: 11; lever: 'none'; reason: 'dialled_in' }
  | { row: 12; lever: 'grind'; target: 'setpoint_search' }
  | { row: 13; lever: 'calibrate'; slot: number; rpm: number; prep: string[] | null }
  | {
      row: 14;
      lever: 'rpm';
      rpm: number;
      reason: 'preferred' | 'previous';
      prep: string[] | null;
    };

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
  const channelled =
    last !== null &&
    (last.channelFlag ||
      chips.includes('channelled') ||
      (chips.includes('astringent') && chips.includes('harsh')));
  const signs: string[] = [];
  if (channelled) {
    if (last?.channelFlag) signs.push('spike or dips in the flow');
    if (chips.includes('channelled')) signs.push('the channelled chip');
    if (chips.includes('astringent')) signs.push('astringency');
  }
  // 13. An active RPM calibration run: pull the next slot (a channelled slot is repeated by the
  // planner; the card adds the prep advice).
  if (f.calibration) {
    return {
      decision: {
        row: 13,
        lever: 'calibrate',
        slot: f.calibration.slot,
        rpm: f.calibration.rpm,
        prep: channelled ? signs : null,
      },
      whyNot,
    };
  }
  // 14. The session just ended on an extreme slot: one compensated move to the preferred RPM
  // (or back to the pre-session RPM when RPM barely changes body).
  if (f.calibrationFinish) {
    return {
      decision: {
        row: 14,
        lever: 'rpm',
        rpm: f.calibrationFinish.rpm,
        reason: f.calibrationFinish.reason,
        prep: channelled ? signs : null,
      },
      whyNot,
    };
  }
  if (channelled) return { decision: { row: 1, lever: 'prep', signs }, whyNot };
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

  // 9. Body move: RPM toward the preferred body, with the dial compensated so flow holds.
  const last3 = f.shots.filter((s) => s.learn).slice(-3);
  const converged =
    last3.filter((s) => s.predictedY !== null && Math.abs(s.predictedY - f.sStar) <= RULES.beta)
      .length >= 2;
  const rf = f.rpmFacts;
  const pref = rf.pref;
  if (f.setpointSd > RULES.setpointSdConverged) {
    whyNot.push(`not body: taste setpoint not yet found (±${(f.setpointSd * 100).toFixed(0)} %)`);
  } else if (!converged) {
    whyNot.push('not body: flow not yet settled (2 of the last 3 shots predicted in band)');
  } else if (!rf.calibrated) {
    whyNot.push(
      `not body: RPM not calibrated yet (flow effect ±${rf.krSd.toFixed(3)} per 100 RPM)`,
    );
  } else if (!pref) {
    whyNot.push('not body: no body ratings yet (use the thin–heavy slider)');
  } else if (rf.shotsSinceBodyMove < RPM.bodyMinShotsBetween) {
    whyNot.push(`not body: only ${rf.shotsSinceBodyMove} shots since the last body move`);
  } else if (pref.pInsensitive >= RPM.pInsensitiveMax) {
    whyNot.push(`not body: RPM barely changes body for you (P ${pref.pInsensitive.toFixed(2)})`);
  } else if (f.rpm >= pref.band[0] && f.rpm <= pref.band[1]) {
    whyNot.push(`not body: already within your ${pref.band[0]}–${pref.band[1]} RPM band`);
  } else if (rf.bodyTarget === f.rpm || rf.probImprove < RPM.bodyImproveProb) {
    whyNot.push(
      `not body: a move is not clearly better yet (P ${rf.probImprove.toFixed(2)}, preferred ${Math.round(pref.thetaMean)} ± ${Math.round(pref.thetaSd)} RPM)`,
    );
  } else {
    return {
      decision: {
        row: 9,
        lever: 'rpm',
        newRpm: rf.bodyTarget,
        thetaMean: pref.thetaMean,
        band: pref.band,
      },
      whyNot,
    };
  }

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
  9: 'body → compensated RPM',
  10: 'temperature suggestion',
  11: 'dialled in',
  12: 'setpoint search',
  13: 'RPM calibration slot',
  14: 'calibration done → preferred RPM',
};

export function leverOf(d: RuleDecision): Lever {
  return d.lever;
}

export { MODEL };
