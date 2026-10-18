/** uuidv7 (RFC 9562): 48-bit ms timestamp, version 7, 74 random bits from an injected source. */

export type RandomBytes = (n: number) => Uint8Array;

export function uuidv7(nowMs: number, random: RandomBytes): string {
  const b = new Uint8Array(16);
  const t = Math.max(0, Math.floor(nowMs));
  b[0] = (t / 2 ** 40) & 0xff;
  b[1] = (t / 2 ** 32) & 0xff;
  b[2] = (t >>> 24) & 0xff;
  b[3] = (t >>> 16) & 0xff;
  b[4] = (t >>> 8) & 0xff;
  b[5] = t & 0xff;
  const r = random(10);
  for (let i = 0; i < 10; i++) b[6 + i] = r[i] ?? 0;
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70; // version 7
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Random source from a seeded PRNG (tests, simulator). */
export function randomBytesFrom(rng: () => number): RandomBytes {
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256) & 0xff;
    return out;
  };
}

export function isUuid(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}
