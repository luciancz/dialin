/**
 * Shot screen: pre-shot card → ARMED → live view → rate sheet. Driven entirely by
 * app.recorder (the pure reducer's state) and app.pending.
 */
import { signal } from '@preact/signals';
import { reportStall } from '../../app/calibration';
import { isDemo } from '../../app/mode';
import { navigate } from '../../app/router';
import {
  backToPlan,
  grindStartedAt,
  openGrindStep,
  openWeighStep,
  preStep,
  weighOpenedAt,
} from '../../app/shotFlow';
import { app } from '../../app/state';
import { allowedRpmRange, e006Guidance } from '../../core/rpm/range';
import type { Chip, Rating, SliderValue, TempSwitch, VsPrevious } from '../../core/types';
import { DEFAULT_DIAL_SPEC, formatDial, toLines } from '../../core/units';
import { realClock } from '../../scale/clock';
import { doseNote, openWeigh, weighStep } from '../../shot/weigh';
import { CurveChart } from '../charts/CurveChart';
import { ConnectionPill } from '../components/ConnectionPill';
import { DialPicker } from '../components/DialPicker';
import { ThreeView } from '../components/ThreeView';

const rpmConfirmedThisSession = signal(false);
const deviation = signal<'followed' | 'partly' | 'ignored' | null>(null);

// ---- rating sheet state ----
const vs = signal<VsPrevious | null>(null);
const sourBitter = signal<SliderValue | null>(null);
const thinHeavy = signal<SliderValue | null>(null);
const chips = signal<Chip[]>([]);
const overall = signal<number | null>(null);
const manualYield = signal('');

function resetRating(): void {
  vs.value = null;
  sourBitter.value = null;
  thinHeavy.value = null;
  chips.value = [];
  overall.value = null;
  manualYield.value = '';
}

export function Shot() {
  const rec = app.recorder.value;
  const pending = app.pending.value;
  if (pending) return <RateSheet />;
  if (rec.phase === 'IDLE' || rec.phase === 'SAVED' || rec.phase === 'ABORTED') return <PreShot />;
  if (rec.phase === 'ARMED') return <Armed />;
  return <Live />;
}

function PreShot() {
  const bag = app.currentBag.value;
  const epoch = app.currentEpoch.value;
  const settings = app.settings.value;
  const ns = app.nextSettings.value;
  const spec = epoch?.dialSpec ?? DEFAULT_DIAL_SPEC;
  const connected = app.clientState.value === 'connected';
  const lastRec = app.lastRecommendation.value;
  const rpmNag = settings?.rpmResetsOnPowerOn !== false && !rpmConfirmedThisSession.value;
  const range = bag ? allowedRpmRange(settings?.rpmRange, [bag]) : ([500, 1600] as const);
  const slot = lastRec?.calibration ?? null;
  const onSlot = slot !== null && ns.grind.rpm === slot.plannedRpm;
  const lowRpm = e006Guidance(ns.grind.rpm);
  if (!bag) {
    return (
      <div>
        <h1>Shot</h1>
        <div class="card">
          <p>Select or create a bag first.</p>
          <a href="#/beans" class="btn">
            Beans & bags
          </a>
        </div>
      </div>
    );
  }
  const set = (patch: Partial<typeof ns>) => {
    app.nextSettings.value = { ...ns, ...patch };
  };
  if (preStep.value === 'weigh') return <WeighBeans />;
  if (preStep.value === 'grind') return <Grind />;
  const weighed = app.weighedDose.value;
  const doseWeighed = weighed !== null && Math.abs(weighed.g - ns.doseG) < 0.05;
  return (
    <div>
      <div class="row between">
        <h1>Pre-shot</h1>
        <ConnectionPill />
      </div>
      {lastRec ? (
        <div class="card">
          <div class="small muted">Last recommendation: {lastRec.sentence}</div>
          <div class="row" style="margin-top:6px">
            {(['followed', 'partly', 'ignored'] as const).map((d) => (
              <button
                key={d}
                type="button"
                class={`small ${deviation.value === d ? 'selected' : ''}`}
                onClick={() => {
                  deviation.value = d;
                  app.pendingDeviation = d;
                }}
              >
                {d === 'ignored' ? 'did something else' : d}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {slot ? (
        <div class={`card ${onSlot ? 'probe' : 'warn'}`}>
          <b>
            RPM calibration {slot.slot + 1}/8 · {slot.plannedRpm} RPM
          </b>
          <p class="small">
            {onSlot
              ? 'Dial and RPM are prefilled from the card (the dial is compensated for this RPM). Feed the beans the same way as always; rate thin–heavy first.'
              : `Set ${slot.plannedRpm} RPM for this slot; at another RPM the shot is not counted for the session.`}{' '}
            <a href="#/rpm">Session</a>
          </p>
        </div>
      ) : null}
      <div class={`card ${doseWeighed ? '' : 'accent'}`}>
        <div class="row between">
          <h3>Beans</h3>
          {doseWeighed ? <span class="badge ok">{ns.doseG.toFixed(1)} g weighed</span> : null}
        </div>
        <p class="small muted">
          {doseWeighed
            ? 'Weighed on the scale; the shot uses this exact dose.'
            : `Weigh the beans on the scale (the dosing cup is tared automatically) and the shot uses the exact dose instead of ${ns.doseG.toFixed(1)} g typed.`}
        </p>
        <div class="row">
          <button
            type="button"
            class={doseWeighed ? 'small' : 'primary'}
            disabled={!connected}
            onClick={() => {
              openWeighStep();
            }}
          >
            {doseWeighed ? 'Weigh again' : 'Weigh beans'}
          </button>
          {doseWeighed ? (
            <button
              type="button"
              class="small"
              onClick={() => {
                openGrindStep();
              }}
            >
              Grind view
            </button>
          ) : null}
        </div>
        {!connected ? <p class="small muted">Connect the scale to weigh.</p> : null}
      </div>
      <div class="card">
        <h3>Grind</h3>
        <DialPicker
          value={ns.grind.dialPos}
          spec={spec}
          onChange={(p) => set({ grind: { ...ns.grind, dialPos: p } })}
        />
      </div>
      <div class={`card ${rpmNag ? 'warn' : ''}`}>
        <h3>RPM</h3>
        <div class="row between">
          <button
            type="button"
            onClick={() =>
              set({
                grind: {
                  ...ns.grind,
                  rpm: Math.max(range[0], ns.grind.rpm - 100),
                  rpmConfirmed: false,
                },
              })
            }
          >
            −100
          </button>
          <div class="rpm-digits">{String(ns.grind.rpm).padStart(4, '0')}</div>
          <button
            type="button"
            onClick={() =>
              set({
                grind: {
                  ...ns.grind,
                  rpm: Math.min(range[1], ns.grind.rpm + 100),
                  rpmConfirmed: false,
                },
              })
            }
          >
            +100
          </button>
        </div>
        <label class="row" style="align-items:center;gap:8px;margin-top:8px">
          <input
            type="checkbox"
            checked={ns.grind.rpmConfirmed}
            onChange={(e) => {
              set({ grind: { ...ns.grind, rpmConfirmed: e.currentTarget.checked } });
              if (e.currentTarget.checked) rpmConfirmedThisSession.value = true;
            }}
          />
          VS6 display matches
        </label>
        {rpmNag ? (
          <p class="small warn">
            First shot this session: the VS6 may have reset to 0500 at power-on. Check the display.
          </p>
        ) : null}
        {lowRpm.length > 0 ? (
          <ul class="small warn">
            {lowRpm.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        ) : null}
        {ns.grind.rpm <= 800 || slot ? (
          <button
            type="button"
            class="small"
            style="margin-top:6px"
            onClick={() => {
              if (confirm(`Record a grinder stall (E006) at ${ns.grind.rpm} RPM for this bag?`)) {
                void reportStall(ns.grind.rpm);
              }
            }}
          >
            Grinder stalled (E006)
          </button>
        ) : null}
        <p class="muted small">
          range {range[0]}–{range[1]} RPM
          {bag.stalls && bag.stalls.length > 0 ? ' (floor raised after a stall)' : ''}
        </p>
      </div>
      <div class="card">
        <div class="grid3">
          <label>
            <span>Dose g{doseWeighed ? ' · weighed' : ''}</span>
            <input
              type="number"
              step="0.1"
              value={ns.doseG}
              onInput={(e) => set({ doseG: Number(e.currentTarget.value) })}
            />
          </label>
          <label>
            <span>Target yield g</span>
            <input
              type="number"
              step="1"
              value={ns.targetYieldG}
              onInput={(e) => set({ targetYieldG: Number(e.currentTarget.value) })}
            />
          </label>
          <label>
            <span>Temp switch</span>
            <select
              value={ns.tempSwitch}
              onChange={(e) => set({ tempSwitch: Number(e.currentTarget.value) as TempSwitch })}
            >
              <option value={0}>0</option>
              <option value={1}>I</option>
              <option value={2}>II</option>
            </select>
          </label>
        </div>
        <p class="muted small">
          ratio 1:{(ns.targetYieldG / Math.max(1, ns.doseG)).toFixed(2)} ·{' '}
          {formatDial(ns.grind.dialPos)} = {toLines(ns.grind.dialPos, spec)} lines
        </p>
      </div>
      {!connected ? (
        <div class="card warn">
          <p>Scale not connected.</p>
          <button
            type="button"
            class="primary"
            onClick={() => void app.connect().catch((err) => app.toast('error', String(err)))}
          >
            Connect ({app.transportKind.value})
          </button>
        </div>
      ) : null}
      <button
        type="button"
        class="primary huge"
        disabled={!connected || !ns.grind.rpmConfirmed}
        onClick={() =>
          app.dispatch({
            type: 'arm',
            now: realClock.now(),
            targetYieldG: ns.targetYieldG,
            tailEstimateG: app.tailEstimate(),
          })
        }
      >
        Arm
      </button>
      {!ns.grind.rpmConfirmed ? (
        <p class="muted small">Tick "VS6 display matches" to arm.</p>
      ) : null}
    </div>
  );
}

/** Weigh the beans: dosing cup on (auto-tare), beans in, the steady reading is the dose. */
function WeighBeans() {
  const ns = app.nextSettings.value;
  const w = app.lastWeight.value;
  const connected = app.clientState.value === 'connected';
  const st = weighStep(openWeigh(weighOpenedAt.value), {
    connected,
    nowMs: realClock.now(),
    tareAtMs: app.lastAutoTareAt.value,
    ring: app.ring,
  });
  const planned = app.weighedDose.value?.plannedG ?? ns.doseG;
  const note = st.doseG !== null ? doseNote(st.doseG, planned, ns.targetYieldG) : null;
  const use = (g: number) => {
    app.weighedDose.value = { g, plannedG: planned };
    app.nextSettings.value = { ...ns, doseG: g };
    openGrindStep();
  };
  const grams = w?.grams ?? null;
  const instruction =
    st.phase === 'need_scale'
      ? 'Connect the scale.'
      : st.phase === 'place_cup'
        ? app.settings.value?.autoTare === false
          ? 'Put the empty dosing cup on the scale, then tap "Tare now".'
          : 'Put the empty dosing cup on the scale: it tares by itself once the reading settles.'
        : st.phase === 'add_beans'
          ? `Add the beans (plan: ${planned.toFixed(1)} g). The weight is taken when it stops moving.`
          : 'Got it. Tip the beans into the VS6 hopper next.';
  return (
    <div>
      <div class="row between">
        <h1>Weigh beans</h1>
        <ConnectionPill />
      </div>
      <ThreeView view="weigh" height={250} />
      <div class={`card ${st.phase === 'captured' ? 'accent' : ''}`} style="text-align:center">
        <div class="big-number">{grams === null ? '—' : `${grams.toFixed(1)} g`}</div>
        <p class="small">{instruction}</p>
        {st.phase === 'captured' && st.doseG !== null ? (
          <p>
            Dose <b>{st.doseG.toFixed(1)} g</b> · yield stays {ns.targetYieldG.toFixed(0)} g · ratio
            1:{(ns.targetYieldG / st.doseG).toFixed(2)}
          </p>
        ) : null}
        {note ? <p class="small warn">{note}</p> : null}
      </div>
      <div class="grid2">
        <button
          type="button"
          class="primary"
          disabled={st.phase === 'need_scale' || grams === null || grams < 3}
          onClick={() => use(st.doseG ?? Math.round((grams ?? 0) * 10) / 10)}
        >
          {st.doseG !== null ? `Use ${st.doseG.toFixed(1)} g` : 'Use this weight'}
        </button>
        <button type="button" disabled={!connected} onClick={() => void app.tareNow()}>
          Tare now
        </button>
      </div>
      <button type="button" class="small" style="margin-top:8px" onClick={backToPlan}>
        Back (keep {ns.doseG.toFixed(1)} g)
      </button>
    </div>
  );
}

/** Grind the weighed dose on the VS6 at the card's dial and RPM. */
function Grind() {
  const ns = app.nextSettings.value;
  const epoch = app.currentEpoch.value;
  const spec = epoch?.dialSpec ?? DEFAULT_DIAL_SPEC;
  return (
    <div>
      <div class="row between">
        <h1>Grind</h1>
        <ConnectionPill />
      </div>
      <ThreeView view="grind" height={290} />
      <div class="card accent">
        <p>
          Tip the <b>{ns.doseG.toFixed(1)} g</b> into the hopper, set{' '}
          <b>{formatDial(ns.grind.dialPos)}</b> ({toLines(ns.grind.dialPos, spec)} lines) and{' '}
          <b>{ns.grind.rpm} RPM</b>, and grind into the dosing cup.
        </p>
        {e006Guidance(ns.grind.rpm).map((g) => (
          <p key={g} class="small warn">
            {g}
          </p>
        ))}
      </div>
      <div class="grid2">
        <button
          type="button"
          class="primary"
          onClick={() => {
            backToPlan();
          }}
        >
          Ground: prep and arm
        </button>
        <button
          type="button"
          onClick={() => {
            grindStartedAt.value = null;
            preStep.value = 'weigh';
          }}
        >
          Back to weighing
        </button>
      </div>
      {ns.grind.rpm <= 800 ? (
        <button
          type="button"
          class="small"
          style="margin-top:8px"
          onClick={() => {
            if (confirm(`Record a grinder stall (E006) at ${ns.grind.rpm} RPM for this bag?`)) {
              void reportStall(ns.grind.rpm);
            }
          }}
        >
          Grinder stalled (E006)
        </button>
      ) : null}
    </div>
  );
}

function Armed() {
  const rec = app.recorder.value;
  const w = app.lastWeight.value;
  const now = realClock.now();
  return (
    <div>
      <div class="row between">
        <h1>Armed</h1>
        <ConnectionPill />
      </div>
      <ThreeView view="marax" height={280} />
      <div class="card accent" style="text-align:center">
        <div class="big-number">{w ? w.grams.toFixed(1) : '—'} g</div>
        <div class={`small ${rec.armed?.stable ? 'ok' : 'warn'}`}>
          {rec.armed?.stable ? 'scale stable' : 'waiting for a stable reading'}
        </div>
        {app.settings.value?.autoTare === false ? null : app.lastAutoTareAt.value !== null &&
          now - app.lastAutoTareAt.value < 20_000 ? (
          <div class="small ok">cup tared automatically</div>
        ) : (
          <div class="small muted">Put the cup on the scale: it tares by itself.</div>
        )}
      </div>
      {rec.prompt === 'forgot_tap' ? (
        <div class="card warn">
          <b>Shot running?</b> The weight is rising.
          <div class="row" style="margin-top:6px">
            <button
              type="button"
              class="primary"
              onClick={() => app.dispatch({ type: 'accept_forgot_tap', now: realClock.now() })}
            >
              Start now
            </button>
            <button
              type="button"
              onClick={() => app.dispatch({ type: 'dismiss_forgot_tap', now: realClock.now() })}
            >
              Not a shot
            </button>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        class="primary huge"
        onClick={() => app.dispatch({ type: 'tap', now: realClock.now() })}
      >
        START (lift the lever)
      </button>
      <div class="row" style="margin-top:8px">
        <button type="button" onClick={() => app.dispatch({ type: 'disarm', now })}>
          Disarm
        </button>
      </div>
    </div>
  );
}

function Live() {
  const rec = app.recorder.value;
  const d = rec.draft;
  const w = app.lastWeight.value;
  const now = realClock.now();
  const t0 = d?.t0Ms ?? now;
  const last = d?.samples[d.samples.length - 1];
  const elapsed = d?.endAt ?? (last ? last.t : (now - t0) / 1000);
  const g = last?.g ?? 0;
  const target = d?.targetYieldG ?? 0;
  const pct = target > 0 ? Math.min(100, (100 * g) / target) : 0;
  const phase = rec.phase;
  const status: string[] = [];
  if (phase === 'RECOVERING') status.push('reconnecting… recording blind');
  if (d?.status === 'late_tap') status.push('late tap recovered');
  if (d?.status === 'no_tap_recovered') status.push('start estimated');
  if (d?.status === 'auto_start') status.push('started by itself at the first drops');
  if (d?.modeHint === 'auto') status.push('scale not in Timer mode');
  if (app.clientState.value === 'reconnecting') status.push('scale link lost');
  if (phase === 'SETTLING' || phase === 'ENDING') status.push('drip window…');
  const series = d
    ? [{ t: d.samples.map((s) => s.t), g: d.samples.map((s) => s.g), label: 'live' }]
    : [];
  return (
    <div>
      <div class="row between">
        <h1>
          {phase === 'RUNNING' ? 'Pulling' : phase === 'RECOVERING' ? 'Recovering' : 'Settling'}
        </h1>
        <ConnectionPill />
      </div>
      <div class="card accent">
        <div class="row between">
          <div class="big-number">{g.toFixed(1)} g</div>
          <div style="text-align:right">
            <div class="med-number">{elapsed.toFixed(1)} s</div>
            <div class="muted small">{rec.liveFlow.toFixed(2)} g/s</div>
          </div>
        </div>
        <div class="target-bar" style="margin-top:8px">
          <div class="fill" style={`width:${pct}%`} />
          <div
            class="mark"
            style={`left:${Math.min(100, (100 * Math.max(0, target - (d?.tailEstimateG ?? 1))) / Math.max(1, target))}%`}
          />
        </div>
        <div class="muted small">
          target {target} g · pre-alert at {(target - (d?.tailEstimateG ?? 1)).toFixed(1)} g · scale{' '}
          {w ? w.grams.toFixed(1) : '—'} g
        </div>
        {status.length > 0 ? (
          <div class="warn small" style="margin-top:4px">
            {status.join(' · ')}
          </div>
        ) : null}
      </div>
      {phase === 'RUNNING' ? (
        <button
          type="button"
          class="primary huge"
          onClick={() => app.dispatch({ type: 'tap', now: realClock.now() })}
        >
          STOP
        </button>
      ) : phase === 'RECOVERING' ? (
        <button
          type="button"
          class="huge"
          onClick={() => app.dispatch({ type: 'tap', now: realClock.now() })}
        >
          End shot now
        </button>
      ) : (
        <button type="button" class="huge" disabled>
          settling…
        </button>
      )}
      <ThreeView view="marax" height={300} />
      <div class="card">
        <CurveChart
          series={series}
          {...(d?.endAt !== null && d?.endAt !== undefined ? { endAt: d.endAt } : {})}
          targetG={target}
        />
      </div>
      <button
        type="button"
        class="danger small"
        onClick={() => app.dispatch({ type: 'abort', now: realClock.now() })}
      >
        Abort shot
      </button>
    </div>
  );
}

const CHIPS: Chip[] = ['balanced', 'astringent', 'harsh', 'hollow', 'channelled'];

function Slider({
  label,
  left,
  right,
  value,
  onChange,
}: {
  label: string;
  left: string;
  right: string;
  value: SliderValue | null;
  onChange: (v: SliderValue | null) => void;
}) {
  return (
    <div class="field">
      <div class="row between small muted">
        <span>{left}</span>
        <span>
          {label}: {value === null ? 'not rated' : value}
        </span>
        <span>{right}</span>
      </div>
      <input
        type="range"
        min={-3}
        max={3}
        step={1}
        value={value ?? 0}
        onInput={(e) => onChange(Number(e.currentTarget.value) as SliderValue)}
      />
    </div>
  );
}

function RateSheet() {
  const p = app.pending.value;
  if (!p) return null;
  const f = p.features;
  const prev = app.shotsOfBag.value[app.shotsOfBag.value.length - 1];
  const cmpReason = app.comparisonReason
    ? app.comparisonReason(p)
    : prev
      ? null
      : 'no previous shot of this bag';
  const cmpOk = cmpReason === null;
  const lastRec = app.lastRecommendation.value;
  const ns = app.nextSettings.value;
  const calShot =
    lastRec?.calibration !== undefined && ns.grind.rpm === lastRec.calibration.plannedRpm;
  const crossRpm = prev !== undefined && prev.settings.grind.rpm !== ns.grind.rpm;
  const badge = p.learn ? 'ok' : 'warn';
  const toggleChip = (c: Chip) => {
    const has = chips.value.includes(c);
    if (has) chips.value = chips.value.filter((x) => x !== c);
    else if (chips.value.length < 2) chips.value = [...chips.value, c];
  };
  const save = async (withRating: boolean) => {
    const rating: Omit<Rating, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'shotId'> | null =
      withRating
        ? {
            comparedToShotId: prev?.id ?? null,
            vsPrevious: cmpOk ? vs.value : null,
            sourBitter: sourBitter.value,
            thinHeavy: thinHeavy.value,
            chips: chips.value,
            drink: 'black',
            ...(overall.value !== null ? { overall1to9: overall.value } : {}),
            secondsSincePull: Math.round(
              (realClock.now() - (p.draft.endAtRxMs ?? realClock.now())) / 1000,
            ),
          }
        : null;
    await app.saveShot(rating);
    backToPlan();
    resetRating();
    deviation.value = null;
    navigate(isDemo() ? '/demo' : '/');
  };
  return (
    <div>
      <h1>Rate</h1>
      <div class="card">
        <div class="row between">
          <div>
            <div class="med-number">
              {f.finalYieldG.toFixed(1)} g in {f.totalTimeS.toFixed(1)} s
            </div>
            <div class="muted small">
              plateau {f.plateauFlow === null ? '—' : `${f.plateauFlow.toFixed(2)} g/s`} · first
              drip {f.firstDripS === null ? '—' : `${f.firstDripS.toFixed(1)} s`} · tail{' '}
              {f.tailMassG.toFixed(1)} g
            </div>
          </div>
          <span class={`badge ${badge}`}>
            {p.status}
            {p.learn ? ' · learns' : ' · excluded'}
          </span>
        </div>
        {f.flags.length > 0 ? <div class="small warn">flags: {f.flags.join(', ')}</div> : null}
        {!f.valid ? <div class="small bad">{f.invalidReasons.join('; ')}</div> : null}
        {p.status === 'partial_disconnect' || p.status === 'manual_entry' ? (
          <div class="row" style="margin-top:6px">
            <input
              type="number"
              step="0.1"
              placeholder="final yield g"
              value={manualYield.value}
              onInput={(e) => (manualYield.value = e.currentTarget.value)}
            />
            <button
              type="button"
              class="small"
              onClick={() => {
                const v = Number(manualYield.value);
                if (v > 0) {
                  app.dispatch({ type: 'manual_yield', now: realClock.now(), grams: v });
                  app.refreshPending();
                }
              }}
            >
              Set
            </button>
          </div>
        ) : null}
        <CurveChart
          series={[{ t: p.curve.t, g: p.curve.g }]}
          endAt={p.curve.endAt}
          targetG={p.draft.targetYieldG}
        />
      </div>
      <div class="card">
        <h3>vs the last shot of this bag</h3>
        <div class="grid3">
          {(['better', 'same', 'worse'] as const).map((v) => (
            <button
              key={v}
              type="button"
              class={vs.value === v ? 'selected' : ''}
              disabled={!cmpOk && v !== 'same'}
              onClick={() => (vs.value = v)}
            >
              {v}
            </button>
          ))}
        </div>
        {cmpReason ? (
          <p class="muted small">better/worse disabled: {cmpReason}</p>
        ) : prev && crossRpm ? (
          <p class="muted small">
            flow matched, {ns.grind.rpm} vs {prev.settings.grind.rpm} RPM: this comparison teaches
            your preferred RPM (body), not the flow
          </p>
        ) : prev ? (
          <p class="muted small">
            compared with the shot at {new Date(prev.at).toLocaleTimeString()}
          </p>
        ) : null}
        {calShot ? (
          <p class="small probe">
            Calibration shot: rate body (thin–heavy) first, then sour–bitter.
          </p>
        ) : null}
        {calShot ? (
          <Slider
            label="thin–heavy"
            left="thin"
            right="heavy"
            value={thinHeavy.value}
            onChange={(v) => (thinHeavy.value = v)}
          />
        ) : null}
        <Slider
          label="sour–bitter"
          left="sour"
          right="bitter"
          value={sourBitter.value}
          onChange={(v) => (sourBitter.value = v)}
        />
        {calShot ? null : (
          <Slider
            label="thin–heavy"
            left="thin"
            right="heavy"
            value={thinHeavy.value}
            onChange={(v) => (thinHeavy.value = v)}
          />
        )}
        <div class="chips">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              class={`small ${chips.value.includes(c) ? 'selected' : ''}`}
              onClick={() => toggleChip(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <label style="margin-top:8px">
          <span>Overall 1–9 (optional): {overall.value ?? '—'}</span>
          <input
            type="range"
            min={1}
            max={9}
            step={1}
            value={overall.value ?? 5}
            onInput={(e) => (overall.value = Number(e.currentTarget.value))}
          />
        </label>
      </div>
      <div class="grid2">
        <button type="button" class="primary" onClick={() => void save(true)}>
          Save with rating
        </button>
        <button type="button" onClick={() => void save(false)}>
          Save, skip rating
        </button>
      </div>
      <div class="row" style="margin-top:8px">
        <button type="button" class="danger small" onClick={() => app.discardPending()}>
          Discard this shot
        </button>
        {ns.grind.rpm <= 800 || calShot ? (
          <button
            type="button"
            class="small"
            onClick={() => {
              if (
                confirm(
                  `The grinder stalled (E006) on this dose at ${ns.grind.rpm} RPM? The shot is kept but not learned from.`,
                )
              ) {
                void reportStall(ns.grind.rpm).then(() => {
                  resetRating();
                  navigate(isDemo() ? '/demo' : '/');
                });
              }
            }}
          >
            Grinder stalled (E006)
          </button>
        ) : null}
      </div>
    </div>
  );
}
