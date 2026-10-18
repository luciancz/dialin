/**
 * App state: signals over the ScaleClient, the recorder reducer and the repository.
 * This is the only place where the pure layers meet the DOM clock, IndexedDB and the UI.
 */
import { computed, signal } from '@preact/signals';
import { computeFeatures } from '../core/curve/features';
import { type RawSample, resample } from '../core/curve/resample';
import { APP_VERSION, BACKUP, MODEL, REC } from '../core/params';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Curve,
  Features,
  Id,
  Rating,
  Recommendation,
  Settings,
  Shot,
  ShotQuality,
  ShotSettings,
} from '../core/types';
import { DEFAULT_DIAL_SPEC } from '../core/units';
import { type Db, openDialinDb } from './../data/db';
import { newId, newMeta, nowIso, Repo } from '../data/repo';
import { diag } from '../diag/log';
import { requestPersistentStorage } from '../scale/capabilityProbe';
import { realClock } from '../scale/clock';
import type { WeightFrame } from '../scale/protocol';
import { commands } from '../scale/protocol';
import {
  type AutoOffInfo,
  type ClientState,
  ScaleClient,
  type Warning,
} from '../scale/scaleClient';
import {
  type Effect,
  initialState,
  learnGate,
  type RecorderEvent,
  type RecorderState,
  reduce,
  type ShotDraft,
  timerDriftPct,
} from '../shot/machine';
import { RingBuffer } from '../shot/ringBuffer';
import {
  defaultSimOptions,
  type MadeTransport,
  makeTransport,
  type SimOptions,
  type TransportKind,
} from './transports';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface PendingShot {
  draft: ShotDraft;
  features: Features;
  curve: Omit<Curve, keyof import('../core/types').Meta | 'shotId'>;
  status: ShotQuality['status'];
  learn: boolean;
}

class AppState {
  // ---- persistence ----
  db: Db | null = null;
  repo: Repo | null = null;
  readonly ready = signal(false);
  readonly settings = signal<Settings | null>(null);
  readonly beans = signal<Bean[]>([]);
  readonly bags = signal<Bag[]>([]);
  readonly epochs = signal<CalibrationEpoch[]>([]);
  readonly currentBagId = signal<Id | null>(null);
  readonly shotsOfBag = signal<Shot[]>([]);
  readonly ratingsOfBag = signal<Rating[]>([]);
  readonly qualityOfBag = signal<ShotQuality[]>([]);
  readonly recommendationsOfBag = signal<Recommendation[]>([]);
  readonly lastRecommendation = signal<Recommendation | null>(null);
  readonly persisted = signal<boolean | string>('unknown');

  readonly currentBag = computed(
    () => this.bags.value.find((b) => b.id === this.currentBagId.value) ?? null,
  );
  readonly currentBean = computed(() => {
    const bag = this.currentBag.value;
    return bag ? (this.beans.value.find((b) => b.id === bag.beanId) ?? null) : null;
  });
  readonly currentEpoch = computed(() => this.epochs.value[this.epochs.value.length - 1] ?? null);

  // ---- scale ----
  readonly transportKind = signal<TransportKind>('webbt');
  readonly simOptions = signal<SimOptions>({ ...defaultSimOptions });
  made: MadeTransport | null = null;
  client: ScaleClient | null = null;
  readonly clientState = signal<ClientState>('disconnected');
  readonly lastWeight = signal<WeightFrame | null>(null);
  readonly autoOff = signal<AutoOffInfo>({ at: null, soon: false, rearms: 0 });
  readonly scaleName = signal('');
  readonly ring = new RingBuffer();

  // ---- recorder ----
  readonly recorder = signal<RecorderState>(initialState());
  readonly pending = signal<PendingShot | null>(null);
  readonly nextSettings = signal<ShotSettings>({
    grind: { dialPos: { rev: 2, number: 5, line: 0 }, rpm: 1000, rpmConfirmed: false },
    doseG: 18,
    targetYieldG: 40,
    tempSwitch: 1,
  });
  readonly toasts = signal<Toast[]>([]);
  private toastSeq = 0;
  private tickCancel: (() => void) | null = null;
  private offs: (() => void)[] = [];
  private shotIndexOfDay = 0;
  private lastShotDay = '';

  // ---- lifecycle ----

  async init(): Promise<void> {
    if (this.ready.value) return;
    this.db = await openDialinDb();
    this.repo = new Repo(this.db);
    await this.ensureDefaults();
    await this.reloadAll();
    this.transportKind.value = this.settings.value?.transport ?? 'webbt';
    this.ready.value = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          const phase = this.recorder.value.phase;
          if (phase === 'RUNNING' || phase === 'ENDING' || phase === 'SETTLING') {
            this.dispatch({ type: 'background', now: realClock.now() });
          }
        }
      });
    }
  }

  private async ensureDefaults(): Promise<void> {
    const repo = this.mustRepo();
    let s = await repo.getSettings();
    if (!s) {
      s = {
        id: 'settings',
        deviceId: newId(),
        onboardingDone: false,
        defaultRpm: 1000,
        allowLowRpm: false,
        rpmResetsOnPowerOn: 'unknown',
        maraSwitch: { temp: 1, mode: 'coffee' },
        autoOffMinutesWanted: 30,
        shotsSinceExport: 0,
        transport: 'webbt',
        updatedAt: nowIso(),
      };
      await repo.saveSettings(s);
      this.persisted.value = await requestPersistentStorage();
    }
    const epochs = await repo.listEpochs();
    if (epochs.length === 0) {
      await repo.putEpoch({
        ...newMeta(s.deviceId),
        startedAt: nowIso(),
        kind: 'initial',
        dialSpec: { ...DEFAULT_DIAL_SPEC },
        burrSet: 'stock SUS420 58 mm',
        washerCount: 0,
        springSet: 'stock',
        note: 'created automatically; edit in Hardware / onboarding',
      });
    }
  }

  async reloadAll(): Promise<void> {
    const repo = this.mustRepo();
    const [settings, beans, bags, epochs] = await Promise.all([
      repo.getSettings(),
      repo.listBeans(),
      repo.listBags(),
      repo.listEpochs(),
    ]);
    this.settings.value = settings ?? null;
    this.beans.value = beans;
    this.bags.value = bags;
    this.epochs.value = epochs;
    if (this.currentBagId.value === null) {
      const open = bags
        .filter((b) => !b.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (open) await this.selectBag(open.id);
    } else await this.loadBagRows(this.currentBagId.value);
  }

  async selectBag(id: Id | null): Promise<void> {
    this.currentBagId.value = id;
    if (id) await this.loadBagRows(id);
    else {
      this.shotsOfBag.value = [];
      this.ratingsOfBag.value = [];
      this.qualityOfBag.value = [];
      this.recommendationsOfBag.value = [];
      this.lastRecommendation.value = null;
    }
  }

  async loadBagRows(bagId: Id): Promise<void> {
    const repo = this.mustRepo();
    const shots = await repo.listShotsForBag(bagId);
    const ratings = (await Promise.all(shots.map((s) => repo.getRatingForShot(s.id)))).filter(
      (r): r is Rating => r !== undefined,
    );
    const quality = (await Promise.all(shots.map((s) => repo.getQualityForShot(s.id)))).filter(
      (q): q is ShotQuality => q !== undefined,
    );
    const recs = await repo.listRecommendationsForBag(bagId);
    this.shotsOfBag.value = shots;
    this.ratingsOfBag.value = ratings;
    this.qualityOfBag.value = quality;
    this.recommendationsOfBag.value = recs;
    this.lastRecommendation.value = recs[recs.length - 1] ?? null;
    const bag = this.bags.value.find((b) => b.id === bagId);
    const last = shots[shots.length - 1];
    const rec = this.lastRecommendation.value;
    if (rec)
      this.nextSettings.value = { ...rec.next, grind: { ...rec.next.grind, rpmConfirmed: false } };
    else if (last)
      this.nextSettings.value = {
        ...last.settings,
        grind: { ...last.settings.grind, rpmConfirmed: false },
      };
    else if (bag) {
      this.nextSettings.value = {
        ...this.nextSettings.value,
        doseG: bag.doseDefaultG,
        targetYieldG: bag.targetYieldG,
        grind: { ...this.nextSettings.value.grind, rpm: bag.rpm, rpmConfirmed: false },
      };
    }
    await this.onBagLoaded?.();
  }

  mustRepo(): Repo {
    if (!this.repo) throw new Error('database not ready');
    return this.repo;
  }

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    const s = this.settings.value;
    if (!s) return;
    const next = { ...s, ...patch };
    await this.mustRepo().saveSettings(next);
    this.settings.value = next;
  }

  // ---- toasts ----

  toast(level: Toast['level'], msg: string, ttlMs = 5000): void {
    const id = ++this.toastSeq;
    this.toasts.value = [...this.toasts.value, { id, level, msg }];
    setTimeout(() => {
      this.toasts.value = this.toasts.value.filter((t) => t.id !== id);
    }, ttlMs);
  }

  // ---- scale connection ----

  async connect(): Promise<void> {
    const kind = this.transportKind.value;
    if (
      this.client &&
      this.clientState.value !== 'disconnected' &&
      this.clientState.value !== 'lost'
    ) {
      await this.client.disconnect();
    }
    for (const off of this.offs) off();
    this.offs = [];
    const made = makeTransport(kind, { sim: this.simOptions.value, replayRows: this.replayRows });
    this.made = made;
    const client = new ScaleClient(made.transport, realClock, {
      autoOffMinutes: this.settings.value?.autoOffMinutesWanted ?? 30,
      log: (level, msg) => diag.log(level, `[scale] ${msg}`),
    });
    this.client = client;
    this.offs.push(
      client.onState.on((s) => {
        this.clientState.value = s;
        if (s === 'connected') this.scaleName.value = made.transport.info.name ?? kind;
        if (s === 'reconnecting') this.dispatch({ type: 'disconnected', now: realClock.now() });
      }),
      client.onWeight.on(({ frame, tRxMs }) => {
        this.lastWeight.value = frame;
        this.ring.push({
          tRxMs,
          grams: frame.grams,
          flowScale: frame.flowGps,
          timerMs: frame.timerMs,
        });
        this.dispatch({
          type: 'frame',
          now: tRxMs,
          grams: frame.grams,
          flow: frame.flowGps,
          timerMs: frame.timerMs,
          tRxMs,
        });
      }),
      client.onRaw.on(({ src, bytes, tRxMs, parsed }) => {
        diag.pushFrame(src, bytes, tRxMs);
        if (parsed.kind === 'bad') diag.countBad();
      }),
      client.onWarning.on((w: Warning) => {
        this.toast(w.code === 'reconnected' ? 'info' : 'warn', w.msg);
      }),
      client.onAutoOff.on((a) => {
        this.autoOff.value = a;
      }),
    );
    await client.connect();
    const caps = { ...(this.settings.value?.bleCaps ?? {}), ...made.transport.info.caps };
    await this.saveSettings({ bleCaps: caps, transport: kind });
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect();
  }

  replayRows: import('../core/types').RawFrameRow[] = [];

  async sendCommand(bytes: Uint8Array): Promise<void> {
    await this.client?.send(bytes);
  }

  // ---- recorder ----

  dispatch(ev: RecorderEvent): void {
    const [next, effects] = reduce(this.recorder.value, ev, this.ring);
    this.recorder.value = next;
    for (const e of effects) this.runEffect(e);
    this.manageTicker();
  }

  private manageTicker(): void {
    const active =
      this.recorder.value.phase !== 'IDLE' &&
      this.recorder.value.phase !== 'RATE' &&
      this.recorder.value.phase !== 'SAVED';
    if (active && !this.tickCancel) {
      const tick = () => {
        this.dispatch({ type: 'tick', now: realClock.now() });
        if (this.tickCancel) this.tickCancel = realClock.setTimeout(tick, 250);
      };
      this.tickCancel = realClock.setTimeout(tick, 250);
    } else if (!active && this.tickCancel) {
      this.tickCancel();
      this.tickCancel = null;
    }
  }

  private runEffect(e: Effect): void {
    switch (e.type) {
      case 'send': {
        const bytes =
          e.cmd === 'tareStart'
            ? commands.tareStart()
            : e.cmd === 'start'
              ? commands.start()
              : e.cmd === 'stop'
                ? commands.stop()
                : commands.beep(e.n ?? 1);
        void this.client
          ?.send(bytes)
          .catch((err) => diag.log('warn', `send ${e.cmd} failed: ${String(err)}`));
        return;
      }
      case 'warn':
        this.toast('warn', e.msg);
        return;
      case 'prompt':
        return; // the Shot screen renders the prompt from recorder.prompt
      case 'pre_alert':
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate?.(80);
          } catch {
            /* ignore */
          }
        }
        return;
      case 'shot_running':
        this.client?.setShotRunning(e.running);
        return;
      case 'mode_hint':
        this.client?.setModeHint(e.hint);
        return;
      case 'finalize':
        if (e.discard) {
          this.toast('info', 'Shot discarded (under 5 g).');
          return;
        }
        this.finalizePending();
        return;
      default:
        return;
    }
  }

  private finalizePending(): void {
    const d = this.recorder.value.draft;
    if (!d) return;
    const endAt = d.endAt ?? 0;
    const samples: RawSample[] = d.samples.map((s) => ({ t: s.t, g: s.g, flow: s.flow }));
    const grid = resample(samples, endAt + REC.settleMs / 1000);
    const finalYieldG = d.finalYieldG ?? 0;
    const features = computeFeatures({
      t: grid.t,
      g: grid.g,
      mask: grid.mask,
      endAt,
      finalYieldG,
      firstDripKnown: d.status === 'ok',
      roastLevel: this.currentBean.value?.roastLevel ?? 'unknown',
    });
    const drift = timerDriftPct(d);
    const curve: PendingShot['curve'] = {
      t: grid.t,
      g: grid.g,
      flowScale: grid.flowScale,
      rawHz:
        d.samples.length > 1
          ? (d.samples.length - 1) /
            Math.max(0.1, (d.samples[d.samples.length - 1]?.t ?? 0) - (d.samples[0]?.t ?? 0))
          : 0,
      timerDriftPct: Number.isNaN(drift) ? 0 : drift,
      gaps: d.gaps,
      endAt,
      ...(d.preTapSpliceS !== null ? { preTapSpliceS: d.preTapSpliceS } : {}),
    };
    this.pending.value = {
      draft: d,
      features,
      curve,
      status: d.status,
      learn: learnGate(d.status, features.valid),
    };
  }

  /** Re-run feature extraction after a manual yield entry. */
  refreshPending(): void {
    this.finalizePending();
  }

  async saveShot(
    rating: Omit<Rating, keyof import('../core/types').Meta | 'shotId'> | null,
  ): Promise<Shot | null> {
    const pending = this.pending.value;
    const bag = this.currentBag.value;
    const epoch = this.currentEpoch.value;
    const settings = this.settings.value;
    const repo = this.mustRepo();
    if (!pending || !bag || !epoch || !settings) {
      this.toast('error', 'Cannot save: no bag selected.');
      return null;
    }
    const deviceId = settings.deviceId;
    const at = nowIso();
    const day = at.slice(0, 10);
    if (day !== this.lastShotDay) {
      this.lastShotDay = day;
      this.shotIndexOfDay = this.shotsOfBag.value.filter((s) => s.at.startsWith(day)).length;
    }
    this.shotIndexOfDay += 1;
    const shotId = newId();
    const prevRec = this.lastRecommendation.value;
    const shot: Shot = {
      ...newMeta(deviceId, shotId, at),
      bagId: bag.id,
      epochId: epoch.id,
      at,
      settings: this.nextSettings.value,
      context: {
        shotIndexOfDay: this.shotIndexOfDay,
        appVersion: APP_VERSION,
        ...(settings.scaleFirmware ? { scaleFirmware: settings.scaleFirmware } : {}),
      },
      features: pending.features,
      endedBy: pending.draft.endedBy ?? 'tap',
      recommendationId: prevRec?.id ?? null,
      deviation: this.pendingDeviation,
    };
    const curve: Curve = { ...newMeta(deviceId, newId(), at), shotId, ...pending.curve };
    const quality: ShotQuality = {
      ...newMeta(deviceId, newId(), at),
      shotId,
      status: pending.status,
      learn: pending.learn,
      notes: [
        ...pending.draft.notes,
        ...(pending.features.valid ? [] : pending.features.invalidReasons),
      ],
    };
    const lastShot = this.shotsOfBag.value[this.shotsOfBag.value.length - 1];
    const ratingRow: Rating | undefined = rating
      ? {
          ...newMeta(deviceId, newId(), at),
          shotId,
          ...rating,
          comparedToShotId: lastShot?.id ?? null,
        }
      : undefined;
    await repo.saveShotBundle({
      shot,
      curve,
      quality,
      ...(ratingRow ? { rating: ratingRow } : {}),
    });
    if (this.made?.recorder) {
      const rows = this.made.recorder.take(realClock.now() - 180_000);
      if (rows.length > 0) {
        await repo.putRawRecording({
          ...newMeta(deviceId, newId(), at),
          shotId,
          transport: this.transportKind.value,
          frames: rows,
        });
      }
    }
    await this.saveSettings({ shotsSinceExport: settings.shotsSinceExport + 1 });
    this.pending.value = null;
    this.pendingDeviation = null;
    this.dispatch({ type: 'rated', now: realClock.now() });
    this.dispatch({ type: 'reset', now: realClock.now() });
    await this.loadBagRows(bag.id);
    await this.afterShotSaved(shot);
    return shot;
  }

  /** Deviation from the previous recommendation, captured on the pre-shot card. */
  pendingDeviation: Shot['deviation'] = null;

  /** Hook for the recommender (M2): called after each saved shot. */
  afterShotSaved: (shot: Shot) => Promise<void> = async () => {};

  /** Hook for the recommender: called after the current bag's rows were (re)loaded. */
  onBagLoaded: (() => Promise<void>) | null = null;

  /** Hook for the recommender: a hardware epoch was opened; recompute the card. */
  afterEpochChanged: (() => Promise<void>) | null = null;

  /**
   * Hook for the setpoint layer (M3): why a better/worse comparison with the previous shot
   * would be invalid (null = valid). Until M3 lands, only "no previous shot" is checked.
   */
  comparisonReason: ((p: PendingShot) => string | null) | null = null;

  discardPending(): void {
    this.pending.value = null;
    this.dispatch({ type: 'reset', now: realClock.now() });
  }

  // ---- beans / bags ----

  async createBeanAndBag(
    bean: Omit<Bean, keyof import('../core/types').Meta>,
    bagFields: { roastDate: string; doseDefaultG: number; rpm: number },
  ): Promise<Bag> {
    const repo = this.mustRepo();
    const deviceId = this.settings.value?.deviceId ?? 'unknown';
    const b: Bean = { ...newMeta(deviceId), ...bean };
    await repo.putBean(b);
    const bag = await this.createBag(b.id, bagFields);
    return bag;
  }

  async createBag(
    beanId: Id,
    f: { roastDate: string; doseDefaultG: number; rpm: number; targetYieldG?: number },
  ): Promise<Bag> {
    const repo = this.mustRepo();
    const deviceId = this.settings.value?.deviceId ?? 'unknown';
    const bean = this.beans.value.find((x) => x.id === beanId) ?? (await repo.getBean(beanId));
    const ratio = MODEL.roastDefaults[bean?.roastLevel ?? 'unknown'].ratio;
    const bag: Bag = {
      ...newMeta(deviceId),
      beanId,
      roastDate: f.roastDate,
      doseDefaultG: f.doseDefaultG,
      targetYieldG: f.targetYieldG ?? Math.round(f.doseDefaultG * ratio),
      storage: [{ at: nowIso(), event: 'opened' }],
      rpm: f.rpm,
      tsSeed: Math.floor(Math.random() * 2 ** 31),
      archived: false,
    };
    await repo.putBag(bag);
    await this.reloadAll();
    await this.selectBag(bag.id);
    return bag;
  }

  async updateBag(bag: Bag): Promise<void> {
    await this.mustRepo().putBag(bag);
    await this.reloadAll();
  }

  async updateBean(bean: Bean): Promise<void> {
    await this.mustRepo().putBean(bean);
    await this.reloadAll();
  }

  backupNag(): 'none' | 'amber' | 'red' {
    const s = this.settings.value;
    if (!s) return 'none';
    const days = s.lastExportAt
      ? (Date.now() - Date.parse(s.lastExportAt)) / 86_400_000
      : Number.POSITIVE_INFINITY;
    const anyShots = this.shotsOfBag.value.length > 0 || s.shotsSinceExport > 0;
    if (!anyShots) return 'none';
    if (days >= BACKUP.redDays) return 'red';
    if (s.shotsSinceExport >= BACKUP.nagShots || days >= BACKUP.nagDays) return 'amber';
    return 'none';
  }
}

export const app = new AppState();
