import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/scale/clock';
import { type FakePersona, FakeTransport } from '../../src/scale/fakeTransport';
import { toHex } from '../../src/scale/protocol';
import { ScaleClient, type Warning } from '../../src/scale/scaleClient';
import { pickWriteMethod } from '../../src/scale/webBluetooth';

function setup(persona: Partial<FakePersona> = {}) {
  const clock = new FakeClock(1000);
  const fake = new FakeTransport({ clock, seed: 7, persona });
  const warnings: Warning[] = [];
  const states: string[] = [];
  const client = new ScaleClient(fake, clock);
  client.onWarning.on((w) => warnings.push(w));
  client.onState.on((s) => states.push(s));
  return { clock, fake, client, warnings, states };
}

async function connectAndSettle(clock: FakeClock, client: ScaleClient): Promise<void> {
  const p = client.connect();
  let err: unknown = null;
  p.catch((e) => {
    err = e;
  });
  // setup: smoothing off, 150 ms, auto-off, first frame, three verification frames.
  await clock.advanceAsync(2500, 25);
  await p.catch(() => {});
  if (err) throw err;
}

describe('ScaleClient', () => {
  it('sends smoothing off then auto-off 30 on connect and verifies both', async () => {
    const { clock, fake, client } = setup();
    await connectAndSettle(clock, client);
    expect(client.state).toBe('connected');
    const sent = fake.commands.map((c) => toHex(c.bytes));
    expect(sent[0]).toBe('030a08000001');
    expect(sent[1]).toBe('030a03001e14');
    expect((fake.commands[1]?.tMs ?? 0) - (fake.commands[0]?.tMs ?? 0)).toBeGreaterThanOrEqual(150);
    expect(client.smoothingVerified).toBe(true);
    expect(client.autoOffVerified).toBe(true);
    expect(client.standbyMin).toBe(30);
  });

  it('records when the scale ignores the auto-off command', async () => {
    const { clock, client } = setup({ autoOffCommandExtends: false });
    await connectAndSettle(clock, client);
    expect(client.autoOffVerified).toBe(false);
    expect(client.standbyMin).toBe(15);
  });

  it('fails with "no frames" when the scale is silent', async () => {
    const { clock, fake, client, warnings } = setup();
    fake.pauseFrames();
    await expect(connectAndSettle(clock, client)).rejects.toThrow(/no frames/);
    expect(client.state).toBe('disconnected');
    expect(warnings.some((w) => w.code === 'no_frames')).toBe(true);
  });

  it('warns at 1.5 s stale and reconnects after 5 s of silence', async () => {
    const { clock, fake, client, warnings, states } = setup();
    await connectAndSettle(clock, client);
    fake.pauseFrames();
    await clock.advanceAsync(2000, 50);
    expect(warnings.some((w) => w.code === 'stale')).toBe(true);
    expect(client.state).toBe('connected');
    await clock.advanceAsync(4000, 50);
    expect(states).toContain('reconnecting');
    fake.resumeFrames();
    await clock.advanceAsync(4000, 25);
    expect(client.state).toBe('connected');
    expect(warnings.some((w) => w.code === 'reconnected')).toBe(true);
  });

  it('retries with 0.5, 1, 2, 4, 8 s backoff and gives up after 60 s', async () => {
    const { clock, fake, client, states } = setup();
    await connectAndSettle(clock, client);
    const attempts: number[] = [];
    const origConnect = fake.connect.bind(fake);
    fake.connect = async () => {
      attempts.push(clock.now());
      return origConnect();
    };
    fake.refuseConnectUntil(Number.POSITIVE_INFINITY);
    const dropAt = clock.now();
    fake.forceDisconnect('walked away');
    await clock.advanceAsync(70_000, 100);
    const rel = attempts.map((t) => t - dropAt);
    expect(rel[0]).toBeCloseTo(500, -2);
    expect(rel[1]).toBeCloseTo(1500, -2);
    expect(rel[2]).toBeCloseTo(3500, -2);
    expect(rel[3]).toBeCloseTo(7500, -2);
    expect(rel[4]).toBeCloseTo(15_500, -2);
    // later attempts stay at the 8 s step
    expect((rel[5] ?? 0) - (rel[4] ?? 0)).toBeCloseTo(8000, -2);
    expect(client.state).toBe('lost');
    expect(states[states.length - 1]).toBe('lost');
  });

  it('keeps retrying while a shot is running', async () => {
    const { clock, fake, client } = setup();
    await connectAndSettle(clock, client);
    client.setShotRunning(true);
    fake.refuseConnectUntil(clock.now() + 90_000);
    fake.forceDisconnect('fault');
    await clock.advanceAsync(80_000, 200);
    expect(client.state).toBe('reconnecting');
    await clock.advanceAsync(20_000, 100);
    expect(client.state).toBe('connected');
  });

  it('keeps an app-side auto-off clock and raises the 3-minute banner', async () => {
    const { clock, fake, client, warnings } = setup();
    await connectAndSettle(clock, client);
    const at0 = client.autoOffAt ?? 0;
    expect(at0).toBeGreaterThan(clock.now() + 29 * 60_000);
    // Weight change (> 0.2 g) is activity.
    await clock.advanceAsync(60_000, 500);
    fake.setCupWeight(5);
    await clock.advanceAsync(500, 50);
    expect(client.autoOffAt ?? 0).toBeGreaterThan(at0 + 50_000);
    const at1 = client.autoOffAt ?? 0;
    await clock.advanceAsync(at1 - clock.now() - 2 * 60_000, 1000);
    expect(warnings.some((w) => w.code === 'auto_off_soon')).toBe(true);
    await client.rearmAutoOff();
    expect(client.rearms).toBe(1);
    expect(client.autoOffAt ?? 0).toBeGreaterThan(at1);
  });

  it('sets the mode hint from a 03 0D frame (Auto-mode persona)', async () => {
    const { clock, fake, client, warnings } = setup({ mode: 'auto' });
    await connectAndSettle(clock, client);
    fake.startShot({ t: [0, 1, 2, 3, 4, 5, 6, 7, 8], g: [0, 0, 0, 1, 3, 5, 7, 9, 11] });
    await clock.advanceAsync(6000, 50);
    expect(client.modeHint).toBe('auto');
    expect(warnings.some((w) => w.code === 'not_timer_mode')).toBe(true);
  });

  it('counts bad frames', async () => {
    const { clock, client } = setup();
    await connectAndSettle(clock, client);
    expect(client.stats.frames).toBeGreaterThan(10);
    expect(client.stats.bad).toBe(0);
  });
});

describe('pickWriteMethod', () => {
  it('prefers writeValueWithResponse, then writeValue, then without-response only if allowed', () => {
    expect(
      pickWriteMethod({
        hasWriteValueWithResponse: true,
        hasWriteValue: true,
        hasWriteValueWithoutResponse: true,
        propertyWriteWithoutResponse: true,
      }),
    ).toBe('withResponse');
    expect(
      pickWriteMethod({
        hasWriteValueWithResponse: false,
        hasWriteValue: true,
        hasWriteValueWithoutResponse: true,
        propertyWriteWithoutResponse: true,
      }),
    ).toBe('legacy');
    expect(
      pickWriteMethod({
        hasWriteValueWithResponse: false,
        hasWriteValue: false,
        hasWriteValueWithoutResponse: true,
        propertyWriteWithoutResponse: true,
      }),
    ).toBe('withoutResponse');
    expect(
      pickWriteMethod({
        hasWriteValueWithResponse: false,
        hasWriteValue: false,
        hasWriteValueWithoutResponse: true,
        propertyWriteWithoutResponse: false,
      }),
    ).toBeNull();
  });
});
