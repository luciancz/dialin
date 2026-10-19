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
import type { ShotDraft } from '../shot/machine';
import { reportStall } from './calibration';
import { DEMO_DB_NAME, isDemo, reloadInto } from './mode';
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

  const prev = app.shotsOfBag.value[app.shotsOfBag.value.length - 1] ?? null;
  const yCup =
    shot.features.plateauFlow && shot.features.plateauFlow > 0
      ? Math.log(shot.features.plateauFlow)
      : shot.yObs;
  const prevY =
    prev?.features.plateauFlow && prev.features.plateauFlow > 0
      ? Math.log(prev.features.plateauFlow)
      : null;
  const tasting = tasteDemoShot(
    w,
    { y: yCup, ratio: ratioOf(s), rpm: s.grind.rpm, channel: shot.channel },
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
  return true;
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
