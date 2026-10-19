/**
 * Vetoes on any model proposal: step and range clamps happen in the inversion; here the
 * compass check (never coarser when sour and fast, never finer when bitter and slow).
 * RPM limits live in rpm/range.ts (clampRpm, allowedRpmRange).
 */
import { MODEL } from '../params';

export interface CompassFacts {
  /** Sour–bitter slider of the last rated shot, if any. */
  v: number | null;
  /** ŷ_cur − s* */
  offset: number;
  deltaLines: number;
}

/** Returns the corrected step and a veto note when the proposal moves against the compass. */
export function compassVeto(f: CompassFacts): { deltaLines: number; veto: string | null } {
  if (f.v === null || f.v === 0) return { deltaLines: f.deltaLines, veto: null };
  if (f.v < 0 && f.offset >= 0 && f.deltaLines > 0) {
    return {
      deltaLines: -MODEL.probeStepLines,
      veto: 'compass: sour and running fast, so the model step coarser was replaced by a rule step finer',
    };
  }
  if (f.v > 0 && f.offset <= 0 && f.deltaLines < 0) {
    return {
      deltaLines: MODEL.probeStepLines,
      veto: 'compass: bitter and running slow, so the model step finer was replaced by a rule step coarser',
    };
  }
  return { deltaLines: f.deltaLines, veto: null };
}
