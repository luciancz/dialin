/**
 * Transport factory for the app: real Web Bluetooth, the self-driving simulator, or a
 * replay of recorded rows. Every transport is wrapped in the RecorderTransport so the raw
 * rows are available for "save last 2 min as fixture".
 */

import { mulberry32, uniform } from '../core/math/rng';
import { randomSpec, synthCurve } from '../core/sim/curveSynth';
import type { RawFrameRow } from '../core/types';
import { diag } from '../diag/log';
import { realClock } from '../scale/clock';
import { FakeTransport } from '../scale/fakeTransport';
import { Cmd } from '../scale/protocol';
import { RecorderTransport } from '../scale/recorderTransport';
import { ReplayTransport } from '../scale/replayTransport';
import type { Transport } from '../scale/transport';
import { WebBluetoothTransport } from '../scale/webBluetooth';

export type TransportKind = 'webbt' | 'fake' | 'replay';

export interface SimOptions {
  /** True plateau flow the simulated grinder/machine produce at the current settings. */
  plateauGps: number;
  stopAtG: number;
  channelProbability: number;
  seed: number;
  persona?: 'normal' | 'auto_mode' | 'disconnect_12s' | 'auto_off_soon' | undefined;
  /** Demo mode: plateau flow read at each lever lift (the hidden world at the current dial). */
  plateauGpsFn?: (() => number) | undefined;
}

export const defaultSimOptions: SimOptions = {
  plateauGps: 1.9,
  stopAtG: 40,
  channelProbability: 0.2,
  seed: 1,
  persona: 'normal',
};

export interface MadeTransport {
  transport: Transport;
  recorder: RecorderTransport;
  fake?: FakeTransport;
  webbt?: WebBluetoothTransport;
}

// Starts at a random value so the first simulated shot after a reload is not always the same one.
let simShotCounter = Math.floor(Math.random() * 1_000_000);

export function makeTransport(
  kind: TransportKind,
  opts: { sim?: SimOptions; replayRows?: RawFrameRow[]; replaySpeed?: number } = {},
): MadeTransport {
  if (kind === 'fake') {
    const sim = opts.sim ?? defaultSimOptions;
    const persona =
      sim.persona === 'auto_mode'
        ? { mode: 'auto' as const }
        : sim.persona === 'disconnect_12s'
          ? { disconnectAtS: 12 }
          : sim.persona === 'auto_off_soon'
            ? { autoOffAfterMs: 4 * 60_000, standbyMin: 5, autoOffCommandExtends: false }
            : {};
    const fake = new FakeTransport({ clock: realClock, seed: sim.seed, persona });
    // The simulated scale starts empty, so putting a cup on it is a visible placement (auto-tare).
    fake.setCupWeight(0);
    // Self-driving: a start command "lifts the lever" and the simulated shot begins to pour.
    fake.onCommand((bytes) => {
      const cmd = bytes[2];
      if (cmd === Cmd.stop) {
        // In the simulator the stop tap is also the lever coming down: pour ends, drips follow.
        fake.stopShot({ g: 1.0 + 0.6 * Math.random(), s: 4.5 });
        return;
      }
      if (cmd !== Cmd.tareStart && cmd !== Cmd.start) return;
      simShotCounter += 1;
      const rng = mulberry32(sim.seed * 1000 + simShotCounter);
      const channel = rng() < sim.channelProbability;
      const spec = randomSpec(
        rng,
        (sim.plateauGpsFn?.() ?? sim.plateauGps) * Math.exp(uniform(rng, -0.05, 0.05)),
        sim.stopAtG + 15,
        {
          channel,
        },
      );
      const curve = synthCurve(spec, rng, 100, 8);
      fake.startShot({ t: curve.t, g: curve.g });
      diag.log(
        'info',
        `[sim] shot ${simShotCounter}: plateau ${spec.plateauGps.toFixed(2)} g/s${channel ? ', channeling' : ''}`,
      );
    });
    const recorder = new RecorderTransport(fake, { now: () => realClock.now() });
    return { transport: recorder, recorder, fake };
  }
  if (kind === 'replay') {
    const replay = new ReplayTransport(opts.replayRows ?? [], {
      clock: realClock,
      speed: opts.replaySpeed ?? 1,
    });
    const recorder = new RecorderTransport(replay, { now: () => realClock.now() });
    return { transport: recorder, recorder };
  }
  const webbt = new WebBluetoothTransport({ log: (m) => diag.log('info', `[webbt] ${m}`) });
  const recorder = new RecorderTransport(webbt, { now: () => realClock.now() });
  return { transport: recorder, recorder, webbt };
}
