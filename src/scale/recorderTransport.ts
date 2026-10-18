/**
 * Decorator: passes everything through and logs raw frames (and written commands) as
 * [seq, tRxMs, src, hex] rows, so the first real session produces regression fixtures.
 */
import type { RawFrameRow } from '../core/types';
import { toHex } from './protocol';
import type { FrameSource, Transport, TransportInfo } from './transport';

export class RecorderTransport implements Transport {
  readonly rows: RawFrameRow[] = [];
  /** Commands written, as [seq, tMs, 'ff12', hex] rows kept apart from notifications. */
  readonly writes: RawFrameRow[] = [];
  private seq = 0;
  private readonly sinks = new Set<(src: FrameSource, bytes: Uint8Array, tRxMs: number) => void>();

  constructor(
    private readonly inner: Transport,
    private readonly opts: { now?: () => number; maxRows?: number } = {},
  ) {
    inner.onFrame((src, bytes, tRxMs) => {
      this.seq += 1;
      this.rows.push([this.seq, Math.round(tRxMs), src, toHex(bytes)]);
      const max = this.opts.maxRows ?? 20_000;
      if (this.rows.length > max) this.rows.splice(0, this.rows.length - max);
      for (const s of this.sinks) s(src, bytes, tRxMs);
    });
  }

  get info(): TransportInfo {
    return this.inner.info;
  }

  connect(): Promise<void> {
    return this.inner.connect();
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.inner.write(bytes);
    this.seq += 1;
    this.writes.push([this.seq, Math.round(this.opts.now?.() ?? Date.now()), 'ff12', toHex(bytes)]);
  }

  onFrame(cb: (src: FrameSource, bytes: Uint8Array, tRxMs: number) => void): () => void {
    this.sinks.add(cb);
    return () => {
      this.sinks.delete(cb);
    };
  }

  onDisconnect(cb: (reason: string) => void): () => void {
    return this.inner.onDisconnect(cb);
  }

  /** Rows since `sinceMs` (receive clock), for "save last 2 min as fixture". */
  take(sinceMs?: number): RawFrameRow[] {
    return sinceMs === undefined ? [...this.rows] : this.rows.filter((r) => r[1] >= sinceMs);
  }

  clear(): void {
    this.rows.length = 0;
    this.writes.length = 0;
  }
}
