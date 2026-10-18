/**
 * Hash router (~40 lines). Hash routes mean a refresh on GitHub Pages never 404s.
 * Patterns use ':name' segments, e.g. match(route, '/bag/:id') → { id }.
 */
import { signal } from '@preact/signals';

export interface Route {
  path: string;
  query: URLSearchParams;
}

function parse(): Route {
  const raw = typeof location === 'undefined' ? '/' : location.hash.replace(/^#/, '') || '/';
  const qIndex = raw.indexOf('?');
  const p = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const q = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  return { path: p.startsWith('/') ? p : `/${p}`, query: new URLSearchParams(q) };
}

export const route = signal<Route>(parse());

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.value = parse();
  });
}

export function navigate(path: string): void {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (location.hash === target) route.value = parse();
  else location.hash = target;
}

/** Returns the named params when the pattern matches, else null. */
export function match(path: string, pattern: string): Record<string, string> | null {
  const a = path.split('/').filter(Boolean);
  const b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < b.length; i++) {
    const seg = b[i] ?? '';
    const got = a[i] ?? '';
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(got);
    else if (seg !== got) return null;
  }
  return params;
}
