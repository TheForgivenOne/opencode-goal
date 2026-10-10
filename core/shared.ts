/**
 * Process-wide plugin state (single source of truth across plugin instances).
 *
 * **Why this exists.** The plugin entrypoint can be loaded several times inside
 * one server process. Measured on 2026-10-09: `index.ts` was loaded **5 times**
 * in a single `serve --service` process, with 33 watcher subscriptions for it.
 * Each load re-evaluates the module rather than reusing a cached evaluation, so
 * every module-level `const` is **per instance**, not per process.
 *
 * That breaks the one-loop-per-session invariant (AC-19) in a way that is
 * invisible until a human interacts. The `/goal` command is executed by exactly
 * one instance and starts one loop there. But *every* instance has a watcher, so
 * the next human prompt calls `noteHumanPrompt` in all of them, and each
 * instance that does not already hold a run starts its own loop for the same
 * session. The symptom is two loops fighting: every evaluation runs twice, and
 * two directives are injected back to back with no turn between them.
 *
 * The registries therefore live on `globalThis`, keyed by a namespaced property,
 * so all instances in a process share one loop per session and one scratch
 * evaluator session per goal. Isolation between processes is preserved, which is
 * what matters: the loop itself lives in the server process.
 */

/** Read a process-wide `Map`, creating it on first use. */
export function sharedMap<K, V>(name: string): Map<K, V> {
  const key = `__opencodeGoalShared__${name}`;
  const host = globalThis as unknown as Record<string, unknown>;
  const existing = host[key];
  if (existing instanceof Map) return existing as Map<K, V>;
  const created = new Map<K, V>();
  host[key] = created;
  return created;
}

/**
 * How long one invocation is considered a duplicate of itself, in ms. The observed
 * duplicate arrived ~50 ms after the first; a second is generous and still far
 * shorter than a human can retype a command deliberately.
 */
export const INVOCATION_DEDUPE_MS = 2000;

/**
 * Collapse duplicate invocations of one user action, **process-wide**.
 *
 * Because the entrypoint is loaded several times per server process (see above),
 * the `/goal` command handler is registered several times and a single invocation
 * runs it more than once. A live session shows the cost: `Goal set: inspect` twice,
 * ~50 ms apart, each with its own directive — the second `startGoal` aborts the run
 * the first just started and rewrites the record, resetting `turnsThisRun`. Gating
 * on the run registry does not work: the duplicate calls arrive while the first is
 * still awaiting, and the registry is populated later.
 *
 * Returns `true` when `key` was seen within `windowMs`, recording `key` either way.
 * Callers key on the invocation itself (session + raw command text), so a different
 * argument is never suppressed: `/goal a` followed by `/goal b` still ends up as `b`.
 * `now` is injectable so the window is testable without sleeping.
 */
export function isDuplicateInvocation(
  key: string,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const seen = sharedMap<string, number>("invocations");
  // Prune on every call, so the map is bounded by the live window rather than by how
  // many distinct commands have been issued. An entry older than the window is gone
  // before the lookup, which is exactly the "outside the window" case.
  for (const [candidate, at] of seen) {
    if (now - at > windowMs) seen.delete(candidate);
  }
  const previous = seen.get(key);
  seen.set(key, now);
  return previous !== undefined;
}

/**
 * Drop this session's invocation records, keeping `keepKey` when given.
 *
 * A time window cannot distinguish "one user action delivered twice" from "the same
 * command issued twice on purpose". The case that matters: `/goal clear` followed
 * quickly by a re-set of the **same** condition would be swallowed, leaving the goal
 * cleared with no output — the very "it just disappears" symptom this guard exists to
 * prevent. Clearing the session's records makes that re-set run. The clearing
 * invocation's own key is kept so a duplicate `clear` is still collapsed, rather than
 * emitting a second "no goal set" line.
 */
export function forgetSessionInvocations(sessionID: string, keepKey?: string): void {
  const seen = sharedMap<string, number>("invocations");
  const prefix = `${sessionID}\u0000`;
  for (const key of [...seen.keys()]) {
    if (key !== keepKey && key.startsWith(prefix)) seen.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Per-session async lock
// ---------------------------------------------------------------------------

/**
 * Serialize session-mutating operations for one session ID, process-wide.
 *
 * **Why this exists.** `startGoal`, `clearGoal`, `noteHumanPrompt`,
 * `stopSessionForNewConversation`, and `onSessionDeleted` all read the goal record,
 * possibly write it, and consult or mutate the run registry. They fire from
 * different events and are async, so two of them can interleave: a `noteHumanPrompt`
 * IIFE can reach its `runs.has` check *before* a concurrent `stopSessionForNewConversation`
 * calls `abortRun` (sync delete). When that happens, `noteHumanPrompt` thinks a run
 * is still in flight and skips the resume; then the stop deletes the run; the user's
 * "human prompt resumes" mental model is silently broken.
 *
 * The lock chains operations on the same `sessionID` so the next one observes the
 * previous one's effects. Failures in one operation do not block the next (a rejected
 * promise is replaced with `Promise.resolve()` before chaining), and the entry is
 * removed when no one is waiting behind us so the map is bounded by active sessions.
 *
 * Operations that only do **sync** state — `noteToolUse`, `notePermissionAsk`,
 * `abortAll` — do not need the lock; it is for read+write+`runs.has` chains.
 */
export async function withSessionLock<T>(
  sessionID: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = sharedMap<string, Promise<unknown>>("goalSessionLocks");
  const previous = locks.get(sessionID) ?? Promise.resolve();
  // Replace any rejection from the previous operation with a clean resolution so the
  // next caller can run; the original error already surfaced to the previous caller.
  const safePrevious = previous.catch(() => undefined);
  const result = safePrevious.then(fn);
  locks.set(sessionID, result);
  try {
    return await result;
  } finally {
    if (locks.get(sessionID) === result) locks.delete(sessionID);
  }
}

// ---------------------------------------------------------------------------
// Evaluator model cache (process-wide)
// ---------------------------------------------------------------------------

/** A model reference. The cache is keyed by the joined id for set membership. */
export interface ModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

const modelRefId = (model: ModelRef): string => `${model.providerID}/${model.modelID}`;

/**
 * A process-wide cache of evaluator-model outcomes.
 *
 * The cost-ascending selector puts two unusable models first on this install
 * (`muse-spark-1.2-contributor` and `muse-spark-1.3-contributor`, both `cost 0.2`).
 * Every evaluation paid for them until `mimo-v2.6-flash` (the third candidate) was
 * tried. With a live model that *is* usable, the right move is to remember it: try
 * `lastGood` first, demote models we have *seen* fail to the back, and only fall
 * through to the cost-ordered list when nothing else is available.
 *
 * The cache is **process-wide** because the failure mode is model-specific, not
 * session-specific: a model that failed for session A will fail the same way for
 * session B. A misclassification is recoverable — `noteModelSuccess` clears the
 * unusable flag.
 */
const lastGoodModelStore = sharedMap<string, ModelRef | null>("goalLastGoodModel");
const knownUnusableStore = sharedMap<string, Map<string, true>>("goalKnownUnusable");

/** Record that `model` answered an evaluation successfully. */
export function noteModelSuccess(model: ModelRef): void {
  lastGoodModelStore.set("model", { providerID: model.providerID, modelID: model.modelID });
  const set = knownUnusableStore.get("set");
  if (set !== undefined && set.delete(modelRefId(model))) {
    knownUnusableStore.set("set", set);
  }
}

/** Record that `model` failed with an *unusable* error (retired, free-tier, opt-in, …). */
export function noteModelUnusable(model: ModelRef): void {
  const set = knownUnusableStore.get("set") ?? new Map<string, true>();
  set.set(modelRefId(model), true);
  knownUnusableStore.set("set", set);
}

/** The most recent model that answered an evaluation, or `null` if none yet. */
export function getLastGoodModel(): ModelRef | null {
  return lastGoodModelStore.get("model") ?? null;
}

/** True if `model` is in the process-wide known-unusable set. */
export function isKnownUnusable(model: ModelRef): boolean {
  return knownUnusableStore.get("set")?.has(modelRefId(model)) ?? false;
}

/**
 * Drop the model cache. Tests use it; a config knob could too (e.g. after the user
 * fixes a model setting). Clearing the cache forces the selector back to the
 * cost-ordered list.
 */
export function clearModelCache(): void {
  lastGoodModelStore.delete("model");
  knownUnusableStore.delete("set");
}
