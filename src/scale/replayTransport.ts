/** Streams recorded [seq, tRxMs, src, hex] rows at real or accelerated pace. */
import type { RawFrameRow } from '../core/types';
import { realClock } from './clock';
import { fromHex } from './protocol';
import {
  type Clock,
  Emitter,
  type FrameSource,
  type Transport,
  type TransportInfo,
} from './transport';

interface FrameEvent {
  src: FrameSource;
  bytes: Uint8Array;
  tRxMs: number;
}

export class ReplayTransport implements Transport {
  readonly info: TransportInfo = { kind: 'replay', name: 'replay', caps: {} };
  readonly commands: { tMs: number; bytes: Uint8Array }[] = [];
  private readonly frames = new Emitter<FrameEvent>();
  private readonly disconnects = new Emitter<string>();
  private cancel: (() => void) | null = null;
  private connected = false;
  private index = 0;

  constructor(
    private readonly rows: RawFrameRow[],
    private readonly opts: { clock?: Clock; speed?: number; loop?: boolean; name?: string } = {},
  ) {
    if (opts.name) this.info.name = opts.name;
    this.info.caps.rows = rows.length;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    this.index = 0;
    this.scheduleNext();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.cancel?.();
    this.cancel = null;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.commands.push({ tMs: (this.opts.clock ?? realClock).now(), bytes: bytes.slice() });
  }

  onFrame(cb: (src: FrameSource, bytes: Uint8Array, tRxMs: number) => void): () => void {
    return this.frames.on((e) => cb(e.src, e.bytes, e.tRxMs));
  }

  onDisconnect(cb: (reason: string) => void): () => void {
    return this.disconnects.on(cb);
  }

  private scheduleNext(): void {
    const clock = this.opts.clock ?? realClock;
    const speed = this.opts.speed ?? 1;
    const row = this.rows[this.index];
    if (!row) {
      if (this.opts.loop && this.rows.length > 0) {
        this.index = 0;
        this.scheduleNext();
        return;
      }
      this.connected = false;
      this.disconnects.emit('end of replay');
      return;
    }
    const prev = this.index > 0 ? this.rows[this.index - 1] : undefined;
    const wait = prev ? Math.max(0, (row[1] - prev[1]) / speed) : 0;
    this.cancel = clock.setTimeout(() => {
      if (!this.connected) return;
      this.index += 1;
      this.frames.emit({ src: row[2], bytes: fromHex(row[3]), tRxMs: clock.now() });
      this.scheduleNext();
    }, wait);
  }
}
