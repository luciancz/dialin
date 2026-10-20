/**
 * A 3D view of the grinder, the machine and the scale (src/ui/three, loaded on demand so the
 * main bundle stays small). The scene reads the app's signals every frame through getState,
 * so it is created once per view and never rebuilt on a weight frame. Renders nothing when
 * Settings → 3D views is off, when WebGL is missing, or if the chunk fails to load.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { grindStartedAt } from '../../app/shotFlow';
import { app } from '../../app/state';
import { DEFAULT_DIAL_SPEC } from '../../core/units';
import { diag } from '../../diag/log';
import { realClock } from '../../scale/clock';
import { grindRateGps, hopperAngle } from '../three/anim';
import type { LiveState, SceneHandle, View } from '../three/scene';

let webgl: boolean | null = null;
function webglAvailable(): boolean {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    webgl = !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}

/** The live state for the scene, from the app's signals (peek: no subscriptions). */
export function liveState(): LiveState {
  const ns = app.nextSettings.peek();
  const rec = app.recorder.peek();
  const spec = app.currentEpoch.peek()?.dialSpec ?? DEFAULT_DIAL_SPEC;
  const pulling = rec.phase === 'RUNNING' || rec.phase === 'RECOVERING';
  const d = rec.draft;
  const inShot =
    d !== null &&
    (rec.phase === 'RUNNING' ||
      rec.phase === 'ENDING' ||
      rec.phase === 'SETTLING' ||
      rec.phase === 'RECOVERING' ||
      rec.phase === 'RATE');
  const lastT = d?.samples[d.samples.length - 1]?.t ?? 0;
  const started = grindStartedAt.peek();
  const rate = grindRateGps(ns.grind.rpm);
  const progress =
    started === null
      ? null
      : Math.min(1, ((realClock.now() - started) / 1000) * (rate / Math.max(1, ns.doseG)));
  const pending = app.pending.peek();
  return {
    scaleG: app.lastWeight.peek()?.grams ?? null,
    cupG: inShot ? Math.max(0, d?.lastG ?? 0) : pending ? (pending.features.finalYieldG ?? 0) : 0,
    flowGps: pulling ? rec.liveFlow : 0,
    running: pulling,
    shotTimeS: lastT,
    rpm: ns.grind.rpm,
    hopperAngle: hopperAngle(ns.grind.dialPos, spec),
    rev: ns.grind.dialPos.rev,
    tempSwitch: ns.tempSwitch,
    doseG: ns.doseG,
    grindProgress: progress,
  };
}

export function ThreeView({ view, height = 260 }: { view: View; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const settings = app.settings.value;
  const on = settings?.show3d !== false;
  const color = settings?.grinderColor ?? 'black';
  useEffect(() => {
    const canvas = ref.current;
    if (!on || !canvas) return undefined;
    if (!webglAvailable()) {
      setFailed(true);
      return undefined;
    }
    let handle: SceneHandle | null = null;
    let cancelled = false;
    const reducedMotion =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    import('../three/index')
      .then(({ mountScene }) => {
        if (cancelled) return;
        handle = mountScene(canvas, {
          view,
          grinderColor: color,
          reducedMotion,
          spec: app.currentEpoch.peek()?.dialSpec ?? DEFAULT_DIAL_SPEC,
          getState: liveState,
        });
      })
      .catch((err: unknown) => {
        diag.log('warn', `3D view unavailable: ${String(err)}`);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      handle?.dispose();
    };
  }, [view, on, color]);
  if (!on || failed) return null;
  return (
    <div class="three-wrap" style={`height:${height}px`}>
      <canvas
        ref={ref}
        role="img"
        aria-label={
          view === 'marax'
            ? 'Lelit Mara X pouring into the cup on the scale'
            : view === 'grind'
              ? 'Varia VS6 grinding into the dosing cup'
              : view === 'weigh'
                ? 'Beans in the Varia dosing cup on the scale'
                : 'Your setup: Lelit Mara X, Bookoo Themis Mini and Varia VS6'
        }
      />
      <span class="three-hint">drag to turn · double-tap to reset</span>
    </div>
  );
}
