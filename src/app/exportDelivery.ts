/**
 * Deliver an export file: share sheet (Bluefy → Files / AirDrop) → blob download →
 * clipboard. Returns which path worked so Diagnostics can record it.
 */

export type DeliveryMethod = 'share' | 'download' | 'clipboard' | 'failed';

export async function deliverJson(filename: string, json: string): Promise<DeliveryMethod> {
  const file = new File([json], filename, { type: 'application/json' });
  try {
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return 'share';
    }
  } catch (err) {
    // AbortError = user dismissed the sheet; fall through to a download.
    if (err instanceof Error && err.name === 'AbortError') return 'failed';
  }
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'download';
  } catch {
    /* fall through */
  }
  try {
    await navigator.clipboard.writeText(json);
    return 'clipboard';
  } catch {
    return 'failed';
  }
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsText(file);
  });
}
