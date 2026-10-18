/**
 * Demo-mode flag. Demo mode uses its own IndexedDB database, so simulated shots never mix
 * with real ones. On with `?demo=1` in the URL or the stored flag; storage may be blocked,
 * so every access is guarded.
 */

const FLAG_KEY = 'dialin-demo';
export const DEMO_DB_NAME = 'dialin-demo';

export function isDemo(): boolean {
  try {
    if (
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('demo') === '1'
    ) {
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemoFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG_KEY, '1');
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    /* ignore: the ?demo=1 URL still works */
  }
}

/** Reload into or out of demo mode, landing on `hash`. */
export function reloadInto(demo: boolean, hash: string): void {
  setDemoFlag(demo);
  const params = new URLSearchParams(location.search);
  if (demo) params.set('demo', '1');
  else params.delete('demo');
  const search = params.toString();
  const url = `${location.pathname}${search ? `?${search}` : ''}#${hash}`;
  if (url === `${location.pathname}${location.search}${location.hash}`) location.reload();
  else {
    location.replace(url);
    // Same path and search: replace() only changes the hash, so force the reload.
    if (search === location.search.replace(/^\?/, '')) location.reload();
  }
}
