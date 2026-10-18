import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytesFrom, uuidv7 } from '../../src/core/ids';
import { mulberry32 } from '../../src/core/math/rng';
import type {
  Bag,
  Bean,
  Curve,
  Features,
  Meta,
  RpmCalibrationRun,
  Settings,
  Shot,
  ShotQuality,
} from '../../src/core/types';
import { type Db, openDialinDb } from '../../src/data/db';
import {
  buildExport,
  curveHash,
  type ExportCurve,
  importFile,
  mergeSnapshots,
  readSnapshot,
  type Snapshot,
  serializeCurve,
  snapshotFromFile,
} from '../../src/data/exportImport';
import { migrateRows, storesNeedingMigration } from '../../src/data/migrations';
import { Repo } from '../../src/data/repo';
import { validateExportFile } from '../../src/data/validate';

const rng = mulberry32(99);
const rand = randomBytesFrom(rng);
let clock = 1_700_000_000_000;
function id(): string {
  clock += 1000;
  return uuidv7(clock, rand);
}
function meta(deviceId = 'dev-A', at = '2026-10-01T10:00:00.000Z'): Meta {
  return { id: id(), createdAt: at, updatedAt: at, deviceId };
}
function bean(): Bean {
  return {
    ...meta(),
    roaster: 'Assembly',
    name: 'Kiawamururu',
    roastLevel: 'light',
    roastTarget: 'espresso',
    process: 'washed',
    decaf: false,
  };
}
function bag(beanId: string): Bag {
  return {
    ...meta(),
    beanId,
    roastDate: '2026-09-20',
    doseDefaultG: 18,
    targetYieldG: 40,
    storage: [],
    rpm: 1000,
    tsSeed: 7,
    archived: false,
  };
}
const features: Features = {
  firstDripS: 8,
  t50S: 20,
  plateauFlow: 1.9,
  meanFlow: 1.5,
  lateSlopeRel: 0,
  maxJump1s: 0.1,
  dipCount: 0,
  tailMassG: 1,
  totalTimeS: 30,
  finalYieldG: 40,
  plateauDurS: 10,
  curveChannelScore: 0,
  flags: [],
  valid: true,
  invalidReasons: [],
};
function shot(bagId: string, epochId: string): Shot {
  return {
    ...meta(),
    bagId,
    epochId,
    at: '2026-10-01T10:00:00.000Z',
    settings: {
      grind: { dialPos: { rev: 2, number: 4, line: 6 }, rpm: 1000, rpmConfirmed: true },
      doseG: 18,
      targetYieldG: 40,
      tempSwitch: 1,
    },
    context: { shotIndexOfDay: 1, appVersion: 'test' },
    features,
    endedBy: 'tap',
    recommendationId: null,
    deviation: null,
  };
}
function curve(shotId: string, n = 50): Curve {
  const t = new Float32Array(n);
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i / 10;
    g[i] = i * 0.19;
  }
  return {
    ...meta(),
    shotId,
    t,
    g,
    flowScale: new Float32Array(n),
    rawHz: 10,
    timerDriftPct: 0.7,
    gaps: [],
    endAt: (n - 1) / 10,
  };
}
function quality(shotId: string): ShotQuality {
  return { ...meta(), shotId, status: 'ok', learn: true, notes: [] };
}
function settings(deviceId: string): Settings {
  return {
    id: 'settings',
    deviceId,
    onboardingDone: true,
    defaultRpm: 1000,
    allowLowRpm: false,
    rpmResetsOnPowerOn: 'unknown',
    maraSwitch: { temp: 1, mode: 'coffee' },
    autoOffMinutesWanted: 30,
    shotsSinceExport: 0,
    updatedAt: '2026-10-01T10:00:00.000Z',
  };
}

let db: Db;
let repo: Repo;
beforeEach(async () => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  db = await openDialinDb(`t-${Math.random()}`);
  repo = new Repo(db);
});

describe('schema and repo', () => {
  it('creates every store with its indexes and round-trips a shot bundle', async () => {
    expect([...db.objectStoreNames].sort()).toEqual([
      'bags',
      'beans',
      'curves',
      'epochs',
      'quality',
      'ratings',
      'rawRecordings',
      'recommendations',
      'rpmRuns',
      'sensorSamples',
      'settings',
      'shots',
    ]);
    const b = bean();
    await repo.putBean(b);
    const bg = bag(b.id);
    await repo.putBag(bg);
    const epoch = {
      ...meta(),
      startedAt: '2026-09-01T00:00:00.000Z',
      kind: 'initial' as const,
      dialSpec: { numbersPerRev: 10, linesPerNumber: 10, revs: 6, umPerLineNominal: 5 },
      burrSet: 'stock',
      washerCount: 0,
      springSet: 'stock',
    };
    await repo.putEpoch(epoch);
    const s = shot(bg.id, epoch.id);
    const c = curve(s.id);
    await repo.saveShotBundle({ shot: s, curve: c, quality: quality(s.id) });
    const shots = await repo.listShotsForBag(bg.id);
    expect(shots.length).toBe(1);
    const back = await repo.getCurveForShot(s.id);
    expect(back?.g).toBeInstanceOf(Float32Array);
    expect(back?.g.length).toBe(50);
    expect((await repo.getQualityForShot(s.id))?.learn).toBe(true);
    expect((await repo.currentEpoch())?.id).toBe(epoch.id);
    const counts = await repo.counts();
    expect(counts.shots).toBe(1);
  });

  it('keeps only the last five raw recordings', async () => {
    for (let i = 0; i < 8; i++) {
      await repo.putRawRecording({
        ...meta('dev-A', `2026-10-0${(i % 9) + 1}T00:00:00.000Z`),
        transport: 'fake',
        frames: [],
      });
    }
    expect((await repo.listRawRecordings()).length).toBe(5);
  });
});

describe('export / import', () => {
  it('round-trips through an export file and validates it', async () => {
    const b = bean();
    const bg = bag(b.id);
    const epochId = id();
    const s = shot(bg.id, epochId);
    await repo.putBean(b);
    await repo.putBag(bg);
    await repo.saveShotBundle({ shot: s, curve: curve(s.id), quality: quality(s.id) });
    await repo.saveSettings(settings('dev-A'));
    const file = await buildExport(db);
    expect(file.format).toBe('dialin');
    expect(file.curves[0]?.g).toBeInstanceOf(Array);
    const json = JSON.parse(JSON.stringify(file));
    const v = validateExportFile(json);
    expect(v.ok).toBe(true);
    expect(validateExportFile({ format: 'nope' }).ok).toBe(false);

    const db2 = await openDialinDb(`t2-${Math.random()}`);
    const plan = await importFile(db2, json, true);
    expect(plan.adds.shots).toBe(1);
    expect(plan.adds.curves).toBe(1);
    expect(plan.conflicts.length).toBe(0);
    const snapA = await readSnapshot(db, false);
    const snapB = await readSnapshot(db2, false);
    expect(snapB.shots).toEqual(snapA.shots);
    expect(snapB.curves).toEqual(snapA.curves);
    expect(snapB.beans).toEqual(snapA.beans);
    // Second import is a no-op.
    const again = await importFile(db2, json, true);
    expect(again.adds.shots).toBe(0);
    expect(again.unchanged.shots).toBe(1);
  });

  it('applies tombstones and last-writer-wins on mutable rows', () => {
    const b = bean();
    const local: Snapshot = empty({ beans: [b] });
    const deleted: Bean = { ...b, updatedAt: '2026-10-02T00:00:00.000Z', deleted: true };
    const r = mergeSnapshots(local, empty({ beans: [deleted] }));
    expect(r.result.beans[0]?.deleted).toBe(true);
    expect(r.plan.updates.beans).toBe(1);
    const older: Bean = { ...b, name: 'older', updatedAt: '2026-09-01T00:00:00.000Z' };
    const r2 = mergeSnapshots(local, empty({ beans: [older] }));
    expect(r2.result.beans[0]?.name).toBe(b.name);
    expect(r2.plan.unchanged.beans).toBe(1);
  });

  it('flags a curve with the same id but different samples and keeps the local one', () => {
    const s = shot('bag', 'epoch');
    const c = serializeCurve(curve(s.id));
    const other: ExportCurve = { ...c, g: c.g.map((v) => v + 0.5) };
    expect(curveHash(c)).not.toBe(curveHash(other));
    const r = mergeSnapshots(
      empty({ shots: [s], curves: [c] }),
      empty({ shots: [s], curves: [other] }),
    );
    expect(r.plan.conflicts.length).toBe(1);
    expect(r.result.curves[0]?.g).toEqual(c.g);
    expect(r.writes.length).toBe(0);
  });

  it('merge is idempotent and commutative over 200 random snapshot pairs', () => {
    const r = mulberry32(2024);
    for (let trial = 0; trial < 200; trial++) {
      const [a, b] = randomPair(r);
      const ab = mergeSnapshots(a, b).result;
      const ba = mergeSnapshots(b, a).result;
      expect(canon(ab)).toEqual(canon(ba));
      const abb = mergeSnapshots(ab, b).result;
      expect(canon(abb)).toEqual(canon(ab));
      const aba = mergeSnapshots(ab, a).result;
      expect(canon(aba)).toEqual(canon(ab));
    }
  });

  it('runs the shared migration chain on an older file', () => {
    const steps = {
      1: { bags: (row: Record<string, unknown>) => ({ ...row, rpm: row.rpm ?? 1000 }) },
    };
    const rows = migrateRows('bags', [{ id: 'x' }], 1, 2, steps);
    expect(rows[0]?.rpm).toBe(1000);
    expect(storesNeedingMigration(1, 2, steps)).toEqual(['bags']);
    expect(() => migrateRows('bags', [], 5, 1)).toThrow(/newer/);
    const snap = snapshotFromFile({
      format: 'dialin',
      schemaVersion: 1,
      exportedAt: 'x',
      deviceId: 'd',
      appVersion: 't',
      settings: null,
      beans: [],
      bags: [],
      epochs: [],
      shots: [],
      curves: [],
      ratings: [],
      quality: [],
      recommendations: [],
    });
    expect(snap.bags).toEqual([]);
  });

  it('upgrades a v1 database to v2: creates rpmRuns and migrates settings', async () => {
    const { openDB } = await import('idb');
    const name = `v1-${Math.random()}`;
    // A v1 database exactly as the v1 app created it (subset of stores is enough).
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('settings', { keyPath: 'id' });
        db.createObjectStore('beans', { keyPath: 'id' });
        db.createObjectStore('bags', { keyPath: 'id' }).createIndex('beanId', 'beanId');
        const epochs = db.createObjectStore('epochs', { keyPath: 'id' });
        epochs.createIndex('startedAt', 'startedAt');
        const shots = db.createObjectStore('shots', { keyPath: 'id' });
        shots.createIndex('bagId', 'bagId');
        shots.createIndex('epochId', 'epochId');
        shots.createIndex('at', 'at');
        for (const s of ['curves', 'ratings', 'quality'] as const) {
          db.createObjectStore(s, { keyPath: 'id' }).createIndex('shotId', 'shotId', {
            unique: true,
          });
        }
        const recs = db.createObjectStore('recommendations', { keyPath: 'id' });
        recs.createIndex('bagId', 'bagId');
        recs.createIndex('createdAt', 'createdAt');
        db.createObjectStore('rawRecordings', { keyPath: 'id' }).createIndex('shotId', 'shotId');
        db.createObjectStore('sensorSamples', { keyPath: 'id' }).createIndex('shotId', 'shotId');
      },
    });
    const { rpmRange: _drop, ...v1Settings } = settings('dev-A');
    await v1.put('settings', v1Settings);
    v1.close();
    const v2 = await openDialinDb(name);
    expect([...v2.objectStoreNames]).toContain('rpmRuns');
    const s = await v2.get('settings', 'settings');
    expect(s?.rpmRange).toEqual([500, 1600]);
    expect(s?.deviceId).toBe('dev-A');
    v2.close();
  });

  it('imports a v1 export file: settings gain rpmRange, runs default to none', () => {
    const { rpmRange: _drop, ...v1Settings } = settings('dev-B');
    const snap = snapshotFromFile({
      format: 'dialin',
      schemaVersion: 1,
      exportedAt: 'x',
      deviceId: 'dev-B',
      appVersion: 't',
      settings: v1Settings as Settings,
      beans: [],
      bags: [],
      epochs: [],
      shots: [],
      curves: [],
      ratings: [],
      quality: [],
      recommendations: [],
    });
    expect(snap.settings?.rpmRange).toEqual([500, 1600]);
    expect(snap.rpmRuns).toEqual([]);
  });

  it('imports settings only onto a device that has not finished onboarding', () => {
    const incoming = settings('dev-B');
    const r1 = mergeSnapshots(empty({ settings: null }), empty({ settings: incoming }));
    expect(r1.plan.settings).toBe('imported');
    const local = { ...settings('dev-A'), onboardingDone: true };
    const r2 = mergeSnapshots(empty({ settings: local }), empty({ settings: incoming }));
    expect(r2.plan.settings).toBe('kept');
    const fresh = { ...settings('dev-A'), onboardingDone: false };
    const r3 = mergeSnapshots(empty({ settings: fresh }), empty({ settings: incoming }));
    expect(r3.plan.settings).toBe('imported');
    expect(r3.result.settings?.deviceId).toBe('dev-A');
  });
});

function empty(over: Partial<Snapshot> = {}): Snapshot {
  return {
    settings: null,
    beans: [],
    bags: [],
    epochs: [],
    shots: [],
    curves: [],
    ratings: [],
    quality: [],
    recommendations: [],
    rawRecordings: [],
    rpmRuns: [],
    ...over,
  };
}

function canon(s: Snapshot): unknown {
  const sortRows = <T extends Meta>(rows: T[]) =>
    [...rows].sort((x, y) => x.id.localeCompare(y.id));
  return {
    beans: sortRows(s.beans),
    bags: sortRows(s.bags),
    shots: sortRows(s.shots),
    curves: sortRows(s.curves),
    quality: sortRows(s.quality),
    rpmRuns: sortRows(s.rpmRuns),
  };
}

function randomPair(r: () => number): [Snapshot, Snapshot] {
  const ids = Array.from({ length: 6 }, () => id());
  const dates = [
    '2026-10-01T00:00:00.000Z',
    '2026-10-02T00:00:00.000Z',
    '2026-10-03T00:00:00.000Z',
  ];
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const mk = (device: string): Snapshot => {
    const beans: Bean[] = [];
    const quality: ShotQuality[] = [];
    const shots: Shot[] = [];
    const curves: ExportCurve[] = [];
    const rpmRuns: RpmCalibrationRun[] = [];
    for (const i of ids) {
      if (r() < 0.3) {
        rpmRuns.push({
          ...meta(device, pick(dates)),
          id: `run-${i}`,
          epochId: 'epoch',
          bagId: 'bag',
          startedAt: '2026-10-01T00:00:00.000Z',
          status: pick(['active', 'done', 'abandoned'] as const),
        });
      }
      if (r() < 0.6) {
        const at = pick(dates);
        beans.push({
          ...bean(),
          id: i,
          deviceId: device,
          updatedAt: at,
          name: `${device}-${at}`,
          ...(r() < 0.2 ? { deleted: true as const } : {}),
        });
      }
      if (r() < 0.5) {
        const s = { ...shot('bag', 'epoch'), id: `s-${i}`, deviceId: device };
        shots.push(s);
        // identical curve samples on both sides (same shot captured once, exported twice)
        curves.push({ ...serializeCurve(curve(s.id, 5)), id: `c-${i}`, deviceId: device });
        quality.push({
          ...quality0(s.id),
          id: `q-${i}`,
          deviceId: device,
          updatedAt: pick(dates),
          learn: r() < 0.5,
        });
      }
    }
    return empty({ beans, shots, curves, quality, rpmRuns });
  };
  return [mk('A'), mk('B')];
}

function quality0(shotId: string): ShotQuality {
  return { ...meta(), shotId, status: 'ok', learn: true, notes: [] };
}
