# Algorithm notes (as implemented)

The design is the approved plan; this file records how the code maps to it and the few
places where the implementation had to choose. Every constant lives in `src/core/params.ts`
with its source.

## Pipeline per shot

1. **Recorder** (`src/shot/machine.ts`, pure reducer): tap → `07` (tare + start) or, when the
   weight is already rising, `04` with a software tare and the pre-tap frames spliced in
   (`late_tap`). Sample time is the scale timer re-anchored to the tap once the first non-zero
   timer frame arrives; arrival time is used only for gaps and drift. Auto-end after 3 s
   under 0.15 g/s past half the target, or at target + 3 g. Six-second drip window, final
   yield = median of the last second. Link loss opens a gap; 20 s without the link ends the
   shot (`partial_disconnect` when the 25–75 % window is affected). If the scale ignores
   `07` (Auto mode), the stream still shows the pre-tap weight after the 400 ms settle
   window and a software tare is applied; five zero-timer frames set `modeHint = 'auto'`.
2. **Features** (`src/core/curve/features.ts`): 100 ms grid, Savitzky–Golay derivative
   (window 11, order 2, exact for quadratics; one-sided regression at edges and next to
   masked cells). Plateau flow = (w(t75) − w(t25))/(t75 − t25) with interpolated crossings.
   `noisy` is the RMS residual of the raw weight around its local quadratic fit over the
   plateau (> 0.15 g). The plan's cross-check compared two 1 s derivatives that are
   mathematically identical on a symmetric window, so the residual was used instead.
3. **Flow model** (`src/core/flowmodel`): joint Gaussian over `[k_g, k_r, k_d, κ, a_b…]` per
   epoch (y = a_b + k_g·ΔL + k_r·u + κ·u² + k_d·d, u = (RPM − 1000)/100), per-bag reference line `L_ref,b`, robust Huber update with asymmetric knees
   (2/4 slow side, 1.5/3 fast side), Joseph-form covariance, two-skip re-anchor, anchor shot
   after epoch events, bean-age drift and process noise, pooled priors for later bags with
   a ridge-regression metadata offset after four well-sampled bags.
4. **Setpoint** (`src/core/setpoint/grid.ts`): 121-point grid posterior over the optimal
   ln plateau flow. One update per tasting: the better/worse preference likelihood when the
   comparison is valid, otherwise the sour–bitter slider (sign test: sour ⇒ finer), hollow /
   harsh chips, or a `balanced` bump. The setpoint is the balanced flow at 1000 RPM: every
   flow enters as y_ref = y − δ̂·u, and the slider scale widens with sd(δ)·|u|. Forgetting
   with bean age and on temperature changes (no longer on RPM changes). Thompson target while σ_s > 0.08, deterministic ±0.07 probe after two `same`
   answers, the mean otherwise. "Dialled in" (row 11) and the RPM lever (row 9) need
   σ_s ≤ 0.08 (`RULES.setpointSdConverged`, see Deviations).
5. **Rules** (`src/core/rules/table.ts`): rows 13 (calibration slot) and 14 (calibration
   done) first, then the twelve rows in order; first match wins. Vetoes:
   step clamps (10 lines, 5 while the gain is unsure, 15 absolute), chirp + 5 floor, gain
   floor 0.010, compass check; RPM inside Settings → RPM range (500–1600 by default), raised
   to a stall + 100 on a bag that reported E006, always a multiple of 100.
6. **Arbitration** (`src/core/recommend.ts`): one lever, next settings, sentence from the
   templates, confidence `Φ(β/s_p) − Φ(−β/s_p)` from parameter uncertainty only, predicted
   band including σ_y, why-not list, model snapshot.
7. **Replay** (`src/core/replay.ts`): epochs folded in order with the event transforms between
   them; only `learn === true` shots update the flow model; ratings update the setpoint.
   The slider update is skipped when, in stage C, the same slider is about to drive the
   yield rule (in band, slider ≠ 0, ratio strictly inside its bounds).

## RPM calibration

Plan "RPM calibration" (2026-10-19); code in `src/core/rpm`.

- **Flow effect** (`flowmodel/state.ts`): k_r ~ N(−0.015, 0.035²) and κ ~ N(0, 0.005²) per
  epoch, reset on new burrs. `invert()` evaluates the shot row at L_ref,b, so the RPM terms
  enter the compensated dial exactly once. It also reports which dial limit clamped the step.
- **Balance shift** (`balance.ts`): s*(RPM) = s* + δ·u, a scalar Kalman filter on δ from
  sour–bitter pairs at matched flow. A pair is two rated, learnable, unchannelled shots on
  the same bag within 12 h, |Δu| ≥ 1 and |Δy| ≤ 0.15. The observation is z = Δv/c + Δy with
  noise 2/c², c = 12 slider steps per ln flow. c is an assumption for the field test.
- **Preferred RPM** (`preference.ts`): a grid posterior per bean. θ runs 500–1600 in steps of
  50, β has nine values and the order bias three. Thin–heavy is an ordered probit with
  σ 0.8, and "hollow" without a slider counts as −1. Better / same / worse across RPMs at
  matched flow (|Δy_ref| ≤ 0.07) uses the setpoint layer's likelihood family on the utility
  −β²(u − θ_u)²/18. The bean prior is 0.8 × the pooled earlier beans, blurred by 150 RPM,
  plus 0.2 × N(1000, 300²). Outputs: θ, P(RPM barely matters) = P(|6β| < 1), the Bayes RPM
  (step 100) and the JND band.
- **Routing** (`replay.ts`): a same-RPM comparison goes to the setpoint and a cross-RPM
  matched-flow comparison to θ, never both. Every thin–heavy goes to θ. Sour–bitter goes to
  the setpoint and to δ.
- **Session** (`calibration.ts`): eight tagged slots, A B B A at 700 / 1300 (starting nearer
  the current RPM), then X Y Y X with |X − Y| ≥ 300 chosen once by expected information
  about θ plus the flow effect. A slot repeats when its shot is excluded, skipped or
  weighted below 0.5. Three tries stop the run as "too noisy", and stalled shots do not count
  as tries. It stops early after block 1 when sd(k_r) ≤ min(0.015, 0.05/u_max) and θ would
  barely move. The offer card needs: sd(k_g) ≤ 0.012, 2 of the last 3 shots predicted in
  band, σ_s ≤ 0.10, past the freshness gate, and no run declined in the last 7 days.
- **Levers** (`levers.ts`, `recommend.ts`). Every RPM move re-inverts the dial at s*(RPM).
  - Row 13 pulls the next slot. If the compensated dial clamps, the level moves toward 1000.
  - Row 14 leaves the last slot's RPM: back to the usual RPM when it sits inside the body
    band, otherwise to the Bayes RPM.
  - Row 9 is the body move. It needs: calibrated (sd(k_r) ≤ 0.015), σ_s ≤ 0.08, three shots
    since the last move, P(barely matters) < 0.8, outside the band, and P(improve) ≥ 0.7.
    Steps are at most 300 RPM.
  - Backup: when the dial is at the chirp floor or the end, it picks the RPM within ±400
    closest to the target. It needs a significant slope. In-band wins within 0.02 ln.
  - Trim: when the dial step rounds to zero, an in-band RPM within ±200 that cuts the
    residual by ≥ 0.01.
  - Guidance appears at ≤ 600 RPM (E006).

## Simulator and convergence suite

`src/core/sim`: seeded hidden truth (gains, intercepts, drift, taste optimum, taste noise
and lapses, channeling), a 1/x flow law, a mis-counted dial (gain ×2), curve synthesis
through the real feature extractor, and the real replay/recommend loop with a simulated
user who follows every recommendation. `test/core/convergence.test.ts` runs 200 seeds per
scenario and asserts the plan's rates. The simulated taster uses the app's sign convention:
a shot faster than the balanced flow, or a ratio shorter than the optimum, reads sour. Before
2026-10-18 both signs were inverted, which made the taste scenarios look far worse than the
design is (README "Convergence suite").

## Deviations from the plan text

- `noisy` flag: residual-based (see above).
- Interrupted shots: the "gap covers the 25–75 % window" test uses the last known weight
  against 0.75 × target, since the final yield is unknown when the link never returns.
- Shots with the same id but differing content on import are kept locally and listed as
  conflicts rather than stored twice, because a duplicate would break the shot ↔ curve link.
- Taste convergence gate σ_s ≤ 0.08 instead of 0.06 (`RULES.setpointSdConverged`,
  2026-10-18). At one tasting per day the bean-age forgetting holds σ_s near 0.065–0.07,
  under the plan's gate. Meanwhile the posterior is conservative, with the mean within 1σ of
  the balanced flow in about 90 % of simulated bags. The likelihoods, the one-update-per-
  tasting rule and the sign test are unchanged. A stronger slider likelihood and forgetting
  on ratio changes were measured and rejected. README "Convergence suite" has the rates.
