import type { DialPosition, DialSpec } from '../../core/types';
import { formatDial, fromLines, stepDial, toLines } from '../../core/units';

interface Props {
  value: DialPosition;
  spec: DialSpec;
  onChange: (p: DialPosition) => void;
}

/** Three-wheel picker (rev · number · line) with ± one-line steppers. */
export function DialPicker({ value, spec, onChange }: Props) {
  const set = (patch: Partial<DialPosition>) => {
    const next = { ...value, ...patch };
    // Keep every component in range and normalise through lines.
    const clamped: DialPosition = {
      rev: Math.max(1, Math.min(spec.revs, next.rev)),
      number: Math.max(0, Math.min(spec.numbersPerRev - 1, next.number)),
      line: Math.max(0, Math.min(spec.linesPerNumber - 1, next.line)),
    };
    onChange(fromLines(toLines(clamped, spec), spec));
  };
  const col = (label: string, v: number, key: keyof DialPosition) => (
    <div class="col">
      <button
        type="button"
        class="small"
        onClick={() => set({ [key]: v + 1 })}
        aria-label={`${label} up`}
      >
        ▲
      </button>
      <div class="val">{v}</div>
      <div class="lbl">{label}</div>
      <button
        type="button"
        class="small"
        onClick={() => set({ [key]: v - 1 })}
        aria-label={`${label} down`}
      >
        ▼
      </button>
    </div>
  );
  return (
    <div>
      <div class="wheel">
        {col('rev', value.rev, 'rev')}
        {col('number', value.number, 'number')}
        {col('line', value.line, 'line')}
      </div>
      <div class="row between" style="margin-top:6px">
        <button type="button" class="small" onClick={() => onChange(stepDial(value, -1, spec))}>
          −1 line (finer)
        </button>
        <span class="mono">
          {formatDial(value)} · {toLines(value, spec)} lines
        </span>
        <button type="button" class="small" onClick={() => onChange(stepDial(value, 1, spec))}>
          +1 line (coarser)
        </button>
      </div>
    </div>
  );
}
