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
| RPM calibration (8-shot session, compensated RPM levers, E006 handling) | done; see "RPM calibration" |
| Bean weighing, auto-tare, 3D VS6 / Mara X / Themis Mini views | done; see "3D views and weighing" |
| Hands-free shot: the scale moves the steps, timer-button start, beep cues, one-tap rating | done in code; see "Hands-free"; needs the field test |
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
   "Delete bean" removes it with all its bags and their shots.
4. **Shot**: Plan → **Weigh beans** → Grind → Arm → pour. Hands-free (the default, see
   below) moves through these steps from the scale; every step also has its button.
   - **Weigh beans:** put the empty dosing cup on the scale and it tares itself. Pour in the
     beans; the steady reading becomes the exact dose, and the planned yield stays.
   - **Grind:** shows the VS6 at the card's dial and RPM.
   - **Arm:** put the cup on the scale and it tares itself. **Press the scale's timer (or
     tap START) as you lift the lever** → STOP at the target, or let it auto-end → rate:
     one tap sour / balanced / bitter, or the detailed form (better / same / worse,
     sour–bitter, thin–heavy, chips).
5. **Home** shows the next-shot card: one lever, absolute dial, RPM, yield, a sentence, a
   confidence word and the predicted flow band; "why not the other levers" expands the model
   numbers. The taste-setpoint card shows the posterior over plateau flow.
6. **Hardware**: open a new calibration epoch when you clean, add a washer, change springs or
   burrs, re-zero or recount the dial. The card is recomputed from the transformed model.
7. **RPM calibration** (`#/rpm`, from Hardware, the bag page or the offer on the card):
   eight shots minutes apart, every dial compensated to hold the balanced flow. Afterwards
   the app moves body at the same flow, uses RPM when the dial is at a limit, and trims
   below one dial line. "Grinder stalled (E006)" on the shot screen raises the bag's RPM
   floor to the stall + 100.
8. **History**: badges, include / exclude a shot from learning (with a note), delete a shot,
   flow-vs-dial scatter with the fitted line, overlay of two curves. A deleted shot or bean
   is kept as a tombstone, so importing an older backup does not bring it back; the model
   replays without it and the card is recomputed.
9. **Settings → Backup**: export (share sheet → download → clipboard) and import with a
   dry-run merge preview. Export every few shots; the app nags at 5 shots or 7 days.

### 3D views and weighing

The VS6, the Mara X and the Themis Mini are drawn in 3D with three.js, from the published
dimensions, Varia's product photos and Lelit's V1 manual drawings (sources in
`src/ui/three/dims.ts`). three.js is a lazily loaded chunk of about 165 kB gzip.

- **VS6.** The C-shaped body leans 13.5° forward on its level base. The head carries the
  stepped index collar, the hopper with the scale (numbers 0–9, ten lines each, dots for the
  turn) and the feed ring with six screws, and the red LED display on its top face. The chute
  tube drops into the magnetic dosing cup; the RPM knob is on the base's right side. Black or
  white (Settings → Grinder & machine).
- **Mara X (V1).** The E61-style group with its side fins and the brew lever on its right,
  which hangs down and lifts towards you, and the Normcore 58 mm all-stainless bottomless
  portafilter (straight lay-flat bar handle): the shot runs as one stream from the basket. The dual gauge (steam over pump), six-lobed knobs
  on the corner valves (steam left, hot water right) with their wands, the pilot lights, the
  lit I/O button and the red LELIT badge. The 0/I/II rocker sits in the drip-tray bay, with
  wire grates on the tray and on top beside the tank lid.
- **What moves.** The VS6 hopper turns to the card's dial, its LED shows the RPM, and grounds
  fall into the dosing cup while grinding. The Mara X lever lifts, the pump needle ramps, the
  steam needle follows the temperature switch, and two streams thicken with the live flow. The
  cup fills to the live weight, and the scale shows the reading.
- **Where.** Home, the weigh and grind steps, Armed and the live shot, and the demo's
  "Watch a shot". "Watch a shot" scripts only the simulated scale (cups, beans, the lever,
  its timer button) and lets the hands-free flow and the real recorder do the rest.
- **Settings → Grinder & machine.** 3D views can be turned off; nothing renders without
  WebGL. You can also pick the grinder colour and turn auto-tare off.

Auto-tare (`src/shot/autoTare.ts`) sends one tare when the reading rises by 20 g or more with
a sharp jump, then holds within ±0.2 g for 1 s. It is off from START until the shot is saved.
After a tare it waits until something is taken off, so beans poured into a tared dosing cup are
never tared away. Putting a cup down while armed no longer raises "Shot running?", and a
START right after putting the cup down is no longer read as a late tap.

### Hands-free

The scale moves the shot on, so the phone can stay on the counter: the only tap is the
rating. The controller is `src/shot/handsFree.ts` (pure, tested), wired in
`src/app/handsFree.ts`; Settings → Hands-free turns it off. It needs auto-tare.

| You do | The app does | Scale beeps |
|---|---|---|
| Put the empty dosing cup on the scale | tares it, opens Weigh beans on the Shot screen | 1 |
| Pour in the beans | takes the reading once it holds still for 1 s as the dose, learns the cup's weight, opens Grind | 2 |
| Tip the beans into the VS6 and grind; put the espresso cup on the scale | tares it, arms | 1 |
| Lift the lever and press the scale's timer | starts the shot from the scale's timer | |
| Lever down at the pre-alert | pre-alert at the target minus the drip tail | 3 |
| Wait | ends 3 s after the flow stops, drip window, rate sheet | |
| Taste, one tap: Sour / Balanced / Bitter | saves the shot | |

- **Cups.** Once the dosing cup's weight is learned (Settings shows it, with Forget), any
  other cup put down arms straight away: a shot without weighing needs no taps either. The
  dosing cup put back after grinding, empty or with the grounds, is ignored. Coffee arriving
  while the weighing is open means the cup went under the spout: it arms, and the recorder
  starts at the first drops.
- **Start.** Arming sends `06`, so a timer frozen by the last shot's `05` reads 0. A timer
  that starts rising while armed is the scale's own button: the shot starts at t0 = receive
  time − timer, status `ok`, first drip known, and nothing is sent. Pressed after the first
  drops, it is spliced like a late tap. Not pressed at all: with Settings → "Start by itself
  at the first drops" (default on) the shot starts at the first drops (`auto_start`, spliced
  back to the onset, learned), else the "Shot running?" prompt asks. A START tapped within
  2 s of a shot that started by itself is ignored (the button had just become STOP).
- **End.** The flow stopping ends the shot after 3 s. Pressing the scale's timer again at
  lever down ends it at that moment, which gives an exact end and drip tail.
- **Cues** are scale beeps only (`02` "beep n"): speech and vibration are unreliable in
  Bluefy. Settings → Beep cues turns them off.
- **Rating.** The rate sheet opens with three big buttons: sour–bitter −2, 0 (with the
  `balanced` chip) or +2, saved at once; the detailed form stays below. Left untouched for
  2 minutes, the shot is saved unrated. Home → "Rate earlier shots" lists the bag's unrated
  shots of the last 3 days with the same buttons, and recomputes the card after each.
- **Manual buttons.** Every automatic step keeps its button (Weigh beans, Use, Ground, Arm,
  START, STOP), and the controller follows them. The Shot screen's strip names the next thing
  to do with your hands.

### iPhone (Bluefy)

No iOS browser has Web Bluetooth except third-party WKWebView browsers. Install **Bluefy**
(free), open the Pages URL **inside Bluefy** and bookmark it there. A Home Screen icon opens
Safari, which has no Bluetooth. Keep the screen on during the shot, phone in hand or on the
counter (the link drops when the screen locks); try the keep-awake options on the Probe
screen and record which works.
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
rate, so a change that moves them is visible either way. Measured with the simulated
shot-to-shot noise equal to the model's `σ_y = 0.07` and the taste gate at `σ_s ≤ 0.08`
(see "Taste retune" below). Re-measured on 2026-10-19: the RPM calibration build redraws
k_r from the research prior and adds RPM truth draws, so every seed's random stream
changed. Moves of a few points against 2026-10-18 are sampling noise between two sets of
200 seeds.

| Scenario | Plan target | Measured |
|---|---|---|
| (a) first bag, gain within 25 % by shot 6 | ≥ 90 % | 74 % (low-gain truths need more excursion than 5-line probe steps give) |
| (a′) mis-counted dial | ≥ 90 % | 68 % |
| (b) later bag in band by shot 2 / 3 | ≥ 85 % / 75 % | 89 % / 74.5 % (shot 3 is one seed short; 83 % on the old draw) |
| (c) taste setpoint found within 9 rated shots at the plan's gate σ_s ≤ 0.06 | ≥ 80 % | 8 % |
| (c) found at the app's gate σ_s ≤ 0.08, within 9 / 14 rated shots | retune target > 60 % within 14 | 61 % / 92 % |
| (d) same with 20 % channeling, plan's gate, within 11 | ≥ 80 % | 4 % |
| (d) at the app's gate, within 11 / 14 | none | 44 % / 65 % |
| (e) 30-day drift bias < 0.05 | ≥ 90 % | 93 % |
| (f) washer epoch re-anchors in one shot | ≥ 90 % | 84 % (the card is recomputed when the epoch opens, so the anchor shot is pulled at the predicted shift) |
| (g) RPM sign after 3 pairs | ≥ 80 % | 94 %, passes |
| (h) confidence calibration ±0.10 | all words | worst gap 0.04, passes |
| (i) 1/x truth in band by shot 5 | ≥ 90 % | 78 % |

"Found" means σ_s at or below the gate and |μ_s − s\*_eff| < 0.08, where s\*_eff is the flow
that tastes balanced at the shot's brew ratio.

### Taste retune (2026-10-18)

**The simulated taster had the sour–bitter sign backwards.** `perceivedOffset` in
`src/core/sim/truth.ts` called slow shots sour and short ratios bitter. The app's sign test
(sour ⇒ finer), the compass veto and rule rows 5–8 assume the opposite on both counts, which
is the usual espresso convention. Every slider update and every yield move therefore pushed
the simulated cup away from balance. The posterior was also overconfident: μ_s sat within 1σ
of the truth in only 28–45 % of bags. Most of the earlier "≈ 4 %" came from this bug. The sign is fixed,
and `test/core/setpoint.test.ts` now checks the taster against the sign test.

**Information per update.** These numbers come from the setpoint layer alone: 400 seeds,
Thompson targets, σ_y noise and the simulator's taster.

- A valid better/worse comparison carries 0.18–0.35 nats. A slider carries about 0.03 nats,
  and about 0.01 within 0.02 of the optimum, where it mostly reads 0.
- The slider floor caps how far one tasting moves the odds between two setpoints at 4. The
  lapse floor caps a preference at about 28.
- After 9 updates σ_s is 0.11 from sliders alone, 0.067 from preferences alone and 0.063
  from the one-update-per-tasting mix.
- At one tasting per day the bean-age forgetting (0.02/√day) holds σ_s at 0.064–0.070. The
  0.06 gate sits under that floor: once forgetting is on, the isolated 14-shot rate falls
  from 88 % to 42 %. In the full loop about 12 of 14 tastings update the posterior, and the
  balanced flow moves whenever the yield rule changes the ratio.

**Variants.** The table gives the rate of "found" within 9 and 14 rated shots, 200 seeds per
scenario. Scenarios b, g and h pass under every variant. Scenarios a, e, f and i are unrated
and do not change.

| Variant | Gate | (c) 9 | (c) 14 | (d) 9 | (d) 14 |
|---|---|---|---|---|---|
| Plan constants | 0.06 | 8 % | 32 % | 2 % | 10 % |
| Stronger slider: floor 0.15, exponent (1 + \|v\|)/4 | 0.06 | 9 % | 38 % | 3 % | 13 % |
| Forgetting on ratio change, sd 0.15 per ratio unit | 0.06 | 3 % | 13 % | 2 % | 5 % |
| **Gate 0.08 (applied)** | 0.08 | 62 % | 90 % | 32 % | 60 % |
| Stronger slider plus gate 0.08 | 0.08 | 63 % | 93 % | 40 % | 70 % |
| Old taster sign, plan constants | 0.06 | 4 % | 12 % | 1 % | 2 % |
| Old taster sign, gate 0.08 | 0.08 | 24 % | 47 % | 7 % | 18 % |

The ratio forgetting was sized to the simulator's ratio coupling. It widens the posterior
without adding information, so it only slows convergence.

**Choice.** The smallest change above 60 % is one constant: `RULES.setpointSdConverged`
goes from 0.06 to 0.08. The likelihoods, the one-update-per-tasting rule and the sign test
are unchanged, so no single tasting moves the posterior more than before. From the prior,
one tasting shrinks σ_s by at most 33 % for a preference and 12 % for a slider. The worst
single step seen in the loop is 44 %. `RULES.setpointSdRoute` stays at 0.10, above the gate.

**Why the looser gate is acceptable.** σ_s is conservative in the corrected simulator. At
shots 9 and 14, μ_s lies within 1σ of s\*_eff in 88–92 % of bags and within 2σ in 99–100 %. When σ_s first reaches 0.08, the median error is 0.027 and 86 % of bags are within
β = 0.07. 0.08 also equals the Thompson threshold, so exploration stops where "dialled in"
starts.

**What it costs.**

- "Dialled in" now fires at 1σ = 0.08, wider than β. In 14 % of bags the mean is off by
  more than β when the gate is first reached. 21 of 139 "dialled in" cards sat on a shot
  outside β.
- The RPM texture lever unlocks sooner. It fired 105 times in 200 bags, against 19 before.
  Each RPM change re-widens σ_s by 0.08, so the gate has to be earned again before the next.
- Scenario d stays the weak case at 60 % within 14. Channeled shots invalidate comparisons,
  which leaves more of the work to sliders.

The stronger slider adds 3 pp on c and 10 pp on d on top of the gate, at 1.7 times the
odds per tasting. It is the next lever to try if field data shows the slider is reliable.
All of this is simulation; the field test has to confirm it.

### RPM calibration (2026-10-19)

`test/core/convergence_rpm.test.ts` and `convergence_rpm_limits.test.ts` run 200 seeds each.
The hidden truth adds an RPM curvature κ ~ N(0, 0.004²), a balance shift δ ~ N(0, 0.02²), a
preferred RPM θ ~ U(700, 1400) and a body sensitivity β, which is 0 in 30 % of seeds. k_r is
drawn from the research prior N(−0.015, 0.035²). The simulated taster rates thin–heavy as
β·(u − θ_u) plus N(0, 0.8²) and adds the body utility to better / same / worse. Scenario
k is 8 rated shots then the session, pulled ten minutes apart. Scenario l adds 10 daily
shots. In scenario m the second bag's balanced dial sits below chirp + 5. In scenario n
the grinder stalls below 750 RPM.

| Scenario | Plan target | Measured |
|---|---|---|
| (k) sd(k_r) ≤ 0.012 after the session | ≥ 95 % | 98.5 %, passes |
| (k) k̂_r within 2 sd of the truth | ≥ 90 % | 94 %, passes |
| (k) session done within 10 shots | ≥ 95 % | 93.5 % (channelled slots repeat; 97.5 % of runs complete) |
| (k) every calibration shot within 0.14 ln of the balanced flow at its RPM | ≥ 90 % | 15 % of sessions, 72 % of shots |
| (k) δ within 2 sd of the truth | none | 95.5 % |
| (l) body-sensitive: final body regret ≤ 0.1 | ≥ 75 % | 92 %, passes (63 % if RPM stays at 1000) |
| (l) compensated RPM moves hold flow within β | ≥ 80 % | 97.5 % of 202 moves, passes |
| (l) RPM-insensitive: no body move, back to the usual RPM | ≥ 90 % | 100 %, passes |
| (l) RPM-insensitive: P(RPM barely matters) ≥ 0.6 | ≥ 70 % | 98 %, passes |
| (m) backup RPM reaches the band at the dial floor, reachable seeds | ≥ 80 % | 86 %, passes (1 % without RPM) |
| (n) no recommendation below stall + 100 | 100 % | 100 %, passes |
| (n) session completes after the stall | ≥ 90 % | 100 %, passes |

**Two fixes came out of these runs.**

- **Session finish (rule row 14).** The session used to leave you at its last slot, often
  500 or 1600 RPM. Body moves then crawled back 300 RPM at a time with three-shot gaps,
  which ended worse than never leaving 1000. Now the card after the last slot makes one
  compensated move. It returns to your usual RPM when that sits inside your body band, and
  otherwise goes to the preferred RPM.
- **Backup RPM selection.** When no RPM inside the body band helped, the in-band
  preference also blocked the out-of-band RPMs that close the gap. Now an in-band RPM wins
  only when it gets within 0.02 ln of the best RPM overall. The backup is also tried when
  the dial already sits at its limit and the step rounds to zero.

**What it costs.** The first shot at each new RPM level carries the prior's uncertainty,
about ±11 % flow at 700 RPM and more at 500 or 1600. On the slot table, repeat visits miss
the balanced flow by 0.07–0.09 ln RMS and first visits by 0.10–0.19. The 0.14 target for
every shot cannot hold while the session spans 500–1600. Narrowing block 2 would trade away
the information the session exists to collect, so the target stays under `it.fails`. The
plan's "flow within β after body moves" is measured as the true flow at the moved settings
against the model's prediction. Matching the true balanced flow also depends on the
setpoint, which σ_s covers.

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
- RPM calibration on the real grinder (`docs/FIELD_TEST.md` §RPM): the sign and size of k_r
  against the prior N(−0.015, 0.035²); whether the 12 slider steps per ln flow assumed by δ
  is plausible from matched-flow tastings; whether compensated moves hold flow within 7 %.
- Hands-free (`docs/FIELD_TEST.md` §H): what the Themis timer button does (tare? restart or
  resume? a second press stops?), whether `06` on arm zeroes a frozen timer, whether the
  scale beeps on `02` and is heard over the pump, taps per shot, cup recognition, and the
  pump-vibration lead before the first drops.
