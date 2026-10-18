/**
 * Keep the screen on during a shot. Two candidate mechanisms, both probed and recorded:
 * the standard Wake Lock API and Bluefy's undocumented bluetooth.setScreenDimEnabled.
 * Which argument of the latter keeps the screen on is a field-test item (settings.screenDimArg).
 * The user-facing fallback is "turn Auto-Lock off while dialling in".
 */

export type ScreenDimArg = 'true' | 'false' | 'none';

export interface KeepAwakeResult {
  wakeLock: 'acquired' | 'unsupported' | string;
  screenDim: 'absent' | 'skipped' | 'called:true' | 'called:false' | string;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}

let sentinel: WakeLockSentinelLike | null = null;
let wanted = false;
let visibilityHooked = false;

async function acquire(): Promise<'acquired' | 'unsupported' | string> {
  const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<unknown> } })
    .wakeLock;
  if (!wl) return 'unsupported';
  try {
    sentinel = (await wl.request('screen')) as WakeLockSentinelLike;
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
    return 'acquired';
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible' && sentinel === null) void acquire();
  });
}

export async function keepAwake(screenDimArg: ScreenDimArg): Promise<KeepAwakeResult> {
  wanted = true;
  hookVisibility();
  const wakeLock = await acquire();
  let screenDim: string;
  const bt = navigator.bluetooth as unknown as
    | { setScreenDimEnabled?: (v: boolean) => unknown }
    | undefined;
  if (typeof bt?.setScreenDimEnabled !== 'function') screenDim = 'absent';
  else if (screenDimArg === 'none') screenDim = 'skipped';
  else {
    try {
      await bt.setScreenDimEnabled(screenDimArg === 'true');
      screenDim = `called:${screenDimArg}`;
    } catch (err) {
      screenDim = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { wakeLock, screenDim };
}

export async function releaseKeepAwake(): Promise<void> {
  wanted = false;
  const s = sentinel;
  sentinel = null;
  if (s) {
    try {
      await s.release();
    } catch {
      /* ignore */
    }
  }
}
