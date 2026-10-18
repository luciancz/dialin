/// <reference types="node" />
/**
 * Synthetic frame fixtures. The generator is deterministic (seeded clock, RNG and curve);
 * the committed JSON under test/fixtures/synthetic must equal what the generator produces,
 * and the replay transport must stream it back frame for frame. On a fresh checkout with
 * the files missing, this test writes them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/math/rng';
import { type CurveSpec, synthCurve } from '../../src/core/sim/curveSynth';
import type { RawFrameRow } from '../../src/core/types';
import { FakeClock } from '../../src/scale/clock';
import { FakeTransport } from '../../src/scale/fakeTransport';
import { commands, fromHex, parseFrame } from '../../src/scale/protocol';
import { ReplayTransport } from '../../src/scale/replayTransport';

const DIR = join(__dirname, '..', 'fixtures', 'synthetic');

interface Fixture {
  format: 'dialin-frames';
  name: string;
  description: string;
  rows: RawFrameRow[];
}

const SPECS: Record<
  string,
  { spec: CurveSpec; seed: number; persona?: 'auto'; description: string }
> = {
  'normal-36g': {
    seed: 11,
    description: 'Timer mode, 18 g → 36 g at 1.9 g/s plateau, first drip 8 s, clean.',
    spec: {
      firstDripS: 8,
      plateauGps: 1.9,
      rampS: 3,
      lateRise: 0.02,
      stopAtG: 36,
      tailG: 1.3,
      tailS: 4.5,
      noiseG: 0.05,
      truncG: 0.1,
    },
  },
  'channeling-spike': {
    seed: 12,
    description: 'Timer mode with a +0.9 g/s spike for 1.5 s at 17 s and two dips.',
    spec: {
      firstDripS: 7,
      plateauGps: 2.1,
      rampS: 3,
      lateRise: 0.05,
      stopAtG: 36,
      tailG: 1.5,
      tailS: 4.5,
      noiseG: 0.05,
      truncG: 0.1,
      spike: { atS: 17, gps: 0.9, durS: 1.5 },
      dips: [
        { atS: 14, depth: 0.5, durS: 0.8 },
        { atS: 22, depth: 0.5, durS: 0.9 },
      ],
    },
  },
  'slow-choked': {
    seed: 13,
    description: 'Too fine: 0.6 g/s plateau, first drip 14 s, stops at 30 g after a long pull.',
    spec: {
      firstDripS: 14,
      plateauGps: 0.6,
      rampS: 4,
      lateRise: 0.03,
      stopAtG: 30,
      tailG: 0.8,
      tailS: 5,
      noiseG: 0.05,
      truncG: 0.1,
    },
  },
  'auto-mode': {
    seed: 14,
    persona: 'auto',
    description: 'Scale in Auto mode: ignores tare+start, emits 03 0D on FF12, timer self-starts.',
    spec: {
      firstDripS: 8,
      plateauGps: 1.9,
      rampS: 3,
      lateRise: 0.02,
      stopAtG: 36,
      tailG: 1.3,
      tailS: 4.5,
      noiseG: 0.05,
      truncG: 0.1,
    },
  },
};

function generate(name: string): Fixture {
  const cfg = SPECS[name];
  if (!cfg) throw new Error(name);
  const clock = new FakeClock(0);
  const fake = new FakeTransport({
    clock,
    seed: cfg.seed,
    persona: cfg.persona ? { mode: 'auto' } : {},
  });
  const rows: RawFrameRow[] = [];
  let seq = 0;
  fake.onFrame((src, bytes, tRxMs) => {
    seq += 1;
    rows.push([
      seq,
      Math.round(tRxMs),
      src,
      Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
    ]);
  });
  fake.setCupWeight(118.3);
  void fake.connect();
  clock.advance(2000);
  void fake.write(commands.smoothing(false));
  clock.advance(150);
  void fake.write(commands.autoOff(30));
  clock.advance(1500);
  void fake.write(commands.tareStart());
  const curve = synthCurve(cfg.spec, mulberry32(cfg.seed), 100, 8);
  fake.startShot({ t: curve.t, g: curve.g });
  clock.advance(Math.round((curve.endAt + 0.3) * 1000));
  void fake.write(commands.stop());
  clock.advance(7000);
  void fake.disconnect();
  return { format: 'dialin-frames', name, description: cfg.description, rows };
}

describe('synthetic fixtures', () => {
  for (const name of Object.keys(SPECS)) {
    it(`${name}: committed file matches the generator and replays frame for frame`, () => {
      const fx = generate(name);
      expect(fx.rows.length).toBeGreaterThan(200);
      mkdirSync(DIR, { recursive: true });
      const file = join(DIR, `${name}.json`);
      if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(fx)}\n`);
      const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Fixture;
      expect(onDisk.rows).toEqual(fx.rows);

      // Every FF11 row parses as a weight frame; FF12 rows are the undocumented serial/auto frames.
      let weights = 0;
      let maxG = 0;
      for (const r of fx.rows) {
        const p = parseFrame(fromHex(r[3]));
        expect(p.kind).not.toBe('bad');
        if (p.kind === 'weight') {
          weights++;
          maxG = Math.max(maxG, p.frame.grams);
        }
      }
      expect(weights).toBeGreaterThan(200);
      expect(maxG).toBeGreaterThan(29);

      // Replay streams the same rows in order with the recorded spacing.
      const clock = new FakeClock(5000);
      const replay = new ReplayTransport(fx.rows, { clock, speed: 1 });
      const got: RawFrameRow[] = [];
      const times: number[] = [];
      replay.onFrame((src, bytes, tRxMs) => {
        got.push([
          got.length + 1,
          0,
          src,
          Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
        ]);
        times.push(tRxMs);
      });
      let ended = false;
      replay.onDisconnect(() => {
        ended = true;
      });
      void replay.connect();
      clock.advance(120_000);
      expect(got.map((r) => r[3])).toEqual(fx.rows.map((r) => r[3]));
      const first = fx.rows[0];
      const last = fx.rows[fx.rows.length - 1];
      if (first && last) {
        expect((times[times.length - 1] ?? 0) - (times[0] ?? 0)).toBe(last[1] - first[1]);
      }
      expect(ended).toBe(true);
    });
  }
});
