/** Typed CRUD and queries over the dialin database. */

import type { IDBPTransaction, StoreNames } from 'idb';
import { uuidv7 } from '../core/ids';
import { BACKUP } from '../core/params';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Curve,
  Id,
  Meta,
  Rating,
  RawRecording,
  Recommendation,
  RpmCalibrationRun,
  Settings,
  Shot,
  ShotQuality,
} from '../core/types';
import type { Db, DialinDB } from './db';

export function nowIso(): string {
  return new Date().toISOString();
}

function cryptoBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

export function newId(): Id {
  return uuidv7(Date.now(), cryptoBytes);
}

export function newMeta(deviceId: Id, id = newId(), at = nowIso()): Meta {
  return { id, createdAt: at, updatedAt: at, deviceId };
}

export function touched<T extends Meta>(row: T, at = nowIso()): T {
  return { ...row, updatedAt: at };
}

function tombstone<T extends Meta>(row: T, at: string): T {
  return { ...row, deleted: true, updatedAt: at };
}

/** The stores a shot's deletion writes to. */
const SHOT_STORES = [
  'shots',
  'curves',
  'quality',
  'ratings',
  'recommendations',
  'rawRecordings',
] as const;

type ShotStore = (typeof SHOT_STORES)[number];

/**
 * Tombstone shots with their satellite rows and the recommendations after them (with
 * `wholeBag`, every recommendation in `recs`); drop their raw recordings.
 */
async function tombstoneShots<S extends StoreNames<DialinDB>>(
  tx: IDBPTransaction<DialinDB, (ShotStore | S)[], 'readwrite'>,
  shots: Shot[],
  recs: Recommendation[],
  at: string,
  wholeBag = false,
): Promise<void> {
  const ids = new Set(shots.map((s) => s.id));
  for (const shot of shots) {
    await tx.objectStore('shots').put(tombstone(shot, at));
    for (const store of ['curves', 'quality', 'ratings'] as const) {
      const row = await tx.objectStore(store).index('shotId').get(shot.id);
      if (row && !row.deleted) await tx.objectStore(store).put(tombstone(row, at));
    }
    for (const key of await tx.objectStore('rawRecordings').index('shotId').getAllKeys(shot.id))
      await tx.objectStore('rawRecordings').delete(key);
  }
  for (const r of recs) {
    if (r.deleted) continue;
    if (wholeBag || (r.afterShotId !== null && ids.has(r.afterShotId)))
      await tx.objectStore('recommendations').put(tombstone(r, at));
  }
}

export class Repo {
  constructor(readonly db: Db) {}

  // ---- settings ----
  async getSettings(): Promise<Settings | undefined> {
    return this.db.get('settings', 'settings');
  }

  async saveSettings(s: Settings): Promise<void> {
    await this.db.put('settings', { ...s, updatedAt: nowIso() });
  }

  // ---- beans / bags / epochs ----
  async listBeans(includeDeleted = false): Promise<Bean[]> {
    const all = await this.db.getAll('beans');
    return includeDeleted ? all : all.filter((b) => !b.deleted);
  }

  getBean(id: Id): Promise<Bean | undefined> {
    return this.db.get('beans', id);
  }

  async putBean(b: Bean): Promise<void> {
    await this.db.put('beans', touched(b));
  }

  async listBags(includeDeleted = false): Promise<Bag[]> {
    const all = await this.db.getAll('bags');
    return includeDeleted ? all : all.filter((b) => !b.deleted);
  }

  async listBagsForBean(beanId: Id): Promise<Bag[]> {
    return (await this.db.getAllFromIndex('bags', 'beanId', beanId)).filter((b) => !b.deleted);
  }

  getBag(id: Id): Promise<Bag | undefined> {
    return this.db.get('bags', id);
  }

  async putBag(b: Bag): Promise<void> {
    await this.db.put('bags', touched(b));
  }

  async listEpochs(): Promise<CalibrationEpoch[]> {
    const all = await this.db.getAllFromIndex('epochs', 'startedAt');
    return all.filter((e) => !e.deleted);
  }

  async currentEpoch(): Promise<CalibrationEpoch | undefined> {
    const all = await this.listEpochs();
    return all[all.length - 1];
  }

  getEpoch(id: Id): Promise<CalibrationEpoch | undefined> {
    return this.db.get('epochs', id);
  }

  async putEpoch(e: CalibrationEpoch): Promise<void> {
    await this.db.put('epochs', touched(e));
  }

  // ---- shots and their satellite rows ----
  async listShotsForBag(bagId: Id): Promise<Shot[]> {
    const all = await this.db.getAllFromIndex('shots', 'bagId', bagId);
    return all.filter((s) => !s.deleted).sort((a, b) => a.at.localeCompare(b.at));
  }

  async listShots(): Promise<Shot[]> {
    return (await this.db.getAllFromIndex('shots', 'at')).filter((s) => !s.deleted);
  }

  getShot(id: Id): Promise<Shot | undefined> {
    return this.db.get('shots', id);
  }

  getCurveForShot(shotId: Id): Promise<Curve | undefined> {
    return this.db.getFromIndex('curves', 'shotId', shotId);
  }

  getRatingForShot(shotId: Id): Promise<Rating | undefined> {
    return this.db.getFromIndex('ratings', 'shotId', shotId);
  }

  getQualityForShot(shotId: Id): Promise<ShotQuality | undefined> {
    return this.db.getFromIndex('quality', 'shotId', shotId);
  }

  async listRatings(): Promise<Rating[]> {
    return (await this.db.getAll('ratings')).filter((r) => !r.deleted);
  }

  async listQuality(): Promise<ShotQuality[]> {
    return (await this.db.getAll('quality')).filter((r) => !r.deleted);
  }

  async putRating(r: Rating): Promise<void> {
    await this.db.put('ratings', touched(r));
  }

  async putQuality(q: ShotQuality): Promise<void> {
    await this.db.put('quality', touched(q));
  }

  async putShot(s: Shot): Promise<void> {
    await this.db.put('shots', touched(s));
  }

  /** Shot, curve, quality and optional rating/recommendation in one transaction. */
  async saveShotBundle(b: {
    shot: Shot;
    curve: Curve;
    quality: ShotQuality;
    rating?: Rating;
    recommendation?: Recommendation;
  }): Promise<void> {
    const tx = this.db.transaction(
      ['shots', 'curves', 'quality', 'ratings', 'recommendations'],
      'readwrite',
    );
    await Promise.all([
      tx.objectStore('shots').put(b.shot),
      tx.objectStore('curves').put(b.curve),
      tx.objectStore('quality').put(b.quality),
      b.rating ? tx.objectStore('ratings').put(b.rating) : Promise.resolve(),
      b.recommendation
        ? tx.objectStore('recommendations').put(b.recommendation)
        : Promise.resolve(),
    ]);
    await tx.done;
  }

  async listRecommendationsForBag(bagId: Id): Promise<Recommendation[]> {
    const all = await this.db.getAllFromIndex('recommendations', 'bagId', bagId);
    return all.filter((r) => !r.deleted).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getRecommendation(id: Id): Promise<Recommendation | undefined> {
    return this.db.get('recommendations', id);
  }

  async putRecommendation(r: Recommendation): Promise<void> {
    await this.db.put('recommendations', touched(r));
  }

  /** Keep only the last N raw recordings. */
  async putRawRecording(r: RawRecording): Promise<void> {
    await this.db.put('rawRecordings', r);
    const all = (await this.db.getAll('rawRecordings')).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const excess = all.length - BACKUP.rawRecordingsKept;
    for (let i = 0; i < excess; i++) {
      const row = all[i];
      if (row) await this.db.delete('rawRecordings', row.id);
    }
  }

  async listRawRecordings(): Promise<RawRecording[]> {
    return this.db.getAll('rawRecordings');
  }

  // ---- RPM calibration runs ----
  async listRpmRuns(): Promise<RpmCalibrationRun[]> {
    return (await this.db.getAll('rpmRuns')).filter((r) => !r.deleted);
  }

  async putRpmRun(r: RpmCalibrationRun): Promise<void> {
    await this.db.put('rpmRuns', touched(r));
  }

  // ---- deleting ----
  /**
   * Delete a shot: it and its curve, quality, rating and the recommendations made after it
   * become tombstones (so an import of an older backup cannot bring them back); its raw
   * recordings, which are never merged by tombstone age, are dropped. Returns the shot's bag.
   */
  async deleteShot(shotId: Id): Promise<Id | null> {
    const tx = this.db.transaction(SHOT_STORES, 'readwrite');
    const shot = await tx.objectStore('shots').get(shotId);
    if (!shot || shot.deleted) {
      await tx.done;
      return null;
    }
    const recs = await tx.objectStore('recommendations').index('bagId').getAll(shot.bagId);
    await tombstoneShots(tx, [shot], recs, nowIso());
    await tx.done;
    return shot.bagId;
  }

  /**
   * Delete a bean with all its bags, their shots (as deleteShot), recommendations and RPM
   * calibration runs. Returns how many bags and shots went with it.
   */
  async deleteBean(beanId: Id): Promise<{ bags: number; shots: number }> {
    const tx = this.db.transaction([...SHOT_STORES, 'beans', 'bags', 'rpmRuns'], 'readwrite');
    const at = nowIso();
    const bean = await tx.objectStore('beans').get(beanId);
    if (!bean || bean.deleted) {
      await tx.done;
      return { bags: 0, shots: 0 };
    }
    const bags = (await tx.objectStore('bags').index('beanId').getAll(beanId)).filter(
      (b) => !b.deleted,
    );
    let shotCount = 0;
    for (const bag of bags) {
      const shots = (await tx.objectStore('shots').index('bagId').getAll(bag.id)).filter(
        (s) => !s.deleted,
      );
      const recs = await tx.objectStore('recommendations').index('bagId').getAll(bag.id);
      // Recommendations made with no shot yet (afterShotId null) go with the bag too.
      await tombstoneShots(tx, shots, recs, at, true);
      shotCount += shots.length;
      for (const run of await tx.objectStore('rpmRuns').index('bagId').getAll(bag.id)) {
        if (!run.deleted) await tx.objectStore('rpmRuns').put(tombstone(run, at));
      }
      await tx.objectStore('bags').put(tombstone(bag, at));
    }
    await tx.objectStore('beans').put(tombstone(bean, at));
    await tx.done;
    return { bags: bags.length, shots: shotCount };
  }

  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const name of [
      'beans',
      'bags',
      'epochs',
      'shots',
      'curves',
      'ratings',
      'quality',
      'recommendations',
      'rawRecordings',
      'rpmRuns',
    ] as const) {
      out[name] = await this.db.count(name);
    }
    return out;
  }

  async wipe(): Promise<void> {
    const names = [
      'beans',
      'bags',
      'epochs',
      'shots',
      'curves',
      'ratings',
      'quality',
      'recommendations',
      'rawRecordings',
      'sensorSamples',
      'settings',
      'rpmRuns',
    ] as const;
    const tx = this.db.transaction(names, 'readwrite');
    await Promise.all(names.map((n) => tx.objectStore(n).clear()));
    await tx.done;
  }
}
