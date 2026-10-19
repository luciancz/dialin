/**
 * Scatter with a fitted line and ± σ band. y is ln plateau flow (ticks in g/s), or with
 * yMode "lnChange" an ln-flow change (ticks in %), e.g. the RPM effect on the calibration screen.
 */

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
  yMode?: 'lnFlow' | 'lnChange';
}

const W = 480;

export function ScatterChart({
  points,
  line,
  xLabel = 'lines',
  height = 200,
  yMode = 'lnFlow',
}: Props) {
  const change = yMode === 'lnChange';
  const pct = (y: number) => {
    const v = Math.round(Math.expm1(y) * 100);
    return v === 0 ? '0 %' : `${v > 0 ? '+' : ''}${v} %`;
  };
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
  // Tick positions in y units (ln flow or ln change) with their labels.
  const yTicks: { y: number; label: string }[] = [];
  if (change) {
    const yStep = yhi - ylo > 0.35 ? 0.1 : 0.05;
    for (let k = -10; k <= 10; k++) {
      const y = yStep * k;
      if (y >= ylo && y <= yhi) yTicks.push({ y, label: pct(y) });
    }
  } else {
    for (let f = 0.5; f <= 4; f += 0.5) {
      if (Math.log(f) >= ylo && Math.log(f) <= yhi)
        yTicks.push({ y: Math.log(f), label: `${f.toFixed(1)}g/s` });
    }
  }
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
      {yTicks.map((t) => (
        <g key={t.label}>
          <line x1={padL} x2={W - padR} y1={sy(t.y)} y2={sy(t.y)} stroke="var(--line)" />
          <text x={4} y={sy(t.y) + 3} font-size="10" fill="var(--fg-2)">
            {t.label}
          </text>
        </g>
      ))}
      {xTicks.map((x) => (
        <text key={x} x={sx(x)} y={H - 6} font-size="10" text-anchor="middle" fill="var(--fg-2)">
          {x}
        </text>
      ))}
      <text x={W - padR} y={padT + 10} font-size="10" text-anchor="end" fill="var(--fg-2)">
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
          <title>{`${p.label ?? p.x} · ${change ? pct(p.y) : `${Math.exp(p.y).toFixed(2)} g/s`}${p.learn ? '' : ' (excluded)'}`}</title>
        </circle>
      ))}
    </svg>
  );
}
