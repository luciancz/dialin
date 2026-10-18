/** SVG weight + flow chart. Pure function of its props; no chart library. */
import { deriveFlow } from '../../core/curve/features';

export interface CurveSeries {
  t: ArrayLike<number>;
  g: ArrayLike<number>;
  /** Optional precomputed flow; otherwise derived with Savitzky–Golay when the grid is uniform. */
  flow?: ArrayLike<number>;
  label?: string;
  color?: string;
}

interface Props {
  series: CurveSeries[];
  endAt?: number;
  targetG?: number;
  /** Shaded predicted flow band in g/s. */
  band?: [number, number];
  maxT?: number;
  height?: number;
}

const W = 480;

function path(xs: number[], ys: number[]): string {
  let d = '';
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    d += `${d === '' ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

export function CurveChart({ series, endAt, targetG, band, maxT, height = 220 }: Props) {
  const H = height;
  const padL = 34;
  const padR = 34;
  const padT = 8;
  const padB = 22;
  let tMax = maxT ?? 0;
  let gMax = targetG ?? 0;
  for (const s of series) {
    for (let i = 0; i < s.t.length; i++) {
      tMax = Math.max(tMax, s.t[i] ?? 0);
      gMax = Math.max(gMax, s.g[i] ?? 0);
    }
  }
  tMax = Math.max(10, Math.ceil(tMax / 5) * 5);
  gMax = Math.max(10, Math.ceil((gMax + 2) / 5) * 5);
  const fMax = 4;
  const sx = (t: number) => padL + ((W - padL - padR) * t) / tMax;
  const sy = (g: number) => H - padB - ((H - padT - padB) * g) / gMax;
  const sf = (f: number) => H - padB - ((H - padT - padB) * Math.max(0, Math.min(fMax, f))) / fMax;
  const colors = ['var(--accent)', 'var(--info)', 'var(--probe)'];
  const ticks: number[] = [];
  for (let t = 0; t <= tMax; t += tMax > 40 ? 10 : 5) ticks.push(t);
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="shot curve">
      <title>shot curve</title>
      {band ? (
        <rect
          x={padL}
          y={sf(band[1])}
          width={W - padL - padR}
          height={Math.max(0, sf(band[0]) - sf(band[1]))}
          fill="var(--info)"
          opacity="0.12"
        />
      ) : null}
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={sx(t)}
            x2={sx(t)}
            y1={padT}
            y2={H - padB}
            stroke="var(--line)"
            stroke-width="1"
          />
          <text x={sx(t)} y={H - 6} font-size="10" text-anchor="middle" fill="var(--fg-2)">
            {t}s
          </text>
        </g>
      ))}
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <text key={f} x={4} y={sy(f * gMax) + 3} font-size="10" fill="var(--fg-2)">
          {Math.round(f * gMax)}g
        </text>
      ))}
      {[1, 2, 3, 4].map((f) => (
        <text key={f} x={W - padR + 4} y={sf(f) + 3} font-size="10" fill="var(--info)">
          {f}g/s
        </text>
      ))}
      {targetG !== undefined ? (
        <line
          x1={padL}
          x2={W - padR}
          y1={sy(targetG)}
          y2={sy(targetG)}
          stroke="var(--ok)"
          stroke-dasharray="4 3"
        />
      ) : null}
      {endAt !== undefined ? (
        <line
          x1={sx(endAt)}
          x2={sx(endAt)}
          y1={padT}
          y2={H - padB}
          stroke="var(--fg-2)"
          stroke-dasharray="2 3"
        />
      ) : null}
      {series.map((s, i) => {
        const xs: number[] = [];
        const ys: number[] = [];
        for (let k = 0; k < s.t.length; k++) {
          xs.push(sx(s.t[k] ?? 0));
          ys.push(sy(s.g[k] ?? 0));
        }
        let flowPath = '';
        const uniform = s.t.length > 12 && Math.abs((s.t[1] ?? 0) - (s.t[0] ?? 0) - 0.1) < 1e-3;
        const flow =
          s.flow ?? (uniform ? deriveFlow(s.g, new Uint8Array(s.t.length).fill(1)) : null);
        if (flow) {
          const fx: number[] = [];
          const fy: number[] = [];
          for (let k = 0; k < s.t.length; k++) {
            const v = flow[k] ?? Number.NaN;
            if (Number.isNaN(v)) continue;
            fx.push(sx(s.t[k] ?? 0));
            fy.push(sf(v));
          }
          flowPath = path(fx, fy);
        }
        const color = s.color ?? colors[i % colors.length];
        return (
          <g key={s.label ?? i}>
            <path d={path(xs, ys)} fill="none" stroke={color} stroke-width="2" />
            {flowPath ? (
              <path
                d={flowPath}
                fill="none"
                stroke={color}
                stroke-width="1.2"
                opacity="0.65"
                stroke-dasharray="3 2"
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
