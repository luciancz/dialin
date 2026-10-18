/**
 * Data model. Every persisted row extends Meta. All times are ISO strings;
 * Id is a uuidv7 (time-sortable). Mirrors the approved plan's "Data model" section.
 */

export type Id = string;

export interface Meta {
  id: Id;
  createdAt: string;
  updatedAt: string;
  deviceId: Id;
  deleted?: true;
}

export type RoastLevel = 'light' | 'medium_light' | 'medium' | 'medium_dark' | 'dark' | 'unknown';
export type Process =
  | 'washed'
  | 'natural'
  | 'honey'
  | 'anaerobic'
  | 'carbonic_maceration'
  | 'other'
  | 'unknown';
export type RoastTarget = 'filter' | 'espresso' | 'omni' | 'unknown';

export interface Bean extends Meta {
  roaster: string;
  name: string;
  origin?: string;
  roastLevel: RoastLevel;
  roastLabelRaw?: string;
  roastTarget: RoastTarget;
  process: Process;
  decaf: boolean;
  decafMethod?: string;
  blend?: { component: string; pct?: number }[];
  notes?: string;
}

export type StorageEventKind = 'opened' | 'frozen' | 'thawed' | 'finished';

export interface Bag extends Meta {
  beanId: Id;
  roastDate: string;
  openedAt?: string;
  weightG?: number;
  /** Fixed dose for this bag (default 18 g). Dose changes are a covariate, not a lever. */
  doseDefaultG: number;
  /** Current target yield; dose × ratio default by roast. */
  targetYieldG: number;
  roasterRecipe?: {
    doseG?: number;
    yieldG?: number;
    timeS?: [number, number];
    tempC?: number;
    raw?: string;
  };
  storage: { at: string; event: StorageEventKind }[];
  /** Grinder stalls (VS6 E006) reported with this bag: they raise its RPM floor. */
  stalls?: { at: string; rpm: number; shotId?: Id }[];
  /** Held RPM, default 1000. */
  rpm: number;
  /** Thompson-sampling PRNG seed. */
  tsSeed: number;
  archived: boolean;
}

export interface DialSpec {
  /** Numbered units per revolution (10). */
  numbersPerRev: number;
  /** Small lines per numbered unit (default 10, unconfirmed). */
  linesPerNumber: number;
  /** Usable revolutions (6). */
  revs: number;
  /** Nominal burr travel per small line (5 µm). Never used by the estimator. */
  umPerLineNominal: number;
}

export interface DialPosition {
  /** 1..revs */
  rev: number;
  /** 0..numbersPerRev-1 */
  number: number;
  /** 0..linesPerNumber-1 */
  line: number;
}

export type EpochEventKind =
  | 'initial'
  | 'new_burrs'
  | 'washer_change'
  | 'spring_change'
  | 'cleaning'
  | 're_zero'
  | 'dial_recount'
  | 'other';

export interface CalibrationEpoch extends Meta {
  startedAt: string;
  kind: EpochEventKind;
  parentEpochId?: Id;
  dialSpec: DialSpec;
  burrSet: string;
  washerCount: number;
  springSet: string;
  chirp?: DialPosition;
  /** washer_change: signed change in washer count. */
  deltaWashers?: number;
  /** Starting dial for the epoch anchor (L_ref,e) when there is no chirp. */
  usualDial?: DialPosition;
  note?: string;
}

export interface GrinderSetting {
  dialPos: DialPosition;
  rpm: number;
  rpmConfirmed: boolean;
}

export type TempSwitch = 0 | 1 | 2;

export interface ShotSettings {
  grind: GrinderSetting;
  doseG: number;
  targetYieldG: number;
  tempSwitch: TempSwitch;
}

export interface Context {
  minutesSincePowerOn?: number;
  secondsSinceLastLever?: number;
  flushedBefore?: boolean;
  shotIndexOfDay: number;
  prepNote?: string;
  appVersion: string;
  scaleFirmware?: string;
  /** Future drop-ins (Gicar tap, pump reed, pressure). Nothing writes these yet. */
  sensors?: { gicar?: unknown; pumpOnAtMs?: number; pressureBar?: number[] };
}

export interface Curve extends Meta {
  shotId: Id;
  /** Seconds from the tap, 100 ms grid. */
  t: Float32Array;
  /** Grams on the grid (linear interpolation of the raw frames). */
  g: Float32Array;
  /** Scale's own EMA flow, display only. */
  flowScale: Float32Array;
  rawHz: number;
  timerDriftPct: number;
  /** [startS, endS] intervals with no frames (> 400 ms). */
  gaps: [number, number][];
  /** Seconds; the moment stop (05) was sent or the auto-end fired. */
  endAt: number;
  /** Late-tap recovery: seconds of pre-tap frames spliced in. */
  preTapSpliceS?: number;
}

export type FeatureFlag =
  | 'spike'
  | 'dip'
  | 'early_drip'
  | 'late_drip'
  | 'choked'
  | 'blond_rise'
  | 'low_info'
  | 'noisy';

export interface Features {
  firstDripS: number | null;
  t50S: number | null;
  /** Model observable: (w(t75) − w(t25)) / (t75 − t25), g/s. */
  plateauFlow: number | null;
  meanFlow: number | null;
  lateSlopeRel: number | null;
  maxJump1s: number | null;
  dipCount: number;
  tailMassG: number;
  totalTimeS: number;
  finalYieldG: number;
  plateauDurS: number;
  /** 0..1, a pure function of the curve. */
  curveChannelScore: number;
  flags: FeatureFlag[];
  valid: boolean;
  invalidReasons: string[];
}

export type VsPrevious = 'better' | 'same' | 'worse';
export type SliderValue = -3 | -2 | -1 | 0 | 1 | 2 | 3;
export type Chip = 'balanced' | 'astringent' | 'harsh' | 'hollow' | 'channelled';

export interface Rating extends Meta {
  shotId: Id;
  comparedToShotId: Id | null;
  vsPrevious: VsPrevious | null;
  /** −3 sour … +3 bitter. */
  sourBitter: SliderValue | null;
  /** −3 thin … +3 heavy. */
  thinHeavy: SliderValue | null;
  chips: Chip[];
  overall1to9?: number;
  drink: 'black';
  secondsSincePull?: number;
}

export type ShotStatus =
  | 'ok'
  | 'late_tap'
  | 'no_tap_recovered'
  | 'partial_disconnect'
  | 'aborted'
  | 'manual_entry'
  /** The grinder stalled (VS6 E006): kept for the record, never learned from. */
  | 'stalled';

export interface ShotQuality extends Meta {
  shotId: Id;
  status: ShotStatus;
  learn: boolean;
  userOverride?: boolean;
  notes: string[];
}

export type EndedBy = 'tap' | 'auto' | 'disconnect' | 'abort';
export type Deviation = 'followed' | 'partly' | 'ignored';

/** Immutable after save; curve, quality and rating are separate rows. */
export interface Shot extends Meta {
  bagId: Id;
  epochId: Id;
  at: string;
  settings: ShotSettings;
  context: Context;
  features: Features;
  endedBy: EndedBy;
  recommendationId: Id | null;
  deviation: Deviation | null;
  /** RPM calibration slot this shot was pulled for (immutable tag). */
  calibration?: CalibrationTag;
}

export interface CalibrationTag {
  runId: Id;
  /** 0..7: block 1 = slots 0–3 (L H H L), block 2 = slots 4–7 (X Y Y X). */
  slot: number;
  plannedRpm: number;
}

export type RpmRunStatus = 'active' | 'done' | 'stopped' | 'abandoned' | 'declined';

/**
 * An RPM calibration session (or a declined offer). Only intent and status are stored; the
 * slots, repeats and results are derived in replay from the tagged shots.
 */
export interface RpmCalibrationRun extends Meta {
  epochId: Id;
  bagId: Id;
  startedAt: string;
  status: RpmRunStatus;
  endedAt?: string;
  note?: string;
}

/**
 * `rpm` is the compensated body move (RPM and dial change together so flow holds);
 * `calibrate` is a calibration slot.
 */
export type Lever =
  | 'grind'
  | 'yield'
  | 'rpm'
  | 'prep'
  | 'wait'
  | 'temperature'
  | 'none'
  | 'calibrate';
export type Stage = 'B_grind' | 'C_ratio' | 'D_hone' | 'E_temp' | 'F_rpm';
export type ConfidenceWord = 'firm' | 'probable' | 'probe' | 'insufficient';

export interface Recommendation extends Meta {
  bagId: Id;
  afterShotId: Id | null;
  lever: Lever;
  stage: Stage;
  next: ShotSettings;
  delta: { lines?: number; yieldG?: number; rpm?: number };
  targetLnFlow: number;
  predictedLnFlow: number;
  /** g/s */
  predictedBand: [number, number];
  confidence: number;
  confidenceWord: ConfidenceWord;
  sentence: string;
  whyNot: string[];
  vetoes: string[];
  source: 'rules' | 'flowModel' | 'setpoint' | 'rpmModel';
  snapshot: {
    kGrind: [number, number];
    kRpm: [number, number];
    kDose: [number, number];
    aBag: [number, number];
    setpoint: [number, number];
    /** RPM curvature κ (mean, sd). */
    kRpmCurv?: [number, number];
    /** Balance shift δ per 100 RPM (mean, sd). */
    delta?: [number, number];
    /** Preferred RPM θ (mean, sd) and P(RPM barely changes body). */
    rpmPref?: [number, number, number];
  };
  /** A card the user can accept (start an RPM calibration). */
  offer?: 'rpm_calibration';
  /** Set when the next shot is a calibration slot; the shot copies it as its tag. */
  calibration?: CalibrationTag;
  /** Extra practical guidance (e.g. E006 at low RPM). */
  guidance?: string[];
  /** Probability that the body move improves the cup (rpm lever). */
  bodyConfidence?: number;
}

export type BleCaps = Record<string, string | boolean | number>;

export interface Settings {
  id: 'settings';
  deviceId: Id;
  onboardingDone: boolean;
  defaultRpm: number;
  /** Legacy (pre-RPM-calibration); superseded by rpmRange and no longer read. */
  allowLowRpm: boolean;
  /** RPM range for calibration and recommendations; VS6 hardware is 500–1600. */
  rpmRange?: [number, number];
  rpmResetsOnPowerOn: boolean | 'unknown';
  maraSwitch: { temp: TempSwitch; mode: 'coffee' | 'steam' | 'unknown' };
  scaleFirmware?: string;
  scaleName?: string;
  /** Minutes requested from the scale on connect (30). */
  autoOffMinutesWanted: number;
  lastExportAt?: string;
  shotsSinceExport: number;
  bleCaps?: BleCaps;
  /** Which argument to pass Bluefy's setScreenDimEnabled, if present. */
  screenDimArg?: 'true' | 'false' | 'none';
  /** Preferred transport on the Settings screen. */
  transport?: 'webbt' | 'fake' | 'replay';
  updatedAt: string;
}

export type FrameSource = 'ff11' | 'ff12';

/** [seq, tRxMs, src, hex] */
export type RawFrameRow = [number, number, FrameSource, string];

export interface RawRecording extends Meta {
  shotId?: Id;
  transport: string;
  frames: RawFrameRow[];
}

/** Exists for a later serial tap / pump reed; nothing writes it. */
export interface SensorSample extends Meta {
  shotId: Id;
  source: 'gicar' | 'pump_reed' | 'pressure';
  tRxMs: number;
  payload: unknown;
}
