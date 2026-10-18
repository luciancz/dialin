/** Settings / Diagnostics / Backup. */
import { signal } from '@preact/signals';
import { deliverJson, readFileAsText } from '../../app/exportDelivery';
import {
  modelSummary,
  type RerunRow,
  refreshModelSummary,
  rerunRecommendations,
} from '../../app/recommender';
import { app } from '../../app/state';
import type { SimOptions, TransportKind } from '../../app/transports';
import type { RawFrameRow } from '../../core/types';
import { formatDial } from '../../core/units';
import { buildExport, exportFileName, importFile, type MergePlan } from '../../data/exportImport';
import { validateExportFile } from '../../data/validate';
import { diag } from '../../diag/log';
import { probeCaps } from './Probe';

const importText = signal('');
const importPlan = signal<MergePlan | null>(null);
const importErrors = signal<string[]>([]);
const pendingFile = signal<unknown>(null);
const counts = signal<Record<string, number>>({});
const logTail = signal<string[]>([]);
const lastDelivery = signal('');

diag.changed.on(() => {
  logTail.value = diag.lines
    .slice(-15)
    .map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.level}: ${l.msg}`);
});

async function refreshCounts(): Promise<void> {
  if (app.repo) counts.value = await app.repo.counts();
}

async function doExport(includeRaw: boolean): Promise<void> {
  if (!app.db) return;
  const file = await buildExport(app.db, { includeRaw });
  const json = JSON.stringify(file);
  const method = await deliverJson(exportFileName(), json);
  lastDelivery.value = method;
  if (method !== 'failed') {
    await app.saveSettings({ lastExportAt: new Date().toISOString(), shotsSinceExport: 0 });
    app.toast('info', `Exported via ${method}.`);
    const caps = { ...(app.settings.value?.bleCaps ?? {}), exportMethod: method };
    await app.saveSettings({ bleCaps: caps });
  } else app.toast('error', 'Export failed on every path.');
}

async function dryRun(text: string): Promise<void> {
  importErrors.value = [];
  importPlan.value = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    importErrors.value = [`not JSON: ${String(err)}`];
    return;
  }
  const v = validateExportFile(parsed);
  if (!v.ok) {
    importErrors.value = v.errors;
    return;
  }
  if (!app.db) return;
  pendingFile.value = v.file;
  importPlan.value = await importFile(app.db, v.file, false);
}

async function applyImport(): Promise<void> {
  const file = pendingFile.value;
  if (!app.db || !file) return;
  const v = validateExportFile(file);
  if (!v.ok) return;
  const plan = await importFile(app.db, v.file, true);
  importPlan.value = null;
  pendingFile.value = null;
  importText.value = '';
  await app.reloadAll();
  await refreshCounts();
  app.toast(
    'info',
    `Imported: ${Object.values(plan.adds).reduce((a, b) => a + b, 0)} added, ${Object.values(plan.updates).reduce((a, b) => a + b, 0)} updated, ${plan.conflicts.length} conflicts.`,
  );
}

const rerunRows = signal<RerunRow[] | null>(null);

function ModelCard() {
  const m = modelSummary.value;
  const rows = rerunRows.value;
  return (
    <div class="card">
      <h3>Model (replayed from stored shots)</h3>
      {m ? (
        <p class="small mono">
          k_grind {m.kGrind[0].toFixed(4)} ± {m.kGrind[1].toFixed(4)} ln/line (≈{' '}
          {m.secPerLine?.[0].toFixed(1)} ± {m.secPerLine?.[1].toFixed(1)} s/line) · k_rpm{' '}
          {m.kRpm[0].toFixed(3)} ± {m.kRpm[1].toFixed(3)} · k_dose {m.kDose[0].toFixed(3)} ±{' '}
          {m.kDose[1].toFixed(3)}
          <br />
          bag intercept {m.aBag ? `${m.aBag[0].toFixed(2)} ± ${m.aBag[1].toFixed(2)}` : '—'} ·
          setpoint{' '}
          {Number.isNaN(m.setpoint[0])
            ? '—'
            : `${Math.exp(m.setpoint[0]).toFixed(2)} g/s ± ${(m.setpoint[1] * 100).toFixed(0)} %`}{' '}
          · {m.learnableShots} learnable shots · {m.predictedInBand} predicted in band
        </p>
      ) : (
        <p class="muted small">No model yet.</p>
      )}
      <div class="row">
        <button type="button" class="small" onClick={() => void refreshModelSummary()}>
          Replay now
        </button>
        <button
          type="button"
          class="small"
          onClick={() => {
            void rerunRecommendations().then((r) => {
              rerunRows.value = r;
            });
          }}
        >
          Re-run recommendations (dev)
        </button>
      </div>
      {rows ? (
        <table class="small" style="margin-top:6px">
          <thead>
            <tr>
              <th>shot</th>
              <th>stored</th>
              <th>recomputed</th>
              <th>same</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.shotId}>
                <td>{new Date(r.at).toLocaleString()}</td>
                <td>
                  {r.stored
                    ? `${r.stored.lever} → ${formatDial(r.stored.next.grind.dialPos)} ${r.stored.next.grind.rpm} ${r.stored.next.targetYieldG} g`
                    : '—'}
                </td>
                <td>
                  {r.recomputed
                    ? `${r.recomputed.lever} → ${formatDial(r.recomputed.next.grind.dialPos)} ${r.recomputed.next.grind.rpm} ${r.recomputed.next.targetYieldG} g`
                    : '—'}
                </td>
                <td class={r.identical ? 'ok' : 'warn'}>
                  {r.identical ? 'yes' : r.stored ? 'no' : 'n/a'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function downloadRows(name: string, rows: RawFrameRow[]): void {
  void deliverJson(name, JSON.stringify({ format: 'dialin-frames', rows }, null, 0));
}

export function Settings() {
  const s = app.settings.value;
  const sim = app.simOptions.value;
  if (Object.keys(counts.value).length === 0) void refreshCounts();
  const caps = { ...(s?.bleCaps ?? {}), ...probeCaps.value };
  return (
    <div>
      <h1>Settings</h1>

      <div class="card">
        <h3>Scale transport</h3>
        <div class="row">
          <select
            value={app.transportKind.value}
            onChange={(e) => {
              app.transportKind.value = e.currentTarget.value as TransportKind;
            }}
          >
            <option value="webbt">Web Bluetooth (real scale)</option>
            <option value="fake">Simulator</option>
            <option value="replay">Replay fixture</option>
          </select>
          <button
            type="button"
            class="primary"
            onClick={() => void app.connect().catch((err) => app.toast('error', String(err)))}
          >
            Connect
          </button>
          <button type="button" onClick={() => void app.disconnect()}>
            Disconnect
          </button>
        </div>
        {app.transportKind.value === 'fake' ? (
          <div class="grid2" style="margin-top:8px">
            <label>
              <span>true plateau flow g/s</span>
              <input
                type="number"
                step="0.1"
                value={sim.plateauGps}
                onInput={(e) =>
                  (app.simOptions.value = { ...sim, plateauGps: Number(e.currentTarget.value) })
                }
              />
            </label>
            <label>
              <span>channeling probability</span>
              <input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={sim.channelProbability}
                onInput={(e) =>
                  (app.simOptions.value = {
                    ...sim,
                    channelProbability: Number(e.currentTarget.value),
                  })
                }
              />
            </label>
            <label>
              <span>persona</span>
              <select
                value={sim.persona ?? 'normal'}
                onChange={(e) =>
                  (app.simOptions.value = {
                    ...sim,
                    persona: e.currentTarget.value as SimOptions['persona'],
                  })
                }
              >
                <option value="normal">normal (Timer mode)</option>
                <option value="auto_mode">Auto mode (ignores 04/07)</option>
                <option value="disconnect_12s">disconnect 12 s into the shot</option>
                <option value="auto_off_soon">auto-off after 4 min, ignores re-arm</option>
              </select>
            </label>
            <label>
              <span>seed</span>
              <input
                type="number"
                value={sim.seed}
                onInput={(e) =>
                  (app.simOptions.value = { ...sim, seed: Number(e.currentTarget.value) })
                }
              />
            </label>
          </div>
        ) : null}
        {app.transportKind.value === 'replay' ? (
          <label style="margin-top:8px">
            <span>fixture JSON (dialin-frames or a rawRecordings row)</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (!f) return;
                void readFileAsText(f).then((txt) => {
                  const obj = JSON.parse(txt) as { rows?: RawFrameRow[]; frames?: RawFrameRow[] };
                  app.replayRows = obj.rows ?? obj.frames ?? [];
                  app.toast('info', `${app.replayRows.length} frames loaded for replay.`);
                });
              }}
            />
          </label>
        ) : null}
        <p class="muted small">
          Probe the browser's Bluetooth support on the <a href="#/probe">Probe</a> screen. To try
          everything with a hidden simulated grinder and palate and separate data, open the{' '}
          <a href="#/demo">Simulation</a>.
        </p>
      </div>

      <div class="card">
        <h3>Backup</h3>
        <div class="row">
          <button type="button" class="primary" onClick={() => void doExport(false)}>
            Export JSON
          </button>
          <button type="button" onClick={() => void doExport(true)}>
            Export with raw frames
          </button>
        </div>
        <p class="muted small">
          {s?.lastExportAt
            ? `last export ${new Date(s.lastExportAt).toLocaleString()}`
            : 'never exported'}{' '}
          · {s?.shotsSinceExport ?? 0} shots since
          {lastDelivery.value ? ` · last delivery: ${lastDelivery.value}` : ''}
        </p>
        <h3 style="margin-top:12px">Import (merge)</h3>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void readFileAsText(f).then((t) => dryRun(t));
          }}
        />
        <textarea
          placeholder="…or paste an export here"
          value={importText.value}
          onInput={(e) => (importText.value = e.currentTarget.value)}
        />
        <button type="button" class="small" onClick={() => void dryRun(importText.value)}>
          Preview merge
        </button>
        {importErrors.value.length > 0 ? (
          <ul class="small bad">
            {importErrors.value.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : null}
        {importPlan.value ? (
          <div class="small" style="margin-top:6px">
            <table>
              <thead>
                <tr>
                  <th>store</th>
                  <th>add</th>
                  <th>update</th>
                  <th>same</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(importPlan.value.adds) as (keyof MergePlan['adds'])[]).map((k) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{importPlan.value?.adds[k]}</td>
                    <td>{importPlan.value?.updates[k]}</td>
                    <td>{importPlan.value?.unchanged[k]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {importPlan.value.conflicts.length > 0 ? (
              <p class="warn">
                {importPlan.value.conflicts.length} conflicts (local kept):{' '}
                {importPlan.value.conflicts.map((c) => `${c.store}/${c.id.slice(0, 8)}`).join(', ')}
              </p>
            ) : null}
            <p>settings: {importPlan.value.settings}</p>
            <button type="button" class="primary" onClick={() => void applyImport()}>
              Apply merge
            </button>
          </div>
        ) : null}
      </div>

      <div class="card">
        <h3>Grinder & machine</h3>
        <label class="row" style="align-items:center;gap:8px">
          <input
            type="checkbox"
            checked={s?.allowLowRpm ?? false}
            onChange={(e) => void app.saveSettings({ allowLowRpm: e.currentTarget.checked })}
          />
          allow 500–600 RPM recommendations (stall risk)
        </label>
        <label>
          <span>VS6 shows 0500 after power-on?</span>
          <select
            value={String(s?.rpmResetsOnPowerOn ?? 'unknown')}
            onChange={(e) => {
              const v = e.currentTarget.value;
              void app.saveSettings({
                rpmResetsOnPowerOn: v === 'unknown' ? 'unknown' : v === 'true',
              });
            }}
          >
            <option value="unknown">unknown</option>
            <option value="true">yes</option>
            <option value="false">no, it remembers</option>
          </select>
        </label>
        <label>
          <span>Auto-off minutes requested on connect</span>
          <input
            type="number"
            min={5}
            max={30}
            value={s?.autoOffMinutesWanted ?? 30}
            onChange={(e) =>
              void app.saveSettings({ autoOffMinutesWanted: Number(e.currentTarget.value) })
            }
          />
        </label>
        <p class="small">
          <a href="#/onboarding">Re-run onboarding</a> · <a href="#/hardware">Hardware epochs</a>
        </p>
      </div>

      <ModelCard />

      <div class="card">
        <h3>Diagnostics</h3>
        <p class="small mono">
          device {s?.deviceId.slice(0, 8)} · persisted {String(app.persisted.value)} · frames{' '}
          {diag.counters.frames} · bad {diag.counters.bad} · {diag.frameHz().toFixed(1)} Hz
        </p>
        <p class="small mono">
          {Object.entries(counts.value)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')}
        </p>
        <div class="row">
          <button
            type="button"
            class="small"
            onClick={() => downloadRows('dialin-raw-ring.json', diag.lastWindow(10 * 60_000))}
          >
            Download raw ring
          </button>
          <button
            type="button"
            class="small"
            onClick={() =>
              downloadRows(
                `fixture-${Date.now()}.json`,
                app.made?.recorder.take(performance.now() - 120_000) ?? diag.lastWindow(120_000),
              )
            }
          >
            Save last 2 min as fixture
          </button>
          <button type="button" class="small" onClick={() => void app.client?.rearmAutoOff()}>
            Re-arm auto-off
          </button>
        </div>
        <details>
          <summary>Capabilities ({Object.keys(caps).length})</summary>
          <table>
            <tbody>
              {Object.entries(caps).map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td class="mono">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <details>
          <summary>Log</summary>
          <pre>{logTail.value.join('\n') || '—'}</pre>
        </details>
        <details>
          <summary>Danger zone</summary>
          <button
            type="button"
            class="danger"
            onClick={() => {
              if (
                confirm('Delete every bean, bag, shot and setting on this device? Export first.')
              ) {
                void app.repo?.wipe().then(() => location.reload());
              }
            }}
          >
            Wipe local data
          </button>
        </details>
      </div>
    </div>
  );
}
