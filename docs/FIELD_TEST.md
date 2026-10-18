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

## D. Backup

1. Export via the share sheet on the iPhone → Files. Import on the PC: 0 conflicts.
2. Export on the PC, import on the iPhone: 0 conflicts, identical shot list.

## E. Bluefy specifics

- Does the connection survive switching apps for 10 s? (`notifyAppStatePresent`, and the
  recorder's "return to Bluefy" gap.)
- Does the connection survive the screen locking? (Expected: no. Keep the phone in hand.)
- Does a Home Screen bookmark open Bluefy or Safari? (Expected: Safari, which has no
  Bluetooth. Bookmark inside Bluefy instead.)

## F. Confidence calibration (after 20 shots)

Compare the stated confidence on each recommendation with whether the next shot's plateau
flow landed within 7 % of the predicted value. The History screen shows the realised
in-deadband frequency per confidence word; it should match within ±0.10.
