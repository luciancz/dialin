// Renders the service worker from scripts/sw-template.js. Shared by gen-sw.mjs and the tests.
// Tokens appear only in code (never in comments) and every occurrence is replaced.

/**
 * @param {{ template: string, precache: string[], version: string, base: string }} o
 * @returns {string}
 */
export function renderSw({ template, precache, version, base }) {
  const out = template
    .replaceAll('__SW_VERSION__', version)
    .replaceAll('__SW_BASE__', base)
    .replaceAll('__SW_PRECACHE__', JSON.stringify(precache, null, 2));
  const left = out.match(/__SW_[A-Z]+__/);
  if (left) throw new Error(`sw.js: token ${left[0]} not replaced`);
  return out;
}
