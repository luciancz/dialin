/**
 * Hands-free strip on the Shot screen: where the shot is and the next thing to do with the
 * hands (not with the phone). The scale moves the steps on; the buttons below stay for doing
 * any step by hand.
 */
import { handsFree, handsFreeOn } from '../../app/handsFree';
import { app } from '../../app/state';

const STEPS = [
  ['weigh', 'Weigh'],
  ['grind', 'Grind'],
  ['armed', 'Cup'],
  ['pour', 'Pull'],
  ['rate', 'Rate'],
] as const;

type StripStep = (typeof STEPS)[number][0] | 'ready';

function nextAction(step: StripStep): { title: string; detail: string } {
  const s = app.settings.value;
  const rec = app.recorder.value;
  const ns = app.nextSettings.value;
  const rpm = ns.grind.rpmConfirmed ? '' : ` Check the VS6 shows ${ns.grind.rpm} RPM.`;
  switch (step) {
    case 'ready':
      return s?.dosingCupG
        ? {
            title: 'Dosing cup on the scale to weigh the beans, or the espresso cup to skip it.',
            detail: 'Either is tared by itself (1 beep).',
          }
        : {
            title: 'Put the empty dosing cup on the scale.',
            detail: 'It is tared by itself (1 beep) and its weight is learned.',
          };
    case 'weigh':
      return {
        title: 'Pour the beans into the dosing cup.',
        detail: 'The dose is taken when the reading holds still (2 beeps).',
      };
    case 'grind':
      return {
        title: 'Grind, then put the espresso cup on the scale.',
        detail: `Armed once it is tared (1 beep).${rpm}`,
      };
    case 'armed':
      return {
        title: "Lift the lever and press the scale's timer.",
        detail:
          s?.autoStartFallback === false
            ? 'Or tap START below.'
            : 'Forgot the timer? The shot starts by itself at the first drops.',
      };
    case 'pour': {
      const d = rec.draft;
      if (rec.phase === 'ENDING' || rec.phase === 'SETTLING')
        return { title: 'Leave the cup on the scale.', detail: 'Drip window, then the rating.' };
      if (d?.alertFired) return { title: 'Lever down now.', detail: 'It ends by itself.' };
      const at = d ? Math.max(0, d.targetYieldG - d.tailEstimateG) : ns.targetYieldG;
      return {
        title: `Lever down at 3 beeps (${at.toFixed(1)} g).`,
        detail: 'The shot ends by itself when the flow stops.',
      };
    }
    case 'rate':
      return {
        title: 'Taste it, then one tap: sour, balanced or bitter.',
        detail: 'Untouched for 2 minutes it is saved unrated, to rate later on Home.',
      };
    default:
      return { title: '', detail: '' };
  }
}

export function HandsFreeStrip() {
  if (!handsFreeOn()) return null;
  if (app.clientState.value !== 'connected' && !app.pending.value) return null;
  const phase = app.recorder.value.phase;
  // The recorder is authoritative for the shot itself.
  const step: StripStep = app.pending.value
    ? 'rate'
    : phase === 'ARMED'
      ? 'armed'
      : phase === 'RUNNING' || phase === 'ENDING' || phase === 'SETTLING' || phase === 'RECOVERING'
        ? 'pour'
        : handsFree.value.step;
  const { title, detail } = nextAction(step);
  const at = STEPS.findIndex(([k]) => k === step);
  return (
    <div class="card accent hf-strip" aria-live="polite">
      <div class="hf-steps">
        {STEPS.map(([k, label], i) => (
          <span key={k} class={i === at ? 'now' : i < at ? 'done' : ''}>
            {label}
          </span>
        ))}
      </div>
      <b>{title}</b>
      <div class="small muted">{detail}</div>
    </div>
  );
}
