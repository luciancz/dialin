/**
 * Simulation mode. Outside demo mode: what it is and a start button. Inside: pull simulated
 * shots (rate them yourself or let the simulated palate rate them), watch the card follow,
 * and reveal the hidden truth next to what the model has learned.
 */

import { activeRun, startRun } from '../../app/calibration';
import {
  autoRunDemo,
  demoBusy,
  demoWorld,
  enterDemo,
  exitDemo,
  lastDemoShot,
  pullDemoShot,
  resetDemo,
  updateDemoWorld,
} from '../../app/demo';
import { isDemo } from '../../app/mode';
import { lastReplay, modelSummary } from '../../app/recommender';
import { navigate } from '../../app/router';
import { app } from '../../app/state';
import { kRpm, kRpmCurv } from '../../core/flowmodel/state';
import { balanceSd } from '../../core/rpm/balance';
import { initPreference, summarizePreference } from '../../core/rpm/preference';
import { allowedRpmRange } from '../../core/rpm/range';
import {
  balancedLnFlow,
  bestLines,
  ratioOf,
  secondsPerLine,
  trueLnFlow,
} from '../../core/sim/demoWorld';
import { formatDial, fromLines, toLines } from '../../core/units';
import { RecommendationCard } from '../components/RecommendationCard';

function DemoIntro() {
  return (
    <div>
      <h1>Simulation</h1>
      <div class="card accent">
        <p>
          Try the whole app without the scale, the grinder or the machine. The simulation hides a
          "true" setup and you dial it in:
        </p>
        <ul class="small">
          <li>
            <b>Grinder</b>: a VS6 with an unknown flow per dial line (chirp at 1·0·0, 10 lines per
            number, RPM remembered).
          </li>
          <li>
            <b>Machine and scale</b>: realistic weight curves with puck-prep noise and occasional
            channeling, through the real curve analysis.
          </li>
          <li>
            <b>Your palate</b>: a hidden best flow and ratio, and a preferred body (or none) that
            the RPM calibration can find. The grinder may stall (E006) at low RPM.
          </li>
        </ul>
        <p class="small">
          Demo data lives in a separate database on this device. Your real beans and shots are not
          touched, and leaving the demo brings them back.
        </p>
        <button type="button" class="primary wide" onClick={enterDemo}>
          Start the simulation
        </button>
      </div>
    </div>
  );
}

function row(label: string, truth: string, model: string) {
  return (
    <tr key={label}>
      <th>{label}</th>
      <td>{truth}</td>
      <td>{model}</td>
    </tr>
  );
}

export function Demo() {
  if (!isDemo()) return <DemoIntro />;
  const w = demoWorld.value;
  const epoch = app.currentEpoch.value;
  const busy = demoBusy.value;
  const shots = app.shotsOfBag.value;
  const ratings = app.ratingsOfBag.value;
  const recs = app.recommendationsOfBag.value;
  const ns = app.nextSettings.value;
  const m = modelSummary.value;
  if (!w || !epoch || !app.currentBag.value) {
    return (
      <div>
        <h1>Simulation</h1>
        <p class="muted">Setting up the simulated grinder and bean…</p>
      </div>
    );
  }
  const spec = epoch.dialSpec;
  const lastT = shots[shots.length - 1]?.features.totalTimeS ?? 30;
  const best = fromLines(bestLines(w, ns), spec);
  const flowNow = Math.exp(trueLnFlow(w, ns, spec));
  const balanced = Math.exp(balancedLnFlow(w, ratioOf(ns), ns.grind.rpm));
  const rr = lastReplay.value;
  const bag = app.currentBag.value;
  const bean = app.currentBean.value;
  const run = activeRun();
  const krM = rr ? kRpm(rr.model) : null;
  const kqM = rr ? kRpmCurv(rr.model) : null;
  const prefS = summarizePreference(
    (bean && rr?.prefByBean.get(bean.id)) || initPreference(),
    allowedRpmRange(app.settings.value?.rpmRange, bag ? [bag] : []),
  );
  const last = lastDemoShot.value;
  return (
    <div>
      <div class="row between">
        <h1>Simulation</h1>
        <span class="badge probe">demo data</span>
      </div>

      <RecommendationCard rec={app.lastRecommendation.value} />

      <div class="card">
        <h3>Next simulated shot</h3>
        <p class="small">
          {formatDial(ns.grind.dialPos)} ({toLines(ns.grind.dialPos, spec)} lines) · {ns.grind.rpm}{' '}
          RPM · {ns.doseG} g → {ns.targetYieldG} g. The simulated you pulls exactly what the card
          says; change the dial on the Shot screen to try something else.
        </p>
        <div class="stack">
          <button
            type="button"
            class="primary"
            disabled={busy !== ''}
            onClick={() => {
              void pullDemoShot('manual').then((ok) => {
                if (ok) navigate('/shot');
              });
            }}
          >
            Pull a shot and rate it myself
          </button>
          <div class="grid2">
            <button type="button" disabled={busy !== ''} onClick={() => void pullDemoShot('auto')}>
              Pull and auto-rate
            </button>
            <button type="button" disabled={busy !== ''} onClick={() => void autoRunDemo(5)}>
              Auto-run 5 shots
            </button>
          </div>
          <div class="grid2">
            {run ? (
              <a href="#/rpm" class="btn">
                RPM calibration in progress
              </a>
            ) : (
              <button type="button" disabled={busy !== ''} onClick={() => void startRun()}>
                Start RPM calibration
              </button>
            )}
            <button type="button" disabled={busy !== ''} onClick={() => void autoRunDemo(8)}>
              Auto-run 8 shots
            </button>
          </div>
          <button
            type="button"
            class="small"
            disabled={busy !== ''}
            onClick={() => {
              void app
                .connect()
                .then(() => navigate('/shot'))
                .catch((err) => app.toast('error', String(err)));
            }}
          >
            Or use the live shot screen with the simulated scale (Arm → START → STOP)
          </button>
        </div>
        {busy ? <p class="small probe">{busy}</p> : null}
        {last ? (
          <p class="muted small">
            Last simulated shot: true {Math.exp(last.yTrue).toFixed(2)} g/s, poured{' '}
            {Math.exp(last.yObs).toFixed(2)} g/s{last.channel ? ' (channelled)' : ''}.
          </p>
        ) : null}
      </div>

      <div class="card probe">
        <details>
          <summary>Reveal the hidden truth</summary>
          <table class="small">
            <thead>
              <tr>
                <th />
                <th>truth</th>
                <th>model / app</th>
              </tr>
            </thead>
            <tbody>
              {row(
                'grinder gain',
                `${secondsPerLine(w, lastT).toFixed(1)} s per line`,
                m?.secPerLine
                  ? `${m.secPerLine[0].toFixed(1)} ± ${m.secPerLine[1].toFixed(1)} s per line`
                  : '—',
              )}
              {row(
                'best dial now',
                `${formatDial(best)} at ${ns.grind.rpm} RPM, ${ns.targetYieldG} g`,
                `card: ${formatDial(ns.grind.dialPos)}`,
              )}
              {row(
                'flow at that dial',
                `${flowNow.toFixed(2)} g/s`,
                app.lastRecommendation.value
                  ? `${Math.exp(app.lastRecommendation.value.predictedLnFlow).toFixed(2)} g/s predicted`
                  : '—',
              )}
              {row(
                'balanced flow',
                `${balanced.toFixed(2)} g/s at 1:${ratioOf(ns).toFixed(2)}`,
                m && !Number.isNaN(m.setpoint[0])
                  ? `${Math.exp(m.setpoint[0]).toFixed(2)} g/s ± ${(m.setpoint[1] * 100).toFixed(0)} %`
                  : '—',
              )}
              {row('best ratio', `1:${w.rStar.toFixed(2)}`, `1:${ratioOf(ns).toFixed(2)}`)}
              {row(
                'RPM flow effect',
                `k_r ${w.kR.toFixed(3)}, κ ${w.kQ.toFixed(4)} per 100 RPM`,
                krM && kqM
                  ? `k_r ${krM.mean.toFixed(3)} ± ${krM.sd.toFixed(3)}, κ ${kqM.mean.toFixed(4)}`
                  : '—',
              )}
              {row(
                'balance shift δ',
                `${w.delta.toFixed(3)} per 100 RPM`,
                rr ? `${rr.balance.mean.toFixed(3)} ± ${balanceSd(rr.balance).toFixed(3)}` : '—',
              )}
              {row(
                'preferred body',
                w.betaBody === 0
                  ? 'RPM does not change body'
                  : `${w.rpmStar} RPM (β ${w.betaBody.toFixed(2)} steps per 100 RPM)`,
                prefS.ratings === 0
                  ? `${ns.grind.rpm} RPM (no body ratings)`
                  : `θ ${prefS.thetaMean.toFixed(0)} ± ${prefS.thetaSd.toFixed(0)}, P(flat) ${prefS.pInsensitive.toFixed(2)}`,
              )}
              {row(
                'E006 stall',
                w.stallBelow === null ? 'never' : `below ${w.stallBelow} RPM`,
                bag?.stalls?.length ? `${bag.stalls.length} reported` : 'none reported',
              )}
              {row('channeling', `${Math.round(w.channelProb * 100)} % of shots`, '')}
            </tbody>
          </table>
          <p class="muted small">
            The model only sees the curves and your ratings; this table is the answer key.
          </p>
        </details>
      </div>

      {shots.length > 0 ? (
        <div class="card">
          <h3>Simulated shots ({shots.length})</h3>
          <table class="small">
            <thead>
              <tr>
                <th>#</th>
                <th>dial · RPM · yield</th>
                <th>g/s measured / true</th>
                <th>taste</th>
                <th>next</th>
              </tr>
            </thead>
            <tbody>
              {[...shots].reverse().map((s, i) => {
                const r = ratings.find((x) => x.shotId === s.id);
                const rec = recs.find((x) => x.afterShotId === s.id);
                const v = r?.sourBitter ?? null;
                return (
                  <tr key={s.id}>
                    <td>{shots.length - i}</td>
                    <td>
                      {formatDial(s.settings.grind.dialPos)} · {s.settings.grind.rpm} ·{' '}
                      {s.settings.targetYieldG}
                    </td>
                    <td>
                      {s.features.plateauFlow?.toFixed(2) ?? '—'} /{' '}
                      {Math.exp(trueLnFlow(w, s.settings, spec)).toFixed(2)}
                    </td>
                    <td>
                      {r
                        ? `${r.vsPrevious ?? ''} ${v === null ? '' : v < 0 ? `sour ${v}` : v > 0 ? `bitter +${v}` : 'balanced'}`
                        : 'unrated'}
                    </td>
                    <td>{rec ? rec.lever : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div class="card">
        <h3>Simulation settings</h3>
        <label>
          <span>channeling: {Math.round(w.channelProb * 100)} % of shots</span>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.05}
            value={w.channelProb}
            onInput={(e) => updateDemoWorld({ channelProb: Number(e.currentTarget.value) })}
          />
        </label>
        <label>
          <span>
            taste noise: {w.tasteNoise.toFixed(1)} slider steps (0 = a perfectly consistent taster)
          </span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.1}
            value={w.tasteNoise}
            onInput={(e) => updateDemoWorld({ tasteNoise: Number(e.currentTarget.value) })}
          />
        </label>
        <div class="grid2" style="margin-top:8px">
          <button
            type="button"
            class="danger"
            onClick={() => {
              if (
                confirm(
                  'Start over with a new hidden grinder, bean and palate? Demo shots are deleted.',
                )
              ) {
                void resetDemo();
              }
            }}
          >
            New hidden setup
          </button>
          <button type="button" onClick={exitDemo}>
            Leave the demo
          </button>
        </div>
      </div>
    </div>
  );
}
