/**
 * Pre-shot flow shared by the Shot screen and the demo's "Watch a shot":
 * Plan → Weigh beans → Grind → Arm. Only UI state; nothing here is stored.
 */
import { signal } from '@preact/signals';
import { realClock } from '../scale/clock';

/** Pre-shot step: the plan card, weighing the beans, grinding. */
export const preStep = signal<'plan' | 'weigh' | 'grind'>('plan');
/** When the weighing step was opened (a tare after this zeroes the dosing cup). */
export const weighOpenedAt = signal(0);
/** When the grind animation started (null = not grinding). */
export const grindStartedAt = signal<number | null>(null);

export function openWeighStep(): void {
  weighOpenedAt.value = realClock.now();
  grindStartedAt.value = null;
  preStep.value = 'weigh';
}

export function openGrindStep(): void {
  grindStartedAt.value = realClock.now();
  preStep.value = 'grind';
}

export function backToPlan(): void {
  grindStartedAt.value = null;
  preStep.value = 'plan';
}
