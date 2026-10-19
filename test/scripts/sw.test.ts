/**
 * The generated service worker must be valid JavaScript with every token filled in (until
 * 2026-10-19 the first replace hit the header comment and the deployed worker threw on
 * `__PRECACHE__`), precache the given list, and serve the cached shell offline.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderSw } from '../../scripts/sw-build.mjs';

const template = readFileSync(new URL('../../scripts/sw-template.js', import.meta.url), 'utf8');
const precache = ['/dialin/', '/dialin/assets/index-abc.js', '/dialin/assets/three-def.js'];

type Listener = (event: Record<string, unknown>) => void;

function load(sw: string) {
  const listeners: Record<string, Listener> = {};
  const store = new Map<string, string>();
  const added: string[][] = [];
  const cache = {
    addAll: async (list: string[]) => {
      added.push(list);
      for (const u of list) store.set(u, `cached ${u}`);
    },
    put: async (req: { url: string }, res: string) => {
      store.set(new URL(req.url).pathname, res);
    },
  };
  const caches = {
    open: async () => cache,
    keys: async () => [],
    delete: async () => true,
    match: async (req: string | { url: string }, opts?: { ignoreSearch?: boolean }) => {
      const url = typeof req === 'string' ? req : new URL(req.url).pathname;
      const key = opts?.ignoreSearch ? url.split('?')[0] : url;
      return store.get(key ?? '');
    },
  };
  const self = {
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    location: { origin: 'https://luciancz.github.io' },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
  };
  const offline = async () => {
    throw new Error('offline');
  };
  new Function('self', 'caches', 'fetch', sw)(self, caches, offline);
  return { listeners, added, store };
}

describe('service worker build', () => {
  it('fills every token, including ones a comment could shadow', () => {
    const sw = renderSw({ template, precache, version: 'v123', base: '/dialin/' });
    expect(sw).not.toMatch(/__[A-Z_]+__/);
    expect(sw).toContain("const VERSION = 'v123';");
    expect(sw).toContain('/dialin/assets/three-def.js');
    expect(() =>
      renderSw({ template: 'x __SW_OTHER__', precache, version: 'v', base: '/' }),
    ).toThrow(/not replaced/);
  });

  it('precaches the list on install and serves the shell offline for a navigation', async () => {
    const sw = renderSw({ template, precache, version: 'v1', base: '/dialin/' });
    const { listeners, added } = load(sw);
    let installed: Promise<unknown> | undefined;
    listeners.install?.({ waitUntil: (p: Promise<unknown>) => (installed = p) });
    await installed;
    expect(added[0]).toEqual(precache);
    let response: Promise<unknown> | undefined;
    listeners.fetch?.({
      request: {
        method: 'GET',
        mode: 'navigate',
        url: 'https://luciancz.github.io/dialin/?demo=1',
      },
      respondWith: (p: Promise<unknown>) => (response = p),
    });
    expect(await response).toBe('cached /dialin/');
  });
});
