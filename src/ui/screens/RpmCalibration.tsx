/**
 * RPM calibration (#/rpm): the 8-slot session, the live estimates (k_r, κ, δ, θ) and the
 * plain-language results. Slots and progress are derived from the tagged shots; this screen
 * only starts, stops or abandons the run (src/app/calibration.ts).
 */
import { abandonRun, activeRun, runsThisEpoch, startRun, stopRun } from '../../app/calibration';
import { isDemo } from '../../app/mode';
import { calibrationProgress, lastReplay } from '../../app/recommender';
import { navigate } from '../../app/router';
import { app } from '../../app/state';
import { predictAt } from '../../core/flowmodel/invert';
import { kGrind, kRpm, kRpmCurv, rpmEffect } from '../../core/flowmodel/state';
import { RPM } from '../../core/params';
import { bagContext } from '../../core/replay';
import { balanceSd } from '../../core/rpm/balance';
import {
  CALIBRATION_SLOTS,
  type CalibrationProgress,
  isCalibrated,
  planCalibration,
} from '../../core/rpm/calibration';
import {
  initPreference,
  type PreferenceSummary,
  summarizePreference,
  thetaMarginal,
} from '../../core/rpm/preference';
import { allowedRpmRange, uOf } from '../../core/rpm/range';
import type { RpmCalibrationRun } from '../../core/types';
import { formatDial } from '../../core/units';
import { ScatterChart } from '../charts/ScatterChart';

const W = 480;

function pct(lnPer100: number): string {
  return `${(Math.abs(Math.expm1(lnPer100)) * 100).toFixed(1)} %`;
}

function ThetaBars({
  thetas,
  p,
  range,
}: {
  thetas: number[];
  p: number[];
  range: readonly [number, number];
}) {
  const H = 90;
  const padB = 18;
  const max = Math.max(...p, 1e-9);
  const n = thetas.length;
  const bw = (W - 20) / n;
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="preferred RPM posterior">
      <title>preferred RPM posterior</title>
      {thetas.map((t, i) => {
        const h = ((H - padB - 4) * (p[i] ?? 0)) / max;
        const inRange = t >= range[0] && t <= range[1];
        return (
          <rect
            key={t}
            x={10 + i * bw + 1}
            y={H - padB - h}
            width={Math.max(1, bw - 2)}
            height={h}
            fill={inRange ? 'var(--probe)' : 'var(--line)'}
            opacity="0.7"
          />
        );
      })}
      {thetas
        .filter((t) => t % 200 === 0)
        .map((t) => {
          const i = thetas.indexOf(t);
          return (
            <text
              key={`l${t}`}
              x={10 + i * bw + bw / 2}
              y={H - 4}
              text-anchor="middle"
              font-size="10"
              fill="var(--fg-2)"
            >
              {t}
            </text>
          );
        })}
    </svg>
  );
}

function Results({ pref, ratings }: { pref: PreferenceSummary; ratings: number }) {
  const r = lastReplay.value;
  if (!r) return null;
  const kr = kRpm(r.model);
  const kq = kRpmCurv(r.model);
  const kg = kGrind(r.model);
  const delta = r.balance;
  const dSd = balanceSd(delta);
  const lines = kg.mean > 1e-6 ? kr.mean / kg.mean : 0;
  const slower = kr.mean < 0;
  const curved = Math.abs(kq.mean) > RPM.backupZ * kq.sd && Math.abs(kq.mean) > 0.001;
  const shift = Math.abs(delta.mean) > RPM.backupZ * dSd && delta.n > 0;
  const sure = Math.abs(kr.mean) > RPM.backupZ * kr.sd;
  return (
    <div class="card accent">
      <h3>What the calibration says</h3>
      <ul>
        <li>
          {sure ? (
            <>
              <b>
                +100 RPM ≈ {pct(kr.mean)} {slower ? 'slower' : 'faster'} flow
              </b>
              , like going {Math.abs(lines).toFixed(1)} line{Math.abs(lines) >= 1.5 ? 's' : ''}{' '}
              {lines < 0 ? 'finer' : 'coarser'} (± {pct(kr.sd)}).
            </>
          ) : (
            <>
              RPM barely changes flow on your grinder: +100 RPM is {pct(kr.mean)} ± {pct(kr.sd)}.
            </>
          )}
          {curved ? (
            <> The effect {kq.mean * kr.mean > 0 ? 'grows' : 'shrinks'} toward the high end.</>
          ) : null}
        </li>
        <li>
          {ratings === 0 ? (
            'No body ratings yet: rate thin–heavy on the calibration shots.'
          ) : pref.pInsensitive >= RPM.pInsensitiveMax ? (
            <>
              <b>RPM barely changes body for you</b> (P {pref.pInsensitive.toFixed(2)}), so the app
              keeps your usual RPM and uses RPM only for flow.
            </>
          ) : (
            <>
              <b>You prefer ≈ {pref.bayesRpm} RPM</b> (θ {pref.thetaMean.toFixed(0)} ±{' '}
              {pref.thetaSd.toFixed(0)}); the body is the same for you anywhere in {pref.band[0]}–
              {pref.band[1]} RPM.
            </>
          )}
        </li>
        <li>
          {delta.n === 0
            ? 'No matched-flow pair at two RPMs rated sour–bitter yet, so no taste shift is assumed.'
            : shift
              ? `At the same flow, higher RPM tasted more ${delta.mean > 0 ? 'bitter' : 'sour'} (δ ${delta.mean.toFixed(3)} ± ${dSd.toFixed(3)} ln per 100 RPM): the app aims ${delta.mean > 0 ? 'slightly faster' : 'slightly slower'} at high RPM.`
              : `No taste shift with RPM at matched flow (δ ${delta.mean.toFixed(3)} ± ${dSd.toFixed(3)}).`}
        </li>
      </ul>
      <p class="muted small">
        {isCalibrated(r.model)
          ? 'Calibrated: the app now uses RPM to move body at the same flow, as a backup when the dial is at a limit, and for trims smaller than one line.'
          : `Not calibrated yet: k_r ± ${kr.sd.toFixed(3)} (needs ≤ ${RPM.calibratedSd}).`}
      </p>
    </div>
  );
}

function statusLabel(s: CalibrationProgress['slots'][number], next: number | null): string {
  if (s.status === 'done') return s.tries > 1 ? `done (${s.tries} tries)` : 'done';
  if (s.status === 'failed') return 'too noisy';
  if (next === s.slot) return s.tries > 0 ? 'repeat next' : 'next';
  return s.tries > 0 ? 'repeat' : '';
}

export function RpmCalibration() {
  const bag = app.currentBag.value;
  const bean = app.currentBean.value;
  const epoch = app.currentEpoch.value;
  const settings = app.settings.value;
  const r = lastReplay.value;
  if (!bag || !bean || !epoch || !settings) {
    return (
      <div>
        <h1>RPM calibration</h1>
        <div class="card">
          <p>Select a bag first.</p>
          <a href="#/beans" class="btn">
            Beans & bags
          </a>
        </div>
      </div>
    );
  }
  const run = activeRun();
  const runs = runsThisEpoch().filter((x) => x.status !== 'declined' && x.bagId === bag.id);
  const shown: RpmCalibrationRun | null = run ?? runs[0] ?? null;
  const range = allowedRpmRange(settings.rpmRange, [bag]);
  const ctx = r ? bagContext(r, bag.id) : null;
  const views = ctx?.views ?? [];
  const pref = r?.prefByBean.get(bean.id) ?? initPreference();
  const ps = summarizePreference(pref, range);
  let progress: CalibrationProgress | null = null;
  if (shown && r) {
    const live = calibrationProgress.value;
    progress =
      live && live.runId === shown.id
        ? live
        : planCalibration({
            run: shown,
            views,
            model: r.model,
            bagId: bag.id,
            pref,
            range,
            currentRpm: app.nextSettings.value.grind.rpm,
            doseG: app.nextSettings.value.doseG,
            doseDefaultG: bag.doseDefaultG,
          });
  }
  const byId = new Map(views.map((v) => [v.shot.id, v]));
  const nextRec = app.lastRecommendation.value;

  // Observed RPM effect per learnable shot: y − (ŷ − model RPM effect), against the fitted curve.
  const points: { x: number; y: number; learn: boolean; label?: string }[] = [];
  const curve: { x: number; y: number; sd: number }[] = [];
  if (r) {
    for (const v of views) {
      if (v.y === null || v.skipped) continue;
      const rpm = v.shot.settings.grind.rpm;
      const p = predictAt(r.model, bag.id, v.lines, rpm, v.shot.settings.doseG);
      if (!p) continue;
      const eff = rpmEffect(r.model, uOf(rpm)).mean;
      points.push({
        x: rpm,
        y: v.y - (p.yHat - eff),
        learn: v.learn,
        ...(v.shot.calibration ? { label: `${v.shot.calibration.slot + 1}` } : {}),
      });
    }
    for (let rpm = range[0]; rpm <= range[1]; rpm += 50) {
      const e = rpmEffect(r.model, uOf(rpm));
      curve.push({ x: rpm, y: e.mean, sd: e.sd });
    }
  }
  const kr = r ? kRpm(r.model) : null;
  const kq = r ? kRpmCurv(r.model) : null;
  const doneSlots = progress?.slots.filter((s) => s.status === 'done').length ?? 0;
  return (
    <div>
      <h1>RPM calibration</h1>
      <p class="muted small">
        {bean.roaster} {bean.name} · {range[0]}–{range[1]} RPM
        {bag.stalls && bag.stalls.length > 0 ? ' (raised after a stall)' : ''}
      </p>
      {!run ? (
        <div class="card">
          <p>
            Eight shots, minutes apart, at two pairs of RPMs (low high high low, then a pair the app
            picks). Every dial is compensated so the flow stays near your balanced flow. It measures
            how RPM changes flow on your grinder and whether you prefer a body.
          </p>
          <ul class="small">
            <li>Warm the grinder with a purge dose; feed the beans the same way every shot.</li>
            <li>Rate every shot: thin–heavy first, then sour–bitter and better/same/worse.</li>
            <li>Rinse with water between tastings.</li>
            <li>
              Below {RPM.e006Rpm + 1} RPM: start the motor before pouring the beans, feed slowly;
              tap "Grinder stalled (E006)" on the shot screen if it stops.
            </li>
          </ul>
          <button
            type="button"
            class="primary"
            onClick={() =>
              void startRun().then((x) => {
                if (x) navigate('/shot');
              })
            }
          >
            Start calibration (8 shots)
          </button>
        </div>
      ) : (
        <div class="card accent">
          <div class="row between">
            <h3>
              Session: {doneSlots}/{CALIBRATION_SLOTS} done
            </h3>
            <span class="badge probe">active</span>
          </div>
          {progress?.next && nextRec?.calibration ? (
            <p>
              Next: slot {progress.next.slot + 1} at <b>{nextRec.next.grind.rpm} RPM</b>, dial{' '}
              <b>{formatDial(nextRec.next.grind.dialPos)}</b> (compensated).
            </p>
          ) : null}
          <div class="row">
            <button type="button" class="primary" onClick={() => navigate('/shot')}>
              Go to shot
            </button>
            <button type="button" onClick={() => void stopRun()}>
              Stop, keep results
            </button>
            <button type="button" class="danger small" onClick={() => void abandonRun()}>
              Abandon
            </button>
          </div>
        </div>
      )}
      {progress ? (
        <div class="card">
          <h3>Slots</h3>
          <table class="small">
            <thead>
              <tr>
                <th>#</th>
                <th>RPM</th>
                <th>dial</th>
                <th>flow</th>
                <th>predicted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {progress.slots.map((s) => {
                const lastId = s.shotIds[s.shotIds.length - 1];
                const v = lastId ? byId.get(lastId) : undefined;
                const isNext = progress?.next?.slot === s.slot;
                return (
                  <tr key={s.slot} class={isNext ? 'selected' : ''}>
                    <td>
                      {s.slot + 1}
                      <span class="muted"> · {s.slot < 4 ? 'A' : 'B'}</span>
                    </td>
                    <td>{s.plannedRpm ?? '—'}</td>
                    <td>
                      {v
                        ? formatDial(v.shot.settings.grind.dialPos)
                        : isNext && nextRec
                          ? formatDial(nextRec.next.grind.dialPos)
                          : '—'}
                    </td>
                    <td>{v?.y != null ? `${Math.exp(v.y).toFixed(2)} g/s` : '—'}</td>
                    <td>{v?.predictedY != null ? `${Math.exp(v.predictedY).toFixed(2)}` : '—'}</td>
                    <td>{statusLabel(s, progress?.next?.slot ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {progress.stopReason && progress.stopReason !== 'ended' ? (
            <p class="small muted">
              Ended: {progress.stopReason.replace('_', ' ')} after {progress.shotsUsed} shots.
            </p>
          ) : shown && shown.status !== 'active' ? (
            <p class="small muted">
              {shown.status} {shown.endedAt ? new Date(shown.endedAt).toLocaleString() : ''}
              {shown.note ? ` (${shown.note.replace('_', ' ')})` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
      {r && kr && kq ? (
        <div class="card">
          <h3>Flow vs RPM</h3>
          <ScatterChart points={points} line={curve} xLabel="RPM" height={190} yMode="lnChange" />
          <p class="mono small">
            k_r {kr.mean.toFixed(3)} ± {kr.sd.toFixed(3)} per 100 RPM · κ {kq.mean.toFixed(4)} ±{' '}
            {kq.sd.toFixed(4)} · δ {r.balance.mean.toFixed(3)} ± {balanceSd(r.balance).toFixed(3)}
          </p>
          <p class="muted small">
            Flow change from RPM against 1000 RPM, each shot corrected to the same dial and dose;
            the band is the fitted effect ± 1 sd.
          </p>
        </div>
      ) : null}
      <div class="card">
        <h3>Preferred RPM (body)</h3>
        <ThetaBars thetas={pref.thetas} p={thetaMarginal(pref)} range={range} />
        <p class="mono small">
          θ {ps.thetaMean.toFixed(0)} ± {ps.thetaSd.toFixed(0)} · P(RPM barely matters){' '}
          {ps.pInsensitive.toFixed(2)} · band {ps.band[0]}–{ps.band[1]} · {pref.ratings} ratings
        </p>
      </div>
      {shown || pref.ratings > 0 ? <Results pref={ps} ratings={pref.ratings} /> : null}
      {runs.length > 1 ? (
        <details class="card">
          <summary>Earlier sessions this epoch</summary>
          <ul class="small">
            {runs.slice(run ? 0 : 1).map((x) => (
              <li key={x.id}>
                {new Date(x.startedAt).toLocaleString()} · {x.status}
                {x.note ? ` (${x.note.replace('_', ' ')})` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {isDemo() ? (
        <p class="small">
          <a href="#/demo">Demo screen</a>: compare these numbers with the hidden truth.
        </p>
      ) : null}
    </div>
  );
}
