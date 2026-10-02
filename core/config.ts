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
}

export const DEFAULT_CONFIG: Readonly<ResolvedConfig> = Object.freeze({
  antiSpinThreshold: 3,
  turnCap: 50,
  evaluatorModel: undefined,
  permissiveModePolicy: "warn",
});

/** Inclusive numeric bounds; outside → default + warning (spec §9, T-3 ceilings). */
export const ANTI_SPIN_MIN = 1;
export const ANTI_SPIN_MAX = 25;
export const TURN_CAP_MIN = 1;
export const TURN_CAP_MAX = 500;

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
