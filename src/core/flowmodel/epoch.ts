/**
 * Epoch events transform the state into the new epoch's prior. Shots never cross epochs;
 * the first shot of every active bag after an event is an anchor shot.
 */
import { MODEL } from '../params';
import type { CalibrationEpoch, DialSpec, Id } from '../types';
import { fromLines, toLines } from '../units';
import { cloneState, type FlowModelState, IDX_KG, IDX_KR, kGrind } from './state';

export interface EpochTransition {
  newEpochId: Id;
  kind: CalibrationEpoch['kind'];
  oldSpec: DialSpec;
  newSpec: DialSpec;
  /** New chirp line in the new spec, for re_zero. */
  newChirpLines?: number | null;
  deltaWashers?: number;
}

export function applyEpochEvent(prev: FlowModelState, t: EpochTransition): FlowModelState {
  const s = cloneState(prev);
  s.epochId = t.newEpochId;
  s.lastOutlier = null;
  const kg = kGrind(s).mean;
  const setVar = (sd: number) => {
    for (const b of s.bags) (s.P[b.index] as number[])[b.index] = sd * sd;
  };
  switch (t.kind) {
    case 'cleaning':
      setVar(MODEL.cleaningSd);
      break;
    case 're_zero': {
      const newRef = t.newChirpLines ?? null;
      if (newRef !== null && s.LrefE !== null) {
        const shift = kg * (s.LrefE - newRef);
        for (const b of s.bags) s.m[b.index] = (s.m[b.index] ?? 0) + shift;
        for (const p of s.pooled) p.aAtAnchor += shift;
        s.LrefE = newRef;
      }
      setVar(MODEL.reZeroSd);
      break;
    }
    case 'washer_change': {
      const dw = t.deltaWashers ?? 0;
      const shift = -kg * MODEL.washerLinesPer * dw * (5 / Math.max(1, t.oldSpec.umPerLineNominal));
      for (const b of s.bags) s.m[b.index] = (s.m[b.index] ?? 0) + shift;
      for (const p of s.pooled) p.aAtAnchor += shift;
      setVar(MODEL.washerSd);
      break;
    }
    case 'spring_change':
      setVar(MODEL.springSd);
      break;
    case 'dial_recount': {
      const convert = (lines: number) => toLines(fromLines(lines, t.oldSpec), t.newSpec);
      for (const b of s.bags) b.LrefB = convert(b.LrefB);
      if (s.LrefE !== null) s.LrefE = convert(s.LrefE);
      setVar(MODEL.recountSd);
      break;
    }
    case 'new_burrs': {
      s.m[IDX_KG] = MODEL.kGrindPrior.mean;
      s.m[IDX_KR] = MODEL.kRpmPrior.mean;
      for (let j = 0; j < s.m.length; j++) {
        (s.P[IDX_KG] as number[])[j] = 0;
        (s.P[j] as number[])[IDX_KG] = 0;
        (s.P[IDX_KR] as number[])[j] = 0;
        (s.P[j] as number[])[IDX_KR] = 0;
      }
      (s.P[IDX_KG] as number[])[IDX_KG] = MODEL.kGrindPrior.sd ** 2;
      (s.P[IDX_KR] as number[])[IDX_KR] = MODEL.kRpmPrior.sd ** 2;
      setVar(MODEL.newBurrsSd);
      break;
    }
    default:
      setVar(MODEL.springSd);
      break;
  }
  // Cross-covariances between a re-opened intercept and the gains are stale: zero them.
  for (const b of s.bags) {
    b.anchorPending = true;
    b.consecutiveSkips = 0;
    for (let j = 0; j < s.m.length; j++) {
      if (j === b.index) continue;
      (s.P[b.index] as number[])[j] = 0;
      (s.P[j] as number[])[b.index] = 0;
    }
  }
  return s;
}
