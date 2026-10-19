/** Hardware epochs: timeline and the events that re-open the flow model. */
import { signal } from '@preact/signals';
import { lastReplay } from '../../app/recommender';
import { app } from '../../app/state';
import { kRpm } from '../../core/flowmodel/state';
import { isCalibrated } from '../../core/rpm/calibration';
import type { CalibrationEpoch, DialPosition, EpochEventKind } from '../../core/types';
import { formatDial, fromLines, toLines } from '../../core/units';
import { newMeta, nowIso } from '../../data/repo';
import { DialPicker } from '../components/DialPicker';

const EVENTS: { kind: EpochEventKind; label: string; resets: string }[] = [
  {
    kind: 'cleaning',
    label: 'I cleaned the burrs',
    resets:
      'Keeps the gain and every bean intercept, but widens each intercept to ±0.25 (the zero wanders 1–6 lines after cleaning). Next shot per bean is an anchor shot.',
  },
  {
    kind: 'washer_change',
    label: 'Added / removed a washer',
    resets:
      'Keeps the gain; shifts every intercept by −gain × 20 lines per washer (finer at the same reading), widened to ±0.5.',
  },
  {
    kind: 'spring_change',
    label: 'Changed springs',
    resets: 'Keeps the gain; intercepts widened to ±0.5.',
  },
  {
    kind: 're_zero',
    label: 'Re-zeroed (new chirp point)',
    resets:
      'Moves the reference line to the new chirp; intercepts shifted by the gain times the chirp move, widened to ±0.25.',
  },
  {
    kind: 'dial_recount',
    label: 'Recounted the dial',
    resets:
      'Converts every stored reference through the new lines-per-number; intercepts widened to ±0.5.',
  },
  {
    kind: 'new_burrs',
    label: 'New burrs',
    resets:
      'Resets the grind and RPM gains to their priors and widens every intercept to ±0.5. Dose gain is kept.',
  },
];

const pending = signal<EpochEventKind | null>(null);
const deltaWashers = signal(1);
const newLinesPerNumber = signal(10);
const newChirp = signal<DialPosition>({ rev: 1, number: 0, line: 0 });
const note = signal('');
const burrSet = signal('');

async function apply(): Promise<void> {
  const kind = pending.value;
  const prev = app.currentEpoch.value;
  const settings = app.settings.value;
  const repo = app.repo;
  if (!kind || !prev || !settings || !repo) return;
  const spec =
    kind === 'dial_recount'
      ? { ...prev.dialSpec, linesPerNumber: Math.max(1, Math.round(newLinesPerNumber.value)) }
      : prev.dialSpec;
  const convert = (p: DialPosition | undefined) =>
    p && kind === 'dial_recount' ? fromLines(toLines(p, prev.dialSpec), spec) : p;
  const chirp = kind === 're_zero' ? newChirp.value : convert(prev.chirp);
  const usual = convert(prev.usualDial);
  const e: CalibrationEpoch = {
    ...newMeta(settings.deviceId),
    startedAt: nowIso(),
    kind,
    parentEpochId: prev.id,
    dialSpec: spec,
    burrSet: kind === 'new_burrs' && burrSet.value.trim() ? burrSet.value.trim() : prev.burrSet,
    washerCount:
      kind === 'washer_change' ? prev.washerCount + deltaWashers.value : prev.washerCount,
    springSet: prev.springSet,
    ...(chirp ? { chirp } : {}),
    ...(usual ? { usualDial: usual } : {}),
    ...(kind === 'washer_change' ? { deltaWashers: deltaWashers.value } : {}),
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
  };
  await repo.putEpoch(e);
  pending.value = null;
  note.value = '';
  await app.reloadAll();
  await app.afterEpochChanged?.();
  app.toast(
    'info',
    `New epoch: ${kind.replace('_', ' ')}. The next shot per bean re-anchors the model.`,
  );
}

export function Hardware() {
  const epochs = app.epochs.value;
  const current = app.currentEpoch.value;
  const ev = EVENTS.find((x) => x.kind === pending.value) ?? null;
  return (
    <div>
      <h1>Hardware</h1>
      {current ? (
        <div class="card accent">
          <h3>Current epoch</h3>
          <p class="small">
            {current.kind.replace('_', ' ')} since{' '}
            {new Date(current.startedAt).toLocaleDateString()} · {current.burrSet} ·{' '}
            {current.washerCount} washer{current.washerCount === 1 ? '' : 's'} · {current.springSet}{' '}
            springs
            <br />
            dial {current.dialSpec.numbersPerRev} numbers/rev × {current.dialSpec.linesPerNumber}{' '}
            lines/number × {current.dialSpec.revs} revs
            {current.chirp ? ` · chirp ${formatDial(current.chirp)}` : ' · no chirp recorded'}
            {current.usualDial ? ` · usual ${formatDial(current.usualDial)}` : ''}
          </p>
        </div>
      ) : null}

      <RpmCalibrationLink />

      <div class="card">
        <h3>Something changed?</h3>
        <div class="stack">
          {EVENTS.map((e) => (
            <button
              key={e.kind}
              type="button"
              class={pending.value === e.kind ? 'selected' : ''}
              onClick={() => (pending.value = pending.value === e.kind ? null : e.kind)}
            >
              {e.label}
            </button>
          ))}
        </div>
        {ev ? (
          <div style="margin-top:10px">
            <p class="small">{ev.resets}</p>
            {ev.kind === 'washer_change' ? (
              <label>
                <span>washers added (negative = removed)</span>
                <input
                  type="number"
                  value={deltaWashers.value}
                  onInput={(e) => (deltaWashers.value = Number(e.currentTarget.value))}
                />
              </label>
            ) : null}
            {ev.kind === 'dial_recount' ? (
              <label>
                <span>lines per number (recounted)</span>
                <input
                  type="number"
                  value={newLinesPerNumber.value}
                  onInput={(e) => (newLinesPerNumber.value = Number(e.currentTarget.value))}
                />
              </label>
            ) : null}
            {ev.kind === 're_zero' && current ? (
              <div>
                <span class="small muted">new chirp point</span>
                <DialPicker
                  value={newChirp.value}
                  spec={current.dialSpec}
                  onChange={(p) => (newChirp.value = p)}
                />
              </div>
            ) : null}
            {ev.kind === 'new_burrs' ? (
              <label>
                <span>burr set</span>
                <input
                  value={burrSet.value}
                  onInput={(e) => (burrSet.value = e.currentTarget.value)}
                  placeholder="e.g. SSP MP 58 mm"
                />
              </label>
            ) : null}
            <label>
              <span>note (optional)</span>
              <input value={note.value} onInput={(e) => (note.value = e.currentTarget.value)} />
            </label>
            <button
              type="button"
              class="primary wide"
              style="margin-top:8px"
              onClick={() => void apply()}
            >
              Open the new epoch
            </button>
          </div>
        ) : null}
      </div>

      <div class="card">
        <h3>Timeline</h3>
        <table>
          <thead>
            <tr>
              <th>from</th>
              <th>event</th>
              <th>hardware</th>
            </tr>
          </thead>
          <tbody>
            {[...epochs].reverse().map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.startedAt).toLocaleDateString()}</td>
                <td>
                  {e.kind.replace('_', ' ')}
                  {e.deltaWashers !== undefined
                    ? ` (${e.deltaWashers > 0 ? '+' : ''}${e.deltaWashers})`
                    : ''}
                  {e.note ? <div class="muted small">{e.note}</div> : null}
                </td>
                <td class="small">
                  {e.burrSet} · {e.washerCount} w · {e.springSet} · {e.dialSpec.linesPerNumber} l/n
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** RPM calibration status for this epoch (the flow effect is a grinder property). */
function RpmCalibrationLink() {
  const r = lastReplay.value;
  const kr = r ? kRpm(r.model) : null;
  const done = r ? isCalibrated(r.model) : false;
  return (
    <div class="card">
      <h3>RPM calibration</h3>
      <p class="small">
        {kr
          ? done
            ? `Calibrated for this epoch: +100 RPM changes ln flow by ${kr.mean.toFixed(3)} ± ${kr.sd.toFixed(3)}.`
            : `Not calibrated for this epoch (k_r ± ${kr.sd.toFixed(3)}). New burrs reset it; re-check the preferred body per bean.`
          : 'No shots in this epoch yet.'}
      </p>
      <a href="#/rpm" class="btn">
        {done ? 'Calibration and results' : 'Calibrate RPM (8 shots)'}
      </a>
    </div>
  );
}
