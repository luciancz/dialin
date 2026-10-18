/** Typed CRUD and queries over the dialin database. */
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
  Settings,
  Shot,
  ShotQuality,
} from '../core/types';
import type { Db } from './db';

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
    ] as const;
    const tx = this.db.transaction(names, 'readwrite');
    await Promise.all(names.map((n) => tx.objectStore(n).clear()));
    await tx.done;
  }
}
