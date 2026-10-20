# Field test checklist (M5)

Run on Windows Chrome/Edge first, then on the iPhone in Bluefy. Record every result on the
Diagnostics screen (Settings → Diagnostics → Capabilities) and export afterwards; the caps
table is included in the export.

Before you start: scale charged, in **Timer mode**, BOOKOO N app closed (only one central may
connect). Grinder and machine warm.

## A. Capability probe (Settings → Probe)

| # | Check | Expected | Record |
|---|---|---|---|
| A1 | Open the Pages URL | page loads over HTTPS, `secureContext` true | — |
| A2 | Connect | chooser shows the scale with the services filter, or `filterMode = acceptAll` after the fallback | `filterMode`, `advertisedName` |
| A3 | Frames | ≈ 10 Hz, 0 bad frames over 2 min | `frameHz`, `checksumFailRate` |
| A4 | `ff12Notifies` | true on Chrome; whatever Bluefy says | `ff12Notifies` |
| A5 | Write method | `withResponse` on Chrome | `writeMethod` |
| A6 | Tare+Start | timer advances within 5 frames (Timer mode). If "NOT in Timer mode", switch the scale's mode and retry | `timerModeConfirmed` |
| A7 | Smooth off / Auto-off 30 | smoothing byte 0, standby reads 30.0 min | `smoothingReported`, `standbyMinReported` |
| A8 | Walk out of range | disconnect detected by event or by poll; reconnect without a chooser | `firstDisconnectDetector`, `disconnectEventFired`, `pollDetectedDisconnect`, `hasGetDevices` |
| A9 | Keep-awake | screen stays on through 2 min idle; note which `setScreenDimEnabled` argument worked (Bluefy) | `wakeLockWorks`, `screenDimCall` |
| A10 | Persist storage | `storagePersisted` true (Chrome: usually after an install or bookmark) | `storagePersisted` |
| A11 | Service worker | registered on Chrome, expected false in Bluefy | `serviceWorkerRegistered` |
| A12 | Share files | `shareFilesWorks` true on iOS | `shareFilesWorks` |

## B. Auto-off

1. Connect, leave the scale untouched. Note the time.
2. At the 3-minute banner, tap **re-arm** on one session and ignore it on another.
3. Record whether the scale survived to 30 min with re-arm, and whether it powered off at the
   scale's own setting (15 min default) without it. Also record whether placing a cup (weight
   change) kept it alive (`weightChangeResetsAutoOff`).

## C. Shots

1. Pre-shot card: dial, RPM typed and ticked, dose, yield. Arm.
2. Tap START as the lever lifts. Confirm the live weight, the clock and the pre-alert.
3. STOP at the target (or let the auto-end fire). Rate. Confirm the curve, plateau flow and
   first-drip time look right.
4. Pull **5 shots at fixed settings** (same dial, RPM, dose, yield). Export. The plateau-flow
   CV over those shots is the acceptance figure: ≤ 10 % keeps `σ_y = 0.07`; otherwise raise
   `MODEL.sigmaY` in `src/core/params.ts` and re-run the test suite.
5. From the same shots, note mean flow vs plateau flow: it calibrates `plateauOffsetLn`.
6. Deliberately tap late once and forget to tap once; confirm the recovery paths and badges.
   Do it right after a normal shot as well: the late-tap path now sends reset (06) before
   start (04), and the clock must keep running.
7. **Auto-tare.**
   - Put the empty dosing cup down: one tare once the reading settles, about 1 s.
   - Pour the beans in: no second tare, and the dose is captured to 0.1 g. Check it
     against a kitchen scale: ±0.1 g.
   - Take the cup off, put the espresso cup down: one tare.
   - Arm, START: no tare during the pour or the drip window.
   - Record any false or missed tare, and the cup weights. The thresholds are
     `REC.autoTare*` in `src/core/params.ts`.
8. **3D views on the iPhone (Bluefy).** Check that rendering is smooth while pouring, that
   battery drain over a session is acceptable, and that vertical swipes still scroll the
   page. If not, turn 3D views off in Settings.

## D. Backup

1. Export via the share sheet on the iPhone → Files. Import on the PC: 0 conflicts.
2. Export on the PC, import on the iPhone: 0 conflicts, identical shot list.

## E. Bluefy specifics

- Does the connection survive switching apps for 10 s? (`notifyAppStatePresent`, and the
  recorder's "return to Bluefy" gap.)
- Does the connection survive the screen locking? (Expected: no. Keep the screen on, also
  when the phone lies on the counter for a hands-free shot.)
- Does a Home Screen bookmark open Bluefy or Safari? (Expected: Safari, which has no
  Bluetooth. Bookmark inside Bluefy instead.)

## F. Confidence calibration (after 20 shots)

Compare the stated confidence on each recommendation with whether the next shot's plateau
flow landed within 7 % of the predicted value. The History screen shows the realised
in-deadband frequency per confidence word; it should match within ±0.10.

## G. RPM calibration (VS6, after the grind has settled)

Wait for the offer card ("Calibrate RPM for your grinder?"), or start from Hardware → RPM
calibration. The offer needs a settled grind gain, 2 of the last 3 shots predicted in band,
a taste setpoint within ±10 % and a rested bean.

1. **Warm up.** Run a purge dose through the grinder and pull one shot at your usual settings
   first. Keep the beans, dose, puck prep and feeding technique the same for all 8 shots.
2. **Order.** Follow the cards: slots 1–4 are low high high low (700 / 1300 by default), and
   slots 5–8 are a pair the app picks. That pair can be 500 or 1600. Each card's dial is
   compensated; set it exactly and tick "VS6 display matches".
3. **At 600 RPM or below** start the motor before pouring the beans and feed slowly. If
   the VS6 shows **E006**, tap "Grinder stalled (E006)". On the pre-shot card that is
   enough. If you finished grinding at another RPM and pulled the shot, use the button on
   the rate sheet; the shot is kept but not learned from. That bag's floor becomes the
   stall + 100.
4. **Rate every shot:** thin–heavy first, then sour–bitter, then better / same / worse
   against the previous shot. Rinse with water between tastings. Cross-RPM comparisons are
   valid only when the flows matched; the sheet says when they did not.
5. **Repeats.** A channelled or outlier shot repeats its slot. Three tries on one slot end
   the session as "too noisy"; fix the prep and start again later.
6. **After the session** the card moves you back to your usual RPM, or to your preferred
   one, with a compensated dial.

Record from the RPM screen and the export:

| # | Check | Expected | Record |
|---|---|---|---|
| G1 | k_r sign and size | prior −0.015 ± 0.035 ln per 100 RPM; Varia's PSD data says slightly finer at high RPM | k̂_r ± sd |
| G2 | Curvature | κ near 0, or steeper above 1100 RPM (the research hints at a break there) | κ̂ |
| G3 | Compensated flow | every slot's measured flow within ±14 % of the target; repeats within ±7 % | slot table |
| G4 | Slider scale c | δ assumes 12 sour–bitter steps per ln flow. Check it against two matched-flow pairs at one RPM: Δslider / Δln flow | c |
| G5 | Body | thin–heavy differs between 700 and 1300 by ≥ 1 step, or the app reports "RPM barely changes body" | θ̂, P(flat) |
| G6 | Body move | a later card that changes RPM keeps the flow within 7 % | next shot |
| G7 | E006 | stalls only at ≤ 600 RPM; note the bean and RPM | stalls list |

## H. Hands-free (Settings → Hands-free on, auto-tare on, beep cues on)

Pull these shots without touching the phone except for the rating. Put the phone where you
can see it, and count every tap.

1. **Cycle.** Dosing cup on (1 beep, Weigh beans opens) → beans in (2 beeps, Grind opens) →
   cup off, grind → espresso cup on (1 beep, armed) → lever up **and press the scale's
   timer** → lever down at 3 beeps → one tap on the rate sheet.
2. **Second cycle without weighing:** espresso cup straight on from the plan → armed.

| # | Check | Expected | Record |
|---|---|---|---|
| H1 | Does the Themis timer button tare? | unknown; either works (the recorder decides from the first frames when the cup was not tared) | yes / no |
| H2 | Arm after a shot (timer frozen by `05`): does the scale's display read 0.0 s before you press? | yes (`06` sent on arm) | yes / no |
| H3 | Timer button on a stopped timer: restart from 0 or resume? Second press: stops? | start / stop (the recorder handles restart and resume) | restart / resume; stops |
| H4 | Start: status `ok`, "started by the scale's timer", first-drip time plausible | t0 within 0.1 s of the press | status, first drip |
| H5 | Does `02` beep? Is "beep n" n beeps? | n beeps | yes / no, count |
| H6 | Are the 3 pre-alert beeps audible over the Mara X pump? | yes | yes / no; if not, note it |
| H7 | Taps per shot (5 shots) | 1 (the rating); 0 when the 2-minute unrated save does it | taps |
| H8 | Cup recognition: dosing cup empty / with the grounds, espresso cup weights; any false or missed arm | arms only on the espresso cup | weights, misses |
| H9 | Dose capture: time from the last bean to 2 beeps; any capture while still pouring | ≈ 2.5 s, none early | s |
| H10 | Forget the timer once: auto-start at the first drops (`auto_start`); press it late once: `late_tap` | as described | status |
| H11 | Pump-vibration lead: on the forgotten-timer shot, `context.sensors.pumpOnAtMs` in the export vs a stopwatch from lever up to the first drops | within 1 s, or null (no buzz on the tray) | ms |
| H12 | Press the timer again at lever down once: the shot ends then (`ended by the scale timer button`), tail mass > 0 | yes | tail g |
| H13 | Leave a rate sheet for 2 minutes: saved unrated; Home → Rate earlier shots rates it | yes | — |
