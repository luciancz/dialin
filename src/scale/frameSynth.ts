/** Build 20-byte frames with a runtime XOR, for the fake transport and fixtures. */
import { encodeWeightFrame, FRAME_HEADER, FRAME_LENGTH, xorChecksum } from './protocol';

export interface FrameOpts {
  batteryPct?: number;
  standbyMin?: number;
  smoothing?: boolean;
  unit?: number;
  buzzer?: number;
}

export function weightFrameBytes(
  timerMs: number,
  grams: number,
  flowGps: number,
  opts: FrameOpts = {},
): Uint8Array {
  return encodeWeightFrame({
    timerMs,
    unit: opts.unit ?? 1,
    grams,
    flowGps,
    batteryPct: opts.batteryPct ?? 80,
    standbyMin: opts.standbyMin ?? 15,
    buzzer: opts.buzzer ?? 0,
    smoothing: opts.smoothing ?? false,
  });
}

/** Undocumented FF12 frames (03 0D / 0C / 0E …) as seen in hardware tests. */
export function otherFrameBytes(type: number, payload: readonly number[] = []): Uint8Array {
  const b = new Uint8Array(FRAME_LENGTH);
  b[0] = FRAME_HEADER;
  b[1] = type & 0xff;
  for (let i = 0; i < Math.min(payload.length, FRAME_LENGTH - 3); i++)
    b[2 + i] = (payload[i] ?? 0) & 0xff;
  b[FRAME_LENGTH - 1] = xorChecksum(b, FRAME_LENGTH - 1);
  return b;
}
