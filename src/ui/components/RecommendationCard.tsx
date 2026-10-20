import { declineOffer, startRun } from '../../app/calibration';
import { type LastShotMark, markLastShot } from '../../app/recommender';
import { navigate } from '../../app/router';
import { app } from '../../app/state';
import type { Recommendation } from '../../core/types';
import { formatDial } from '../../core/units';

const LEVER_LABEL: Record<Recommendation['lever'], string> = {
  grind: 'Grind',
  yield: 'Yield',
  rpm: 'RPM',
  prep: 'Puck prep',
  wait: 'Wait',
  temperature: 'Temperature',
  none: 'Repeat',
  calibrate: 'RPM calibration',
};

/** "RPM 1000 → 1200 · dial 2 lines finer (holds flow)" when RPM and dial move together. */
function combinedMove(rec: Recommendation): string | null {
  const dr = rec.delta.rpm;
  if (dr === undefined || dr === 0) return null;
  const to = rec.next.grind.rpm;
  const from = to - dr;
  const dl = rec.delta.lines ?? 0;
  const dial =
    dl === 0
      ? 'dial unchanged'
      : `dial ${Math.abs(dl)} line${Math.abs(dl) === 1 ? '' : 's'} ${dl < 0 ? 'finer' : 'coarser'}`;
  const why =
    rec.lever === 'rpm' || rec.lever === 'calibrate'
      ? ' (compensated: holds flow)'
      : rec.source === 'rpmModel'
        ? ' (RPM covers the flow change)'
        : '';
  return `RPM ${from} → ${to} · ${dial}${why}`;
}

/**
 * What the card lets the user correct about the bag's last shot: channeling it blamed (puck
 * prep, or the prep line a calibration card adds) or an outlier it wants repeated. The texts
 * come from src/core/rules/explain.ts.
 */
function correction(
  rec: Recommendation,
): { mark: LastShotMark; label: string; hint: string } | null {
  const last = app.shotsOfBag.value[app.shotsOfBag.value.length - 1];
  if (!last || rec.afterShotId !== last.id) return null;
  if (rec.lever === 'prep' || rec.sentence.includes('looked channelled'))
    return {
      mark: 'notChannelled',
      label: 'No channeling',
      hint: 'Only too slow or too fast? The card is recomputed from the shot as it ran.',
    };
  if (rec.lever === 'none' && rec.sentence.includes('off the model'))
    return {
      mark: 'confirmed',
      label: 'It was real',
      hint: 'Nothing odd about that shot? The card is recomputed from it, no repeat.',
    };
  return null;
}

function CorrectionRow({ rec }: { rec: Recommendation }) {
  const c = correction(rec);
  if (!c) return null;
  return (
    <div class="row" style="align-items:center;gap:8px;margin-bottom:8px">
      <button
        type="button"
        class="small"
        onClick={() =>
          void markLastShot(c.mark).then((r) => {
            if (r) app.toast('info', 'Noted; the card was recomputed.');
          })
        }
      >
        {c.label}
      </button>
      <span class="muted small">{c.hint}</span>
    </div>
  );
}

export function RecommendationCard({ rec }: { rec: Recommendation | null }) {
  if (!rec) {
    return (
      <div class="card">
        <h3>Next shot</h3>
        <p class="muted small">No recommendation yet: pull and rate a shot.</p>
      </div>
    );
  }
  const word = rec.confidenceWord;
  const badge =
    word === 'firm' ? 'ok' : word === 'probable' ? 'warn' : word === 'probe' ? 'probe' : 'bad';
  const move = combinedMove(rec);
  const snap = rec.snapshot;
  return (
    <div class={`card ${word === 'insufficient' ? 'warn' : 'accent'}`}>
      <div class="row between">
        <h3>
          Next shot · {LEVER_LABEL[rec.lever]}
          {rec.calibration ? ` ${rec.calibration.slot + 1}/8` : ''}
        </h3>
        <span class={`badge ${badge}`}>
          {word} · {(rec.confidence * 100).toFixed(0)} %
        </span>
      </div>
      <div class="grid3" style="margin:6px 0">
        <div>
          <div class="muted small">dial</div>
          <div class="med-number">{formatDial(rec.next.grind.dialPos)}</div>
        </div>
        <div>
          <div class="muted small">RPM</div>
          <div class="med-number">{rec.next.grind.rpm}</div>
        </div>
        <div>
          <div class="muted small">yield</div>
          <div class="med-number">{rec.next.targetYieldG.toFixed(0)} g</div>
        </div>
      </div>
      {move ? <p class="small">{move}</p> : null}
      <p>{rec.sentence}</p>
      <CorrectionRow rec={rec} />
      {rec.guidance && rec.guidance.length > 0 ? (
        <ul class="small warn">
          {rec.guidance.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      ) : null}
      <p class="muted small">
        predicted {rec.predictedBand[0].toFixed(2)}–{rec.predictedBand[1].toFixed(2)} g/s · target{' '}
        {Math.exp(rec.targetLnFlow).toFixed(2)} g/s · stage {rec.stage.replace('_', ' ')}
        {rec.bodyConfidence !== undefined
          ? ` · P(better body) ${(rec.bodyConfidence * 100).toFixed(0)} %`
          : ''}
      </p>
      {word === 'probe' && rec.lever !== 'calibrate' ? (
        <p class="small probe">This shot teaches the grinder gain; it may not be a great cup.</p>
      ) : null}
      {rec.lever === 'calibrate' ? (
        <p class="small probe">
          Calibration shot: rate thin–heavy first. <a href="#/rpm">Session progress</a>
        </p>
      ) : null}
      {rec.offer === 'rpm_calibration' ? (
        <div class="card probe" style="margin:8px 0 4px">
          <b>Calibrate RPM for your grinder?</b>
          <p class="small">
            Eight shots, minutes apart, with compensated dials. Afterwards the app can change body
            at the same flow, use RPM when the dial is at a limit, and trim below one line.
          </p>
          <div class="row">
            <button
              type="button"
              class="primary small"
              onClick={() =>
                void startRun().then((r) => {
                  if (r) navigate('/rpm');
                })
              }
            >
              Start (8 shots)
            </button>
            <button type="button" class="small" onClick={() => void declineOffer()}>
              Not now
            </button>
          </div>
        </div>
      ) : null}
      {rec.whyNot.length > 0 || rec.vetoes.length > 0 ? (
        <details>
          <summary>Why not the other levers</summary>
          <ul class="small">
            {rec.whyNot.map((w) => (
              <li key={w}>{w}</li>
            ))}
            {rec.vetoes.map((v) => (
              <li key={v} class="warn">
                veto: {v}
              </li>
            ))}
          </ul>
          <p class="mono small">
            k_grind {snap.kGrind[0].toFixed(3)} ± {snap.kGrind[1].toFixed(3)} · k_rpm{' '}
            {snap.kRpm[0].toFixed(3)} ± {snap.kRpm[1].toFixed(3)} · a_bag {snap.aBag[0].toFixed(2)}{' '}
            ± {snap.aBag[1].toFixed(2)} · setpoint {snap.setpoint[0].toFixed(2)} ±{' '}
            {snap.setpoint[1].toFixed(2)}
            {snap.kRpmCurv
              ? ` · κ ${snap.kRpmCurv[0].toFixed(4)} ± ${snap.kRpmCurv[1].toFixed(4)}`
              : ''}
            {snap.delta ? ` · δ ${snap.delta[0].toFixed(3)} ± ${snap.delta[1].toFixed(3)}` : ''}
            {snap.rpmPref
              ? ` · θ ${snap.rpmPref[0].toFixed(0)} ± ${snap.rpmPref[1].toFixed(0)} (P flat ${snap.rpmPref[2].toFixed(2)})`
              : ''}
          </p>
        </details>
      ) : null}
    </div>
  );
}
