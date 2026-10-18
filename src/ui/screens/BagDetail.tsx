/** Bag detail: metadata, roaster recipe, storage events, archive, shot table and progress bars. */
import { signal } from '@preact/signals';
import { modelSummary, refreshModelSummary } from '../../app/recommender';
import { app } from '../../app/state';
import { MODEL, RULES } from '../../core/params';
import type { Bag, StorageEventKind } from '../../core/types';
import { formatDial } from '../../core/units';
import { nowIso } from '../../data/repo';
import { daysSince } from './Home';

const editing = signal(false);
const draft = signal<Bag | null>(null);

function Progress({
  label,
  value,
  max,
  text,
}: {
  label: string;
  value: number;
  max: number;
  text: string;
}) {
  const pct = Math.max(0, Math.min(100, (100 * value) / max));
  return (
    <div class="field">
      <div class="row between small">
        <span>{label}</span>
        <span class="muted">{text}</span>
      </div>
      <div class="progress">
        <div style={`width:${pct}%`} />
      </div>
    </div>
  );
}

export function BagDetail({ id }: { id: string }) {
  const bag = app.bags.value.find((b) => b.id === id);
  const bean = bag ? app.beans.value.find((b) => b.id === bag.beanId) : undefined;
  if (!bag || !bean) {
    return (
      <div>
        <h1>Bag</h1>
        <p class="muted">Not found.</p>
      </div>
    );
  }
  if (app.currentBagId.value !== bag.id)
    void app.selectBag(bag.id).then(() => refreshModelSummary());
  const shots = app.shotsOfBag.value;
  const m = modelSummary.value;
  const d = draft.value ?? bag;
  const gainReady = m !== null && m.kGrind[1] <= MODEL.kGrindSdConverged;
  const spSd = m ? m.setpoint[1] : Number.NaN;
  const save = async () => {
    if (draft.value) await app.updateBag(draft.value);
    editing.value = false;
    draft.value = null;
  };
  const addEvent = async (event: StorageEventKind) => {
    await app.updateBag({ ...bag, storage: [...bag.storage, { at: nowIso(), event }] });
    await refreshModelSummary();
  };
  return (
    <div>
      <div class="row between">
        <h1>
          {bean.roaster} · {bean.name}
        </h1>
        <button
          type="button"
          class="small"
          onClick={() => {
            editing.value = !editing.value;
            draft.value = { ...bag };
          }}
        >
          {editing.value ? 'Cancel' : 'Edit'}
        </button>
      </div>
      <div class="card">
        <Progress
          label="flow model"
          value={Math.min(4, m?.learnableShots ?? 0)}
          max={4}
          text={`${Math.min(4, m?.learnableShots ?? 0)}/4 shots`}
        />
        <Progress
          label="taste setpoint"
          value={Number.isNaN(spSd) ? 0 : Math.max(0, 0.2 - spSd)}
          max={0.2 - RULES.setpointSdConverged}
          text={Number.isNaN(spSd) ? '—' : `±${(spSd * 100).toFixed(0)} % (found at ±6 %)`}
        />
        <p class="small">
          Gain{' '}
          {gainReady && m?.secPerLine
            ? `≈ ${m.secPerLine[0].toFixed(1)} s per line ± ${m.secPerLine[1].toFixed(1)}`
            : 'still learning (needs 4–6 learnable shots ≥ 10 lines apart)'}
        </p>
      </div>
      <div class="card">
        {editing.value ? (
          <div class="grid2">
            <label>
              <span>roast date</span>
              <input
                type="date"
                value={d.roastDate}
                onInput={(e) => (draft.value = { ...d, roastDate: e.currentTarget.value })}
              />
            </label>
            <label>
              <span>dose g (fixed)</span>
              <input
                type="number"
                step="0.1"
                value={d.doseDefaultG}
                onInput={(e) =>
                  (draft.value = { ...d, doseDefaultG: Number(e.currentTarget.value) })
                }
              />
            </label>
            <label>
              <span>target yield g</span>
              <input
                type="number"
                value={d.targetYieldG}
                onInput={(e) =>
                  (draft.value = { ...d, targetYieldG: Number(e.currentTarget.value) })
                }
              />
            </label>
            <label>
              <span>held RPM</span>
              <input
                type="number"
                step="100"
                value={d.rpm}
                onInput={(e) => (draft.value = { ...d, rpm: Number(e.currentTarget.value) })}
              />
            </label>
            <label>
              <span>recipe yield g</span>
              <input
                type="number"
                value={d.roasterRecipe?.yieldG ?? ''}
                onInput={(e) => {
                  const v = Number(e.currentTarget.value);
                  const { yieldG: _old, ...rest } = d.roasterRecipe ?? {};
                  draft.value = {
                    ...d,
                    roasterRecipe: v > 0 ? { ...rest, yieldG: v } : rest,
                  };
                }}
              />
            </label>
            <label>
              <span>recipe time s (e.g. 28-32)</span>
              <input
                value={d.roasterRecipe?.timeS ? d.roasterRecipe.timeS.join('-') : ''}
                onInput={(e) => {
                  const m2 = e.currentTarget.value.match(/^(\d+)\s*-\s*(\d+)$/);
                  draft.value = {
                    ...d,
                    roasterRecipe: {
                      ...(d.roasterRecipe ?? {}),
                      ...(m2 ? { timeS: [Number(m2[1]), Number(m2[2])] as [number, number] } : {}),
                    },
                  };
                }}
              />
            </label>
            <label class="row" style="align-items:center;gap:8px">
              <input
                type="checkbox"
                checked={d.archived}
                onChange={(e) => (draft.value = { ...d, archived: e.currentTarget.checked })}
              />
              archived
            </label>
            <button type="button" class="primary" onClick={() => void save()}>
              Save
            </button>
          </div>
        ) : (
          <p class="small">
            roasted {bag.roastDate} ({daysSince(bag.roastDate)} days) · {bag.doseDefaultG} g →{' '}
            {bag.targetYieldG} g · {bag.rpm} RPM
            {bag.roasterRecipe?.raw ? ` · recipe: ${bag.roasterRecipe.raw}` : ''}
            {bag.roasterRecipe?.yieldG ? ` · recipe ${bag.roasterRecipe.yieldG} g` : ''}
            {bag.roasterRecipe?.timeS
              ? ` in ${bag.roasterRecipe.timeS[0]}–${bag.roasterRecipe.timeS[1]} s`
              : ''}
            {bag.archived ? ' · archived' : ''}
          </p>
        )}
        <div class="row" style="margin-top:6px">
          {(['opened', 'frozen', 'thawed', 'finished'] as const).map((ev) => (
            <button key={ev} type="button" class="small" onClick={() => void addEvent(ev)}>
              {ev}
            </button>
          ))}
        </div>
        {bag.storage.length > 0 ? (
          <p class="muted small">
            {bag.storage
              .map((e) => `${e.event} ${new Date(e.at).toLocaleDateString()}`)
              .join(' · ')}
          </p>
        ) : null}
      </div>
      <div class="card">
        <h3>Shots ({shots.length})</h3>
        <table>
          <tbody>
            {[...shots].reverse().map((s) => (
              <tr key={s.id}>
                <td class="small">{new Date(s.at).toLocaleDateString()}</td>
                <td class="small">
                  {formatDial(s.settings.grind.dialPos)} · {s.settings.grind.rpm} ·{' '}
                  {s.settings.targetYieldG} g
                </td>
                <td class="small">
                  {s.features.finalYieldG.toFixed(1)} g / {s.features.totalTimeS.toFixed(0)} s ·{' '}
                  {s.features.plateauFlow?.toFixed(2) ?? '—'} g/s
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="small">
          <a href="#/history">Full history and charts</a>
        </p>
      </div>
    </div>
  );
}
