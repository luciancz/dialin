/**
 * Every tunable constant in one place, each with the source it came from.
 * Units: grams, seconds, g/s, ln(g/s), dial lines, RPM, days. "plan §X" refers to the
 * approved design (docs/ALGORITHM.md summarises it).
 */

export const APP_VERSION = '0.1.0';

/** Recorder (shot state machine). */
export const REC = {
  /** ARMED requires |Δw| < 0.3 g over 2 s (stable cup). */
  stableDeltaG: 0.3,
  stableWindowMs: 2000,
  /** Late tap: weight already rising > 0.5 g in the last 2 s at the tap → send 04, splice. */
  lateTapRiseG: 0.5,
  lateTapWindowMs: 2000,
  /** Forgot tap: in ARMED, > 2 g over 3 s with flow > 0.4 g/s → prompt. */
  forgotTapRiseG: 2,
  forgotTapWindowMs: 3000,
  forgotTapFlowGps: 0.4,
  /** Timer-mode verification: timer still 0 after this many frames → modeHint 'auto'. */
  timerVerifyFrames: 5,
  /** Frames in the first 400 ms with |g| > 2 are tare settling and ignored. */
  tareSettleMs: 400,
  tareSettleG: 2,
  /** Auto-end: t ≥ 10 s, w ≥ 0.5·target, derived flow < 0.15 g/s for 3 s; or w ≥ target + 3 g. */
  autoEndMinS: 10,
  autoEndMinYieldFrac: 0.5,
  autoEndFlowGps: 0.15,
  autoEndQuietMs: 3000,
  autoEndOvershootG: 3,
  /** Pre-alert at target − tailEstimate (default 1.0 g, later the bag's mean tail). */
  tailEstimateDefaultG: 1.0,
  /** Drip window after stop, then final yield = median of the last 1 s. */
  settleMs: 6000,
  finalYieldMedianMs: 1000,
  /** Disconnect while RUNNING/ENDING: keep the app clock, reconnect each 1 s, give up at 20 s. */
  recoverRetryMs: 1000,
  recoverGiveUpMs: 20_000,
  /** Aborted shots under 5 g are discarded rather than stored. */
  abortDiscardG: 5,
  /** Frame ring kept while connected. */
  ringMs: 120_000,
  /** Gap threshold between frames for curve masking. */
  gapMs: 400,
  /** Derived-flow window used by the recorder for auto-end (1 s regression). */
  liveFlowWindowMs: 1000,
  /**
   * A frame-to-frame jump this large is an object put on or taken off the scale, never a pour
   * (a fast shot adds ≈ 0.4 g per 100 ms frame). Rise windows that contain one are not a
   * forgotten or late tap.
   */
  placementJumpG: 8,
  /** After a tare command, frames this long are the scale applying it. */
  tareApplyMs: 600,
  /**
   * Auto-tare (cup or dosing cup put down): the reading rose ≥ 20 g within the last 3 s, with a
   * placement jump, then held within ±0.2 g for 1 s → one tare. It re-arms when something is
   * taken off (reading ≤ −10 g), with 3 s between tares.
   */
  autoTareStepG: 20,
  autoTareLookbackMs: 3000,
  autoTareSettleMs: 1000,
  autoTareBandG: 0.2,
  autoTareRemovedG: 10,
  autoTareCooldownMs: 3000,
  /**
   * Bean weighing: the dose is captured once the reading is above 3 g and steady within one
   * scale count (0.1 g) for 1.5 s; it is re-opened if the reading moves by 0.3 g. A dose more
   * than 0.3 g from the plan gets a note.
   */
  weighMinG: 3,
  weighStableMs: 1500,
  weighStableRangeG: 0.1,
  weighReopenG: 0.3,
  weighNoteG: 0.3,
} as const;

/** ScaleClient. */
export const CLIENT = {
  staleMs: 1500,
  lostMs: 5000,
  backoffMs: [500, 1000, 2000, 4000, 8000] as readonly number[],
  backoffCapMs: 15_000,
  giveUpMs: 60_000,
  /** While a shot is RUNNING keep retrying for the shot duration + 30 s. */
  runningExtraMs: 30_000,
  /** Wait at most 2 s for the first weight frame after subscribing. */
  firstFrameMs: 2000,
  /** Delay between smoothing-off and auto-off commands on connect. */
  commandGapMs: 150,
  autoOffMinutes: 30,
  autoOffBannerMs: 3 * 60_000,
  batteryWarnPct: 20,
  /** Weight changes > 0.2 g count as activity for the app-side auto-off clock. */
  activityDeltaG: 0.2,
} as const;

/** Curve resampling and feature extraction (plan "Feature extraction"). */
export const FEAT = {
  gridMs: 100,
  sgWindow: 11,
  /** 'noisy' when the RMS residual of raw weight around its local quadratic fit exceeds this (g). */
  noisyResidualG: 0.15,
  firstDripG: 0.5,
  firstDripFlowGps: 0.2,
  firstDripConsecutive: 5,
  plateauLo: 0.25,
  plateauHi: 0.75,
  lateLo: 0.8,
  lateHi: 0.95,
  jumpStartAfterDripS: 2,
  jumpWindowHiFrac: 0.9,
  dipRatio: 0.7,
  dipRecoverRatio: 0.9,
  dipMinS: 0.5,
  dipMedianWindowS: 3,
  spikeGps: 0.7,
  earlyDripS: 4,
  lateDripS: 15,
  chokedAtS: 15,
  chokedFlowGps: 0.5,
  chokedWeightG: 5,
  blondRiseRel: 0.5,
  lowInfoPlateauS: 6,
  lowInfoYieldG: 20,
  validMinYieldG: 10,
  validTimeS: [10, 90] as const,
  validGridFraction: 0.6,
  validMinPlateauS: 2,
  /** curveChannelScore weights (plan table). */
  channelW: { jump: 0.5, dips: 0.3, lateSlope: 0.2, earlyDripLight: 0.2 },
} as const;

/** Flow model priors and process noise (plan "Flow model"). */
export const MODEL = {
  /** ln per line, positive because a higher dial = coarser = faster. 1–1.7 s per 5 µm line at ~30 s. */
  kGrindPrior: { mean: 0.045, sd: 0.03 },
  /**
   * ln flow per 100 RPM on stock VS6 flats. From Varia's own laser-diffraction data (flats
   * barely change PSD with RPM, slightly finer at high RPM, mostly above 1100) converted to
   * flow with a Kozeny–Carman exponent 2–4: −0.007 … −0.037. Other flat grinders show both
   * signs (EG-1 owners faster at high RPM, Mythos 2 slower), so the sd keeps +0.04 within 1.6σ.
   * Research 2026-10-19 (docs/ALGORITHM.md "RPM").
   */
  kRpmPrior: { mean: -0.015, sd: 0.035 },
  /** Curvature κ of the RPM effect per (100 RPM)²: Varia's data is steeper above ~1100. Shrunk. */
  kRpmCurvPrior: { mean: 0, sd: 0.005 },
  /** per gram of dose; 1–3 s per gram at 30 s. Never reset by epoch events. */
  kDosePrior: { mean: -0.06, sd: 0.04 },
  /** First bag of an epoch. */
  aFirstSd: 0.5,
  /** Later bags: 0.25² + sd(k_g)²·(ΔL_ref)². */
  aLaterSd: 0.25,
  /** Measurement noise of ln(plateauFlow); measured in M1 (acceptance CV ≤ 10 %). */
  sigmaY: 0.07,
  /** Reference bean age for the intercept definition. */
  refAgeDays: 14,
  /** Offset from mean-after-first-drip flow to plateau flow (to be re-measured). */
  plateauOffsetLn: 0.08,
  /** EAF time windows: dose 18 g × ratio, mid-window seconds, first drip ≈ 8 s. */
  roastDefaults: {
    light: { ratio: 2.3, tMidS: 31.5 },
    medium_light: { ratio: 2.1, tMidS: 27.5 },
    medium: { ratio: 2.0, tMidS: 27.5 },
    medium_dark: { ratio: 1.9, tMidS: 26 },
    dark: { ratio: 1.7, tMidS: 24 },
    unknown: { ratio: 2.0, tMidS: 27.5 },
  },
  firstDripAssumedS: 8,
  doseDefaultG: 18,
  /** Metadata offsets on a later bag's intercept prior. */
  deltaMeta: { light: 0.1, dark: -0.1, naturalLike: -0.08, decaf: -0.1, filter: -0.05 },
  ridgeMinBags: 4,
  ridgeMinShotsPerBag: 3,
  ridgeLambda: 1,
  ridgeMinSd: 0.15,
  /** Bean-age drift of ln flow per day (33 s → 27 s over 4 weeks), 0 while frozen. */
  driftYoung: 0.007,
  driftOld: 0.002,
  driftAgeSplitDays: 21,
  /** Process noise sd per √day on a_b. */
  qYoung: 0.03,
  qMid: 0.02,
  qOld: 0.01,
  qFrozen: 0.005,
  qAgeYoungDays: 10,
  qAgeMidDays: 21,
  /** Added variance on a thawed/opened storage event. */
  thawVar: 0.05 ** 2,
  /** k_g, k_r variance growth per day (sd 0.010 → 0.012 over about a year). */
  kDriftVarPerDay: 1e-7,
  /** Robust update: Huber thresholds (r1, r2) by innovation sign. Channeling only speeds shots up. */
  huberNeg: [2, 4] as const,
  huberPos: [1.5, 3] as const,
  /** Base weight multipliers. */
  wChannel: 0.3,
  wFreshness: 0.5,
  wLowInfo: 1 / 1.5 ** 2,
  wEarlyChannel: 0.5,
  earlyChannelScore: 0.3,
  earlyChannelShots: 3,
  /** Escape hatch after two consecutive skips: inflate P[a_b] to 0.5². */
  reanchorSkips: 2,
  reanchorSd: 0.5,
  /** Epoch-event variances. */
  cleaningSd: 0.25,
  reZeroSd: 0.25,
  washerSd: 0.5,
  springSd: 0.5,
  recountSd: 0.5,
  newBurrsSd: 0.5,
  /** A 0.1 mm washer ≈ 20 nominal lines (finer at the same reading). */
  washerLinesPer: 20,
  /** Inversion floor on k_g and step clamps. */
  kGrindFloor: 0.01,
  stepMaxLines: 10,
  probeStepLines: 5,
  stepAbsMaxLines: 15,
  kGrindSdConverged: 0.012,
  /** Lines above the chirp where the model may recommend. */
  chirpMarginLines: 5,
} as const;

/** Rule table thresholds (plan "Rule layer"). */
export const RULES = {
  beta: 0.07,
  betaRoute: 0.14,
  setpointSdRoute: 0.1,
  /**
   * "Dialled in" (row 11) and RPM-lever (row 9) gate on σ_s. Plan: 0.06. Retuned to 0.08 on
   * 2026-10-18 (README "Convergence suite", 200-seed simulator): at one tasting per day the
   * bean-age forgetting (0.02/√day) holds σ_s near 0.065–0.07, so 0.06 sits under the floor
   * and was reached within 14 rated shots in 32 % of bags. σ_s is conservative there (the
   * mean is within 1σ of the balanced flow in ~90 % of bags), and at the first σ_s ≤ 0.08 the
   * median error is 0.027 with 86 % inside β. 0.08 also equals SETPOINT.thompsonSd, so
   * exploration stops where "dialled in" starts. Must stay below setpointSdRoute.
   */
  setpointSdConverged: 0.08,
  freshnessDays: { light: 5, medium_light: 5, medium: 3, medium_dark: 2, dark: 2, unknown: 3 },
  /** Freshness gate still allows a half grind step when far off band. */
  freshnessOverrideLn: 0.25,
  ratioCap: { light: 2.8, medium: 2.3, dark: 2.0 },
  ratioFloor: { light: 1.8, medium: 1.6, dark: 1.4 },
  yieldStepG: 2,
  yieldBigStepG: 4,
  /** Temperature card: ≥ 4 rated in-band shots with mean |v| ≥ 1.5, once per bag. */
  tempMinRated: 4,
  tempMeanSlider: 1.5,
  /** Confidence words from Φ(β/s_p) − Φ(−β/s_p). */
  firm: 0.7,
  probable: 0.4,
  /** Outlier gate on the last shot (r > 4) blocks changes until re-anchored. */
  outlierR: 4,
  /** Lookback for rule evaluation. */
  lookback: 5,
} as const;

/** Preference-based setpoint search (plan "Preference-based setpoint search"). */
export const SETPOINT = {
  gridHalfWidth: 0.6,
  gridStep: 0.01,
  priorSd: 0.2,
  utilityW: 0.15,
  jnd: 0.1,
  tauBase: 0.5,
  tauPerDay: 0.25,
  lapse: 0.1,
  /** Validity of a better/worse comparison. */
  maxLnYieldDiff: 0.1,
  maxDoseDiffG: 0.3,
  minLnFlowDiff: 0.04,
  sliderScale: 0.1,
  /**
   * Slider pseudo-likelihood floor (plan). One tasting moves the odds between two setpoints by
   * at most 1/floor = 4. Tried 2026-10-18 and not applied: floor 0.15 with exponent
   * (1 + |v|)/4 (odds ≤ 6.7) gained 6 pp on scenario c and 3 pp on d within 14 rated shots at
   * the 0.06 gate, too little to justify trusting a single slider more (README).
   */
  sliderFloor: 0.25,
  balancedMinOverall: 7,
  forgetPerDaySd: 0.02,
  forgetOnLeverChangeSd: 0.08,
  thompsonSd: 0.08,
  thompsonClamp: 0.12,
  probeOffset: 0.07,
  /** Roaster recipe blends 50/50 into the prior mean. */
  recipeWeight: 0.5,
} as const;

/** Simulator hidden-truth ranges (plan "Simulator"). */
export const SIM = {
  kGrind: [0.02, 0.09] as const,
  kRpm: [-0.08, 0.08] as const,
  kDose: [-0.1, -0.03] as const,
  aSd: 0.3,
  drift: [0.004, 0.01] as const,
  setpointSd: 0.15,
  tasteTau: [0.3, 0.6] as const,
  tasteLapse: 0.15,
  channelProb: [0.15, 0.25] as const,
  channelLn: [0.15, 0.4] as const,
  spikeGps: 0.9,
  spikeS: 1.5,
  dips: [1, 3] as const,
  firstDripS: [6, 10] as const,
  rampS: 3,
  lateRise: 0.02,
  noiseG: 0.05,
  truncG: 0.1,
  timerSlow: 0.007,
  tailG: [1, 2] as const,
  tailS: [4, 5] as const,
  frameMs: 100.7,
  frameJitterMs: 30,
  sliderScale: 0.25,
} as const;

/**
 * RPM calibration and the RPM levers (plan "RPM calibration", research 2026-10-19).
 * u = (RPM − 1000)/100 everywhere.
 */
export const RPM = {
  /** VS6 hardware: 500–1600 RPM in 100 RPM steps. */
  rangeDefault: [500, 1600] as const,
  step: 100,
  reference: 1000,
  /** E006: undocumented VS6 stall error seen at 500–600 RPM with dense beans. */
  e006Rpm: 600,
  /** A reported stall raises that bean's floor to the stall RPM + this. */
  stallMargin: 100,
  /** "Calibrated": sd(k_r) at or below this (≤ 5 % flow error over ±300 RPM). */
  calibratedSd: 0.015,
  /** Block 1: L H H L, L = max(lo, 700), H = min(hi, L + 600) (Δ = 6 → sd ≈ 0.0115 in 4 shots). */
  blockLow: 700,
  blockSpan: 600,
  /** Block 2: X Y Y X with |X − Y| ≥ 300, chosen by information gain. */
  block2MinSpan: 300,
  /** A slot counts when its shot is learnable, accepted and has Huber weight ≥ 0.5. */
  slotMinWeight: 0.5,
  maxRepeatsPerSlot: 2,
  /** Early stop after a block: sd(k_r) ≤ min(calibratedSd, stopFlowErr/u_max) and MI(θ) < this. */
  stopFlowErr: 0.05,
  stopMiNats: 0.05,
  /** Offer gate. */
  offerMaxSetpointSd: 0.1,
  offerDeclineDays: 7,
  /** Cross-RPM comparisons count as matched flow when |Δ y_ref| ≤ this. */
  matchedFlowLn: 0.07,
  /** Balance shift δ (ln flow per 100 RPM): prior and observation model. */
  deltaPriorSd: 0.02,
  /** Slider steps per ln unit of flow offset (3 steps per 0.25 ln). Assumption: measure in the field. */
  sliderPerLn: 12,
  deltaMaxPairHours: 12,
  deltaMaxDyLn: 0.15,
  /** Preference grid. */
  thetaMin: 500,
  thetaMax: 1600,
  thetaStep: 50,
  betaGrid: [-0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 0.75, 1] as const,
  orderBiasGrid: [-0.25, 0, 0.25] as const,
  thetaPriorMean: 1000,
  thetaPriorSd: 300,
  /** Bean prior: blend of earlier beans (blurred) and the population prior. */
  beanPriorBlur: 150,
  beanPriorWeight: 0.8,
  beanPriorMinRatings: 3,
  otherRoastWeight: 0.3,
  /** Thin–heavy ordered probit noise and the utility scale U = −β²(u − θ_u)²/18. */
  bodyNoise: 0.8,
  utilityScale: 18,
  tieBand: 0.5,
  lapse: 0.1,
  /** "RPM barely changes body": P(|6β| < 1). Body moves need pInsensitive below this. */
  pInsensitiveMax: 0.8,
  /** JND band: RPMs with expected regret ≤ this. */
  regretJnd: 0.1,
  /** Body move gates. */
  bodyMinShotsBetween: 3,
  bodyImproveProb: 0.7,
  bodyStepCap: 300,
  /** Backup flow lever and fine trim. */
  backupMaxStep: 400,
  trimMaxStep: 200,
  trimMinResidual: 0.015,
  trimMinGain: 0.01,
  /** Slope significance for the backup lever: |slope| ≥ z·sd. */
  backupZ: 1.28,
  /** Backup RPM: an RPM inside the body band wins when within this much ln flow of the best. */
  backupBandSlackLn: 0.02,
  /** κ variance growth per day, scaled like k_r's (sd ratio 0.005/0.035). */
  curvDriftVarPerDay: 1e-7 * (0.005 / 0.035) ** 2,
} as const;

/** Backup nags. */
export const BACKUP = {
  nagShots: 5,
  nagDays: 7,
  redDays: 14,
  rawRecordingsKept: 5,
} as const;
