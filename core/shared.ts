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
  const previous = seen.get(key);
  seen.set(key, now);
  if (seen.size > 64) {
    for (const [candidate, at] of seen) {
      if (now - at > windowMs) seen.delete(candidate);
    }
  }
  return previous !== undefined && now - previous <= windowMs;
}
