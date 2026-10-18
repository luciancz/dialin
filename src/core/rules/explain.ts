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

export function rpmSentence(a: {
  dial: DialPosition;
  rpm: number;
  prevRpm: number;
  texture: 'thin' | 'heavy';
  k: number;
}): string {
  return `Hold ${formatDial(a.dial)}; set ${a.rpm} RPM (was ${a.prevRpm}). Texture read ${a.texture} on ${a.k} of the last 3 shots. Flow may move either way; next shot re-dials.`;
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
