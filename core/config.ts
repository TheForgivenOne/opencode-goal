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
  evaluatorModel?: unknown;
  permissiveModePolicy?: unknown;
  transcriptMaxMessageChars?: unknown;
  transcriptMaxTotalChars?: unknown;
  evaluatorMaxAttempts?: unknown;
}

export const DEFAULT_CONFIG: Readonly<ResolvedConfig> = Object.freeze({
  antiSpinThreshold: 3,
  turnCap: 50,
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

  return { config, warnings };
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
 * Every environment variable the plugin reads for configuration, with the
 * validation applied **before** the override is accepted. This is what stops an
 * invalid environment value from erasing a valid `.opencode/goal.json` value.
 */
const ENV_SPECS: readonly {
  readonly name: string;
  readonly key: keyof RawConfig;
  readonly parse: (text: string) => { ok: true; value: unknown } | { ok: false; expectation: string };
}[] = [
  { name: "OPENCODE_GOAL_ANTISPIN", key: "antiSpinThreshold", parse: envInteger(ANTI_SPIN_MIN, ANTI_SPIN_MAX) },
  { name: "OPENCODE_GOAL_TURNCAP", key: "turnCap", parse: envInteger(TURN_CAP_MIN, TURN_CAP_MAX) },
  { name: "OPENCODE_GOAL_EVAL_MODEL", key: "evaluatorModel", parse: envNonEmptyString },
  { name: "OPENCODE_GOAL_PERMISSIVE", key: "permissiveModePolicy", parse: envPermissivePolicy },
  {
    name: "OPENCODE_GOAL_TRANSCRIPT_MESSAGE",
    key: "transcriptMaxMessageChars",
    parse: envInteger(TRANSCRIPT_MESSAGE_MIN, TRANSCRIPT_MESSAGE_MAX),
  },
  {
    name: "OPENCODE_GOAL_TRANSCRIPT_TOTAL",
    key: "transcriptMaxTotalChars",
    parse: envInteger(TRANSCRIPT_TOTAL_MIN, TRANSCRIPT_TOTAL_MAX),
  },
  {
    name: "OPENCODE_GOAL_EVAL_ATTEMPTS",
    key: "evaluatorMaxAttempts",
    parse: envInteger(EVALUATOR_ATTEMPTS_MIN, EVALUATOR_ATTEMPTS_MAX),
  },
];

/** The environment variable that stops the loop outright (spec §8.5); not a config key. */
export const DISABLE_ENV = "OPENCODE_GOAL_DISABLE";

function envInteger(min: number, max: number) {
  return (text: string): { ok: true; value: number } | { ok: false; expectation: string } => {
    const trimmed = text.trim();
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      return { ok: false, expectation: `an integer in [${min}, ${max}]` };
    }
    return { ok: true, value: parsed };
  };
}

function envNonEmptyString(text: string): { ok: true; value: string } | { ok: false; expectation: string } {
  if (text.trim() === "") return { ok: false, expectation: "a non-empty model id" };
  return { ok: true, value: text };
}

function envPermissivePolicy(text: string): { ok: true; value: string } | { ok: false; expectation: string } {
  if (text !== "warn" && text !== "refuse") return { ok: false, expectation: '"warn" or "refuse"' };
  return { ok: true, value: text };
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
 * An invalid **environment** value is rejected *before* it is applied and is
 * reported as an ignored override, so it cannot erase a valid file or option
 * value (this was the defect: the old env layer wrote the raw string into the
 * merge map, and validation then fell through to the *built-in default*).
 * Invalid `options`/`file` values still fall back to the default, because those
 * layers are copied verbatim and validated at the end.
 */
export function resolveConfigFrom(sources: ConfigSources): ConfigLoadResult {
  const warnings: string[] = [];
  const raw: RawConfig = {};

  if (isPlainObject(sources.options)) Object.assign(raw, sources.options);
  if (isPlainObject(sources.file)) Object.assign(raw, sources.file);

  if (sources.env !== undefined) {
    for (const spec of ENV_SPECS) {
      const text = sources.env[spec.name];
      if (text === undefined) continue;
      const parsed = spec.parse(text);
      if (!parsed.ok) {
        warnings.push(
          `Invalid ${spec.name} (${describe(text)}); expected ${parsed.expectation}; ignoring this environment override.`,
        );
        continue;
      }
      raw[spec.key] = parsed.value;
    }
  }

  const result = loadConfig(raw);
  return { config: result.config, warnings: [...warnings, ...result.warnings] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
