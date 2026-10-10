/**
 * Pure configuration validation.
 *
 * Contract: spec §9; acceptance criteria AC-38, AC-39.
 *
 * This module does **not** read files or environment. It receives already-read
 * raw values (`loadConfig(raw)`), so the reading side (env → `goal.json` →
 * defaults, per spec §9) is a separate later-phase concern and this module is
 * independently testable.
 *
 * Rules:
 * - absent (`undefined`) → default, silently.
 * - present but invalid (wrong type, `null`, or out of range) → default **and** a
 *   warning naming the offending value (AC-39). JSON distinguishes `null` from
 *   absent, so `null` means the user supplied a value and it was not used.
 *
 * Sources and precedence (lowest → highest): built-in defaults < **plugin options**
 * (`ctx.options`, the documented V2 option channel) < `<root>/.opencode/goal.json` <
 * `OPENCODE_GOAL_*` environment variables. An **invalid** value at the highest layer
 * does not erase a valid value from a lower one — see {@link resolveConfigFrom} — so a
 * mistyped environment variable falls back to the file, not to the built-in default.
 */

export type PermissiveModePolicy = "warn" | "refuse";

export interface ResolvedConfig {
  /** Consecutive no-tool turns before anti-spin stops the loop. */
  antiSpinThreshold: number;
  /** Loop-started turns per unattended run before the hard cap stops the loop. */
  turnCap: number;
  /**
   * Longest one turn-end wait may block, in ms (spec §4.2). `0` waits
   * indefinitely, which is the behaviour that wedged a live loop (see §4.2).
   */
  turnWaitMaxMs: number;
  /** Model id for evaluation; `undefined` means auto-select (spec §7.2). */
  evaluatorModel?: string;
  /** Response to a positively-inferred permissive mode (spec §8.6). */
  permissiveModePolicy: PermissiveModePolicy;
  /** Per-message transcript cap sent to the evaluator, in code points (spec §7.4). */
  transcriptMaxMessageChars: number;
  /** Total transcript budget sent to the evaluator, in code points (spec §7.4). */
  transcriptMaxTotalChars: number;
  /** Model candidates one evaluation may try before it fails (E8). */
  evaluatorMaxAttempts: number;
}

export interface ConfigLoadResult {
  config: ResolvedConfig;
  warnings: string[];
}

export interface RawConfig {
  antiSpinThreshold?: unknown;
  turnCap?: unknown;
  turnWaitMaxMs?: unknown;
  evaluatorModel?: unknown;
  permissiveModePolicy?: unknown;
  transcriptMaxMessageChars?: unknown;
  transcriptMaxTotalChars?: unknown;
  evaluatorMaxAttempts?: unknown;
}

export const DEFAULT_CONFIG: Readonly<ResolvedConfig> = Object.freeze({
  antiSpinThreshold: 10,
  turnCap: 50,
  turnWaitMaxMs: 120_000,
  evaluatorModel: undefined,
  permissiveModePolicy: "warn",
  transcriptMaxMessageChars: 8000,
  transcriptMaxTotalChars: 48000,
  evaluatorMaxAttempts: 5,
});

/** Inclusive numeric bounds; outside → default + warning (spec §9, T-3 ceilings). */
export const ANTI_SPIN_MIN = 1;
export const ANTI_SPIN_MAX = 25;
export const TURN_CAP_MIN = 1;
export const TURN_CAP_MAX = 500;
/**
 * Turn-end wait bound, in ms. `ctx.session.wait` returns at *global* loop idle,
 * so a session the human keeps working in may never go idle; the bound is what
 * stops the loop from wedging with no verdict and no counters moving. `0`
 * restores the unbounded wait.
 */
export const TURN_WAIT_MIN = 0;
export const TURN_WAIT_MAX = 3_600_000;
/** Transcript caps bound evaluator cost/egress per evaluation, so they are tunable. */
export const TRANSCRIPT_MESSAGE_MIN = 200;
export const TRANSCRIPT_MESSAGE_MAX = 200_000;
export const TRANSCRIPT_TOTAL_MIN = 200;
export const TRANSCRIPT_TOTAL_MAX = 2_000_000;
export const EVALUATOR_ATTEMPTS_MIN = 1;
export const EVALUATOR_ATTEMPTS_MAX = 25;

/**
 * Accept a value only if it is an integer within `[min, max]`; otherwise fall
 * back to `fallback` and record the rejection.
 */
function readInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  key: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    warnings.push(
      `Invalid ${key} (${describe(value)}); expected an integer in [${min}, ${max}]; using default ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

function readEvaluatorModel(value: unknown, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    warnings.push(
      `Invalid evaluatorModel (${describe(value)}); expected a non-empty model id; using automatic selection.`,
    );
    return undefined;
  }
  return value;
}

function readPermissivePolicy(value: unknown, warnings: string[]): PermissiveModePolicy {
  if (value === undefined) return DEFAULT_CONFIG.permissiveModePolicy;
  if (value === "warn" || value === "refuse") return value;
  warnings.push(
    `Invalid permissiveModePolicy (${describe(value)}); expected "warn" or "refuse"; using default "${DEFAULT_CONFIG.permissiveModePolicy}".`,
  );
  return DEFAULT_CONFIG.permissiveModePolicy;
}

/**
 * Validate raw configuration values into a resolved configuration plus the
 * warnings AC-39 requires. Never throws.
 */
export function loadConfig(raw: RawConfig | null | undefined): ConfigLoadResult {
  const warnings: string[] = [];
  const source: RawConfig =
    typeof raw === "object" && raw !== null ? raw : {};

  const config: ResolvedConfig = {
    antiSpinThreshold: readInteger(
      source.antiSpinThreshold,
      ANTI_SPIN_MIN,
      ANTI_SPIN_MAX,
      DEFAULT_CONFIG.antiSpinThreshold,
      "antiSpinThreshold",
      warnings,
    ),
    turnCap: readInteger(
      source.turnCap,
      TURN_CAP_MIN,
      TURN_CAP_MAX,
      DEFAULT_CONFIG.turnCap,
      "turnCap",
      warnings,
    ),
    evaluatorModel: readEvaluatorModel(source.evaluatorModel, warnings),
    turnWaitMaxMs: readInteger(
      source.turnWaitMaxMs,
      TURN_WAIT_MIN,
      TURN_WAIT_MAX,
      DEFAULT_CONFIG.turnWaitMaxMs,
      "turnWaitMaxMs",
      warnings,
    ),
    permissiveModePolicy: readPermissivePolicy(source.permissiveModePolicy, warnings),
    transcriptMaxMessageChars: readInteger(
      source.transcriptMaxMessageChars,
      TRANSCRIPT_MESSAGE_MIN,
      TRANSCRIPT_MESSAGE_MAX,
      DEFAULT_CONFIG.transcriptMaxMessageChars,
      "transcriptMaxMessageChars",
      warnings,
    ),
    transcriptMaxTotalChars: readInteger(
      source.transcriptMaxTotalChars,
      TRANSCRIPT_TOTAL_MIN,
      TRANSCRIPT_TOTAL_MAX,
      DEFAULT_CONFIG.transcriptMaxTotalChars,
      "transcriptMaxTotalChars",
      warnings,
    ),
    evaluatorMaxAttempts: readInteger(
      source.evaluatorMaxAttempts,
      EVALUATOR_ATTEMPTS_MIN,
      EVALUATOR_ATTEMPTS_MAX,
      DEFAULT_CONFIG.evaluatorMaxAttempts,
      "evaluatorMaxAttempts",
      warnings,
    ),
  };

  enforceTranscriptCaps(config, warnings);

  return { config, warnings };
}

/**
 * A per-message cap larger than the total budget would truncate every message
 * out entirely, leaving the evaluator with nothing to judge — two individually
 * valid values that together disable evaluation. Clamp to the budget and say so.
 */
function enforceTranscriptCaps(config: ResolvedConfig, warnings: string[]): void {
  if (config.transcriptMaxMessageChars <= config.transcriptMaxTotalChars) return;
  warnings.push(
    `transcriptMaxMessageChars (${config.transcriptMaxMessageChars}) is larger than transcriptMaxTotalChars (${config.transcriptMaxTotalChars}); using the total budget as the per-message cap.`,
  );
  config.transcriptMaxMessageChars = config.transcriptMaxTotalChars;
}

/** Render an offending value for a warning so the message names it (AC-39). */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Layered resolution (pure) — spec §9
// ---------------------------------------------------------------------------

/**
 * How each configuration key is accepted. One spec per key, shared by every
 * layer, so a value is validated **before** it is applied — in any layer. That
 * is what stops an invalid value from erasing a valid one from a lower layer,
 * and it also means only known keys are ever read.
 */
const KEY_SPECS: readonly {
  readonly key: keyof RawConfig;
  readonly accept: (
    value: unknown,
  ) => { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly expectation: string };
}[] = [
  { key: "antiSpinThreshold", accept: acceptInteger(ANTI_SPIN_MIN, ANTI_SPIN_MAX) },
  { key: "turnCap", accept: acceptInteger(TURN_CAP_MIN, TURN_CAP_MAX) },
  { key: "turnWaitMaxMs", accept: acceptInteger(TURN_WAIT_MIN, TURN_WAIT_MAX) },
  { key: "evaluatorModel", accept: acceptModelId },
  { key: "permissiveModePolicy", accept: acceptPolicy },
  {
    key: "transcriptMaxMessageChars",
    accept: acceptInteger(TRANSCRIPT_MESSAGE_MIN, TRANSCRIPT_MESSAGE_MAX),
  },
  {
    key: "transcriptMaxTotalChars",
    accept: acceptInteger(TRANSCRIPT_TOTAL_MIN, TRANSCRIPT_TOTAL_MAX),
  },
  {
    key: "evaluatorMaxAttempts",
    accept: acceptInteger(EVALUATOR_ATTEMPTS_MIN, EVALUATOR_ATTEMPTS_MAX),
  },
];

function acceptInteger(min: number, max: number) {
  return (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? ({ ok: true, value } as const)
      : ({ ok: false, expectation: `an integer in [${min}, ${max}]` } as const);
}

function acceptModelId(value: unknown) {
  return typeof value === "string" && value.trim() !== ""
    ? ({ ok: true, value } as const)
    : ({ ok: false, expectation: "a non-empty model id" } as const);
}

function acceptPolicy(value: unknown) {
  return value === "warn" || value === "refuse"
    ? ({ ok: true, value } as const)
    : ({ ok: false, expectation: `"warn" or "refuse"` } as const);
}

function specFor(key: keyof RawConfig) {
  const spec = KEY_SPECS.find((candidate) => candidate.key === key);
  if (spec === undefined) throw new Error(`no config spec for ${String(key)}`);
  return spec;
}

/** Environment variable names, one per key (spec §9). */
const ENV_NAMES: Readonly<Record<string, keyof RawConfig>> = {
  OPENCODE_GOAL_ANTISPIN: "antiSpinThreshold",
  OPENCODE_GOAL_TURNCAP: "turnCap",
  OPENCODE_GOAL_TURN_WAIT: "turnWaitMaxMs",
  OPENCODE_GOAL_EVAL_MODEL: "evaluatorModel",
  OPENCODE_GOAL_PERMISSIVE: "permissiveModePolicy",
  OPENCODE_GOAL_TRANSCRIPT_MESSAGE: "transcriptMaxMessageChars",
  OPENCODE_GOAL_TRANSCRIPT_TOTAL: "transcriptMaxTotalChars",
  OPENCODE_GOAL_EVAL_ATTEMPTS: "evaluatorMaxAttempts",
};

/** The environment variable that stops the loop outright (spec §8.5); not a config key. */
export const DISABLE_ENV = "OPENCODE_GOAL_DISABLE";

/** Environment values arrive as strings: coerce the numeric keys, leave text keys alone. */
function coerceEnv(key: keyof RawConfig, text: string): unknown {
  if (key === "evaluatorModel" || key === "permissiveModePolicy") return text;
  const trimmed = text.trim();
  // An empty numeric value must not coerce to 0; keep the string so it is rejected.
  return trimmed === "" ? text : Number(trimmed);
}

export interface ConfigSources {
  /** `ctx.options` from the plugin entry — the documented V2 option channel. */
  readonly options?: unknown;
  /** Parsed `<root>/.opencode/goal.json`, or `null` when absent/malformed. */
  readonly file?: unknown;
  /** An environment lookup; pass `process.env` (or a stub, in tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Merge and validate every configuration source. Precedence, lowest → highest:
 * defaults → plugin `options` → project `goal.json` → environment.
 *
 * **Every layer is validated before it is applied**, so an invalid value in any
 * layer is reported and skipped and the next-lower layer stays in effect; the
 * built-in default applies only when no layer supplies a valid value.
 *
 * Until 2026-10-09 the layers were copied verbatim into one map and validated at
 * the end, so an invalid value in a *higher* layer erased a valid lower one and
 * fell through to the built-in default — silently. The environment layer was
 * fixed first; this rewrite applies the same discipline to all of them.
 *
 * Only known keys are read, so a `__proto__` key in a parsed JSON config file
 * cannot retarget the accumulator's prototype the way `Object.assign` would.
 */
export function resolveConfigFrom(sources: ConfigSources): ConfigLoadResult {
  const warnings: string[] = [];
  const raw: RawConfig = {};

  const applyLayer = (layer: unknown, label: string): void => {
    if (!isPlainObject(layer)) return;
    for (const spec of KEY_SPECS) {
      if (!Object.prototype.hasOwnProperty.call(layer, spec.key)) continue;
      const value = layer[spec.key];
      const accepted = spec.accept(value);
      if (!accepted.ok) {
        warnings.push(
          `Invalid ${spec.key} (${describe(value)}) in ${label}; expected ${accepted.expectation}; ignoring it.`,
        );
        continue;
      }
      raw[spec.key] = accepted.value;
    }
  };

  applyLayer(sources.options, "the plugin options");
  applyLayer(sources.file, "the goal config file");

  if (sources.env !== undefined) {
    for (const [name, key] of Object.entries(ENV_NAMES)) {
      const text = sources.env[name];
      if (text === undefined) continue;
      const accepted = specFor(key).accept(coerceEnv(key, text));
      if (!accepted.ok) {
        warnings.push(
          `Invalid ${name} (${describe(text)}); expected ${accepted.expectation}; ignoring this environment override.`,
        );
        continue;
      }
      raw[key] = accepted.value;
    }
  }

  const result = loadConfig(raw);
  return { config: result.config, warnings: [...warnings, ...result.warnings] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
