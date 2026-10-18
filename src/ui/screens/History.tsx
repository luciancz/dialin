/**
 * History: per-bag shot list with badges and the learn toggle, flow-vs-lines scatter with
 * the fitted line ± σ, and an overlay of two curves.
 */
import { signal } from '@preact/signals';
import { lastReplay, refreshModelSummary } from '../../app/recommender';
import { app } from '../../app/state';
import { predictAt } from '../../core/flowmodel/invert';
import { bagContext } from '../../core/replay';
import type { Curve, Id, Shot, ShotQuality } from '../../core/types';
import { formatDial, toLines } from '../../core/units';
import { CurveChart } from '../charts/CurveChart';
import { ScatterChart } from '../charts/ScatterChart';

const overlay = signal<Id[]>([]);
const curves = signal<Map<Id, Curve>>(new Map());
const noteFor = signal<Id | null>(null);
const noteText = signal('');

async function toggleOverlay(shotId: Id): Promise<void> {
  const cur = overlay.value;
  if (cur.includes(shotId)) {
    overlay.value = cur.filter((x) => x !== shotId);
    return;
  }
  const next = [...cur, shotId].slice(-2);
  const map = new Map(curves.value);
  for (const id of next) {
    if (!map.has(id)) {
      const c = await app.repo?.getCurveForShot(id);
      if (c) map.set(id, c);
    }
  }
  curves.value = map;
  overlay.value = next;
}

async function flipLearn(q: ShotQuality, note: string): Promise<void> {
  const repo = app.repo;
  if (!repo) return;
  await repo.putQuality({
    ...q,
    learn: !q.learn,
    userOverride: true,
    notes: [...q.notes, `${q.learn ? 'excluded' : 'included'} by hand: ${note || 'no note'}`],
  });
  noteFor.value = null;
  noteText.value = '';
  const bagId = app.currentBagId.value;
  if (bagId) await app.loadBagRows(bagId);
  await refreshModelSummary();
}

function badge(
  shot: Shot,
  q: ShotQuality | undefined,
  skipped: boolean,
): { text: string; cls: string } {
  if (q && !q.learn)
    return {
      text: q.userOverride
        ? 'excluded by hand'
        : q.status === 'ok'
          ? 'excluded'
          : q.status.replace('_', ' '),
      cls: 'warn',
    };
  if (skipped) return { text: 'outlier', cls: 'bad' };
  if (q?.status === 'late_tap') return { text: 'late tap', cls: 'ok' };
  if (shot.endedBy === 'disconnect') return { text: 'partial', cls: 'warn' };
  return { text: 'ok', cls: 'ok' };
}

export function History() {
  const bag = app.currentBag.value;
  const shots = app.shotsOfBag.value;
  const quality = app.qualityOfBag.value;
  const ratings = app.ratingsOfBag.value;
  const epoch = app.currentEpoch.value;
  const result = lastReplay.value;
  const views = bag && result ? bagContext(result, bag.id).views : [];
  const spec = epoch?.dialSpec;
  if (!bag || !spec) {
    return (
      <div>
        <h1>History</h1>
        <p class="muted">Select a bag first.</p>
      </div>
    );
  }
  const points = views
    .filter((v) => v.y !== null)
    .map((v) => ({
      x: v.lines,
      y: v.y as number,
      learn: v.learn && !v.skipped,
      label: formatDial(v.shot.settings.grind.dialPos),
    }));
  const xs = points.map((p) => p.x);
  const lo = xs.length ? Math.min(...xs) - 5 : 0;
  const hi = xs.length ? Math.max(...xs) + 5 : 10;
  const line: { x: number; y: number; sd: number }[] = [];
  if (result) {
    const cur = shots[shots.length - 1]?.settings;
    for (let L = lo; L <= hi; L += Math.max(1, Math.round((hi - lo) / 20))) {
      const p = predictAt(
        result.model,
        bag.id,
        L,
        cur?.grind.rpm ?? 1000,
        cur?.doseG ?? bag.doseDefaultG,
      );
      if (p) line.push({ x: L, y: p.yHat, sd: p.sP });
    }
  }
  const ov = overlay.value
    .map((id) => curves.value.get(id))
    .filter((c): c is Curve => c !== undefined);
  return (
    <div>
      <h1>History</h1>
      <p class="muted small">
        {shots.length} shots of this bag · tap "overlay" on two shots to compare their curves.
      </p>
      {points.length > 0 ? (
        <div class="card">
          <h3>Flow vs dial</h3>
          <ScatterChart points={points} line={line} xLabel="lines" />
        </div>
      ) : null}
      {ov.length > 0 ? (
        <div class="card">
          <h3>Overlay</h3>
          <CurveChart series={ov.map((c, i) => ({ t: c.t, g: c.g, label: `shot ${i + 1}` }))} />
        </div>
      ) : null}
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>when</th>
              <th>settings</th>
              <th>result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...shots].reverse().map((s) => {
              const q = quality.find((x) => x.shotId === s.id);
              const r = ratings.find((x) => x.shotId === s.id);
              const v = views.find((x) => x.shot.id === s.id);
              const b = badge(s, q, v?.skipped ?? false);
              return (
                <tr key={s.id}>
                  <td class="small">{new Date(s.at).toLocaleString()}</td>
                  <td class="small">
                    {formatDial(s.settings.grind.dialPos)} (
                    {toLines(s.settings.grind.dialPos, spec)}) · {s.settings.grind.rpm} ·{' '}
                    {s.settings.doseG} → {s.settings.targetYieldG} g
                  </td>
                  <td class="small">
                    {s.features.finalYieldG.toFixed(1)} g / {s.features.totalTimeS.toFixed(0)} s ·{' '}
                    {s.features.plateauFlow?.toFixed(2) ?? '—'} g/s
                    {r
                      ? ` · ${r.vsPrevious ?? ''} v${r.sourBitter ?? '·'} h${r.thinHeavy ?? '·'}${r.chips.length ? ` ${r.chips.join(',')}` : ''}`
                      : ''}
                    <div>
                      <span class={`badge ${b.cls}`}>{b.text}</span>
                      {s.deviation ? (
                        <span class="badge" style="margin-left:4px">
                          {s.deviation}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <button type="button" class="small" onClick={() => void toggleOverlay(s.id)}>
                      {overlay.value.includes(s.id) ? 'un-overlay' : 'overlay'}
                    </button>
                    {q ? (
                      <button
                        type="button"
                        class="small"
                        onClick={() => (noteFor.value = noteFor.value === s.id ? null : s.id)}
                      >
                        {q.learn ? 'exclude' : 'include'}
                      </button>
                    ) : null}
                    {noteFor.value === s.id && q ? (
                      <div class="row" style="margin-top:4px">
                        <input
                          placeholder="why?"
                          value={noteText.value}
                          onInput={(e) => (noteText.value = e.currentTarget.value)}
                        />
                        <button
                          type="button"
                          class="small primary"
                          onClick={() => void flipLearn(q, noteText.value)}
                        >
                          OK
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
