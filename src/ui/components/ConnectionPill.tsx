import { app } from '../../app/state';

function fmtCountdown(atMs: number | null): string {
  if (atMs === null) return '';
  const left = Math.max(0, atMs - performance.now());
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ConnectionPill() {
  const s = app.clientState.value;
  const w = app.lastWeight.value;
  const ao = app.autoOff.value;
  const dot =
    s === 'connected' ? 'ok' : s === 'connecting' || s === 'reconnecting' ? 'warn' : 'bad';
  const label =
    s === 'connected'
      ? app.scaleName.value || 'scale'
      : s === 'reconnecting'
        ? 'reconnecting…'
        : s === 'connecting'
          ? 'connecting…'
          : s === 'lost'
            ? 'lost'
            : 'not connected';
  return (
    <button
      type="button"
      class="pill"
      style="min-height:36px"
      onClick={() => {
        if (s === 'connected' || s === 'reconnecting') void app.disconnect();
        else void app.connect().catch((err) => app.toast('error', String(err)));
      }}
    >
      <span class={`dot ${dot}`} />
      <span>{label}</span>
      {s === 'connected' && w ? <span class="muted">· {w.batteryPct} %</span> : null}
      {s === 'connected' && ao.at !== null ? (
        <span class={ao.soon ? 'warn' : 'muted'}>· off in {fmtCountdown(ao.at)}</span>
      ) : null}
    </button>
  );
}
