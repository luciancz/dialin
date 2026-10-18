/**
 * VS6 dial arithmetic. The dial is stored as revolution · number · line; absolute lines
 * are derived with the epoch's DialSpec, so a dial recount (new DialSpec) never
 * misaligns history. Larger line count = coarser.
 */
import type { DialPosition, DialSpec } from './types';

export const DEFAULT_DIAL_SPEC: DialSpec = {
  numbersPerRev: 10,
  linesPerNumber: 10,
  revs: 6,
  umPerLineNominal: 5,
};

export function toLines(p: DialPosition, s: DialSpec): number {
  return ((p.rev - 1) * s.numbersPerRev + p.number) * s.linesPerNumber + p.line;
}

export function maxLines(s: DialSpec): number {
  return s.revs * s.numbersPerRev * s.linesPerNumber - 1;
}

/** Nearest valid position for an absolute (possibly fractional) line count. */
export function fromLines(lines: number, s: DialSpec): DialPosition {
  const L = Math.max(0, Math.min(maxLines(s), Math.round(lines)));
  const perRev = s.numbersPerRev * s.linesPerNumber;
  const rev = Math.floor(L / perRev) + 1;
  const rem = L - (rev - 1) * perRev;
  const number = Math.floor(rem / s.linesPerNumber);
  const line = rem - number * s.linesPerNumber;
  return { rev, number, line };
}

/** "2·4·6" */
export function formatDial(p: DialPosition): string {
  return `${p.rev}·${p.number}·${p.line}`;
}

/** "2·4·6 (246 lines)" */
export function formatDialLong(p: DialPosition, s: DialSpec): string {
  return `${formatDial(p)} (${toLines(p, s)} lines)`;
}

export function parseDial(text: string): DialPosition | null {
  const m = text.trim().match(/^(\d+)\s*[·.\-/ ]\s*(\d+)\s*[·.\-/ ]\s*(\d+)$/);
  if (!m) return null;
  return { rev: Number(m[1]), number: Number(m[2]), line: Number(m[3]) };
}

export function isValidDial(p: DialPosition, s: DialSpec): boolean {
  return (
    Number.isInteger(p.rev) &&
    Number.isInteger(p.number) &&
    Number.isInteger(p.line) &&
    p.rev >= 1 &&
    p.rev <= s.revs &&
    p.number >= 0 &&
    p.number < s.numbersPerRev &&
    p.line >= 0 &&
    p.line < s.linesPerNumber
  );
}

export function stepDial(p: DialPosition, deltaLines: number, s: DialSpec): DialPosition {
  return fromLines(toLines(p, s) + deltaLines, s);
}

export function formatRpm(rpm: number): string {
  return String(Math.round(rpm)).padStart(4, '0');
}
