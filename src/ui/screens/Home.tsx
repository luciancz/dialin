import { signal } from '@preact/signals';
import { isDemo } from '../../app/mode';
import { rateEarlier } from '../../app/rateLater';
import { modelSummary, setpointView } from '../../app/recommender';
import { app } from '../../app/state';
import { RULES } from '../../core/params';
import { QUICK_TASTES, RATE_LATER_DAYS, unratedRecent } from '../../core/quickRating';
import { formatDial } from '../../core/units';
import { PosteriorBar } from '../charts/PosteriorBar';
import { ConnectionPill } from '../components/ConnectionPill';
import { RecommendationCard } from '../components/RecommendationCard';
import { ThreeView } from '../components/ThreeView';

function SetpointCard() {
  const m = modelSummary.value;
  const sv = setpointView();
  if (!m || !sv || app.shotsOfBag.value.length === 0) return null;
  const [mean, sd] = m.setpoint;
  const found = sd <= RULES.setpointSdConverged;
  return (
    <div class="card">
      <div class="row between">
        <h3>Taste setpoint</h3>
        <span class={`badge ${found ? 'ok' : 'probe'}`}>
          {found ? 'found' : 'searching'} · {Math.exp(mean).toFixed(2)} g/s ±{' '}
          {(sd * 100).toFixed(0)} %
        </span>
      </div>
      <PosteriorBar
        posterior={sv.posterior}
        rated={sv.rated}
        predicted={app.lastRecommendation.value?.predictedLnFlow ?? null}
      />
      <p class="muted small">
        Blue dots sour, amber bitter, grey balanced or unrated; orange line = predicted flow of the
        next shot. Gain ≈{' '}
        {m.secPerLine
          ? `${m.secPerLine[0].toFixed(1)} ± ${m.secPerLine[1].toFixed(1)} s/line`
          : '—'}{' '}
        · flow model {Math.min(4, m.learnableShots)}/4 shots.
      </p>
    </div>
  );
}

/** The shot whose late rating is being saved. */
const ratingShot = signal<string | null>(null);

/** Shots saved without a rating (the sheet left untouched, or skipped): one tap each. */
function RateEarlierCard() {
  const shots = unratedRecent(
    app.shotsOfBag.value,
    app.ratingsOfBag.value,
    app.qualityOfBag.value,
    Date.now(),
  );
  if (shots.length === 0) return null;
  const phase = app.recorder.value.phase;
  // Not while a shot is being made: the new card would replace the settings on screen.
  const busy =
    ratingShot.value !== null ||
    app.pending.value !== null ||
    !(phase === 'IDLE' || phase === 'SAVED' || phase === 'ABORTED');
  return (
    <div class="card">
      <h3>Rate earlier shots</h3>
      <p class="muted small">
        Saved without a rating in the last {RATE_LATER_DAYS} days. One tap each; the card is
        recomputed with it.
      </p>
      {shots.slice(0, 6).map((s) => (
        <div key={s.id} class="rate-row">
          <div class="small">
            {new Date(s.at).toLocaleString([], {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · {s.features.finalYieldG.toFixed(1)} g in {s.features.totalTimeS.toFixed(0)} s ·{' '}
            {formatDial(s.settings.grind.dialPos)} · {s.settings.grind.rpm} RPM
          </div>
          <div class="grid3" style="margin-top:6px">
            {QUICK_TASTES.map((q) => (
              <button
                key={q.taste}
                type="button"
                class={`taste ${q.taste}`}
                disabled={busy}
                onClick={() => {
                  ratingShot.value = s.id;
                  void rateEarlier(s, q.taste)
                    .catch((err) => app.toast('error', `Rating not saved: ${String(err)}`))
                    .finally(() => {
                      ratingShot.value = null;
                    });
                }}
              >
                {ratingShot.value === s.id ? '…' : q.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function daysSince(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}

export function Home() {
  const bag = app.currentBag.value;
  const bean = app.currentBean.value;
  const shots = app.shotsOfBag.value;
  const nag = app.backupNag();
  const s = app.settings.value;
  return (
    <div>
      <div class="row between">
        <h1>Dial-in</h1>
        <ConnectionPill />
      </div>
      {nag !== 'none' ? (
        <div class={`card ${nag === 'red' ? 'bad' : 'warn'}`}>
          <b>Back up your shots.</b> {s?.shotsSinceExport ?? 0} shots since the last export
          {s?.lastExportAt ? `, ${daysSince(s.lastExportAt)} days ago` : ', never exported'}.{' '}
          <a href="#/settings">Export now</a>
        </div>
      ) : null}
      {s && !s.onboardingDone ? (
        <div class="card accent">
          <b>First run.</b> <a href="#/onboarding">Set up the grinder, scale and machine</a> (dial
          spec, washers, usual dial). The defaults work until then.
        </div>
      ) : null}
      {bag && bean ? (
        <div class="card">
          <div class="row between">
            <div>
              <b>
                {bean.roaster} · {bean.name}
              </b>
              <div class="muted small">
                {bean.roastLevel.replace('_', '-')} · {bean.process} · roasted{' '}
                {daysSince(bag.roastDate)} days ago · {shots.length} shots
              </div>
            </div>
            <a href="#/beans" class="small">
              change
            </a>
          </div>
          {shots.length > 0 ? (
            <div class="muted small" style="margin-top:6px">
              last:{' '}
              {formatDial(
                shots[shots.length - 1]?.settings.grind.dialPos ?? { rev: 0, number: 0, line: 0 },
              )}{' '}
              · {shots[shots.length - 1]?.settings.grind.rpm} RPM ·{' '}
              {shots[shots.length - 1]?.features.finalYieldG.toFixed(1)} g in{' '}
              {shots[shots.length - 1]?.features.totalTimeS.toFixed(0)} s
            </div>
          ) : null}
        </div>
      ) : (
        <div class="card">
          <p>No bag selected.</p>
          <a href="#/beans" class="btn">
            Add a bean and bag
          </a>
        </div>
      )}
      <RateEarlierCard />
      <ThreeView view="setup" height={240} />
      <RecommendationCard rec={app.lastRecommendation.value} />
      <SetpointCard />
      <a
        href="#/shot"
        class="btn primary huge"
        style="display:flex;align-items:center;justify-content:center;text-decoration:none;margin-top:12px"
      >
        New shot
      </a>
      <p class="muted small" style="margin-top:12px">
        Scale in Timer mode, BOOKOO N closed.{' '}
        {s?.handsFree === false || s?.autoTare === false
          ? 'Tap START as you lift the lever.'
          : "Hands-free: put the dosing cup on the scale to begin, and press the scale's timer as you lift the lever."}
      </p>
      {isDemo() ? null : (
        <div class="card">
          <b>No machine handy?</b> <a href="#/demo">Try the simulation</a>: a hidden grinder, scale
          and palate to dial in, with its own data.
        </div>
      )}
    </div>
  );
}
