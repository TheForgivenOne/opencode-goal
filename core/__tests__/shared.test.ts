/**
 * Tests for `core/shared.ts` — the cross-instance state registry.
 *
 * The behaviour these protect was measured live, not invented: the plugin
 * entrypoint was loaded 5 times in a single server process with 33 watcher
 * subscriptions for it, and because each load re-evaluates the module, the
 * per-instance `runs` map let a human prompt start a second loop for a session
 * (every evaluation doubled, two directives injected with no turn between them).
 */
import { describe, expect, test } from "bun:test";
import {
  clearModelCache,
  forgetSessionInvocations,
  getLastGoodModel,
  isDuplicateInvocation,
  isKnownUnusable,
  noteModelSuccess,
  noteModelUnusable,
  sharedMap,
  withSessionLock,
} from "../shared";

const host = globalThis as unknown as Record<string, unknown>;

describe("sharedMap", () => {
  test("returns the same map for the same name, so two instances share it", () => {
    const first = sharedMap<string, number>("regression-same");
    const second = sharedMap<string, number>("regression-same");
    expect(second).toBe(first);
  });

  test("state written through one lookup is visible through the next", () => {
    sharedMap<string, number>("regression-visible").set("k", 7);
    expect(sharedMap<string, number>("regression-visible").get("k")).toBe(7);
  });

  test("the registry lives on globalThis, which is what makes it process-wide", () => {
    const map = sharedMap<string, number>("regression-host");
    expect(host["__opencodeGoalShared__regression-host"]).toBe(map);
  });

  test("different names are isolated", () => {
    expect(sharedMap("regression-a")).not.toBe(sharedMap("regression-b"));
  });

  test("a map left on globalThis is reused rather than replaced", () => {
    const name = "regression-reuse";
    const seeded = new Map<string, string>([["seeded", "yes"]]);
    host[`__opencodeGoalShared__${name}`] = seeded;
    expect(sharedMap<string, string>(name)).toBe(seeded);
    expect(sharedMap<string, string>(name).get("seeded")).toBe("yes");
  });

  test("a non-map value on globalThis is replaced, not trusted", () => {
    const name = "regression-junk";
    host[`__opencodeGoalShared__${name}`] = "not-a-map";
    const map = sharedMap<string, string>(name);
    expect(map).toBeInstanceOf(Map);
    expect(host[`__opencodeGoalShared__${name}`]).toBe(map);
  });
});

/**
 * The `/goal` command handler is registered once per plugin load, so a single
 * invocation runs it several times. A live session shows the cost: `Goal set:
 * inspect` twice, ~50 ms apart, each with its own directive.
 */
describe("isDuplicateInvocation", () => {
  test("first sight is not a duplicate; the immediate repeat is", () => {
    expect(isDuplicateInvocation("dedupe-basic", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-basic", 2000, 1050)).toBe(true); // ~50 ms, as observed
  });

  test("outside the window is a fresh invocation again", () => {
    expect(isDuplicateInvocation("dedupe-window", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-window", 2000, 3001)).toBe(false);
  });

  test("the window is inclusive at its boundary", () => {
    expect(isDuplicateInvocation("dedupe-boundary", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-boundary", 2000, 3000)).toBe(true);
  });

  test("a different key is never suppressed, so `/goal a` then `/goal b` applies b", () => {
    expect(isDuplicateInvocation("dedupe-ses\u0000/goal a", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-ses\u0000/goal b", 2000, 1010)).toBe(false);
  });

  test("state is process-wide, so a second plugin load sees the first's record", () => {
    const key = "dedupe-cross-instance";
    expect(isDuplicateInvocation(key, 2000, 1000)).toBe(false);
    expect(sharedMap<string, number>("invocations").has(key)).toBe(true);
    expect(isDuplicateInvocation(key, 2000, 1010)).toBe(true);
  });

  test("stale records are pruned on every call, not only once the map grows", () => {
    const seen = sharedMap<string, number>("invocations");
    isDuplicateInvocation("dedupe-prune-a", 1000, 1000);
    expect(seen.has("dedupe-prune-a")).toBe(true);
    isDuplicateInvocation("dedupe-prune-b", 1000, 2500); // the first is now outside the window
    expect(seen.has("dedupe-prune-a")).toBe(false);
  });

  // Review finding D1, demonstrated: the window cannot tell "one action delivered
  // twice" from "the same command issued twice on purpose", so `/goal clear` then a
  // re-set of the same condition was swallowed — the goal stayed cleared and the user
  // saw nothing, which is the reported "it just disappears" symptom.
  test("a clear can be followed immediately by a re-set of the same condition", () => {
    const S = "dedupe-clear";
    const setKey = `${S}\u0000/goal write the report`;
    const clearKey = `${S}\u0000/goal clear`;
    expect(isDuplicateInvocation(setKey, 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation(clearKey, 2000, 1200)).toBe(false);
    forgetSessionInvocations(S, clearKey);
    expect(isDuplicateInvocation(setKey, 2000, 1500)).toBe(false); // the re-set runs
  });

  test("a duplicate clear is still collapsed, so it prints one line rather than two", () => {
    const S = "dedupe-clear-dup";
    const clearKey = `${S}\u0000/goal clear`;
    expect(isDuplicateInvocation(clearKey, 2000, 1000)).toBe(false);
    forgetSessionInvocations(S, clearKey); // keeps the clearing invocation's own key
    expect(isDuplicateInvocation(clearKey, 2000, 1050)).toBe(true);
  });

  test("forgetSessionInvocations leaves another session's records alone", () => {
    expect(isDuplicateInvocation("dedupe-a\u0000/goal x", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-b\u0000/goal x", 2000, 1000)).toBe(false);
    forgetSessionInvocations("dedupe-a");
    expect(isDuplicateInvocation("dedupe-b\u0000/goal x", 2000, 1010)).toBe(true);
  });
});

/**
 * Per-session async lock. The session-mutating entry points (`startGoal`,
 * `clearGoal`, `noteHumanPrompt`, `stopSessionForNewConversation`,
 * `onSessionDeleted`) wrap their bodies in `withSessionLock`, so a concurrent
 * `noteHumanPrompt` and `stopSessionForNewConversation` observe each other's
 * effects. The bug this closes: `noteHumanPrompt`'s IIFE reached its `runs.has`
 * check *before* a concurrent stop's `abortRun` (sync delete) ran, so the resume
 * was skipped and the goal was left paused with no loop running (R2 in the
 * 2026-10-10 review).
 */
describe("withSessionLock", () => {
  test("runs the body and returns its value", async () => {
    const out = await withSessionLock("ses_basic", async () => 42);
    expect(out).toBe(42);
  });

  test("serialises two operations on the same session id", async () => {
    const order: string[] = [];
    const op = async (id: string, delay: number): Promise<void> => {
      await withSessionLock("ses_order", async () => {
        order.push(`${id}:start`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(`${id}:end`);
      });
    };
    await Promise.all([op("a", 30), op("b", 0)]);
    // The lock is FIFO, so the slower one starts first.
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("isolation: different session ids run in parallel", async () => {
    const order: string[] = [];
    const op = (id: string, delay: number): Promise<void> =>
      withSessionLock(id, async () => {
        order.push(`${id}:start`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(`${id}:end`);
      });
    await Promise.all([op("ses_x", 30), op("ses_y", 0)]);
    // No order across sessions — they are independent.
    expect(order).toContain("ses_x:start");
    expect(order).toContain("ses_y:start");
    expect(order.filter((entry) => entry.endsWith(":end"))).toHaveLength(2);
  });

  // A rejection in one operation must not block the next caller. The error
  // already surfaced to the original caller; the lock just makes the chain
  // available again.
  test("a rejection does not block the next caller", async () => {
    await expect(
      withSessionLock("ses_rej", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const out = await withSessionLock("ses_rej", async () => "ok");
    expect(out).toBe("ok");
  });

  test("the lock entry is removed once the chain is empty", async () => {
    await withSessionLock("ses_cleanup", async () => undefined);
    const locks = sharedMap<string, Promise<unknown>>("goalSessionLocks");
    expect(locks.has("ses_cleanup")).toBe(false);
  });
});

/**
 * Process-wide evaluator model cache. The cost-ascending selector puts two
 * unusable models first on this install; without a cache, every evaluation pays
 * for them. `lastGood` short-circuits the next one; `knownUnusable` demotes
 * models we have already seen fail.
 */
describe("evaluator model cache", () => {
  test("starts empty: no last good, nothing known unusable", () => {
    clearModelCache();
    expect(getLastGoodModel()).toBeNull();
    expect(isKnownUnusable({ providerID: "p", modelID: "m" })).toBe(false);
  });

  test("noteModelSuccess records the model and clears any unusable flag", () => {
    clearModelCache();
    const m = { providerID: "p", modelID: "m" };
    noteModelUnusable(m);
    expect(isKnownUnusable(m)).toBe(true);
    noteModelSuccess(m);
    expect(getLastGoodModel()).toEqual(m);
    expect(isKnownUnusable(m)).toBe(false);
  });

  test("noteModelSuccess overwrites a previous last good", () => {
    clearModelCache();
    noteModelSuccess({ providerID: "p", modelID: "a" });
    noteModelSuccess({ providerID: "p", modelID: "b" });
    expect(getLastGoodModel()).toEqual({ providerID: "p", modelID: "b" });
  });

  test("isKnownUnusable tracks each model independently", () => {
    clearModelCache();
    noteModelUnusable({ providerID: "p", modelID: "a" });
    expect(isKnownUnusable({ providerID: "p", modelID: "a" })).toBe(true);
    expect(isKnownUnusable({ providerID: "p", modelID: "b" })).toBe(false);
  });

  test("the cache is process-wide (visible through a second lookup)", () => {
    clearModelCache();
    noteModelSuccess({ providerID: "p", modelID: "m" });
    expect(getLastGoodModel()).toEqual({ providerID: "p", modelID: "m" });
  });
});
