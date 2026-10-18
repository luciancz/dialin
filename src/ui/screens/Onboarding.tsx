/**
 * Onboarding: the assumptions the app needs the user to confirm at the machine (plan
 * "Open assumptions to confirm at onboarding"). Writes Settings and the calibration epoch.
 */
import { signal } from '@preact/signals';
import { navigate } from '../../app/router';
import { app } from '../../app/state';
import type { CalibrationEpoch, DialPosition, DialSpec, TempSwitch } from '../../core/types';
import { DEFAULT_DIAL_SPEC, fromLines, toLines } from '../../core/units';
import { newMeta, nowIso } from '../../data/repo';
import { DialPicker } from '../components/DialPicker';

interface Form {
  numbersPerRev: number;
  linesPerNumber: number;
  revs: number;
  burrSet: string;
  washerCount: number;
  springSet: string;
  hasChirp: boolean;
  chirp: DialPosition;
  usualDial: DialPosition;
  scaleFirmware: string;
  scaleName: string;
  timerModeChecked: boolean;
  rpmResets: 'true' | 'false' | 'unknown';
  temp: TempSwitch;
  mode: 'coffee' | 'steam' | 'unknown';
  flushHabit: string;
  defaultDose: number;
  defaultRpm: number;
  allowLowRpm: boolean;
}

const form = signal<Form | null>(null);

function initForm(): Form {
  const s = app.settings.value;
  const e = app.currentEpoch.value;
  const spec = e?.dialSpec ?? DEFAULT_DIAL_SPEC;
  return {
    numbersPerRev: spec.numbersPerRev,
    linesPerNumber: spec.linesPerNumber,
    revs: spec.revs,
    burrSet: e?.burrSet ?? 'stock SUS420 58 mm',
    washerCount: e?.washerCount ?? 0,
    springSet: e?.springSet ?? 'stock',
    hasChirp: Boolean(e?.chirp),
    chirp: e?.chirp ?? { rev: 1, number: 0, line: 0 },
    usualDial: e?.usualDial ?? { rev: 2, number: 5, line: 0 },
    scaleFirmware: s?.scaleFirmware ?? '',
    scaleName: s?.scaleName ?? '',
    timerModeChecked: false,
    rpmResets:
      s?.rpmResetsOnPowerOn === 'unknown' || s?.rpmResetsOnPowerOn === undefined
        ? 'unknown'
        : s.rpmResetsOnPowerOn
          ? 'true'
          : 'false',
    temp: s?.maraSwitch.temp ?? 1,
    mode: s?.maraSwitch.mode ?? 'coffee',
    flushHabit: '',
    defaultDose: 18,
    defaultRpm: s?.defaultRpm ?? 1000,
    allowLowRpm: s?.allowLowRpm ?? false,
  };
}

function set<K extends keyof Form>(k: K, v: Form[K]): void {
  if (form.value) form.value = { ...form.value, [k]: v };
}

async function save(): Promise<void> {
  const f = form.value;
  const settings = app.settings.value;
  const repo = app.repo;
  const epoch = app.currentEpoch.value;
  if (!f || !settings || !repo || !epoch) return;
  const spec: DialSpec = {
    numbersPerRev: Math.max(1, Math.round(f.numbersPerRev)),
    linesPerNumber: Math.max(1, Math.round(f.linesPerNumber)),
    revs: Math.max(1, Math.round(f.revs)),
    umPerLineNominal: 5,
  };
  const usual = fromLines(toLines(f.usualDial, spec), spec);
  const chirp = f.hasChirp ? fromLines(toLines(f.chirp, spec), spec) : undefined;
  const shotsInEpoch = (await repo.listShots()).some((s) => s.epochId === epoch.id);
  const specChanged = JSON.stringify(spec) !== JSON.stringify(epoch.dialSpec);
  const hardwareChanged =
    f.burrSet !== epoch.burrSet ||
    f.washerCount !== epoch.washerCount ||
    f.springSet !== epoch.springSet;
  const base = {
    dialSpec: spec,
    burrSet: f.burrSet,
    washerCount: f.washerCount,
    springSet: f.springSet,
    ...(chirp ? { chirp } : {}),
    usualDial: usual,
  };
  if (!shotsInEpoch) {
    const updated: CalibrationEpoch = { ...epoch, ...base, note: 'set up during onboarding' };
    if (!chirp) delete (updated as Partial<CalibrationEpoch>).chirp;
    await repo.putEpoch(updated);
  } else if (specChanged || hardwareChanged) {
    const kind: CalibrationEpoch['kind'] = specChanged
      ? 'dial_recount'
      : f.washerCount !== epoch.washerCount
        ? 'washer_change'
        : f.burrSet !== epoch.burrSet
          ? 'new_burrs'
          : 'spring_change';
    await repo.putEpoch({
      ...newMeta(settings.deviceId),
      startedAt: nowIso(),
      kind,
      parentEpochId: epoch.id,
      ...base,
      ...(kind === 'washer_change' ? { deltaWashers: f.washerCount - epoch.washerCount } : {}),
      note: 'changed while re-running onboarding',
    });
  }
  await app.saveSettings({
    onboardingDone: true,
    defaultRpm: f.defaultRpm,
    allowLowRpm: f.allowLowRpm,
    rpmResetsOnPowerOn: f.rpmResets === 'unknown' ? 'unknown' : f.rpmResets === 'true',
    maraSwitch: { temp: f.temp, mode: f.mode },
    ...(f.scaleFirmware ? { scaleFirmware: f.scaleFirmware } : {}),
    ...(f.scaleName ? { scaleName: f.scaleName } : {}),
  });
  app.nextSettings.value = {
    ...app.nextSettings.value,
    grind: { dialPos: usual, rpm: f.defaultRpm, rpmConfirmed: false },
    doseG: f.defaultDose,
    tempSwitch: f.temp,
  };
  await app.reloadAll();
  form.value = null;
  app.toast('info', 'Onboarding saved.');
  navigate('/probe');
}

export function Onboarding() {
  if (!form.value) form.value = initForm();
  const f = form.value;
  const spec: DialSpec = {
    numbersPerRev: f.numbersPerRev,
    linesPerNumber: f.linesPerNumber,
    revs: f.revs,
    umPerLineNominal: 5,
  };
  return (
    <div>
      <h1>Set-up</h1>
      <p class="muted small">
        Check these at the machine. Defaults are used until you save; everything can be changed
        later in Settings and Hardware.
      </p>

      <div class="card">
        <h3>1 · VS6 dial</h3>
        <div class="grid3">
          <label>
            <span>numbers per rev</span>
            <input
              type="number"
              value={f.numbersPerRev}
              onInput={(e) => set('numbersPerRev', Number(e.currentTarget.value))}
            />
          </label>
          <label>
            <span>lines per number</span>
            <input
              type="number"
              value={f.linesPerNumber}
              onInput={(e) => set('linesPerNumber', Number(e.currentTarget.value))}
            />
          </label>
          <label>
            <span>revolutions</span>
            <input
              type="number"
              value={f.revs}
              onInput={(e) => set('revs', Number(e.currentTarget.value))}
            />
          </label>
        </div>
        <p class="muted small">
          Count the small ticks between the numbers 2 and 3 on the dial; that is "lines per number".
          The gain is learned per line, so an honest count matters more than µm.
        </p>
      </div>

      <div class="card">
        <h3>2 · Grinder hardware</h3>
        <div class="grid3">
          <label>
            <span>burr set</span>
            <input value={f.burrSet} onInput={(e) => set('burrSet', e.currentTarget.value)} />
          </label>
          <label>
            <span>washers</span>
            <input
              type="number"
              value={f.washerCount}
              onInput={(e) => set('washerCount', Number(e.currentTarget.value))}
            />
          </label>
          <label>
            <span>springs</span>
            <input value={f.springSet} onInput={(e) => set('springSet', e.currentTarget.value)} />
          </label>
        </div>
        <label class="row" style="align-items:center;gap:8px;margin-top:6px">
          <input
            type="checkbox"
            checked={f.hasChirp}
            onChange={(e) => set('hasChirp', e.currentTarget.checked)}
          />
          I know the chirp point (burrs just touching)
        </label>
        {f.hasChirp ? (
          <DialPicker value={f.chirp} spec={spec} onChange={(p) => set('chirp', p)} />
        ) : null}
      </div>

      <div class="card">
        <h3>3 · Usual espresso dial</h3>
        <p class="muted small">
          Where you normally pull, or chirp + 15 lines. This seeds the model's reference line.
        </p>
        <DialPicker value={f.usualDial} spec={spec} onChange={(p) => set('usualDial', p)} />
      </div>

      <div class="card">
        <h3>4 · Scale</h3>
        <div class="grid2">
          <label>
            <span>firmware (BOOKOO N app)</span>
            <input
              value={f.scaleFirmware}
              onInput={(e) => set('scaleFirmware', e.currentTarget.value)}
              placeholder="1.4.1"
            />
          </label>
          <label>
            <span>advertised name</span>
            <input
              value={f.scaleName}
              onInput={(e) => set('scaleName', e.currentTarget.value)}
              placeholder="BOOKOO_SC 123456"
            />
          </label>
        </div>
        <label class="row" style="align-items:center;gap:8px;margin-top:6px">
          <input
            type="checkbox"
            checked={f.timerModeChecked}
            onChange={(e) => set('timerModeChecked', e.currentTarget.checked)}
          />
          The scale is in Timer mode (not Auto / flow-rate mode)
        </label>
      </div>

      <div class="card">
        <h3>5 · Grinder RPM and machine</h3>
        <label>
          <span>Does the VS6 show 0500 after power-on?</span>
          <select
            value={f.rpmResets}
            onChange={(e) => set('rpmResets', e.currentTarget.value as Form['rpmResets'])}
          >
            <option value="unknown">don't know yet</option>
            <option value="true">yes, it resets</option>
            <option value="false">no, it remembers</option>
          </select>
        </label>
        <div class="grid2">
          <label>
            <span>Mara X temperature switch</span>
            <select
              value={f.temp}
              onChange={(e) => set('temp', Number(e.currentTarget.value) as TempSwitch)}
            >
              <option value={0}>0</option>
              <option value={1}>I</option>
              <option value={2}>II</option>
            </select>
          </label>
          <label>
            <span>mode switch</span>
            <select
              value={f.mode}
              onChange={(e) => set('mode', e.currentTarget.value as Form['mode'])}
            >
              <option value="coffee">coffee priority</option>
              <option value="steam">steam priority</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
        </div>
        <label>
          <span>flush habit (free text)</span>
          <input
            value={f.flushHabit}
            onInput={(e) => set('flushHabit', e.currentTarget.value)}
            placeholder="5 s flush, then 2 min wait"
          />
        </label>
      </div>

      <div class="card">
        <h3>6 · Defaults</h3>
        <div class="grid3">
          <label>
            <span>dose g</span>
            <input
              type="number"
              step="0.1"
              value={f.defaultDose}
              onInput={(e) => set('defaultDose', Number(e.currentTarget.value))}
            />
          </label>
          <label>
            <span>RPM</span>
            <input
              type="number"
              step="100"
              value={f.defaultRpm}
              onInput={(e) => set('defaultRpm', Number(e.currentTarget.value))}
            />
          </label>
          <label class="row" style="align-items:center;gap:8px">
            <input
              type="checkbox"
              checked={f.allowLowRpm}
              onChange={(e) => set('allowLowRpm', e.currentTarget.checked)}
            />
            allow 500–600 RPM
          </label>
        </div>
      </div>

      <div class="card probe">
        <h3>7 · Bluetooth probe</h3>
        <p class="small">
          After saving you land on the probe: connect the scale and record what this browser
          supports.
        </p>
        <p class="small">
          <b>iPhone:</b> open this page inside <b>Bluefy</b> and bookmark it there. A Home Screen
          icon opens Safari, which has no Bluetooth. Turn Auto-Lock off while dialling in.
        </p>
      </div>

      <button type="button" class="primary wide" onClick={() => void save()}>
        Save and open the probe
      </button>
    </div>
  );
}
