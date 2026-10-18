/**
 * IndexedDB schema via `idb`. Curves are a separate store so history lists never
 * deserialise sample arrays. Upgrades create the v1 stores and then run the pure
 * migration chain over live rows for any later version.
 */
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Curve,
  Id,
  Rating,
  RawRecording,
  Recommendation,
  RpmCalibrationRun,
  SensorSample,
  Settings,
  Shot,
  ShotQuality,
} from '../core/types';
import { DB_VERSION, migrateRows, type StoreName, storesNeedingMigration } from './migrations';

export const DB_NAME = 'dialin';
export { DB_VERSION };

export interface DialinDB extends DBSchema {
  beans: { key: Id; value: Bean };
  bags: { key: Id; value: Bag; indexes: { beanId: Id } };
  epochs: { key: Id; value: CalibrationEpoch; indexes: { startedAt: string } };
  shots: { key: Id; value: Shot; indexes: { bagId: Id; epochId: Id; at: string } };
  curves: { key: Id; value: Curve; indexes: { shotId: Id } };
  ratings: { key: Id; value: Rating; indexes: { shotId: Id } };
  quality: { key: Id; value: ShotQuality; indexes: { shotId: Id } };
  recommendations: { key: Id; value: Recommendation; indexes: { bagId: Id; createdAt: string } };
  rawRecordings: { key: Id; value: RawRecording; indexes: { shotId: Id } };
  sensorSamples: { key: Id; value: SensorSample; indexes: { shotId: Id } };
  settings: { key: 'settings'; value: Settings };
  rpmRuns: { key: Id; value: RpmCalibrationRun; indexes: { epochId: Id; bagId: Id } };
}

export type Db = IDBPDatabase<DialinDB>;

export function openDialinDb(name = DB_NAME): Promise<Db> {
  return openDB<DialinDB>(name, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('beans', { keyPath: 'id' });
        const bags = db.createObjectStore('bags', { keyPath: 'id' });
        bags.createIndex('beanId', 'beanId');
        const epochs = db.createObjectStore('epochs', { keyPath: 'id' });
        epochs.createIndex('startedAt', 'startedAt');
        const shots = db.createObjectStore('shots', { keyPath: 'id' });
        shots.createIndex('bagId', 'bagId');
        shots.createIndex('epochId', 'epochId');
        shots.createIndex('at', 'at');
        const curves = db.createObjectStore('curves', { keyPath: 'id' });
        curves.createIndex('shotId', 'shotId', { unique: true });
        const ratings = db.createObjectStore('ratings', { keyPath: 'id' });
        ratings.createIndex('shotId', 'shotId', { unique: true });
        const quality = db.createObjectStore('quality', { keyPath: 'id' });
        quality.createIndex('shotId', 'shotId', { unique: true });
        const recs = db.createObjectStore('recommendations', { keyPath: 'id' });
        recs.createIndex('bagId', 'bagId');
        recs.createIndex('createdAt', 'createdAt');
        const raw = db.createObjectStore('rawRecordings', { keyPath: 'id' });
        raw.createIndex('shotId', 'shotId');
        const sensors = db.createObjectStore('sensorSamples', { keyPath: 'id' });
        sensors.createIndex('shotId', 'shotId');
        db.createObjectStore('settings', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        const runs = db.createObjectStore('rpmRuns', { keyPath: 'id' });
        runs.createIndex('epochId', 'epochId');
        runs.createIndex('bagId', 'bagId');
      }
      // Existing databases: run the shared row migrations over the live stores. A fresh
      // install (oldVersion 0) has no rows to migrate.
      if (oldVersion < 1) return;
      for (const store of storesNeedingMigration(oldVersion)) {
        const os = tx.objectStore(store as never);
        const rows = (await os.getAll()) as unknown as Record<string, unknown>[];
        const migrated = migrateRows(store as StoreName, rows, oldVersion);
        await os.clear();
        for (const r of migrated) await os.put(r as never);
      }
    },
    blocked() {
      console.warn('dialin db upgrade blocked by another tab');
    },
    blocking() {
      console.warn('dialin db: a newer version wants to open; reload this tab');
    },
  });
}

export async function deleteDialinDb(name = DB_NAME): Promise<void> {
  const { deleteDB } = await import('idb');
  await deleteDB(name);
}
