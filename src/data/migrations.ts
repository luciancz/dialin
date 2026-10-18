/**
 * Pure per-store migrations v(n) → v(n+1) over plain objects. Both the IndexedDB
 * `upgrade` hook (db.ts) and the JSON importer (exportImport.ts) run this same chain,
 * so there is one path and one test. DB_VERSION 1 has no steps yet; the scaffolding is
 * what matters.
 */

export const DB_VERSION = 1;

export const STORE_NAMES = [
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
export type StoreName = (typeof STORE_NAMES)[number];

export type RowMigration = (row: Record<string, unknown>) => Record<string, unknown> | null;

/** steps[v] migrates rows from schema version v to v+1, per store. */
export type MigrationSteps = Record<number, Partial<Record<StoreName, RowMigration>>>;

export const MIGRATIONS: MigrationSteps = {
  // Example for a future change:
  // 1: { bags: (row) => ({ ...row, newField: row.newField ?? 'default' }) },
};

/** Migrate `rows` of `store` from `fromVersion` to `toVersion` (null results are dropped). */
export function migrateRows(
  store: StoreName,
  rows: Record<string, unknown>[],
  fromVersion: number,
  toVersion = DB_VERSION,
  steps: MigrationSteps = MIGRATIONS,
): Record<string, unknown>[] {
  if (fromVersion > toVersion) {
    throw new Error(`schema version ${fromVersion} is newer than this app's ${toVersion}`);
  }
  let out = rows;
  for (let v = fromVersion; v < toVersion; v++) {
    const fn = steps[v]?.[store];
    if (!fn) continue;
    const next: Record<string, unknown>[] = [];
    for (const r of out) {
      const m = fn(r);
      if (m !== null) next.push(m);
    }
    out = next;
  }
  return out;
}

/** Which stores have at least one step between the two versions. */
export function storesNeedingMigration(
  fromVersion: number,
  toVersion = DB_VERSION,
  steps: MigrationSteps = MIGRATIONS,
): StoreName[] {
  const set = new Set<StoreName>();
  for (let v = fromVersion; v < toVersion; v++) {
    for (const k of Object.keys(steps[v] ?? {})) set.add(k as StoreName);
  }
  return [...set];
}
