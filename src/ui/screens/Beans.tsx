import { signal } from '@preact/signals';
import { navigate } from '../../app/router';
import { app } from '../../app/state';
import type { Bag, Bean, Process, RoastLevel, RoastTarget } from '../../core/types';
import { daysSince } from './Home';

const ROASTS: RoastLevel[] = ['light', 'medium_light', 'medium', 'medium_dark', 'dark', 'unknown'];
const PROCESSES: Process[] = [
  'washed',
  'natural',
  'honey',
  'anaerobic',
  'carbonic_maceration',
  'other',
  'unknown',
];
const TARGETS: RoastTarget[] = ['espresso', 'omni', 'filter', 'unknown'];

const showForm = signal(false);
const form = signal({
  roaster: '',
  name: '',
  origin: '',
  roastLevel: 'light' as RoastLevel,
  process: 'washed' as Process,
  roastTarget: 'espresso' as RoastTarget,
  decaf: false,
  roastDate: new Date().toISOString().slice(0, 10),
  doseDefaultG: 18,
  rpm: 1000,
  recipe: '',
  notes: '',
});
const newBagFor = signal<string | null>(null);
const newBagDate = signal(new Date().toISOString().slice(0, 10));

function field<K extends keyof typeof form.value>(k: K, v: (typeof form.value)[K]): void {
  form.value = { ...form.value, [k]: v };
}

async function submit(): Promise<void> {
  const f = form.value;
  if (!f.roaster.trim() || !f.name.trim()) {
    app.toast('warn', 'Roaster and name are required.');
    return;
  }
  const bean: Omit<Bean, 'id' | 'createdAt' | 'updatedAt' | 'deviceId'> = {
    roaster: f.roaster.trim(),
    name: f.name.trim(),
    roastLevel: f.roastLevel,
    roastTarget: f.roastTarget,
    process: f.process,
    decaf: f.decaf,
    ...(f.origin.trim() ? { origin: f.origin.trim() } : {}),
    ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
  };
  const bag = await app.createBeanAndBag(bean, {
    roastDate: f.roastDate,
    doseDefaultG: f.doseDefaultG,
    rpm: f.rpm,
  });
  if (f.recipe.trim()) await app.updateBag({ ...bag, roasterRecipe: { raw: f.recipe.trim() } });
  showForm.value = false;
  app.toast('info', 'Bag created and selected.');
  navigate('/');
}

async function confirmDeleteBean(bean: Bean, beanBags: Bag[]): Promise<void> {
  const repo = app.repo;
  if (!repo) return;
  const shots = (await Promise.all(beanBags.map((b) => repo.listShotsForBag(b.id)))).flat().length;
  const n = beanBags.length;
  if (
    confirm(
      `Delete ${bean.roaster} · ${bean.name} with its ${n} bag${n === 1 ? '' : 's'} and ${shots} shot${shots === 1 ? '' : 's'}? This cannot be undone (export a backup first to keep them).`,
    )
  )
    await app.deleteBean(bean.id);
}

export function Beans() {
  const beans = app.beans.value;
  const bags = app.bags.value;
  const current = app.currentBagId.value;
  const f = form.value;
  return (
    <div>
      <div class="row between">
        <h1>Beans & bags</h1>
        <button
          type="button"
          class="small primary"
          onClick={() => (showForm.value = !showForm.value)}
        >
          {showForm.value ? 'Close' : 'Add bean'}
        </button>
      </div>
      {showForm.value ? (
        <div class="card accent">
          <div class="grid2">
            <label>
              <span>Roaster</span>
              <input value={f.roaster} onInput={(e) => field('roaster', e.currentTarget.value)} />
            </label>
            <label>
              <span>Name</span>
              <input value={f.name} onInput={(e) => field('name', e.currentTarget.value)} />
            </label>
            <label>
              <span>Origin (optional)</span>
              <input value={f.origin} onInput={(e) => field('origin', e.currentTarget.value)} />
            </label>
            <label>
              <span>Roast level</span>
              <select
                value={f.roastLevel}
                onChange={(e) => field('roastLevel', e.currentTarget.value as RoastLevel)}
              >
                {ROASTS.map((r) => (
                  <option key={r} value={r}>
                    {r.replace('_', '-')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Process</span>
              <select
                value={f.process}
                onChange={(e) => field('process', e.currentTarget.value as Process)}
              >
                {PROCESSES.map((r) => (
                  <option key={r} value={r}>
                    {r.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Roast target</span>
              <select
                value={f.roastTarget}
                onChange={(e) => field('roastTarget', e.currentTarget.value as RoastTarget)}
              >
                {TARGETS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Roast date</span>
              <input
                type="date"
                value={f.roastDate}
                onInput={(e) => field('roastDate', e.currentTarget.value)}
              />
            </label>
            <label>
              <span>Dose (g, fixed per bag)</span>
              <input
                type="number"
                step="0.1"
                value={f.doseDefaultG}
                onInput={(e) => field('doseDefaultG', Number(e.currentTarget.value))}
              />
            </label>
            <label>
              <span>Starting RPM</span>
              <input
                type="number"
                step="100"
                value={f.rpm}
                onInput={(e) => field('rpm', Number(e.currentTarget.value))}
              />
            </label>
            <label class="row" style="align-items:center;gap:8px">
              <input
                type="checkbox"
                checked={f.decaf}
                onChange={(e) => field('decaf', e.currentTarget.checked)}
              />
              decaf
            </label>
          </div>
          <label>
            <span>Roaster recipe (optional, free text)</span>
            <input
              value={f.recipe}
              onInput={(e) => field('recipe', e.currentTarget.value)}
              placeholder="18 g → 40 g in 30 s, 93 °C"
            />
          </label>
          <label>
            <span>Notes</span>
            <input value={f.notes} onInput={(e) => field('notes', e.currentTarget.value)} />
          </label>
          <button
            type="button"
            class="primary wide"
            style="margin-top:8px"
            onClick={() => void submit()}
          >
            Create bean and bag
          </button>
        </div>
      ) : null}
      {beans.length === 0 && !showForm.value ? <p class="muted">No beans yet.</p> : null}
      {beans.map((bean) => {
        const beanBags = bags
          .filter((b) => b.beanId === bean.id)
          .sort((a, b) => b.roastDate.localeCompare(a.roastDate));
        return (
          <div class="card" key={bean.id}>
            <div class="row between">
              <b>
                {bean.roaster} · {bean.name}
              </b>
              <span class="muted small">
                {bean.roastLevel.replace('_', '-')} · {bean.process}
                {bean.decaf ? ' · decaf' : ''}
              </span>
            </div>
            {beanBags.map((bag) => (
              <BagRow key={bag.id} bag={bag} selected={bag.id === current} />
            ))}
            {newBagFor.value === bean.id ? (
              <div class="row" style="margin-top:6px">
                <input
                  type="date"
                  value={newBagDate.value}
                  onInput={(e) => (newBagDate.value = e.currentTarget.value)}
                />
                <button
                  type="button"
                  class="small primary"
                  onClick={() => {
                    const last = beanBags[0];
                    void app
                      .createBag(bean.id, {
                        roastDate: newBagDate.value,
                        doseDefaultG: last?.doseDefaultG ?? 18,
                        rpm: last?.rpm ?? 1000,
                      })
                      .then(() => {
                        newBagFor.value = null;
                      });
                  }}
                >
                  Add
                </button>
                <button type="button" class="small" onClick={() => (newBagFor.value = null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div class="row" style="margin-top:6px">
                <button type="button" class="small" onClick={() => (newBagFor.value = bean.id)}>
                  New bag of this bean
                </button>
                <button
                  type="button"
                  class="small danger"
                  onClick={() => void confirmDeleteBean(bean, beanBags)}
                >
                  Delete bean
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BagRow({ bag, selected }: { bag: Bag; selected: boolean }) {
  return (
    <div class="row between" style="margin-top:6px">
      <div>
        <span class={selected ? 'ok' : ''}>{selected ? '● ' : '○ '}</span>
        roasted {bag.roastDate} ({daysSince(bag.roastDate)} d) · {bag.doseDefaultG} g →{' '}
        {bag.targetYieldG} g · {bag.rpm} RPM
        {bag.archived ? (
          <span class="badge" style="margin-left:6px">
            archived
          </span>
        ) : null}
      </div>
      <div class="row">
        {!selected ? (
          <button type="button" class="small" onClick={() => void app.selectBag(bag.id)}>
            Select
          </button>
        ) : null}
        <a href={`#/bag/${bag.id}`} class="small">
          detail
        </a>
      </div>
    </div>
  );
}
