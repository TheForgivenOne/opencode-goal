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
