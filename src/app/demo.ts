/**
 * Demo controller: a separate database, a hidden demo world (src/core/sim/demoWorld.ts), and
 * one-tap simulated shots that go through exactly the same save → replay → recommend path as
 * a real shot. The simulated you follows every recommendation, because the next pre-shot
 * settings are the card's settings.
 */
import { signal } from '@preact/signals';
import { mulberry32, seedFromString } from '../core/math/rng';
import {
  createDemoWorld,
  type DemoWorld,
  ratioOf,
  simulateDemoShot,
  stallsAt,
  tasteDemoShot,
  trueLnFlow,
} from '../core/sim/demoWorld';
import type { DialPosition } from '../core/types';
import { toLines } from '../core/units';
import { deleteDialinDb } from '../data/db';
import { diag } from '../diag/log';
import { realClock } from '../scale/clock';
import type { ShotDraft } from '../shot/machine';
import { openWeigh, weighStep } from '../shot/weigh';
import { grindRateGps } from '../ui/three/anim';
import { reportStall } from './calibration';
import { DEMO_DB_NAME, isDemo, reloadInto } from './mode';
import { navigate } from './router';
import { backToPlan, openGrindStep, openWeighStep, weighOpenedAt } from './shotFlow';
import { app, type PendingShot } from './state';

/** Only the two simulation sliders live in local storage; the hidden world does not. */
const PREFS_KEY = 'dialin-demo-prefs';
export const DEMO_USUAL_DIAL: DialPosition = { rev: 1, number: 8, line: 0 };
const DEMO_CHIRP: DialPosition = { rev: 1, number: 0, line: 0 };

export const demoWorld = signal<DemoWorld | null>(null);
export const demoBusy = signal<string>('');
/** Truth for the most recent simulated shot (shown on the demo screen). */
export const lastDemoShot = signal<{ yTrue: number; yObs: number; channel: boolean } | null>(null);
/** Simulated pulls this session, so a discarded pull never repeats the same random draw. */
let sessionPulls = 0;

interface DemoPrefs {
  channelProb: number;
  tasteNoise: number;
}

function loadPrefs(): Partial<DemoPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<DemoPrefs>) : {};
  } catch {
    return {};
  }
}

function savePrefs(p: DemoPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* defaults next time */
  }
}

/**
 * The hidden world is a pure function of the demo bag's id, so it lives and dies with the
 * demo database: losing local storage can never swap the truth under existing demo shots.
 */
function worldForBag(bagId: string, L0: number): DemoWorld {
  const prefs = loadPrefs();
  return createDemoWorld({
    seed: seedFromString(bagId),
    L0,
    ...(prefs.channelProb !== undefined ? { channelProb: prefs.channelProb } : {}),
    ...(prefs.tasteNoise !== undefined ? { tasteNoise: prefs.tasteNoise } : {}),
  });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Seed the demo database on first use and wire the simulated scale to the hidden world. */
export async function ensureDemoWorld(): Promise<void> {
  if (!isDemo() || !app.ready.value) return;
  const repo = app.repo;
  const settings = app.settings.value;
  const epoch = app.currentEpoch.value;
  if (!repo || !settings || !epoch) return;
  if (!settings.onboardingDone) {
    await repo.putEpoch({
      ...epoch,
      chirp: DEMO_CHIRP,
      usualDial: DEMO_USUAL_DIAL,
      note: 'demo grinder: stock burrs, chirp at 0',
    });
    await app.saveSettings({ onboardingDone: true, rpmResetsOnPowerOn: false, transport: 'fake' });
  }
  if ((await repo.listBeans()).length === 0) {
    await app.createBeanAndBag(
      {
        roaster: 'Demo Roasters',
        name: 'Hidden Truth (washed)',
        roastLevel: 'light',
        roastTarget: 'espresso',
        process: 'washed',
        decaf: false,
        notes: 'simulated bean for the demo',
      },
      { roastDate: daysAgoIso(10), doseDefaultG: 18, rpm: 1000 },
    );
  } else {
    await app.reloadAll();
  }
  const bag = app.currentBag.value;
  const ep = app.currentEpoch.value ?? epoch;
  if (!bag) return;
  const w = worldForBag(bag.id, toLines(ep.usualDial ?? DEMO_USUAL_DIAL, ep.dialSpec));
  demoWorld.value = w;
  if (app.shotsOfBag.value.length === 0) {
    const ns = app.nextSettings.value;
    app.nextSettings.value = {
      ...ns,
      grind: { ...ns.grind, dialPos: DEMO_USUAL_DIAL, rpmConfirmed: true },
    };
  }
  app.transportKind.value = 'fake';
  app.simOptions.value = {
    ...app.simOptions.value,
    channelProbability: w.channelProb,
    // The live simulated scale pours at the hidden world's flow for the dial you set.
    plateauGpsFn: () => {
      const world = demoWorld.value;
      const ep = app.currentEpoch.value;
      if (!world || !ep) return app.simOptions.value.plateauGps;
      return Math.exp(trueLnFlow(world, app.nextSettings.value, ep.dialSpec));
    },
  };
}

function draftFor(
  samples: { t: number; g: number }[],
  endAt: number,
  finalYieldG: number,
  targetYieldG: number,
  now: number,
): ShotDraft {
  const last = samples[samples.length - 1];
  return {
    t0Ms: now,
    tapMs: now,
    status: 'ok',
    startCmd: 'tareStart',
    samples: samples.map((s) => ({
      t: s.t,
      g: s.g,
      flow: 0,
      tRxMs: now + s.t * 1000,
      timerMs: Math.round(s.t * 1000),
    })),
    gaps: [],
    openGapStartS: null,
    endAt,
    endAtRxMs: now + endAt * 1000,
    endedBy: 'tap',
    finalYieldG,
    manualYieldG: null,
    tareOffsetG: 0,
    anchorOffsetS: 0,
    firstTimer: null,
    lastTimer: null,
    modeHint: 'timer',
    framesSinceStart: samples.length,
    preTapSpliceS: null,
    targetYieldG,
    tailEstimateG: 1,
    quietSinceS: null,
    lastFrameRxMs: last ? now + last.t * 1000 : null,
    lastG: last?.g ?? 0,
    maxG: samples.reduce((m, s) => Math.max(m, s.g), 0),
    disconnectedAtMs: null,
    settleUntilMs: null,
    alertFired: true,
    preTapMedianG: 0,
    tareDecided: true,
    notes: ['simulated shot (demo mode)'],
    recoveringFrom: null,
  };
}

/**
 * Pull one simulated shot at the current pre-shot settings. 'manual' opens the rating sheet
 * for you to rate; 'auto' rates it as the simulated palate and saves it.
 */
export async function pullDemoShot(mode: 'manual' | 'auto'): Promise<boolean> {
  const w = demoWorld.value;
  const epoch = app.currentEpoch.value;
  if (!w || !epoch || !app.currentBag.value) return false;
  const s = app.nextSettings.value;
  // The hidden grinder stalls (E006) below its threshold: the simulated you reports it and
  // the card moves the RPM up (no shot is pulled).
  if (stallsAt(w, s.grind.rpm)) {
    lastDemoShot.value = null;
    app.toast('warn', `Simulated VS6: E006 at ${s.grind.rpm} RPM, the motor stalled.`);
    await reportStall(s.grind.rpm);
    return mode === 'auto';
  }
  sessionPulls += 1;
  const rng = mulberry32(
    (w.seed + app.shotsOfBag.value.length * 7919 + sessionPulls * 104_729) >>> 0,
  );
  const shot = simulateDemoShot(w, s, epoch.dialSpec, rng);
  lastDemoShot.value = { yTrue: shot.yTrue, yObs: shot.yObs, channel: shot.channel };
  const now = performance.now();
  const pending: PendingShot = {
    draft: draftFor(
      shot.t.map((t, i) => ({ t, g: shot.g[i] ?? 0 })),
      shot.endAt,
      shot.finalYieldG,
      s.targetYieldG,
      now,
    ),
    features: shot.features,
    curve: {
      t: shot.grid.t,
      g: shot.grid.g,
      flowScale: shot.grid.flowScale,
      rawHz: 10,
      timerDriftPct: 0.7,
      gaps: [],
      endAt: shot.endAt,
    },
    status: 'ok',
    learn: shot.features.valid,
  };
  if (app.lastRecommendation.value) app.pendingDeviation = 'followed';
  app.pending.value = pending;
  if (mode === 'manual') return true;

  await rateAsPalate(w, pending, shot.yObs, shot.channel, rng);
  return true;
}

/** The simulated palate tastes the pending shot and saves it with the rating. */
async function rateAsPalate(
  w: DemoWorld,
  pending: PendingShot,
  yFallback: number,
  channel: boolean,
  rng: () => number,
): Promise<void> {
  const s = app.nextSettings.value;
  const prev = app.shotsOfBag.value[app.shotsOfBag.value.length - 1] ?? null;
  const f = pending.features;
  const yCup = f.plateauFlow && f.plateauFlow > 0 ? Math.log(f.plateauFlow) : yFallback;
  const prevY =
    prev?.features.plateauFlow && prev.features.plateauFlow > 0
      ? Math.log(prev.features.plateauFlow)
      : null;
  const tasting = tasteDemoShot(
    w,
    { y: yCup, ratio: ratioOf(s), rpm: s.grind.rpm, channel },
    prev && prevY !== null
      ? { y: prevY, ratio: ratioOf(prev.settings), rpm: prev.settings.grind.rpm }
      : null,
    rng,
  );
  const reason = prev ? (app.comparisonReason?.(pending) ?? null) : 'no previous shot';
  await app.saveShot({
    comparedToShotId: prev?.id ?? null,
    vsPrevious: reason === null ? tasting.vs : null,
    sourBitter: tasting.sourBitter,
    thinHeavy: tasting.thinHeavy,
    chips: tasting.chips,
    overall1to9: tasting.overall,
    drink: 'black',
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until `ok()` holds (polled every 100 ms); false after `ms`. */
async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = realClock.now() + ms;
  while (realClock.now() < end) {
    if (ok()) return true;
    await sleep(100);
  }
  return ok();
}

/** Weight of the VS6's empty dosing cup and of the glass espresso cup (simulated scale). */
const DOSING_CUP_G = 92.4;
const ESPRESSO_CUP_G = 168.0;
let watching = false;

/**
 * Watch a whole shot through the live path: the simulated scale gets the dosing cup (auto-tare),
 * the beans (the weigh step captures the dose), the grind, then the espresso cup (auto-tare),
 * START, the pour, STOP at the target, the drip window and the simulated palate's rating.
 * Everything runs through the real recorder, auto-tare, weigh step and 3D views.
 */
export async function watchDemoShot(): Promise<void> {
  const w = demoWorld.value;
  if (!w || watching) return;
  watching = true;
  try {
    if (app.clientState.value !== 'connected') {
      demoBusy.value = 'connecting the simulated scale…';
      await app.connect();
      await until(() => app.clientState.value === 'connected', 6000);
    }
    const fake = app.made?.fake;
    if (!fake) throw new Error('the simulated scale is not connected');
    const s0 = app.nextSettings.value;
    if (stallsAt(w, s0.grind.rpm)) {
      app.toast('warn', `Simulated VS6: E006 at ${s0.grind.rpm} RPM, the motor stalled.`);
      await reportStall(s0.grind.rpm);
      return;
    }
    sessionPulls += 1;
    const rng = mulberry32(
      (w.seed + app.shotsOfBag.value.length * 7919 + sessionPulls * 104_729) >>> 0,
    );
    navigate('/shot');
    // 1. Dosing cup on the scale: auto-tare.
    demoBusy.value = 'dosing cup on the scale…';
    fake.setCupWeight(0);
    await sleep(900);
    openWeighStep();
    const opened = weighOpenedAt.value;
    await sleep(500);
    fake.setCupWeight(DOSING_CUP_G);
    const tared = await until(() => (app.lastAutoTareAt.value ?? 0) > opened, 4000);
    if (!tared) await app.tareNow();
    // 2. Beans in over 2.5 s with a small overshoot; the weigh step captures the dose.
    demoBusy.value = 'weighing the beans…';
    const dose = Math.round((s0.doseG + 0.25 * (rng() - 0.5)) * 10) / 10;
    for (let i = 1; i <= 25; i++) {
      const f = i / 25;
      fake.setCupWeight(DOSING_CUP_G + dose * Math.min(1, f * 1.02));
      await sleep(100);
    }
    fake.setCupWeight(DOSING_CUP_G + dose);
    await until(
      () =>
        weighStep(openWeigh(opened), {
          connected: true,
          nowMs: realClock.now(),
          tareAtMs: app.lastAutoTareAt.value,
          ring: app.ring,
        }).phase === 'captured',
      5000,
    );
    const got = Math.round((app.lastWeight.value?.grams ?? dose) * 10) / 10;
    app.weighedDose.value = { g: got, plannedG: s0.doseG };
    app.nextSettings.value = { ...app.nextSettings.value, doseG: got };
    // 3. Grind (the VS6 view runs while the beans go through).
    demoBusy.value = `grinding ${got.toFixed(1)} g at ${s0.grind.rpm} RPM…`;
    openGrindStep();
    await sleep(Math.min(8000, (1000 * got) / grindRateGps(s0.grind.rpm)) + 600);
    // 4. Dosing cup off, espresso cup on: auto-tare again; arm.
    demoBusy.value = 'cup on the scale…';
    fake.setCupWeight(0);
    await sleep(1200);
    backToPlan();
    const before = app.lastAutoTareAt.value ?? 0;
    fake.setCupWeight(ESPRESSO_CUP_G);
    if (!(await until(() => (app.lastAutoTareAt.value ?? 0) > before, 4000))) await app.tareNow();
    const ns = app.nextSettings.value;
    app.nextSettings.value = { ...ns, grind: { ...ns.grind, rpmConfirmed: true } };
    if (app.lastRecommendation.value) app.pendingDeviation = 'followed';
    app.dispatch({ type: 'arm', now: realClock.now(), targetYieldG: ns.targetYieldG });
    await sleep(1800);
    // 5. Lever up (START), pour, STOP at the target minus the drip tail.
    demoBusy.value = 'pulling the shot…';
    app.dispatch({ type: 'tap', now: realClock.now() });
    await until(() => {
      const r = app.recorder.value;
      return r.phase === 'RUNNING' && (r.draft?.lastG ?? 0) >= ns.targetYieldG - 1.2;
    }, 90_000);
    if (app.recorder.value.phase === 'RUNNING') app.dispatch({ type: 'tap', now: realClock.now() });
    demoBusy.value = 'drip window…';
    await until(() => app.pending.value !== null, 15_000);
    const pending = app.pending.value;
    if (!pending) throw new Error('the shot did not finish');
    // 6. The simulated palate tastes it (the curve tells whether it channelled).
    demoBusy.value = 'tasting…';
    await sleep(1200);
    const channel = pending.features.curveChannelScore >= 0.5;
    await rateAsPalate(
      w,
      pending,
      Math.log(Math.max(0.05, pending.features.plateauFlow ?? 1)),
      channel,
      rng,
    );
    fake.setCupWeight(0);
    navigate('/demo');
  } catch (err) {
    app.toast('error', `Watch a shot stopped: ${String(err)}`);
    diag.log('warn', `watch a shot: ${String(err)}`);
  } finally {
    watching = false;
    demoBusy.value = '';
  }
}

/** Pull and auto-rate `n` shots in a row, following each recommendation. */
export async function autoRunDemo(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    demoBusy.value = `simulating shot ${i + 1} of ${n}…`;
    const ok = await pullDemoShot('auto');
    if (!ok) break;
    // Distinct timestamps keep the shot order unambiguous.
    await new Promise((r) => setTimeout(r, 10));
  }
  demoBusy.value = '';
}

export function updateDemoWorld(
  patch: Partial<Pick<DemoWorld, 'channelProb' | 'tasteNoise'>>,
): void {
  const w = demoWorld.value;
  if (!w) return;
  const next = { ...w, ...patch };
  demoWorld.value = next;
  savePrefs({ channelProb: next.channelProb, tasteNoise: next.tasteNoise });
  if (patch.channelProb !== undefined) {
    app.simOptions.value = { ...app.simOptions.value, channelProbability: patch.channelProb };
  }
}

export function enterDemo(): void {
  reloadInto(true, '/demo');
}

export function exitDemo(): void {
  reloadInto(false, '/');
}

/** Delete the demo database and the hidden world, then start a fresh one. */
export async function resetDemo(): Promise<void> {
  try {
    app.db?.close();
    await deleteDialinDb(DEMO_DB_NAME);
  } catch (err) {
    diag.log('warn', `demo reset: ${String(err)}`);
  }
  reloadInto(true, '/demo');
}
