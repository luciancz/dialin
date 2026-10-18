/**
 * Capability probe: connects straight through the Web Bluetooth transport, shows live
 * frames, sends each command on demand, and records every measured capability.
 */
import { signal } from '@preact/signals';
import { swState } from '../../app/sw';
import type { BleCaps } from '../../core/types';
import { diag } from '../../diag/log';
import {
  environmentCaps,
  mergeCaps,
  probeAsync,
  requestPersistentStorage,
} from '../../scale/capabilityProbe';
import { keepAwake, releaseKeepAwake, type ScreenDimArg } from '../../scale/keepAwake';
import { commands, parseFrame, type WeightFrame } from '../../scale/protocol';
import { hasWebBluetooth, WebBluetoothTransport } from '../../scale/webBluetooth';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export const probeCaps = signal<BleCaps>(environmentCaps());
const status = signal<Status>('idle');
const error = signal('');
const last = signal<WeightFrame | null>(null);
const stats = signal({ frames: 0, bad: 0, ff12: 0, hz: 0 });
const timerCheck = signal('not run');
const screenDimArg = signal<ScreenDimArg>('false');
const keepAwakeResult = signal('');
const logTail = signal<string[]>([]);
const asyncProbed = signal(false);

let transport: WebBluetoothTransport | null = null;
let timerProbe: { remaining: number; timers: number[] } | null = null;
let offFrame: (() => void) | null = null;
let offDisc: (() => void) | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;

diag.changed.on(() => {
  logTail.value = diag.lines.slice(-12).map((l) => `${l.level}: ${l.msg}`);
});

function ensureTransport(): WebBluetoothTransport {
  if (!transport) {
    transport = new WebBluetoothTransport({ log: (m) => diag.log('info', `[webbt] ${m}`) });
  }
  return transport;
}

function syncCaps(): void {
  const t = transport;
  const extra: BleCaps = {
    frameHz: Math.round(diag.frameHz() * 100) / 100,
    checksumFailRate: Math.round(diag.checksumFailRate() * 10000) / 10000,
  };
  const sw = swState.registered.value;
  if (sw !== null) extra.serviceWorkerRegistered = sw;
  const f = last.value;
  if (f) {
    extra.standbyMinReported = f.standbyMin;
    extra.smoothingReported = f.smoothing;
    extra.unitByte = f.unit;
  }
  probeCaps.value = mergeCaps(mergeCaps(probeCaps.value, t?.info.caps ?? {}), extra);
}

async function runAsyncProbe(): Promise<void> {
  probeCaps.value = mergeCaps(probeCaps.value, await probeAsync());
  asyncProbed.value = true;
}

async function connect(): Promise<void> {
  if (!hasWebBluetooth()) {
    error.value = 'navigator.bluetooth is missing: use Chrome/Edge on Windows or Bluefy on iOS.';
    status.value = 'error';
    return;
  }
  const t = ensureTransport();
  status.value = 'connecting';
  error.value = '';
  offFrame?.();
  offDisc?.();
  offFrame = t.onFrame((src, bytes, tRxMs) => {
    diag.pushFrame(src, bytes, tRxMs);
    const parsed = parseFrame(bytes);
    if (parsed.kind === 'bad') {
      diag.countBad();
      return;
    }
    if (parsed.kind === 'weight') {
      last.value = parsed.frame;
      if (timerProbe) {
        timerProbe.timers.push(parsed.frame.timerMs);
        timerProbe.remaining -= 1;
        if (timerProbe.remaining <= 0) {
          const advancing = timerProbe.timers.some((v) => v > 0);
          timerCheck.value = advancing
            ? `Timer mode OK (timers ${timerProbe.timers.join(', ')} ms)`
            : 'timer still 0 after 5 frames: scale is NOT in Timer mode (Auto mode?)';
          probeCaps.value = mergeCaps(probeCaps.value, { timerModeConfirmed: advancing });
          timerProbe = null;
        }
      }
    } else if (parsed.kind === 'other' || parsed.kind === 'unknown') {
      diag.log('info', `${src} frame type 0x${parsed.type.toString(16)}: ${bytesToHex(bytes)}`);
    }
  });
  offDisc = t.onDisconnect((reason) => {
    status.value = 'disconnected';
    diag.log('warn', `probe: disconnected (${reason})`);
    syncCaps();
  });
  try {
    await t.connect();
    status.value = 'connected';
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      stats.value = {
        frames: diag.counters.frames,
        bad: diag.counters.bad,
        ff12: diag.counters.ff12,
        hz: Math.round(diag.frameHz() * 100) / 100,
      };
      syncCaps();
    }, 1000);
  } catch (err) {
    status.value = 'error';
    error.value = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    diag.log('error', `probe connect failed: ${error.value}`);
    syncCaps();
  }
}

async function disconnect(): Promise<void> {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  await transport?.disconnect();
  status.value = 'disconnected';
  syncCaps();
}

async function send(name: string, bytes: Uint8Array): Promise<void> {
  const t = transport;
  if (!t) return;
  try {
    await t.write(bytes);
    diag.counters.writes += 1;
    diag.log('info', `sent ${name}: ${bytesToHex(bytes)}`);
  } catch (err) {
    diag.log('error', `write ${name} failed: ${String(err)}`);
  }
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(' ');
}

async function tareStartCheck(): Promise<void> {
  timerProbe = { remaining: 5, timers: [] };
  timerCheck.value = 'waiting for 5 frames…';
  await send('tare+start (07)', commands.tareStart());
}

async function requestKeepAwake(): Promise<void> {
  const r = await keepAwake(screenDimArg.value);
  keepAwakeResult.value = `wakeLock=${r.wakeLock}, screenDim=${r.screenDim}`;
  probeCaps.value = mergeCaps(probeCaps.value, {
    wakeLockWorks: r.wakeLock === 'acquired',
    screenDimCall: r.screenDim,
  });
}

async function persist(): Promise<void> {
  const r = await requestPersistentStorage();
  probeCaps.value = mergeCaps(probeCaps.value, { storagePersisted: r });
}

async function copyCaps(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(probeCaps.value, null, 2));
    diag.log('info', 'caps copied to clipboard');
  } catch (err) {
    diag.log('warn', `clipboard failed: ${String(err)}`);
  }
}

export function Probe() {
  if (!asyncProbed.value) void runAsyncProbe();
  const f = last.value;
  const s = status.value;
  const connected = s === 'connected';
  return (
    <div>
      <h1>Capability probe</h1>
      <p class="muted small">
        Scale on, BOOKOO N closed. Connect, then try each command. Everything measured lands in the
        caps card below.
      </p>

      <div class="card">
        <div class="row between">
          <span class="pill">
            <span class={`dot ${connected ? 'ok' : s === 'connecting' ? 'warn' : 'bad'}`} />
            {s}
            {transport?.info.name ? ` · ${transport.info.name}` : ''}
          </span>
          <span class="small muted">
            {stats.value.hz} Hz · {stats.value.frames} frames · {stats.value.bad} bad ·{' '}
            {stats.value.ff12} ff12
          </span>
        </div>
        {error.value ? <p class="bad small">{error.value}</p> : null}
        <div class="row" style="margin-top:8px">
          <button type="button" class="primary" onClick={connect} disabled={s === 'connecting'}>
            {transport?.hasDevice ? 'Reconnect' : 'Connect'}
          </button>
          <button type="button" onClick={disconnect} disabled={!connected}>
            Disconnect
          </button>
          <button
            type="button"
            class="small"
            onClick={() => {
              transport?.forget();
              status.value = 'idle';
            }}
          >
            Forget device
          </button>
        </div>
      </div>

      {f ? (
        <div class="card accent">
          <div class="row between">
            <div>
              <div class="big-number">{f.grams.toFixed(1)} g</div>
              <div class="muted small">
                timer {(f.timerMs / 1000).toFixed(1)} s · flow {f.flowGps.toFixed(2)} g/s
              </div>
            </div>
            <div class="small muted" style="text-align:right">
              battery {f.batteryPct} %<br />
              auto-off {f.standbyMin} min
              <br />
              smoothing {f.smoothing ? 'on' : 'off'} · unit {f.unit}
            </div>
          </div>
        </div>
      ) : null}

      <div class="card">
        <h3>Commands</h3>
        <div class="grid3">
          <button type="button" disabled={!connected} onClick={() => send('tare', commands.tare())}>
            Tare
          </button>
          <button type="button" disabled={!connected} onClick={tareStartCheck}>
            Tare+Start
          </button>
          <button
            type="button"
            disabled={!connected}
            onClick={() => send('start', commands.start())}
          >
            Start
          </button>
          <button type="button" disabled={!connected} onClick={() => send('stop', commands.stop())}>
            Stop
          </button>
          <button
            type="button"
            disabled={!connected}
            onClick={() => send('reset', commands.reset())}
          >
            Reset
          </button>
          <button
            type="button"
            disabled={!connected}
            onClick={() => send('beep', commands.beep(1))}
          >
            Beep
          </button>
          <button
            type="button"
            disabled={!connected}
            onClick={() => send('smoothing off', commands.smoothing(false))}
          >
            Smooth off
          </button>
          <button
            type="button"
            disabled={!connected}
            onClick={() => send('smoothing on', commands.smoothing(true))}
          >
            Smooth on
          </button>
          <button
            type="button"
            disabled={!connected}
            onClick={() => send('auto-off 30', commands.autoOff(30))}
          >
            Auto-off 30
          </button>
        </div>
        <p class="small">
          Timer-mode check: <span class="mono">{timerCheck.value}</span>
        </p>
      </div>

      <div class="card">
        <h3>Keep-awake</h3>
        <div class="row">
          <label>
            <span>setScreenDimEnabled argument</span>
            <select
              value={screenDimArg.value}
              onChange={(e) => {
                screenDimArg.value = (e.currentTarget as HTMLSelectElement).value as ScreenDimArg;
              }}
            >
              <option value="false">false</option>
              <option value="true">true</option>
              <option value="none">do not call</option>
            </select>
          </label>
          <button type="button" onClick={requestKeepAwake}>
            Request
          </button>
          <button type="button" class="small" onClick={() => void releaseKeepAwake()}>
            Release
          </button>
        </div>
        <p class="small mono">{keepAwakeResult.value || 'not requested'}</p>
        <p class="muted small">
          Try true and false on separate sessions and note which keeps the screen on. Fallback: turn
          Auto-Lock off while dialling in.
        </p>
      </div>

      <div class="card probe">
        <div class="row between">
          <h3>Capabilities</h3>
          <div class="row">
            <button type="button" class="small" onClick={persist}>
              Persist storage
            </button>
            <button type="button" class="small" onClick={copyCaps}>
              Copy JSON
            </button>
          </div>
        </div>
        <table>
          <tbody>
            {Object.entries(probeCaps.value).map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td class="mono">{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3>Log</h3>
        <pre>{logTail.value.join('\n') || '—'}</pre>
      </div>
    </div>
  );
}
