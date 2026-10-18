/**
 * Shot screen: pre-shot card → ARMED → live view → rate sheet. Driven entirely by
 * app.recorder (the pure reducer's state) and app.pending.
 */
import { signal } from '@preact/signals';
import { navigate } from '../../app/router';
import { app } from '../../app/state';
import type { Chip, Rating, SliderValue, TempSwitch, VsPrevious } from '../../core/types';
import { DEFAULT_DIAL_SPEC, formatDial, toLines } from '../../core/units';
import { realClock } from '../../scale/clock';
import { CurveChart } from '../charts/CurveChart';
import { ConnectionPill } from '../components/ConnectionPill';
import { DialPicker } from '../components/DialPicker';

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
                grind: { ...ns.grind, rpm: Math.max(500, ns.grind.rpm - 100), rpmConfirmed: false },
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
                  rpm: Math.min(1600, ns.grind.rpm + 100),
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
      </div>
      <div class="card">
        <div class="grid3">
          <label>
            <span>Dose g</span>
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
            tailEstimateG: tailEstimate(),
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

function tailEstimate(): number {
  const shots = app.shotsOfBag.value.slice(-5);
  const tails = shots.map((s) => s.features.tailMassG).filter((t) => t > 0 && t < 5);
  if (tails.length === 0) return 1.0;
  return tails.reduce((a, b) => a + b, 0) / tails.length;
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
      <div class="card accent" style="text-align:center">
        <div class="big-number">{w ? w.grams.toFixed(1) : '—'} g</div>
        <div class={`small ${rec.armed?.stable ? 'ok' : 'warn'}`}>
          {rec.armed?.stable ? 'scale stable' : 'waiting for a stable reading'}
        </div>
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
    resetRating();
    deviation.value = null;
    navigate('/');
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
        ) : prev ? (
          <p class="muted small">
            compared with the shot at {new Date(prev.at).toLocaleTimeString()}
          </p>
        ) : null}
        <Slider
          label="sour–bitter"
          left="sour"
          right="bitter"
          value={sourBitter.value}
          onChange={(v) => (sourBitter.value = v)}
        />
        <Slider
          label="thin–heavy"
          left="thin"
          right="heavy"
          value={thinHeavy.value}
          onChange={(v) => (thinHeavy.value = v)}
        />
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
      <button
        type="button"
        class="danger small"
        style="margin-top:8px"
        onClick={() => app.discardPending()}
      >
        Discard this shot
      </button>
    </div>
  );
}
