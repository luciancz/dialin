/** Setpoint posterior over plateau flow (g/s) with the rated shots marked. */
import { type SetpointPosterior, summary } from '../../core/setpoint/grid';

interface Props {
  posterior: SetpointPosterior;
  rated: { y: number; v: number | null }[];
  /** Current model prediction (ln flow) to mark. */
  predicted?: number | null;
  height?: number;
}

const W = 480;

export function PosteriorBar({ posterior, rated, predicted, height = 110 }: Props) {
  const H = height;
  const padL = 10;
  const padR = 10;
  const padB = 20;
  const g = posterior.grid;
  const lo = g[0] ?? 0;
  const hi = g[g.length - 1] ?? 1;
  const sx = (s: number) => padL + ((W - padL - padR) * (s - lo)) / (hi - lo);
  const pMax = Math.max(...posterior.p, 1e-9);
  const sy = (p: number) => H - padB - ((H - padB - 6) * p) / pMax;
  let d = '';
  for (let i = 0; i < g.length; i++) {
    const x = sx(g[i] ?? 0);
    const y = sy(posterior.p[i] ?? 0);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  const area = `${d}L${sx(hi).toFixed(1)},${(H - padB).toFixed(1)}L${sx(lo).toFixed(1)},${(H - padB).toFixed(1)}Z`;
  const { mean, sd } = summary(posterior);
  const ticks: number[] = [];
  for (let f = Math.ceil(Math.exp(lo) * 4) / 4; f <= Math.exp(hi); f += 0.25) ticks.push(f);
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="taste setpoint posterior">
      <title>taste setpoint posterior</title>
      <path d={area} fill="var(--probe)" opacity="0.18" />
      <path d={d} fill="none" stroke="var(--probe)" stroke-width="2" />
      <line
        x1={sx(mean)}
        x2={sx(mean)}
        y1={4}
        y2={H - padB}
        stroke="var(--probe)"
        stroke-dasharray="3 2"
      />
      <rect
        x={sx(mean - sd)}
        y={H - padB - 3}
        width={Math.max(1, sx(mean + sd) - sx(mean - sd))}
        height={3}
        fill="var(--probe)"
        opacity="0.6"
      />
      {predicted !== null && predicted !== undefined ? (
        <line
          x1={sx(predicted)}
          x2={sx(predicted)}
          y1={4}
          y2={H - padB}
          stroke="var(--accent)"
          stroke-width="2"
        />
      ) : null}
      {rated.map((r, i) => (
        <circle
          key={`${i}-${r.y}`}
          cx={sx(r.y)}
          cy={H - padB - 8}
          r={4}
          fill={r.v === null || r.v === 0 ? 'var(--fg-2)' : r.v < 0 ? 'var(--info)' : 'var(--warn)'}
        >
          <title>{`${Math.exp(r.y).toFixed(2)} g/s · ${r.v === null ? 'unrated' : r.v < 0 ? 'sour' : r.v > 0 ? 'bitter' : 'balanced'}`}</title>
        </circle>
      ))}
      {ticks.map((f) => (
        <text
          key={f}
          x={sx(Math.log(f))}
          y={H - 4}
          font-size="10"
          text-anchor="middle"
          fill="var(--fg-2)"
        >
          {f.toFixed(2)}
        </text>
      ))}
    </svg>
  );
}
