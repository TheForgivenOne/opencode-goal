/**
 * Pure `GoalRecord` data model: encode / decode and the lifecycle transitions
 * for the three verdicts plus clear.
 *
 * Contract: spec §5.1, §5.2, §5.3; acceptance-criteria verdict table.
 *
 * No I/O, no `@opencode/*` imports. A decode failure never throws — it returns
 * *no record* plus a warning (spec §5.1).
 */

export type GoalState = "active" | "achieved" | "failed";

export type VerdictKind = "not-yet-met" | "met" | "impossible";

export interface GoalRecord {
  /** Verbatim condition (outer whitespace already trimmed by the parser). */
  condition: string;
  state: GoalState;
  /** Epoch ms, set on set. */
  setAt: number;
  /** Epoch ms; present only after `met` / `impossible`. */
  endedAt?: number;
  /** Incremented on each evaluation. */
  turnsEvaluated: number;
  /** Working-turn tokens only; evaluator tokens live in a separate session. */
  tokensSpent: number;
  /** Set on each evaluation. */
  lastVerdict?: VerdictKind;
  /** Set on each evaluation. */
  lastReason: string;
  /** Per evaluated turn (AC-30 / AC-31). */
  consecutiveNoToolTurns: number;
  /** Incremented per loop-started turn (AC-34). */
  turnsThisRun: number;
}

/** The evaluator's decision, as consumed by {@link applyVerdict}. */
export interface Verdict {
  kind: VerdictKind;
  reason: string;
  /** Working-turn tokens to add to `tokensSpent` for this evaluated turn. */
  tokensSpentDelta?: number;
  /** Whether the turn executed at least one tool (AC-30 / AC-31). */
  toolUsedThisTurn?: boolean;
  /** Epoch ms to record as `endedAt` on terminal verdicts; defaults to now. */
  now?: number;
}

export interface DecodeResult {
  record: GoalRecord | null;
  /** Present only when the raw value existed but could not be decoded. */
  warning?: string;
}

const GOAL_STATES: readonly GoalState[] = ["active", "achieved", "failed"];
const VERDICT_KINDS: readonly VerdictKind[] = ["not-yet-met", "met", "impossible"];

function isGoalState(value: unknown): value is GoalState {
  return typeof value === "string" && (GOAL_STATES as readonly string[]).includes(value);
}

function isVerdictKind(value: unknown): value is VerdictKind {
  return typeof value === "string" && (VERDICT_KINDS as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Spec §5.1: the decoder is the validation boundary and enforces field domains.
 * The four evaluation counters must be non-negative integers; negatives,
 * fractional values, `NaN` and `Infinity` are all rejected.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/** Lifecycle "on set": a fresh active record with zeroed counters. */
export function createGoal(condition: string, now: number = Date.now()): GoalRecord {
  return {
    condition,
    state: "active",
    setAt: now,
    turnsEvaluated: 0,
    tokensSpent: 0,
    lastReason: "",
    consecutiveNoToolTurns: 0,
    turnsThisRun: 0,
  };
}

/** Spec §5.2: one record serialised as JSON. */
export function encode(record: GoalRecord): string {
  return JSON.stringify(record);
}

/**
 * Spec §5.1: `JSON.parse`, and on any failure return *no record* plus a warning
 * — never throw. A missing value (`null` / `undefined`) is absence, not a
 * decode failure, so it returns no record and no warning.
 */
export function decode(raw: string | null | undefined): DecodeResult {
  if (raw === null || raw === undefined) return { record: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { record: null, warning: `Failed to decode goal record: ${describeError(err)}` };
  }

  if (!isGoalRecord(parsed)) {
    return { record: null, warning: "Failed to decode goal record: value is not a goal record" };
  }

  return { record: parsed };
}

function isGoalRecord(value: unknown): value is GoalRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.condition === "string" &&
    isGoalState(r.state) &&
    isFiniteNumber(r.setAt) &&
    (r.endedAt === undefined || isFiniteNumber(r.endedAt)) &&
    isNonNegativeInteger(r.turnsEvaluated) &&
    isNonNegativeInteger(r.tokensSpent) &&
    (r.lastVerdict === undefined || isVerdictKind(r.lastVerdict)) &&
    typeof r.lastReason === "string" &&
    isNonNegativeInteger(r.consecutiveNoToolTurns) &&
    isNonNegativeInteger(r.turnsThisRun)
  );
}

/** Spec §5.3. A record is active only while `state === "active"`. */
export function isActive(record: GoalRecord | null | undefined): boolean {
  return record !== null && record !== undefined && record.state === "active";
}

/**
 * Spec §5.3 / criteria verdict table. Pure: returns a new record, never mutates.
 *
 * - `not-yet-met`: record stays `active`; `turnsEvaluated` and the counters move.
 * - `met`:          `state = "achieved"`, `endedAt = now`; counters frozen after.
 * - `impossible`:   `state = "failed"`,   `endedAt = now`; counters frozen after.
 *
 * `turnsEvaluated` is incremented on every evaluation, per the criteria field
 * table ("incremented on each evaluation").
 */
export function applyVerdict(record: GoalRecord, verdict: Verdict): GoalRecord {
  const next: GoalRecord = {
    ...record,
    lastVerdict: verdict.kind,
    lastReason: verdict.reason,
    turnsEvaluated: record.turnsEvaluated + 1,
    tokensSpent: record.tokensSpent + (verdict.tokensSpentDelta ?? 0),
    consecutiveNoToolTurns: verdict.toolUsedThisTurn
      ? 0
      : record.consecutiveNoToolTurns + 1,
  };

  if (verdict.kind === "not-yet-met") return next;

  return {
    ...next,
    state: verdict.kind === "met" ? "achieved" : "failed",
    endedAt: verdict.now ?? Date.now(),
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
