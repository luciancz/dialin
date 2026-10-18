/**
 * Bookoo Themis Mini wire protocol. Pure: no DOM, no state.
 *
 * Source: BooKooCode/OpenSource bookoo_mini_scale/protocols.md (MIT), commit 6c9f39d
 * (2026-07-30) for the u24 / standby×10 / reserved wording, and misch0n/smart-scale
 * hardware tests for FF12 notifications. The official doc shipped wrong command
 * checksums for a year (0A/0D/0C/00 for start/stop/reset/tare+start), which
 * Beanconqueror, aiobookoo and AcaiaArduinoBLE copied; the XOR here is computed at
 * runtime and no checksum literal appears outside the tests.
 */

export const SERVICE_UUID = '00000ffe-0000-1000-8000-00805f9b34fb';
export const WEIGHT_CHAR_UUID = '0000ff11-0000-1000-8000-00805f9b34fb';
export const COMMAND_CHAR_UUID = '0000ff12-0000-1000-8000-00805f9b34fb';
/** Nordic Secure DFU service also advertised by fw 1.4.1; listed as optional only. */
export const DFU_SERVICE_UUID = '0000fe59-0000-1000-8000-00805f9b34fb';

export const FRAME_LENGTH = 20;
export const FRAME_HEADER = 0x03;
export const FRAME_TYPE_WEIGHT = 0x0b;
export const COMMAND_HEADER = 0x0a;

export const Cmd = {
  tare: 0x01,
  beep: 0x02,
  autoOff: 0x03,
  start: 0x04,
  stop: 0x05,
  reset: 0x06,
  tareStart: 0x07,
  smoothing: 0x08,
} as const;
export type CmdName = keyof typeof Cmd;

const SIGN_PLUS = 0x2b;
const SIGN_MINUS = 0x2d;

export interface WeightFrame {
  timerMs: number;
  unit: number;
  grams: number;
  flowGps: number;
  batteryPct: number;
  /** Configured auto-off in minutes (the field is the setting, not a countdown). */
  standbyMin: number;
  buzzer: number;
  smoothing: boolean;
}

export type ParsedFrame =
  | { kind: 'weight'; frame: WeightFrame }
  | { kind: 'other'; type: number; raw: Uint8Array }
  | { kind: 'unknown'; type: number; raw: Uint8Array }
  | { kind: 'bad'; reason: 'length' | 'header' | 'xor' | 'sign'; raw: Uint8Array };

export function xorChecksum(bytes: Uint8Array, end: number): number {
  let x = 0;
  for (let i = 0; i < end; i++) x ^= bytes[i] ?? 0;
  return x;
}

function u24BE(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 16) | ((b[at + 1] ?? 0) << 8) | (b[at + 2] ?? 0);
}

function u16BE(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}

function signOf(byte: number | undefined): 1 | -1 | null {
  if (byte === SIGN_PLUS) return 1;
  if (byte === SIGN_MINUS) return -1;
  return null;
}

export function parseFrame(b: Uint8Array): ParsedFrame {
  if (b.length !== FRAME_LENGTH) return { kind: 'bad', reason: 'length', raw: b };
  if (b[0] !== FRAME_HEADER) return { kind: 'bad', reason: 'header', raw: b };
  if (xorChecksum(b, FRAME_LENGTH - 1) !== b[FRAME_LENGTH - 1]) {
    return { kind: 'bad', reason: 'xor', raw: b };
  }
  const type = b[1] ?? 0;
  if (type === FRAME_TYPE_WEIGHT) {
    const wSign = signOf(b[6]);
    const fSign = signOf(b[10]);
    if (wSign === null || fSign === null) return { kind: 'bad', reason: 'sign', raw: b };
    return {
      kind: 'weight',
      frame: {
        timerMs: u24BE(b, 2),
        unit: b[5] ?? 0,
        grams: (wSign * u24BE(b, 7)) / 100,
        flowGps: (fSign * u16BE(b, 11)) / 100,
        batteryPct: b[13] ?? 0,
        standbyMin: u16BE(b, 14) / 10,
        buzzer: b[16] ?? 0,
        smoothing: b[17] === 1,
      },
    };
  }
  if (type === 0x0d || type === 0x0c || type === 0x0e) return { kind: 'other', type, raw: b };
  return { kind: 'unknown', type, raw: b };
}

/** `03 0A CMD D1 D2 XOR` with the XOR over the first five bytes. */
export function buildCommand(cmd: number, d1 = 0, d2 = 0): Uint8Array {
  const out = new Uint8Array(6);
  out[0] = FRAME_HEADER;
  out[1] = COMMAND_HEADER;
  out[2] = cmd & 0xff;
  out[3] = d1 & 0xff;
  out[4] = d2 & 0xff;
  out[5] = xorChecksum(out, 5);
  return out;
}

export const commands = {
  tare: () => buildCommand(Cmd.tare),
  start: () => buildCommand(Cmd.start),
  stop: () => buildCommand(Cmd.stop),
  reset: () => buildCommand(Cmd.reset),
  tareStart: () => buildCommand(Cmd.tareStart),
  /** 0 = off (raw weight), 1 = on. */
  smoothing: (on: boolean) => buildCommand(Cmd.smoothing, on ? 1 : 0),
  /** 5..30 minutes. */
  autoOff: (minutes: number) => buildCommand(Cmd.autoOff, 0, clampInt(minutes, 5, 30)),
  /** Beep n times (1..5). */
  beep: (n: number) => buildCommand(Cmd.beep, 0, clampInt(n, 1, 5)),
};

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** Build a well-formed 20-byte weight frame (used by the frame synthesiser and tests). */
export function encodeWeightFrame(f: WeightFrame): Uint8Array {
  const b = new Uint8Array(FRAME_LENGTH);
  b[0] = FRAME_HEADER;
  b[1] = FRAME_TYPE_WEIGHT;
  const t = Math.max(0, Math.min(0xffffff, Math.round(f.timerMs)));
  b[2] = (t >> 16) & 0xff;
  b[3] = (t >> 8) & 0xff;
  b[4] = t & 0xff;
  b[5] = f.unit & 0xff;
  b[6] = f.grams < 0 ? SIGN_MINUS : SIGN_PLUS;
  const g = Math.min(0xffffff, Math.round(Math.abs(f.grams) * 100));
  b[7] = (g >> 16) & 0xff;
  b[8] = (g >> 8) & 0xff;
  b[9] = g & 0xff;
  b[10] = f.flowGps < 0 ? SIGN_MINUS : SIGN_PLUS;
  const fl = Math.min(0xffff, Math.round(Math.abs(f.flowGps) * 100));
  b[11] = (fl >> 8) & 0xff;
  b[12] = fl & 0xff;
  b[13] = Math.max(0, Math.min(100, Math.round(f.batteryPct)));
  const sb = Math.max(0, Math.min(0xffff, Math.round(f.standbyMin * 10)));
  b[14] = (sb >> 8) & 0xff;
  b[15] = sb & 0xff;
  b[16] = f.buzzer & 0xff;
  b[17] = f.smoothing ? 1 : 0;
  b[18] = 0;
  b[19] = xorChecksum(b, FRAME_LENGTH - 1);
  return b;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const v of bytes) s += v.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
