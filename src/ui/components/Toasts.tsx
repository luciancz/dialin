import { app } from '../../app/state';

export function Toasts() {
  const list = app.toasts.value;
  if (list.length === 0) return null;
  const t = list[list.length - 1];
  if (!t) return null;
  return (
    <div class="toast" role="status">
      <span class={t.level === 'error' ? 'bad' : t.level === 'warn' ? 'warn' : ''}>{t.msg}</span>
      {list.length > 1 ? <span class="muted small"> (+{list.length - 1})</span> : null}
    </div>
  );
}
