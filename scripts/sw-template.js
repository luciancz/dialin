/* Hand-written service worker for the GitHub Pages build.
 * scripts/gen-sw.mjs replaces __PRECACHE__ with the hashed asset list and
 * __VERSION__ with a content hash. It is a Windows-only nicety: WKWebView
 * (Bluefy) has no supported service worker path, and the app never depends on it.
 */
const VERSION = '__VERSION__';
const BASE = '__BASE__';
const PRECACHE = __PRECACHE__;
const CACHE = `dialin-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(`${BASE}assets/`)) {
    // Hashed assets never change under the same name: cache first.
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => putInCache(req, res))),
    );
    return;
  }
  if (req.mode === 'navigate' || url.pathname === BASE || url.pathname === `${BASE}index.html`) {
    // Navigations: network first, cached index.html as the offline fallback.
    event.respondWith(
      fetch(req)
        .then((res) => putInCache(req, res))
        .catch(() => caches.match(`${BASE}index.html`)),
    );
  }
});

function putInCache(req, res) {
  if (res?.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => cache.put(req, copy));
  }
  return res;
}
