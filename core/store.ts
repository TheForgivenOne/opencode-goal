/**
 * Storage adapter for the persisted goal record (spec §5.1, §5.2).
 *
 * `ctx.storage` is exactly `get` / `set` / `remove` / `scan` over `Schema.Json`
 * (`StorageDomain`; contracts file §5, spec §5.1). This module hides that API
 * behind four operations and owns the key scheme:
 *
 *   key = `goal:v1:<sessionID>` -> a JSON string of `GoalRecord`
 *
 * Decode failures never throw. `readGoal`/`scanGoals` route the raw value
 * through `core/record.ts`'s `decode`, which returns *no record plus a warning*
 * and rejects out-of-domain counters (spec §5.1).
 *
 * Terminal-record expiry on `session.deleted` (spec §5.3, T-9) belongs to the
 * event-watcher phase, not here.
 *
 * `ctx` is a parameter — no global is imported — so the module is exercisable
 * with a fake storage domain.
 */

import type { Plugin } from "@opencode/plugin";
import { decode, encode, type GoalRecord } from "./record";

/** The exact `ctx.storage` surface (derived from the shipped plugin Context). */
export type GoalStorage = Plugin.Context["storage"];

/** The only slice of the plugin context this module needs. */
export interface StorageContext {
  readonly storage: GoalStorage;
}

/** Version segment: a future schema can land under `goal:v2:` with migrate-on-read. */
export const GOAL_KEY_PREFIX = "goal:v1:";

/** The storage key for one session's record. */
export function goalKey(sessionID: string): string {
  return `${GOAL_KEY_PREFIX}${sessionID}`;
}

export interface ReadGoalResult {
  /** The decoded record, or `null` when absent or undecodable. */
  record: GoalRecord | null;
  /** Present only when a stored value existed but could not be decoded. */
  warning?: string;
}

/**
 * Read one session's goal record. Absence returns `{ record: null }` with no
 * warning; a present-but-malformed value returns `{ record: null, warning }`,
 * never a throw (spec §5.1).
 */
export async function readGoal(
  sessionID: string,
  ctx: StorageContext,
): Promise<ReadGoalResult> {
  const raw = await ctx.storage.get(goalKey(sessionID));
  return decodeStoredValue(sessionID, raw);
}

/** Write one session's goal record as a JSON string. */
export async function writeGoal(
  sessionID: string,
  record: GoalRecord,
  ctx: StorageContext,
): Promise<void> {
  await ctx.storage.set(goalKey(sessionID), encode(record));
}

/** Delete one session's goal record (clear, or `session.deleted`). */
export async function deleteGoal(
  sessionID: string,
  ctx: StorageContext,
): Promise<void> {
  await ctx.storage.remove(goalKey(sessionID));
}

export interface ScannedGoal {
  readonly sessionID: string;
  readonly record: GoalRecord;
}

export interface ScanGoalsResult {
  readonly goals: ScannedGoal[];
  /** One warning per present-but-undecodable entry, in scan order. */
  readonly warnings: string[];
}

/**
 * Enumerate every goal record in plugin storage. Undecodable entries are
 * skipped with a warning rather than aborting the scan (spec §5.1).
 */
export async function scanGoals(ctx: StorageContext): Promise<ScanGoalsResult> {
  const goals: ScannedGoal[] = [];
  const warnings: string[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  do {
    const page = await ctx.storage.scan(
      after === undefined
        ? { prefix: GOAL_KEY_PREFIX }
        : { prefix: GOAL_KEY_PREFIX, after },
    );

    for (const entry of page.entries) {
      const sessionID = entry.key.slice(GOAL_KEY_PREFIX.length);
      const result = decodeStoredValue(sessionID, entry.value);
      if (result.warning !== undefined) warnings.push(result.warning);
      if (result.record !== null) goals.push({ sessionID, record: result.record });
    }

    // Guard against a storage cursor that does not advance (would loop forever).
    const next = page.next;
    if (next === undefined || seenCursors.has(next)) break;
    seenCursors.add(next);
    after = next;
  } while (true);

  return { goals, warnings };
}

/**
 * Shared decode path for a single stored value. `undefined` is absence; any
 * non-string `Schema.Json` value is a decode failure (we only ever write
 * strings), and a string is handed to `record.decode`.
 */
function decodeStoredValue(
  sessionID: string,
  raw: unknown,
): ReadGoalResult {
  if (raw === undefined) return { record: null };
  if (typeof raw !== "string") {
    return {
      record: null,
      warning: `Failed to decode goal record for ${sessionID}: stored value is not a JSON string.`,
    };
  }
  return decode(raw);
}
