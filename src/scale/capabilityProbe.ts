/**
 * Records what this browser's Web Bluetooth and related APIs implement. Nothing here is
 * assumed: Bluefy's API surface is undocumented, so every key is measured on the device
 * and shown on the Diagnostics screen / included in exports (settings.bleCaps).
 */
import type { BleCaps } from '../core/types';

interface MaybeBluefyBluetooth {
  setScreenDimEnabled?: unknown;
  getDevices?: unknown;
  getAvailability?: unknown;
  watchAdvertisements?: unknown;
}

interface MaybeBluefyWindow {
  BLENative?: { notifyAppState?: unknown };
}

/** Synchronous facts: API presence, user agent, secure context. */
export function environmentCaps(): BleCaps {
  const caps: BleCaps = {};
  if (typeof navigator === 'undefined') return caps;
  const bt = navigator.bluetooth as unknown as MaybeBluefyBluetooth | undefined;
  caps.ua = navigator.userAgent;
  caps.isBluefy = /Bluefy/i.test(navigator.userAgent);
  caps.isChromium = /Chrome\//.test(navigator.userAgent) && !caps.isBluefy;
  caps.secureContext = typeof window !== 'undefined' ? window.isSecureContext : false;
  caps.webBluetooth = bt !== undefined;
  caps.hasGetDevices = typeof bt?.getDevices === 'function';
  caps.hasGetAvailability = typeof bt?.getAvailability === 'function';
  caps.hasWatchAdvertisements = typeof bt?.watchAdvertisements === 'function';
  caps.screenDimApiPresent = typeof bt?.setScreenDimEnabled === 'function';
  const w = typeof window !== 'undefined' ? (window as unknown as MaybeBluefyWindow) : undefined;
  caps.notifyAppStatePresent = typeof w?.BLENative?.notifyAppState === 'function';
  caps.wakeLockApi = 'wakeLock' in navigator;
  caps.shareApi = typeof navigator.share === 'function';
  caps.canShareApi = typeof navigator.canShare === 'function';
  caps.storageApi = 'storage' in navigator && typeof navigator.storage?.persist === 'function';
  caps.serviceWorkerApi = 'serviceWorker' in navigator;
  caps.indexedDb = typeof indexedDB !== 'undefined';
  return caps;
}

/** Facts that need an async call (no user gesture required). */
export async function probeAsync(): Promise<BleCaps> {
  const caps: BleCaps = {};
  if (typeof navigator === 'undefined') return caps;
  try {
    if (typeof navigator.canShare === 'function') {
      const file = new File(['{}'], 'probe.json', { type: 'application/json' });
      caps.shareFilesWorks = navigator.canShare({ files: [file] });
    } else caps.shareFilesWorks = false;
  } catch (err) {
    caps.shareFilesWorks = `error: ${String(err)}`;
  }
  try {
    caps.storagePersisted = navigator.storage?.persisted
      ? await navigator.storage.persisted()
      : false;
  } catch (err) {
    caps.storagePersisted = `error: ${String(err)}`;
  }
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (est.quota !== undefined) caps.storageQuotaMB = Math.round(est.quota / 1e6);
      if (est.usage !== undefined) caps.storageUsageMB = Math.round((est.usage / 1e6) * 10) / 10;
    }
  } catch {
    /* ignore */
  }
  try {
    const bt = navigator.bluetooth;
    if (bt && typeof bt.getAvailability === 'function') {
      caps.bluetoothAvailable = await bt.getAvailability();
    }
  } catch (err) {
    caps.bluetoothAvailable = `error: ${String(err)}`;
  }
  return caps;
}

/** Ask for persistent storage; returns the granted state. */
export async function requestPersistentStorage(): Promise<boolean | string> {
  try {
    if (!navigator.storage?.persist) return 'unsupported';
    return await navigator.storage.persist();
  } catch (err) {
    return `error: ${String(err)}`;
  }
}

export function mergeCaps(base: BleCaps | undefined, add: BleCaps): BleCaps {
  return { ...(base ?? {}), ...add };
}
