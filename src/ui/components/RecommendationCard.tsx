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
  return (
    <div class={`card ${word === 'insufficient' ? 'warn' : 'accent'}`}>
      <div class="row between">
        <h3>Next shot · {LEVER_LABEL[rec.lever]}</h3>
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
      <p>{rec.sentence}</p>
      <p class="muted small">
        predicted {rec.predictedBand[0].toFixed(2)}–{rec.predictedBand[1].toFixed(2)} g/s · target{' '}
        {Math.exp(rec.targetLnFlow).toFixed(2)} g/s · stage {rec.stage.replace('_', ' ')}
      </p>
      {word === 'probe' ? (
        <p class="small probe">This shot teaches the grinder gain; it may not be a great cup.</p>
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
            k_grind {rec.snapshot.kGrind[0].toFixed(3)} ± {rec.snapshot.kGrind[1].toFixed(3)} ·
            k_rpm {rec.snapshot.kRpm[0].toFixed(3)} ± {rec.snapshot.kRpm[1].toFixed(3)} · a_bag{' '}
            {rec.snapshot.aBag[0].toFixed(2)} ± {rec.snapshot.aBag[1].toFixed(2)} · setpoint{' '}
            {rec.snapshot.setpoint[0].toFixed(2)} ± {rec.snapshot.setpoint[1].toFixed(2)}
          </p>
        </details>
      ) : null}
    </div>
  );
}
