/**
 * Transport-agnostic interfaces. Everything above this line (ScaleClient, recorder)
 * works against these, so Web Bluetooth, the fake simulator, replay and a future
 * WebSocket hub are interchangeable.
 */

export type FrameSource = 'ff11' | 'ff12';

export interface Clock {
  /** Milliseconds, monotonic within a session. */
  now(): number;
  /** Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export type TransportKind = 'webbt' | 'fake' | 'replay';

export interface TransportInfo {
  kind: TransportKind;
  name?: string;
  caps: Record<string, string | boolean | number>;
}

export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onFrame(cb: (src: FrameSource, bytes: Uint8Array, tRxMs: number) => void): () => void;
  onDisconnect(cb: (reason: string) => void): () => void;
  readonly info: TransportInfo;
}

/** Tiny typed event emitter (DOM-free). */
export class Emitter<T> {
  private readonly subs = new Set<(v: T) => void>();
  on(cb: (v: T) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
  emit(v: T): void {
    for (const cb of [...this.subs]) cb(v);
  }
  get size(): number {
    return this.subs.size;
  }
}
