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
3. **Flow model** (`src/core/flowmodel`): joint Gaussian over `[k_g, k_r, k_d, a_b…]` per
   epoch, per-bag reference line `L_ref,b`, robust Huber update with asymmetric knees
   (2/4 slow side, 1.5/3 fast side), Joseph-form covariance, two-skip re-anchor, anchor shot
   after epoch events, bean-age drift and process noise, pooled priors for later bags with
   a ridge-regression metadata offset after four well-sampled bags.
4. **Setpoint** (`src/core/setpoint/grid.ts`): 121-point grid posterior over the optimal
   ln plateau flow. One update per tasting: the better/worse preference likelihood when the
   comparison is valid, otherwise the sour–bitter slider (sign test: sour ⇒ finer), hollow /
   harsh chips, or a `balanced` bump. Forgetting with bean age and on RPM / temperature
   changes. Thompson target while σ_s > 0.08, deterministic ±0.07 probe after two `same`
   answers, the mean otherwise.
5. **Rules** (`src/core/rules/table.ts`): the twelve rows in order; first match wins. Vetoes:
   step clamps (10 lines, 5 while the gain is unsure, 15 absolute), chirp + 5 floor, gain
   floor 0.010, compass check, RPM floor 700 (500 with opt-in).
6. **Arbitration** (`src/core/recommend.ts`): one lever, next settings, sentence from the
   templates, confidence `Φ(β/s_p) − Φ(−β/s_p)` from parameter uncertainty only, predicted
   band including σ_y, why-not list, model snapshot.
7. **Replay** (`src/core/replay.ts`): epochs folded in order with the event transforms between
   them; only `learn === true` shots update the flow model; ratings update the setpoint.
   The slider update is skipped when, in stage C, the same slider is about to drive the
   yield rule (in band, slider ≠ 0, ratio strictly inside its bounds).

## Simulator and convergence suite

`src/core/sim`: seeded hidden truth (gains, intercepts, drift, taste optimum, taste noise
and lapses, channeling), a 1/x flow law, a mis-counted dial (gain ×2), curve synthesis
through the real feature extractor, and the real replay/recommend loop with a simulated
user who follows every recommendation. `test/core/convergence.test.ts` runs 200 seeds per
scenario and asserts the plan's rates.

## Deviations from the plan text

- `noisy` flag: residual-based (see above).
- Interrupted shots: the "gap covers the 25–75 % window" test uses the last known weight
  against 0.75 × target, since the final yield is unknown when the link never returns.
- Shots with the same id but differing content on import are kept locally and listed as
  conflicts rather than stored twice, because a duplicate would break the shot ↔ curve link.
