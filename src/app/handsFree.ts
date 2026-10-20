/**
 * Hands-free on the app: every scale frame (with the auto-tare it fired) goes through the
 * pure controller in src/shot/handsFree.ts, and its actions are carried out here: open the
 * weighing, take the dose, arm, back to the plan, beep the cues. The manual buttons on the
 * Shot screen stay; the controller follows them. Settings → Hands-free turns it off.
 */
import { signal } from '@preact/signals';
import {
  deviationFromCard,
  type HfAction,
  type HfState,
  handsFreeStep,
  initHandsFree,
} from '../shot/handsFree';
import { navigate, route } from './router';
import { backToPlan, openGrindStep, openWeighStep, preStep } from './shotFlow';
import { app } from './state';

/** The controller's state, for the Shot screen's "next step" strip. */
export const handsFree = signal<HfState>(initHandsFree());

export function handsFreeOn(): boolean {
  const s = app.settings.value;
  return s !== null && s.handsFree !== false && s.autoTare !== false;
}

function onFrame(tRxMs: number, tare: { placedG: number } | null): void {
  const s = app.settings.value;
  if (!s || !handsFreeOn() || !app.currentBag.value) {
    if (handsFree.value.step !== 'ready') handsFree.value = initHandsFree(tRxMs);
    return;
  }
  const ns = app.nextSettings.value;
  const r = handsFreeStep(handsFree.value, {
    nowMs: tRxMs,
    connected: app.clientState.value === 'connected',
    phase: app.recorder.value.phase,
    pending: app.pending.value !== null,
    ring: app.ring,
    tare,
    plannedDoseG: app.weighedDose.value?.plannedG ?? ns.doseG,
    dosingCupG: s.dosingCupG ?? null,
    preStep: preStep.value,
  });
  if (r.state !== handsFree.value) handsFree.value = r.state;
  for (const a of r.actions) run(a, tRxMs);
}

function toShotScreen(): void {
  if (route.value.path !== '/shot') navigate('/shot');
}

function run(a: HfAction, tRxMs: number): void {
  const s = app.settings.value;
  switch (a.type) {
    case 'openWeigh':
      toShotScreen();
      openWeighStep(tRxMs);
      return;
    case 'useDose': {
      const ns = app.nextSettings.value;
      app.weighedDose.value = { g: a.g, plannedG: app.weighedDose.value?.plannedG ?? ns.doseG };
      app.nextSettings.value = { ...ns, doseG: a.g };
      if (a.dosingCupG !== null && a.dosingCupG !== s?.dosingCupG)
        void app.saveSettings({ dosingCupG: Math.round(a.dosingCupG * 10) / 10 });
      openGrindStep();
      return;
    }
    case 'arm': {
      const ns = app.nextSettings.value;
      // A VS6 that keeps its RPM over power-off needs no check of its display.
      const next =
        s?.rpmResetsOnPowerOn === false
          ? { ...ns, grind: { ...ns.grind, rpmConfirmed: true } }
          : ns;
      app.nextSettings.value = next;
      const card = app.lastRecommendation.value;
      if (card && app.pendingDeviation === null)
        app.pendingDeviation = deviationFromCard(next, card.next, app.weighedDose.value?.g ?? null);
      app.dispatch({
        type: 'arm',
        now: tRxMs,
        targetYieldG: next.targetYieldG,
        tailEstimateG: app.tailEstimate(),
        autoStart: s?.autoStartFallback !== false,
      });
      toShotScreen();
      return;
    }
    case 'toPlan':
      backToPlan();
      return;
    case 'cue':
      app.cue(a.cue);
      return;
    default:
      return;
  }
}

app.onScaleFrame = onFrame;
