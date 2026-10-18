/** Hand-written runtime validation of an export file. Lenient on optional fields, strict on shape. */
import type { ExportFile } from './exportImport';

export type ValidationResult = { ok: true; file: ExportFile } | { ok: false; errors: string[] };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function checkMetaRows(
  name: string,
  rows: unknown,
  errors: string[],
  required: string[] = [],
): void {
  if (!Array.isArray(rows)) {
    errors.push(`${name}: expected an array`);
    return;
  }
  rows.forEach((r, i) => {
    if (!isObj(r)) {
      errors.push(`${name}[${i}]: not an object`);
      return;
    }
    for (const k of ['id', 'createdAt', 'updatedAt', 'deviceId', ...required]) {
      if (!(k in r)) errors.push(`${name}[${i}]: missing ${k}`);
    }
    if (typeof r.id !== 'string') errors.push(`${name}[${i}]: id must be a string`);
  });
}

export function validateExportFile(x: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(x)) return { ok: false, errors: ['not a JSON object'] };
  if (x.format !== 'dialin') errors.push(`format must be "dialin" (got ${String(x.format)})`);
  if (typeof x.schemaVersion !== 'number') errors.push('schemaVersion must be a number');
  if (typeof x.exportedAt !== 'string') errors.push('exportedAt must be a string');
  checkMetaRows('beans', x.beans, errors, ['roaster', 'name', 'roastLevel']);
  checkMetaRows('bags', x.bags, errors, ['beanId', 'roastDate', 'doseDefaultG', 'targetYieldG']);
  checkMetaRows('epochs', x.epochs, errors, ['startedAt', 'kind', 'dialSpec']);
  checkMetaRows('shots', x.shots, errors, ['bagId', 'epochId', 'at', 'settings', 'features']);
  checkMetaRows('curves', x.curves, errors, ['shotId', 't', 'g', 'endAt']);
  checkMetaRows('ratings', x.ratings, errors, ['shotId']);
  checkMetaRows('quality', x.quality, errors, ['shotId', 'status', 'learn']);
  checkMetaRows('recommendations', x.recommendations, errors, ['bagId', 'lever', 'next']);
  if (x.rawRecordings !== undefined)
    checkMetaRows('rawRecordings', x.rawRecordings, errors, ['frames']);
  if (Array.isArray(x.curves)) {
    x.curves.forEach((c, i) => {
      if (!isObj(c)) return;
      for (const k of ['t', 'g', 'flowScale']) {
        const v = c[k];
        if (!Array.isArray(v) || v.some((n) => typeof n !== 'number')) {
          errors.push(`curves[${i}].${k}: expected a number array`);
        }
      }
    });
  }
  if (x.settings !== null && x.settings !== undefined && !isObj(x.settings))
    errors.push('settings must be an object or null');
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, file: x as unknown as ExportFile };
}
