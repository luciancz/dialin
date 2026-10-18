# dialin

Espresso dial-in assistant for a **Bookoo Themis Mini** scale, a **Varia VS6** grinder and a
**Lelit Mara X** (V1). A static web app: it connects to the scale over Web Bluetooth,
records every shot's weight and flow curve, takes a ten-second taste rating, and recommends
the next grind setting (as revolution · number · line on the VS6 dial), RPM and yield. It
learns per bag and across bags. Everything stays on the device (IndexedDB) with JSON
export / import; GitHub Pages only serves the code.

The design is the approved plan in the parent session; `docs/ALGORITHM.md` maps it to the
code, `docs/PROTOCOL.md` records the scale protocol as implemented, and `docs/FIELD_TEST.md`
is the checklist for the first sessions at the machine.

## Status

| Milestone | State |
|---|---|
| M0 scaffold, protocol, capability probe | done |
| M1 record-only slice (transports, recorder, features, storage, screens) | done |
| M2 flow model, rules, recommendation, replay, simulator | done; see "Convergence suite" |
| M3 taste setpoint, RPM rule, temperature card | done; see "Convergence suite" |
| M4 onboarding, beans/bags, hardware epochs, history, backup nags | done |
| M5 field hardening | **open**, needs the scale and the machine (list below) |

## Setup

Node 24 or newer, plain npm. Keep the checkout outside OneDrive (`node_modules` is large).

```bash
npm install
```

```bash
npm run dev
```

Open `http://localhost:5173/dialin/`. Other scripts: `npm run lint` (Biome), `npm run typecheck`
(two tsconfigs: the DOM app and the DOM-free core), `npm test` (Vitest, including the
convergence suite, about 80 s), `npm run build` (Vite, then `scripts/gen-sw.mjs` writes the
service worker with the precache list into `dist/`).

## Using it

1. **Settings → Scale transport.** `Simulator` lets you try everything without hardware
   (a start tap pours a synthetic shot; personas for Auto mode, a mid-shot disconnect and
   auto-off). `Web Bluetooth` is the real scale. `Replay` plays a recorded fixture.
2. **Probe** (Settings → Probe, also the last onboarding step): connect, send each command,
   check the Timer-mode test, keep-awake and the capability table. Everything measured is
   stored in `settings.bleCaps` and included in exports.
3. **Beans → Add bean**: roaster, name, roast level, process, roast date, dose, starting RPM.
4. **Shot**: dial (rev · number · line), RPM with the "VS6 display matches" tick, dose, target
   yield, temperature switch → Arm → **tap START as you lift the lever** → STOP at the target
   (or let it auto-end) → rate (better / same / worse, sour–bitter, thin–heavy, chips).
5. **Home** shows the next-shot card: one lever, absolute dial, RPM, yield, a sentence, a
   confidence word and the predicted flow band; "why not the other levers" expands the model
   numbers. The taste-setpoint card shows the posterior over plateau flow.
6. **Hardware**: open a new calibration epoch when you clean, add a washer, change springs or
   burrs, re-zero or recount the dial. The card is recomputed from the transformed model.
7. **History**: badges, include / exclude a shot from learning (with a note), flow-vs-dial
   scatter with the fitted line, overlay of two curves.
8. **Settings → Backup**: export (share sheet → download → clipboard) and import with a
   dry-run merge preview. Export every few shots; the app nags at 5 shots or 7 days.

### iPhone (Bluefy)

No iOS browser has Web Bluetooth except third-party WKWebView browsers. Install **Bluefy**
(free), open the Pages URL **inside Bluefy** and bookmark it there. A Home Screen icon opens
Safari, which has no Bluetooth. Keep the phone in hand during the shot (the link drops when
the screen locks); try the keep-awake options on the Probe screen and record which works.
Service workers are not expected to register in Bluefy; the app never depends on them.

### Windows (Chrome / Edge)

Works out of the box over HTTPS (or `localhost`). The chooser appears on every page load
unless the "Use the new permissions backend for Web Bluetooth" flag
(`chrome://flags/#enable-web-bluetooth-new-permissions-backend`) is on, which makes
`getDevices()` available and lets the app reconnect to the last scale without a chooser.

### Scale

Timer mode (not Auto / flow-rate mode), BOOKOO N app closed (only one central may connect).
The app sends smoothing off and auto-off 30 min on connect and keeps its own auto-off clock
with a 3-minute banner and a re-arm button.

## Deployment

`.github/workflows/pages.yml` lints, typechecks, tests, builds and deploys `dist/` to GitHub
Pages on every push to `main` (repository Settings → Pages → Source: GitHub Actions). The
site is served under `/dialin/`; hash routing keeps refreshes working.

## Convergence suite

`test/core/convergence.test.ts` runs the real recommend / replay loop against a seeded hidden
truth for 200 seeds per scenario. Scenarios whose measured rate is below the plan's target
are kept at the plan's number but marked `fails`, with a regression floor at the measured
rate, so a change that moves them is visible either way. Measured on 2026-10-18 with the
simulated shot-to-shot noise equal to the model's `σ_y = 0.07`:

| Scenario | Plan target | Measured |
|---|---|---|
| (a) first bag, gain within 25 % by shot 6 | ≥ 90 % | ≈ 71–82 % (low-gain truths need more excursion than 5-line probe steps give) |
| (a′) mis-counted dial | ≥ 90 % | passes |
| (b) later bag in band by shot 2 / 3 | ≥ 85 % / 75 % | passes |
| (c) taste setpoint σ ≤ 0.06 within 9 rated shots | ≥ 80 % | ≈ 5 %: the tempered slider likelihood barely narrows the posterior (ideal sliders leave σ ≈ 0.15, ideal preferences ≈ 0.07); median error ≈ 0.10 after 14 shots |
| (d) same with 20 % channeling | ≥ 80 % | ≈ 2 % |
| (e) 30-day drift bias < 0.05 | ≥ 90 % | ≈ 82 % |
| (f) washer epoch re-anchors in one shot | ≥ 90 % | ≈ 88 % (the card is recomputed when the epoch opens, so the anchor shot is pulled at the predicted shift) |
| (g) RPM sign after 3 pairs | ≥ 80 % | passes |
| (h) confidence calibration ±0.10 | all words | passes |
| (i) 1/x truth in band by shot 5 | ≥ 90 % | ≈ 79 % |

The taste layer is the open design question: with the plan's tempering the "dialled in" and
RPM stages (which gate on σ_s ≤ 0.06) are rarely reached within a bag. Candidate retunes,
none applied: a stronger slider likelihood (floor 0.25 → 0.15, exponent (1+|v|)/4),
forgetting on ratio changes, or a 0.08 convergence gate.

## M5: open until the first sessions at the machine

Run `docs/FIELD_TEST.md` on Windows Chrome, then on the iPhone in Bluefy. Open items:

- Bluefy capability results: filter mode, write method, FF12 notifications, disconnect
  detection, `getDevices`, keep-awake (`setScreenDimEnabled` true / false), share sheet,
  persistent storage.
- Real frame rate and checksum failure rate; whether `07` starts the timer (Timer mode).
- Auto-off: does re-sending the auto-off command extend it; do weight changes reset it.
- Plateau-flow CV over 5 fixed-setting shots (acceptance ≤ 10 %, else raise `MODEL.sigmaY`).
- Mean-to-plateau flow offset (sets `MODEL.plateauOffsetLn`, currently +0.08).
- Confidence calibration on real shots after 20 shots (±0.10).
- Own recordings from the recorder transport committed as fixtures (replacing the synthetic
  ones for the replay tests).
- Threshold tuning from the first 10 real shots (auto-end, pre-alert tail, late-tap window).
