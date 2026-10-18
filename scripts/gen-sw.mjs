// Post-build: write dist/sw.js from scripts/sw-template.js with the precache list.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '/dialin/';
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const template = readFileSync(join(here, 'sw-template.js'), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(dist)
  .map((p) => relative(dist, p).split('\\').join('/'))
  .filter((p) => p !== 'sw.js' && !p.endsWith('.map'));
const precache = files.map((p) => (p === 'index.html' ? BASE : BASE + p));
const hash = createHash('sha256');
for (const f of files) hash.update(readFileSync(join(dist, f)));
const version = hash.digest('hex').slice(0, 12);

const sw = template
  .replace('__VERSION__', version)
  .replace('__BASE__', BASE)
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
writeFileSync(join(dist, 'sw.js'), sw);
console.log(`sw.js: version ${version}, ${precache.length} precached files`);
