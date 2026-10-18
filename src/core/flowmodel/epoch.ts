/**
 * Epoch events transform the state into the new epoch's prior. Shots never cross epochs;
 * the first shot of every active bag after an event is an anchor shot.
 */
import { MODEL } from '../params';
import type { CalibrationEpoch, DialSpec, Id } from '../types';
import { fromLines, toLines } from '../units';
import { cloneState, type FlowModelState, GRINDER_IDX, kGrind, SHARED_PRIORS } from './state';

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
      // Grind gain and the RPM effect (slope and curvature) are burr properties: back to priors.
      for (const i of GRINDER_IDX) {
        const prior = SHARED_PRIORS[i];
        if (!prior) continue;
        s.m[i] = prior.mean;
        for (let j = 0; j < s.m.length; j++) {
          (s.P[i] as number[])[j] = 0;
          (s.P[j] as number[])[i] = 0;
        }
        (s.P[i] as number[])[i] = prior.sd ** 2;
      }
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
