import { describe, expect, it } from 'vitest';
import {
  buildCommand,
  Cmd,
  commands,
  encodeWeightFrame,
  fromHex,
  parseFrame,
  SERVICE_UUID,
  toHex,
} from '../../src/scale/protocol';

// Documented layout: 03 0B | ms u24BE | unit | sign | g×100 u24BE | flow sign | g/s×100 u16BE
//                    | batt% | standby min×10 u16BE | buzzer | smoothing | 00 | XOR[0..18]
function frameHex(parts: {
  ms: number;
  unit?: number;
  wSign?: string;
  g100: number;
  fSign?: string;
  f100: number;
  batt?: number;
  standby10?: number;
  buzzer?: number;
  smoothing?: number;
}): string {
  const b = [
    0x03,
    0x0b,
    (parts.ms >> 16) & 0xff,
    (parts.ms >> 8) & 0xff,
    parts.ms & 0xff,
    parts.unit ?? 0x01,
    (parts.wSign ?? '+').charCodeAt(0),
    (parts.g100 >> 16) & 0xff,
    (parts.g100 >> 8) & 0xff,
    parts.g100 & 0xff,
    (parts.fSign ?? '+').charCodeAt(0),
    (parts.f100 >> 8) & 0xff,
    parts.f100 & 0xff,
    parts.batt ?? 87,
    ((parts.standby10 ?? 150) >> 8) & 0xff,
    (parts.standby10 ?? 150) & 0xff,
    parts.buzzer ?? 0,
    parts.smoothing ?? 0,
    0x00,
  ];
  let x = 0;
  for (const v of b) x ^= v;
  b.push(x);
  return b.map((v) => v.toString(16).padStart(2, '0')).join('');
}

describe('parseFrame', () => {
  it('parses the documented weight layout', () => {
    const hex = frameHex({ ms: 12_340, g100: 1_823, f100: 215, batt: 87, standby10: 150 });
    const r = parseFrame(fromHex(hex));
    expect(r.kind).toBe('weight');
    if (r.kind !== 'weight') return;
    expect(r.frame.timerMs).toBe(12_340);
    expect(r.frame.unit).toBe(1);
    expect(r.frame.grams).toBeCloseTo(18.23, 6);
    expect(r.frame.flowGps).toBeCloseTo(2.15, 6);
    expect(r.frame.batteryPct).toBe(87);
    expect(r.frame.standbyMin).toBe(15);
    expect(r.frame.smoothing).toBe(false);
  });

  it('handles negative weight and flow signs', () => {
    const r = parseFrame(fromHex(frameHex({ ms: 0, wSign: '-', g100: 50, fSign: '-', f100: 10 })));
    expect(r.kind).toBe('weight');
    if (r.kind !== 'weight') return;
    expect(r.frame.grams).toBeCloseTo(-0.5, 6);
    expect(r.frame.flowGps).toBeCloseTo(-0.1, 6);
  });

  it('reads 24-bit timers and weights', () => {
    const r = parseFrame(fromHex(frameHex({ ms: 0x12_34_56, g100: 0x0f_42_40, f100: 0 })));
    if (r.kind !== 'weight') throw new Error(r.kind);
    expect(r.frame.timerMs).toBe(0x123456);
    expect(r.frame.grams).toBeCloseTo(10_000, 6);
  });

  it('rejects bad length, header, checksum and sign bytes', () => {
    const good = fromHex(frameHex({ ms: 1000, g100: 100, f100: 0 }));
    expect(parseFrame(good.slice(0, 19))).toMatchObject({ kind: 'bad', reason: 'length' });
    const badHeader = new Uint8Array(good);
    badHeader[0] = 0x04;
    expect(parseFrame(badHeader)).toMatchObject({ kind: 'bad', reason: 'header' });
    const badXor = new Uint8Array(good);
    badXor[19] = (badXor[19] ?? 0) ^ 0x01;
    expect(parseFrame(badXor)).toMatchObject({ kind: 'bad', reason: 'xor' });
    const badSign = new Uint8Array(good);
    badSign[6] = 0x00;
    let x = 0;
    for (let i = 0; i < 19; i++) x ^= badSign[i] ?? 0;
    badSign[19] = x;
    expect(parseFrame(badSign)).toMatchObject({ kind: 'bad', reason: 'sign' });
  });

  it('classifies 0D/0C/0E as other and anything else as unknown', () => {
    for (const type of [0x0d, 0x0c, 0x0e]) {
      const b = new Uint8Array(20);
      b[0] = 0x03;
      b[1] = type;
      b[19] = 0x03 ^ type;
      expect(parseFrame(b)).toMatchObject({ kind: 'other', type });
    }
    const b = new Uint8Array(20);
    b[0] = 0x03;
    b[1] = 0x0f;
    b[19] = 0x03 ^ 0x0f;
    expect(parseFrame(b)).toMatchObject({ kind: 'unknown', type: 0x0f });
  });

  it('round-trips through encodeWeightFrame', () => {
    const f = {
      timerMs: 25_400,
      unit: 1,
      grams: 36.2,
      flowGps: 1.85,
      batteryPct: 64,
      standbyMin: 30,
      buzzer: 1,
      smoothing: true,
    };
    const r = parseFrame(encodeWeightFrame(f));
    expect(r.kind).toBe('weight');
    if (r.kind !== 'weight') return;
    expect(r.frame).toEqual(f);
  });
});

describe('buildCommand', () => {
  const vectors: [string, Uint8Array, string][] = [
    ['tare', commands.tare(), '030a01000008'],
    ['start', commands.start(), '030a0400000d'],
    ['stop', commands.stop(), '030a0500000c'],
    ['reset', commands.reset(), '030a0600000f'],
    ['tare+start', commands.tareStart(), '030a0700000e'],
    ['smoothing off', commands.smoothing(false), '030a08000001'],
    ['smoothing on', commands.smoothing(true), '030a08010000'],
    ['auto-off 30 min', commands.autoOff(30), '030a03001e14'],
    ['auto-off 5 min', commands.autoOff(5), '030a0300050f'],
    ['beep 1', commands.beep(1), '030a0200010a'],
    ['beep 3', commands.beep(3), '030a02000308'],
  ];
  for (const [name, bytes, hex] of vectors) {
    it(`emits exactly ${hex} for ${name}`, () => {
      expect(toHex(bytes)).toBe(hex);
    });
  }

  it('never emits the legacy wrong checksums (0A/0D/0C/00 for 04/05/06/07)', () => {
    expect(buildCommand(Cmd.start)[5]).not.toBe(0x0a);
    expect(buildCommand(Cmd.stop)[5]).not.toBe(0x0d);
    expect(buildCommand(Cmd.reset)[5]).not.toBe(0x0c);
    expect(buildCommand(Cmd.tareStart)[5]).not.toBe(0x00);
  });

  it('computes the XOR at runtime for any payload', () => {
    for (let cmd = 0; cmd < 256; cmd += 7) {
      for (const d2 of [0, 1, 0x1e, 0xff]) {
        const b = buildCommand(cmd, 0, d2);
        expect(b.length).toBe(6);
        expect(b[5]).toBe(0x03 ^ 0x0a ^ cmd ^ 0 ^ d2);
      }
    }
  });

  it('clamps auto-off and beep arguments', () => {
    expect(commands.autoOff(99)[4]).toBe(30);
    expect(commands.autoOff(1)[4]).toBe(5);
    expect(commands.beep(9)[4]).toBe(5);
  });
});

describe('constants', () => {
  it('uses the full 128-bit service UUID string', () => {
    expect(SERVICE_UUID).toBe('00000ffe-0000-1000-8000-00805f9b34fb');
  });
});
