/** Explanation templates (plan "Explanation templates"). All numbers rounded as shown. */
import type { DialPosition, Lever, TempSwitch } from '../types';
import { formatDial } from '../units';

const gps = (y: number) => Math.exp(y).toFixed(2);

export function grindSentence(a: {
  deltaLines: number;
  from: DialPosition;
  to: DialPosition;
  rpm: number;
  yieldG: number;
  lastY: number | null;
  targetY: number;
  secPerLine: number;
  secPerLineSd: number;
  learning: boolean;
}): string {
  const n = Math.abs(a.deltaLines);
  const dir = a.deltaLines < 0 ? 'finer' : 'coarser';
  const last = a.lastY === null ? 'no plateau measured' : `last shot ran ${gps(a.lastY)} g/s`;
  const gain = a.learning
    ? `Gain ≈ ${a.secPerLine.toFixed(1)} s/line, still learning.`
    : `Gain ≈ ${a.secPerLine.toFixed(1)} ± ${a.secPerLineSd.toFixed(1)} s/line.`;
  return `Go ${n} line${n === 1 ? '' : 's'} ${dir} (${formatDial(a.from)} → ${formatDial(a.to)}) at ${a.rpm} RPM, ${a.yieldG.toFixed(0)} g: ${last}, target ${gps(a.targetY)} g/s. ${gain}`;
}

export function yieldSentence(a: {
  dial: DialPosition;
  yieldG: number;
  prevYieldG: number;
  lastY: number | null;
  taste: 'sour' | 'bitter';
}): string {
  const y = a.lastY === null ? 'in band' : `in band at ${gps(a.lastY)} g/s`;
  return `Keep ${formatDial(a.dial)}, pull ${a.yieldG.toFixed(0)} g (was ${a.prevYieldG.toFixed(0)}): ${y} but tasted ${a.taste}; ratio first, grind later.`;
}

export function prepSentence(a: { signs: string[]; dial: DialPosition; rpm: number }): string {
  const s = a.signs.length > 0 ? a.signs.join(' and ') : 'the curve';
  return `Change nothing. ${s} point${a.signs.length === 1 ? 's' : ''} to channeling: WDT, level tamp, pull the same ${formatDial(a.dial)} at ${a.rpm} RPM.`;
}

export function waitSentence(a: {
  ageDays: number;
  dial: DialPosition;
  rpm: number;
  yieldG: number;
  gateDay: number;
}): string {
  return `Rest this bean (${a.ageDays} days since roast). Keep ${formatDial(a.dial)} / ${a.rpm} / ${a.yieldG.toFixed(0)} g; grind conclusions are suppressed until day ${a.gateDay}.`;
}

function dialMove(from: DialPosition, to: DialPosition, deltaLines: number): string {
  if (deltaLines === 0) return `keep the dial at ${formatDial(from)}`;
  const n = Math.abs(deltaLines);
  return `go ${n} line${n === 1 ? '' : 's'} ${deltaLines < 0 ? 'finer' : 'coarser'} (${formatDial(from)} → ${formatDial(to)})`;
}

/** Body move: RPM toward the preferred body with the dial compensated. */
export function bodySentence(a: {
  rpm: number;
  prevRpm: number;
  from: DialPosition;
  to: DialPosition;
  deltaLines: number;
  thetaMean: number;
  band: [number, number];
  targetY: number;
}): string {
  const dir = a.rpm > a.prevRpm ? 'more body' : 'more clarity';
  return `Set ${a.rpm} RPM (was ${a.prevRpm}) and ${dialMove(a.from, a.to, a.deltaLines)} to hold ${gps(a.targetY)} g/s: your ratings point to ${dir}, preferred ≈ ${Math.round(a.thetaMean / 50) * 50} RPM (band ${a.band[0]}–${a.band[1]}).`;
}

/** One slot of an RPM calibration run. */
export function calibrationSentence(a: {
  slot: number;
  total: number;
  rpm: number;
  prevRpm: number;
  from: DialPosition;
  to: DialPosition;
  deltaLines: number;
  targetY: number;
  prep: string[] | null;
  repeat: boolean;
}): string {
  const head = `RPM calibration ${a.slot + 1}/${a.total}${a.repeat ? ' (repeat)' : ''}: set ${a.rpm} RPM${a.rpm === a.prevRpm ? '' : ` (was ${a.prevRpm})`} and ${dialMove(a.from, a.to, a.deltaLines)}, compensated to hold ${gps(a.targetY)} g/s.`;
  const tail =
    ' Feed the beans the same way as always, rate body (thin–heavy) and compare with the last shot.';
  const prep =
    a.prep && a.prep.length > 0
      ? ` The last shot looked channelled (${a.prep.join(', ')}): WDT and a level tamp before this one.`
      : '';
  return head + prep + tail;
}

/** The calibration session ended: leave the last slot's RPM for the preferred (or previous) one. */
export function calibrationDoneSentence(a: {
  rpm: number;
  prevRpm: number;
  from: DialPosition;
  to: DialPosition;
  deltaLines: number;
  targetY: number;
  reason: 'preferred' | 'previous';
  prep: string[] | null;
}): string {
  const why =
    a.reason === 'preferred'
      ? 'your preferred body'
      : 'your usual RPM (it is within the RPM range that gives you the same body)';
  const prep =
    a.prep && a.prep.length > 0
      ? ` The last shot looked channelled (${a.prep.join(', ')}): WDT and a level tamp.`
      : '';
  return `RPM calibration done: set ${a.rpm} RPM (was ${a.prevRpm}) for ${why}, and ${dialMove(a.from, a.to, a.deltaLines)}, compensated to hold ${gps(a.targetY)} g/s.${prep}`;
}

/** Backup flow lever: the dial is at a limit, RPM covers the rest. */
export function backupSentence(a: {
  rpm: number;
  prevRpm: number;
  limit: 'chirp' | 'end';
}): string {
  const where = a.limit === 'chirp' ? 'the finest safe setting' : 'the end of the dial';
  return ` The dial is at ${where}, so set ${a.rpm} RPM (was ${a.prevRpm}) to cover the rest of the flow change.`;
}

/** Fine trim smaller than one dial line. */
export function trimSentence(a: {
  rpm: number;
  prevRpm: number;
  dial: DialPosition;
  before: number;
  after: number;
}): string {
  const pct = (x: number) => `${(Math.abs(Math.expm1(x)) * 100).toFixed(0)} %`;
  return `Fine trim: keep ${formatDial(a.dial)} and set ${a.rpm} RPM (was ${a.prevRpm}); predicted flow ${pct(a.before)} off target becomes ${pct(a.after)}, a smaller step than one dial line.`;
}

const SWITCH = ['0', 'I', 'II'];

export function temperatureSentence(a: {
  from: TempSwitch;
  to: TempSwitch | null;
  nudge: 'flush 5 s before' | 'wait 2 min after flush';
  k: number;
  n: number;
  taste: 'sour' | 'bitter';
}): string {
  const sw = a.to === null ? a.nudge : `Switch ${SWITCH[a.from]} → ${SWITCH[a.to]} (or ${a.nudge})`;
  return `${sw}; ${a.k} of the last ${a.n} shots read ${a.taste} at the setpoint. Wait 15 min after changing.`;
}

export function noneSentence(a: {
  yHat: number;
  targetY: number;
  lastRating: 'better' | 'same' | 'worse' | 'unrated';
}): string {
  return `Pull the same shot: predicted ${gps(a.yHat)} g/s is within 7 % of target ${gps(a.targetY)} g/s and the last rating was ${a.lastRating}.`;
}

export function outlierSentence(a: { lastY: number; z: number; dial: DialPosition }): string {
  return `That shot ran ${gps(a.lastY)} g/s, ${Math.abs(a.z).toFixed(1)}σ off the model: repeat at ${formatDial(a.dial)} to confirm before changing anything.`;
}

export function firstShotSentence(a: {
  dial: DialPosition;
  rpm: number;
  yieldG: number;
  fromPrior: boolean;
}): string {
  return a.fromPrior
    ? `Pull ${formatDial(a.dial)} at ${a.rpm} RPM, ${a.yieldG.toFixed(0)} g: the starting dial comes from earlier bags; the model re-anchors on this shot.`
    : `Pull ${formatDial(a.dial)} at ${a.rpm} RPM, ${a.yieldG.toFixed(0)} g: first shot, the model learns the grinder from it.`;
}

export function leverLabel(l: Lever): string {
  return l;
}
