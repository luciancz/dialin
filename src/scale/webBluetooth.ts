/**
 * Web Bluetooth transport for the Bookoo Themis Mini.
 *
 * Everything Bluefy-specific is measured, not assumed, and written into `info.caps`:
 * which requestDevice filter worked, which write method exists, whether FF12 notifies,
 * and which disconnect detection fired first. The BluetoothDevice is retained so that
 * reconnects need no chooser.
 */
import { COMMAND_CHAR_UUID, DFU_SERVICE_UUID, SERVICE_UUID, WEIGHT_CHAR_UUID } from './protocol';
import { Emitter, type FrameSource, type Transport, type TransportInfo } from './transport';

export type WriteMethod = 'withResponse' | 'legacy' | 'withoutResponse';

interface FrameEvent {
  src: FrameSource;
  bytes: Uint8Array;
  tRxMs: number;
}

export interface WebBluetoothOptions {
  log?: (msg: string) => void;
  now?: () => number;
  /** Disconnect poll interval (ms). */
  pollMs?: number;
}

export function hasWebBluetooth(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.bluetooth !== 'undefined';
}

export function isChromium(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Bluefy/i.test(ua);
}

export function isBluefy(): boolean {
  return typeof navigator !== 'undefined' && /Bluefy/i.test(navigator.userAgent);
}

export class WebBluetoothTransport implements Transport {
  readonly info: TransportInfo = { kind: 'webbt', caps: {} };
  private device: BluetoothDevice | null = null;
  private ff11: BluetoothRemoteGATTCharacteristic | null = null;
  private ff12: BluetoothRemoteGATTCharacteristic | null = null;
  private writeMethod: WriteMethod | null = null;
  private readonly frames = new Emitter<FrameEvent>();
  private readonly disconnects = new Emitter<string>();
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private disconnectReported = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly pollMs: number;

  constructor(opts: WebBluetoothOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => performance.now());
    this.pollMs = opts.pollMs ?? 2000;
  }

  /** Adopt a device from navigator.bluetooth.getDevices() so connect() needs no chooser. */
  adopt(device: BluetoothDevice): void {
    this.device = device;
  }

  get hasDevice(): boolean {
    return this.device !== null;
  }

  get connected(): boolean {
    return this.device?.gatt?.connected === true;
  }

  static async rememberedDevices(): Promise<BluetoothDevice[]> {
    const bt = navigator.bluetooth;
    if (!bt || typeof bt.getDevices !== 'function') return [];
    try {
      return await bt.getDevices();
    } catch {
      return [];
    }
  }

  async connect(): Promise<void> {
    const bt = navigator.bluetooth;
    if (!bt) throw new Error('Web Bluetooth is not available in this browser');
    this.info.caps.hasGetDevices = typeof bt.getDevices === 'function';
    if (!this.device) this.device = await this.requestDevice(bt);
    const device = this.device;
    const gatt = device.gatt;
    if (!gatt) throw new Error('Device has no GATT server');
    this.disconnectReported = false;
    this.info.name = device.name ?? '';
    this.info.caps.advertisedName = device.name ?? '';
    this.log(`connecting to ${device.name ?? device.id}`);
    const server = await gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.ff11 = await service.getCharacteristic(WEIGHT_CHAR_UUID);
    this.ff12 = await service.getCharacteristic(COMMAND_CHAR_UUID);
    this.chooseWriteMethod(this.ff12);
    await this.ff11.startNotifications();
    this.ff11.addEventListener('characteristicvaluechanged', this.onFf11);
    try {
      await this.ff12.startNotifications();
      this.ff12.addEventListener('characteristicvaluechanged', this.onFf12);
      this.info.caps.ff12Notifies = true;
    } catch (err) {
      this.info.caps.ff12Notifies = false;
      this.info.caps.ff12NotifyError = String(err);
      this.log(`FF12 notifications unavailable: ${String(err)}`);
    }
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.startPoll();
    this.log(`connected, write method ${this.writeMethod ?? 'none'}`);
  }

  async disconnect(): Promise<void> {
    this.stopPoll();
    const device = this.device;
    if (!device) return;
    device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.ff11?.removeEventListener('characteristicvaluechanged', this.onFf11);
    this.ff12?.removeEventListener('characteristicvaluechanged', this.onFf12);
    try {
      if (device.gatt?.connected) device.gatt.disconnect();
    } catch (err) {
      this.log(`disconnect error: ${String(err)}`);
    }
    this.ff11 = null;
    this.ff12 = null;
  }

  /** Forget the device so the next connect() shows the chooser again. */
  forget(): void {
    this.device = null;
  }

  write(bytes: Uint8Array): Promise<void> {
    const run = async () => {
      const c = this.ff12;
      if (!c) throw new Error('not connected');
      const data = bytes.slice().buffer as ArrayBuffer;
      switch (this.writeMethod) {
        case 'withResponse':
          await c.writeValueWithResponse(data);
          return;
        case 'withoutResponse':
          await c.writeValueWithoutResponse(data);
          return;
        case 'legacy':
          await c.writeValue(data);
          return;
        default:
          throw new Error('no usable write method on FF12');
      }
    };
    // BLE writes must not overlap: chain them.
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => {});
    return next;
  }

  onFrame(cb: (src: FrameSource, bytes: Uint8Array, tRxMs: number) => void): () => void {
    return this.frames.on((e) => cb(e.src, e.bytes, e.tRxMs));
  }

  onDisconnect(cb: (reason: string) => void): () => void {
    return this.disconnects.on(cb);
  }

  private async requestDevice(bt: Bluetooth): Promise<BluetoothDevice> {
    try {
      const d = await bt.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID, DFU_SERVICE_UUID],
      });
      this.info.caps.filterMode = 'services';
      return d;
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const retry = name === 'TypeError' || (name === 'NotFoundError' && !isChromium());
      this.info.caps.filterError = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      if (!retry) throw err;
      this.log(`services filter failed (${name}); retrying with acceptAllDevices`);
      const d = await bt.requestDevice({
        acceptAllDevices: true,
        optionalServices: [0x0ffe],
      });
      this.info.caps.filterMode = 'acceptAll';
      return d;
    }
  }

  private chooseWriteMethod(c: BluetoothRemoteGATTCharacteristic): void {
    const hasWithResponse = typeof c.writeValueWithResponse === 'function';
    const hasLegacy = typeof c.writeValue === 'function';
    const hasWithout =
      typeof c.writeValueWithoutResponse === 'function' && c.properties?.writeWithoutResponse;
    if (hasWithResponse) this.writeMethod = 'withResponse';
    else if (hasLegacy) this.writeMethod = 'legacy';
    else if (hasWithout) this.writeMethod = 'withoutResponse';
    else this.writeMethod = null;
    this.info.caps.writeMethod = this.writeMethod ?? 'none';
    this.info.caps.ff12Write = Boolean(c.properties?.write);
    this.info.caps.ff12WriteWithoutResponse = Boolean(c.properties?.writeWithoutResponse);
  }

  private readonly onFf11 = (ev: Event): void => {
    this.emitFrame('ff11', ev);
  };

  private readonly onFf12 = (ev: Event): void => {
    this.emitFrame('ff12', ev);
  };

  private emitFrame(src: FrameSource, ev: Event): void {
    const target = ev.target as BluetoothRemoteGATTCharacteristic | null;
    const value = target?.value;
    if (!value) return;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    this.frames.emit({ src, bytes, tRxMs: this.now() });
  }

  private readonly onGattDisconnected = (): void => {
    this.info.caps.disconnectEventFired = true;
    this.reportDisconnect('event');
  };

  private startPoll(): void {
    this.stopPoll();
    this.pollHandle = setInterval(() => {
      if (this.device && this.device.gatt?.connected === false) {
        this.info.caps.pollDetectedDisconnect = true;
        this.reportDisconnect('poll');
      }
    }, this.pollMs);
  }

  private stopPoll(): void {
    if (this.pollHandle !== null) clearInterval(this.pollHandle);
    this.pollHandle = null;
  }

  private reportDisconnect(reason: string): void {
    if (this.disconnectReported) return;
    this.disconnectReported = true;
    this.stopPoll();
    if (this.info.caps.firstDisconnectDetector === undefined) {
      this.info.caps.firstDisconnectDetector = reason;
    }
    this.log(`disconnected (${reason})`);
    this.disconnects.emit(reason);
  }
}
