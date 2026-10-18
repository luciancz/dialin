/**
 * Export file build, merge planning and application.
 *
 * Merge rules (plan "Data model"): union by id. Mutable rows (everything except Shot and
 * Curve) are last-writer-wins on updatedAt with `deleted` tombstones. Shot/Curve with an
 * identical id are skipped; a curve whose id matches but whose samples differ is kept
 * locally and flagged as a conflict (the user decides; nothing is silently overwritten).
 * Settings are device-specific: they are imported only onto a device that has not finished
 * onboarding, and keep the local deviceId. Model state is never exported: it is replayed.
 */
import { APP_VERSION } from '../core/params';
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
import { DB_VERSION, migrateRows, type StoreName } from './migrations';
import { nowIso } from './repo';

export type ExportCurve = Omit<Curve, 't' | 'g' | 'flowScale'> & {
  t: number[];
  g: number[];
  flowScale: number[];
};

export interface ExportFile {
  format: 'dialin';
  schemaVersion: number;
  exportedAt: string;
  deviceId: Id;
  appVersion: string;
  settings: Settings | null;
  beans: Bean[];
  bags: Bag[];
  epochs: CalibrationEpoch[];
  shots: Shot[];
  curves: ExportCurve[];
  ratings: Rating[];
  quality: ShotQuality[];
  recommendations: Recommendation[];
  rawRecordings?: RawRecording[];
}

/** Plain-object view of every store, the unit the pure merge works on. */
export interface Snapshot {
  settings: Settings | null;
  beans: Bean[];
  bags: Bag[];
  epochs: CalibrationEpoch[];
  shots: Shot[];
  curves: ExportCurve[];
  ratings: Rating[];
  quality: ShotQuality[];
  recommendations: Recommendation[];
  rawRecordings: RawRecording[];
}

export type MergeStore = Exclude<keyof Snapshot, 'settings'>;
const MUTABLE: MergeStore[] = [
  'beans',
  'bags',
  'epochs',
  'ratings',
  'quality',
  'recommendations',
  'rawRecordings',
];
const IMMUTABLE: MergeStore[] = ['shots', 'curves'];

export interface MergePlan {
  adds: Record<MergeStore, number>;
  updates: Record<MergeStore, number>;
  unchanged: Record<MergeStore, number>;
  conflicts: { store: MergeStore; id: Id; reason: string }[];
  settings: 'kept' | 'imported';
}

export interface MergeResult {
  result: Snapshot;
  /** Rows that differ from the local snapshot and must be written. */
  writes: { store: MergeStore; row: Meta }[];
  plan: MergePlan;
}

export function serializeCurve(c: Curve): ExportCurve {
  return { ...c, t: Array.from(c.t), g: Array.from(c.g), flowScale: Array.from(c.flowScale) };
}

export function deserializeCurve(c: ExportCurve): Curve {
  return {
    ...c,
    t: Float32Array.from(c.t),
    g: Float32Array.from(c.g),
    flowScale: Float32Array.from(c.flowScale),
  };
}

/** FNV-1a over the rounded sample values; equal curves hash equal across devices. */
export function curveHash(c: {
  t: ArrayLike<number>;
  g: ArrayLike<number>;
  endAt: number;
}): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    const q = Math.round(v * 100);
    h ^= q & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  mix(c.endAt);
  mix(c.t.length);
  for (let i = 0; i < c.g.length; i++) mix(c.g[i] ?? 0);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function readSnapshot(db: Db, includeRaw = true): Promise<Snapshot> {
  const [settings, beans, bags, epochs, shots, curves, ratings, quality, recommendations, raw] =
    await Promise.all([
      db.get('settings', 'settings'),
      db.getAll('beans'),
      db.getAll('bags'),
      db.getAll('epochs'),
      db.getAll('shots'),
      db.getAll('curves'),
      db.getAll('ratings'),
      db.getAll('quality'),
      db.getAll('recommendations'),
      includeRaw ? db.getAll('rawRecordings') : Promise.resolve([] as RawRecording[]),
    ]);
  return {
    settings: settings ?? null,
    beans,
    bags,
    epochs,
    shots,
    curves: curves.map(serializeCurve),
    ratings,
    quality,
    recommendations,
    rawRecordings: raw,
  };
}

export async function buildExport(
  db: Db,
  opts: { includeRaw?: boolean } = {},
): Promise<ExportFile> {
  const snap = await readSnapshot(db, opts.includeRaw ?? false);
  const file: ExportFile = {
    format: 'dialin',
    schemaVersion: DB_VERSION,
    exportedAt: nowIso(),
    deviceId: snap.settings?.deviceId ?? 'unknown',
    appVersion: APP_VERSION,
    settings: snap.settings,
    beans: snap.beans,
    bags: snap.bags,
    epochs: snap.epochs,
    shots: snap.shots,
    curves: snap.curves,
    ratings: snap.ratings,
    quality: snap.quality,
    recommendations: snap.recommendations,
  };
  if (opts.includeRaw) file.rawRecordings = snap.rawRecordings;
  return file;
}

/** Run the shared migration chain over an imported file and turn it into a Snapshot. */
export function snapshotFromFile(file: ExportFile): Snapshot {
  const from = file.schemaVersion;
  const mig = <T>(store: StoreName, rows: T[] | undefined): T[] =>
    migrateRows(
      store,
      (rows ?? []) as unknown as Record<string, unknown>[],
      from,
    ) as unknown as T[];
  const settingsRows = mig<Settings>('settings', file.settings ? [file.settings] : []);
  return {
    settings: settingsRows[0] ?? null,
    beans: mig('beans', file.beans),
    bags: mig('bags', file.bags),
    epochs: mig('epochs', file.epochs),
    shots: mig('shots', file.shots),
    curves: mig('curves', file.curves),
    ratings: mig('ratings', file.ratings),
    quality: mig('quality', file.quality),
    recommendations: mig('recommendations', file.recommendations),
    rawRecordings: mig('rawRecordings', file.rawRecordings),
  };
}

function emptyCounts(): Record<MergeStore, number> {
  return {
    beans: 0,
    bags: 0,
    epochs: 0,
    shots: 0,
    curves: 0,
    ratings: 0,
    quality: 0,
    recommendations: 0,
    rawRecordings: 0,
  };
}

function newer(a: Meta, b: Meta): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  // Deterministic tie-break so merge(A,B) === merge(B,A): tombstone wins, then deviceId order.
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return Boolean(a.deleted);
  return a.deviceId > b.deviceId;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Pure merge of two snapshots. Commutative and idempotent (tested). */
export function mergeSnapshots(local: Snapshot, incoming: Snapshot): MergeResult {
  const plan: MergePlan = {
    adds: emptyCounts(),
    updates: emptyCounts(),
    unchanged: emptyCounts(),
    conflicts: [],
    settings: 'kept',
  };
  const writes: MergeResult['writes'] = [];
  const result: Snapshot = { ...local, settings: local.settings };

  for (const store of MUTABLE) {
    const map = new Map<Id, Meta>();
    for (const r of local[store] as Meta[]) map.set(r.id, r);
    for (const r of incoming[store] as Meta[]) {
      const have = map.get(r.id);
      if (!have) {
        map.set(r.id, r);
        plan.adds[store] += 1;
        writes.push({ store, row: r });
      } else if (sameJson(have, r)) {
        plan.unchanged[store] += 1;
      } else if (newer(r, have)) {
        map.set(r.id, r);
        plan.updates[store] += 1;
        writes.push({ store, row: r });
      } else plan.unchanged[store] += 1;
    }
    (result as unknown as Record<string, Meta[]>)[store] = [...map.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  for (const store of IMMUTABLE) {
    const map = new Map<Id, Meta>();
    for (const r of local[store] as Meta[]) map.set(r.id, r);
    for (const r of incoming[store] as Meta[]) {
      const have = map.get(r.id);
      if (!have) {
        map.set(r.id, r);
        plan.adds[store] += 1;
        writes.push({ store, row: r });
        continue;
      }
      if (store === 'curves') {
        const a = have as unknown as ExportCurve;
        const b = r as unknown as ExportCurve;
        if (curveHash(a) !== curveHash(b)) {
          plan.conflicts.push({
            store,
            id: r.id,
            reason: 'same id, different samples; local kept',
          });
          continue;
        }
      } else if (!sameJson(contentOf(have as unknown as Shot), contentOf(r as unknown as Shot))) {
        plan.conflicts.push({
          store,
          id: r.id,
          reason: 'same id, different shot settings; local kept',
        });
        continue;
      }
      // Same content. Metadata or the shot's two mutable link fields (deviation,
      // recommendationId) may still differ: take the newer row with the deterministic tie-break.
      if (!sameJson(have, r) && newer(r, have)) {
        map.set(r.id, r);
        plan.updates[store] += 1;
        writes.push({ store, row: r });
      } else plan.unchanged[store] += 1;
    }
    (result as unknown as Record<string, Meta[]>)[store] = [...map.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  if (incoming.settings && !local.settings?.onboardingDone) {
    result.settings = {
      ...incoming.settings,
      deviceId: local.settings?.deviceId ?? incoming.settings.deviceId,
      bleCaps: local.settings?.bleCaps ?? {},
    };
    plan.settings = 'imported';
  }
  return { result, writes, plan };
}

/** A shot's immutable content: everything except Meta and the two mutable link fields. */
function contentOf(
  s: Shot,
): Omit<
  Shot,
  'deviation' | 'recommendationId' | 'updatedAt' | 'createdAt' | 'deviceId' | 'deleted'
> {
  const {
    deviation: _d,
    recommendationId: _r,
    updatedAt: _u,
    createdAt: _c,
    deviceId: _v,
    deleted: _x,
    ...rest
  } = s;
  return rest;
}

/** Apply a merge result to the database in one transaction. */
export async function applyMerge(db: Db, merged: MergeResult): Promise<void> {
  const stores = [
    'beans',
    'bags',
    'epochs',
    'shots',
    'curves',
    'ratings',
    'quality',
    'recommendations',
    'rawRecordings',
    'settings',
  ] as const;
  const tx = db.transaction(stores, 'readwrite');
  const ops: Promise<unknown>[] = [];
  for (const w of merged.writes) {
    if (w.store === 'curves')
      ops.push(tx.objectStore('curves').put(deserializeCurve(w.row as unknown as ExportCurve)));
    else ops.push(tx.objectStore(w.store).put(w.row as never));
  }
  if (merged.plan.settings === 'imported' && merged.result.settings) {
    ops.push(tx.objectStore('settings').put(merged.result.settings));
  }
  await Promise.all(ops);
  await tx.done;
}

/** Dry-run or apply an import. Returns the plan either way. */
export async function importFile(db: Db, file: ExportFile, apply: boolean): Promise<MergePlan> {
  const incoming = snapshotFromFile(file);
  const local = await readSnapshot(db, true);
  const merged = mergeSnapshots(local, incoming);
  if (apply) await applyMerge(db, merged);
  return merged.plan;
}

export function exportFileName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `dialin-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.json`;
}
