/**
 * Tests for the loop's storage-mutating entry points.
 *
 * `stopSessionForNewConversation` is the AC-13 path. Before 2026-10-10 it called
 * `clearGoal`, which DELETED the record — so a goal vanished with no notice whenever
 * a session was created. The first test here is that regression.
 */

import { describe, expect, it } from "bun:test";
import {
  antiSpinWarning,
  busySessionWarning,
  capWarning,
  evaluationFailureWarning,
  hasActiveRun,
  KILL_SENTINEL_WARNING,
  newConversationWarning,
  permissiveRefusalWarning,
  permissiveWarning,
  stopSessionForNewConversation,
  waitForTurnEnd,
} from "../loop";
import { createGoal, encode } from "../record";
import { goalKey } from "../store";

/** Minimal faithful ctx + storage, matching store.test.ts. */
function fakeDeps(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed));
  const synthetics: string[] = [];
  const deps = {
    ctx: {
      storage: {
        get: async (key: string) => map.get(key) as never,
        set: async (key: string, value: never) => {
          map.set(key, value);
        },
        remove: async (key: string) => {
          map.delete(key);
        },
        scan: async (options: { prefix: string }) => ({
          entries: [...map.keys()]
            .filter((k) => k.startsWith(options.prefix))
            .sort()
            .map((key) => ({ key, value: map.get(key) as never })),
        }),
      },
      session: {
        synthetic: async ({ text }: { text: string }) => {
          synthetics.push(text);
        },
      },
    },
    rootDir: "/tmp/opencode/goal-test-root",
  };
  return { deps: deps as never, map, synthetics };
}

describe("stopSessionForNewConversation (AC-13)", () => {
  it("stops the loop but KEEPS the goal — a new conversation must not delete it", async () => {
    const S = "ses_regression";
    const { deps, map, synthetics } = fakeDeps({ [goalKey(S)]: encode(createGoal("keep going")) });

    await stopSessionForNewConversation(S, deps);

    const raw = map.get(goalKey(S)) as string | undefined;
    expect(raw).toBeDefined(); // the regression: this used to be gone
    expect(JSON.parse(raw as string).state).toBe("active"); // set and dormant, not cleared
    expect(hasActiveRun(S)).toBe(false); // and no loop left running
    expect(synthetics.join("\n")).toContain("remains set");
  });

  it("announces the pause with the shared message text", async () => {
    const S = "ses_notice";
    const { deps, synthetics } = fakeDeps({ [goalKey(S)]: encode(createGoal("c")) });
    await stopSessionForNewConversation(S, deps);
    expect(synthetics).toEqual([`Goal warning: ${newConversationWarning()}`]);
  });

  it("stays silent when there is no goal", async () => {
    const { deps, synthetics } = fakeDeps();
    await stopSessionForNewConversation("ses_none", deps);
    expect(synthetics).toEqual([]);
  });

  it("does not resurrect or rewrite an already-resolved goal", async () => {
    const S = "ses_done";
    const record = { ...createGoal("c"), state: "achieved" as const, endedAt: 1 };
    const { deps, map, synthetics } = fakeDeps({ [goalKey(S)]: encode(record) });
    await stopSessionForNewConversation(S, deps);
    expect(JSON.parse(map.get(goalKey(S)) as string)).toEqual(record);
    expect(synthetics).toEqual([]);
  });
});

/**
 * §4.2 turn-end wait.
 *
 * `ctx.session.wait` resolves at **global** loop idle, not at the end of the loop's
 * own turn. While the loop drives the session that is correct; the moment a human
 * works in the same session it is wrong, because the session never goes idle — a
 * live session shows the loop blocked there for 12+ minutes with `turnsEvaluated`
 * and `tokensSpent` both stuck at 0. `wait` takes `RequestOptions.signal`, so the
 * wait is capped and a run abort cancels it.
 */
describe("waitForTurnEnd (§4.2)", () => {
  /** A `wait` that honours the abort signal the way the real (fetch-backed) one does. */
  function signalAwareWait() {
    const seen: { signal?: AbortSignal } = {};
    const wait = (_input: unknown, options?: { signal?: AbortSignal }): Promise<void> => {
      seen.signal = options?.signal;
      return new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("AbortError")), {
          once: true,
        });
      });
    };
    return { wait, seen };
  }

  function waitDeps(wait: (input: unknown, options?: { signal?: AbortSignal }) => Promise<void>) {
    return { ctx: { session: { wait } }, rootDir: "/tmp/opencode/goal-test-root" } as never;
  }

  it("returns idle when the session does go idle", async () => {
    const deps = waitDeps(async () => {});
    expect(await waitForTurnEnd(deps, "ses_idle", new AbortController().signal, 1000)).toBe("idle");
  });

  it("caps the wait: a session that never goes idle returns timeout rather than hanging", async () => {
    const { wait, seen } = signalAwareWait();
    const started = Date.now();
    const outcome = await waitForTurnEnd(waitDeps(wait), "ses_busy", new AbortController().signal, 40);
    expect(outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000); // bounded, not wedged
    expect(seen.signal?.aborted).toBe(true); // and the in-flight request was cancelled
  });

  it("returns aborted when the run is aborted mid-wait, so /goal clear takes effect", async () => {
    const { wait } = signalAwareWait();
    const run = new AbortController();
    const pending = waitForTurnEnd(waitDeps(wait), "ses_abort", run.signal, 60_000);
    run.abort();
    expect(await pending).toBe("aborted");
  });

  it("turnWaitMaxMs 0 restores the unbounded wait", async () => {
    const deps = waitDeps(async () => {});
    expect(await waitForTurnEnd(deps, "ses_unbounded", new AbortController().signal, 0)).toBe("idle");
  });

  it("a genuine wait error still propagates, so the E8 failure path handles it", async () => {
    const deps = waitDeps(async () => {
      throw new Error("transport down");
    });
    await expect(
      waitForTurnEnd(deps, "ses_err", new AbortController().signal, 1000),
    ).rejects.toThrow("transport down");
  });
});

/**
 * `warn()` prepends `Goal warning: ` to whatever a builder returns, so a builder
 * that returns it too produces `Goal warning: Goal warning: …`. Observed live on
 * 2026-10-10 for the busy-session warning; the permissive warning had carried the
 * same defect since it was written.
 */
describe("warning builders return the reason only — warn() adds the prefix", () => {
  const builders: Array<[string, string]> = [
    ["KILL_SENTINEL_WARNING", KILL_SENTINEL_WARNING],
    ["capWarning", capWarning(50)],
    ["antiSpinWarning", antiSpinWarning(10)],
    ["newConversationWarning", newConversationWarning()],
    ["busySessionWarning", busySessionWarning(120_000)],
    ["permissiveWarning", permissiveWarning()],
    ["permissiveRefusalWarning", permissiveRefusalWarning()],
    ["evaluationFailureWarning", evaluationFailureWarning(new Error("x"))],
  ];

  it("none of them repeats the prefix", () => {
    const offenders = builders
      .filter(([, text]) => text.startsWith("Goal warning: "))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("the busy warning names the cap and the key to change it", () => {
    expect(busySessionWarning(120_000)).toContain("120s");
    expect(busySessionWarning(120_000)).toContain("turnWaitMaxMs");
  });
});
