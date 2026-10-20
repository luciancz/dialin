import { describe, expect, it } from 'vitest';
import { computeFeatures } from '../../src/core/curve/features';
import { resample } from '../../src/core/curve/resample';
import { mulberry32 } from '../../src/core/math/rng';
import { recommend } from '../../src/core/recommend';
import { bagContext, channelFlagOf, curveChannelled, replay } from '../../src/core/replay';
import { type CurveSpec, synthCurve } from '../../src/core/sim/curveSynth';
import type {
  Bag,
  Bean,
  CalibrationEpoch,
  Features,
  Rating,
  Shot,
  ShotQuality,
} from '../../src/core/types';
import { DEFAULT_DIAL_SPEC, fromLines, toLines } from '../../src/core/units';

/**
 * A choked shot on a bottomless portafilter, shaped like a real one (18 → 41 g in 70 s at a
 * too-fine dial): nothing for 22 s, then spurts that come closer together, a thin stream from
 * 44 s that wavers and keeps speeding up as the puck opens, stop at 41 g.
 */
function chokedShot(seed = 1) {
  const rng = mulberry32(seed);
  const t: number[] = [];
  const g: number[] = [];
  let w = 0;
  let spurtAt = 22;
  let spurtEnd = 22;
  const endAt = 70;
  for (let k = 0; k <= (endAt + 6) * 10; k++) {
    const s = k / 10;
    let flow = 0;
    if (s >= 22 && s < 44) {
      // Spurts of ~0.5 s at about 1 g/s, the pauses shrinking from 2 s to 0.3 s.
      if (s >= spurtAt) {
        spurtEnd = spurtAt + 0.4 + 0.3 * rng();
        spurtAt = spurtEnd + (2 - (1.7 * (s - 22)) / 22) * (0.6 + 0.8 * rng());
      }
      if (s < spurtEnd) flow = 0.8 + 0.4 * rng();
    } else if (s >= 44 && s <= endAt) {
      // The stream: 0.6 → 2.2 g/s, wavering for its first 10 s.
      const base = 0.6 + (1.6 * (s - 44)) / (endAt - 44);
      flow = s < 54 ? base * (0.55 + 0.9 * Math.abs(Math.sin(s * 1.3))) : base;
    }
    w += flow / 10;
    t.push(s);
    g.push(Math.round((w + (rng() - 0.5) * 0.04) * 100) / 100);
  }
  const grid = resample(
    t.map((x, i) => ({ t: x, g: g[i] ?? 0 })),
    endAt + 6,
  );
  return computeFeatures({
    t: grid.t,
    g: grid.g,
    mask: grid.mask,
    endAt,
    finalYieldG: w,
    firstDripKnown: true,
    roastLevel: 'light',
  });
}

const base: CurveSpec = {
  firstDripS: 8,
  plateauGps: 1.9,
  rampS: 3,
  lateRise: 0,
  stopAtG: 36,
  tailG: 1.2,
  tailS: 4.5,
  noiseG: 0.05,
  truncG: 0.1,
};

function synthFeatures(spec: CurveSpec): Features {
  const c = synthCurve(spec, mulberry32(1));
  const grid = resample(
    c.t.map((t, i) => ({ t, g: c.g[i] ?? 0 })),
    c.endAt + 6,
  );
  return computeFeatures({
    t: grid.t,
    g: grid.g,
    mask: grid.mask,
    endAt: c.endAt,
    finalYieldG: c.finalYieldG,
    firstDripKnown: true,
    roastLevel: 'light',
  });
}

const meta = { createdAt: 'x', updatedAt: 'x', deviceId: 'd' };
const bean: Bean = {
  ...meta,
  id: 'bean',
  roaster: 'R',
  name: 'N',
  roastLevel: 'light',
  roastTarget: 'espresso',
  process: 'washed',
  decaf: false,
};
const epoch: CalibrationEpoch = {
  ...meta,
  id: 'e1',
  startedAt: '2026-09-01T00:00:00.000Z',
  kind: 'initial',
  dialSpec: DEFAULT_DIAL_SPEC,
  burrSet: 'stock',
  washerCount: 0,
  springSet: 'stock',
  chirp: fromLines(230, DEFAULT_DIAL_SPEC),
};
const bag: Bag = {
  ...meta,
  id: 'bag',
  beanId: 'bean',
  roastDate: '2026-09-01',
  doseDefaultG: 18,
  targetYieldG: 41,
  storage: [],
  rpm: 1000,
  tsSeed: 3,
  archived: false,
};

function mkShot(i: number, lines: number, features: Features): Shot {
  return {
    ...meta,
    id: `s${i}`,
    bagId: 'bag',
    epochId: 'e1',
    at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
    settings: {
      grind: { dialPos: fromLines(lines, DEFAULT_DIAL_SPEC), rpm: 1000, rpmConfirmed: true },
      doseG: 18,
      targetYieldG: 41,
      tempSwitch: 1,
    },
    context: { shotIndexOfDay: 1, appVersion: 't' },
    features,
    endedBy: 'auto',
    recommendationId: null,
    deviation: null,
  };
}

const quality = (shotId: string, over: Partial<ShotQuality> = {}): ShotQuality => ({
  ...meta,
  id: `q-${shotId}`,
  shotId,
  status: 'ok',
  learn: true,
  notes: [],
  ...over,
});

/** The card after three shots: coarse and fast, a little fast, then the choked one, bitter. */
function cardAfter(
  last: Features,
  opts: { mark?: Partial<ShotQuality>; sourBitter?: Rating['sourBitter'] } = {},
) {
  const steady = (gps: number): Features => ({ ...synthFeatures(base), plateauFlow: gps });
  const shots = [mkShot(0, 258, steady(3.0)), mkShot(1, 253, steady(2.3)), mkShot(2, 251, last)];
  const rating: Rating = {
    ...meta,
    id: 'r2',
    shotId: 's2',
    comparedToShotId: 's1',
    vsPrevious: null,
    sourBitter: opts.sourBitter === undefined ? 3 : opts.sourBitter,
    thinHeavy: 1,
    chips: ['harsh'],
    drink: 'black',
  };
  const r = replay({
    epochs: [epoch],
    beans: [bean],
    bags: [bag],
    shots,
    ratings: [rating],
    quality: shots.map((s) => quality(s.id, s.id === 's2' ? (opts.mark ?? {}) : {})),
    recommendations: [],
  });
  const ctx = bagContext(r, 'bag');
  const { rec } = recommend({
    bag,
    bean,
    epoch,
    shots: ctx.views,
    model: r.model,
    setpoint: ctx.setpoint,
    current: (shots[2] as Shot).settings,
    now: '2026-10-20T00:00:00.000Z',
    shotsSinceBodyMove: ctx.shotsSinceBodyMove,
    balance: r.balance,
    tempCardShown: ctx.tempCardShown,
  });
  return { rec, lines: toLines(rec.next.grind.dialPos, DEFAULT_DIAL_SPEC) };
}

describe('channeling vs a slow puck', () => {
  it("a choked shot's sputtering start trips the curve score but is not channeling", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const f = chokedShot(seed);
      expect(f.curveChannelScore).toBeGreaterThanOrEqual(0.5);
      expect(f.flags).toContain('late_drip');
      expect(f.flags).toContain('choked');
      expect(curveChannelled(f)).toBe(false);
      expect(channelFlagOf(f, null)).toBe(false);
    }
  });

  it('a spike at normal speed still counts; the chip counts; the user has the last word', () => {
    const spiky = synthFeatures({ ...base, spike: { atS: 18, gps: 0.9, durS: 1.5 } });
    expect(spiky.flags).not.toContain('late_drip');
    expect(channelFlagOf(spiky, null)).toBe(true);
    const choked = chokedShot();
    const chip = { chips: ['channelled'] } as unknown as Rating;
    expect(channelFlagOf(choked, chip)).toBe(true);
    expect(channelFlagOf(spiky, chip, quality('s', { notChannelled: true }))).toBe(false);
  });

  it('after the choked shot the card grinds coarser instead of asking for puck prep', () => {
    const choked = { ...chokedShot(), plateauFlow: 1.26 };
    const { rec, lines } = cardAfter(choked);
    expect(rec.lever).not.toBe('prep');
    expect(lines).toBeGreaterThan(251);
    // The same curve without the slow start read as channeling, as before.
    const asChannel = { ...choked, flags: choked.flags.filter((x) => x === 'spike') };
    expect(cardAfter(asChannel).rec.lever).toBe('prep');
    // "No channeling" on that card: the grind moves.
    const told = cardAfter(asChannel, { mark: { notChannelled: true } });
    expect(told.rec.lever).not.toBe('prep');
    expect(told.lines).toBeGreaterThan(251);
  });

  it('a slow outlier is believed when it tasted bitter or the user says it was real', () => {
    const choked = { ...chokedShot(), plateauFlow: 1.26 };
    // Unrated, 4.5σ off: the card asks to repeat it.
    const unrated = cardAfter(choked, { sourBitter: null });
    expect(unrated.rec.lever).toBe('none');
    expect(unrated.rec.sentence).toMatch(/off the model/);
    // "It was real": no repeat, the grind moves.
    const real = cardAfter(choked, { sourBitter: null, mark: { confirmed: true } });
    expect(real.rec.lever).toBe('grind');
    expect(real.lines).toBeGreaterThan(251);
    // Rated bitter (the default here): believed without asking.
    expect(cardAfter(choked).rec.lever).toBe('grind');
  });
});
