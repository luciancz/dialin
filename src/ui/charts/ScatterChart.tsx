/** Flow (ln) vs dial lines scatter with the fitted line and ± σ band. */

interface Point {
  x: number;
  y: number;
  learn: boolean;
  label?: string;
}

interface Props {
  points: Point[];
  line: { x: number; y: number; sd: number }[];
  xLabel?: string;
  height?: number;
}

const W = 480;

export function ScatterChart({ points, line, xLabel = 'lines', height = 200 }: Props) {
  const H = height;
  const padL = 40;
  const padR = 10;
  const padT = 8;
  const padB = 24;
  const xs = [...points.map((p) => p.x), ...line.map((l) => l.x)];
  const ys = [...points.map((p) => p.y), ...line.flatMap((l) => [l.y - l.sd, l.y + l.sd])];
  const xlo = xs.length ? Math.min(...xs) : 0;
  const xhi = xs.length ? Math.max(...xs) : 1;
  const ylo = ys.length ? Math.min(...ys) - 0.05 : 0;
  const yhi = ys.length ? Math.max(...ys) + 0.05 : 1;
  const sx = (x: number) => padL + ((W - padL - padR) * (x - xlo)) / Math.max(1e-9, xhi - xlo);
  const sy = (y: number) => H - padB - ((H - padT - padB) * (y - ylo)) / Math.max(1e-9, yhi - ylo);
  const path = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  const band =
    line.length > 1
      ? `${path(line.map((l) => ({ x: l.x, y: l.y + l.sd })))}${[...line]
          .reverse()
          .map((l) => `L${sx(l.x).toFixed(1)},${sy(l.y - l.sd).toFixed(1)}`)
          .join('')}Z`
      : '';
  const yTicks: number[] = [];
  for (let f = 0.5; f <= 4; f += 0.5) if (Math.log(f) >= ylo && Math.log(f) <= yhi) yTicks.push(f);
  const xTicks: number[] = [];
  const step = Math.max(1, Math.round((xhi - xlo) / 6));
  for (let x = Math.ceil(xlo); x <= xhi; x += step) xTicks.push(x);
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="flow versus dial">
      <title>flow versus dial</title>
      {band ? <path d={band} fill="var(--info)" opacity="0.12" /> : null}
      {line.length > 1 ? (
        <path d={path(line)} fill="none" stroke="var(--info)" stroke-width="1.5" />
      ) : null}
      {yTicks.map((f) => (
        <g key={f}>
          <line
            x1={padL}
            x2={W - padR}
            y1={sy(Math.log(f))}
            y2={sy(Math.log(f))}
            stroke="var(--line)"
          />
          <text x={4} y={sy(Math.log(f)) + 3} font-size="10" fill="var(--fg-2)">
            {f.toFixed(1)}g/s
          </text>
        </g>
      ))}
      {xTicks.map((x) => (
        <text key={x} x={sx(x)} y={H - 6} font-size="10" text-anchor="middle" fill="var(--fg-2)">
          {x}
        </text>
      ))}
      <text x={W - padR} y={H - 6} font-size="10" text-anchor="end" fill="var(--fg-2)">
        {xLabel}
      </text>
      {points.map((p, i) => (
        <circle
          key={`${i}-${p.x}`}
          cx={sx(p.x)}
          cy={sy(p.y)}
          r={5}
          fill={p.learn ? 'var(--accent)' : 'var(--fg-2)'}
          opacity={p.learn ? 0.9 : 0.5}
        >
          <title>{`${p.label ?? p.x} · ${Math.exp(p.y).toFixed(2)} g/s${p.learn ? '' : ' (excluded)'}`}</title>
        </circle>
      ))}
    </svg>
  );
}
