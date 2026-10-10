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
  noteHumanPrompt,
  permissiveRefusalWarning,
  permissiveWarning,
  resumeGoal,
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
        // Never settles, so a run started in a test stays live: the loop parks here.
        wait: () => new Promise<void>(() => {}),
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
    resumeGoal(S, "attach", deps);
    expect(hasActiveRun(S)).toBe(true);

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
    resumeGoal(S, "attach", deps);
    await stopSessionForNewConversation(S, deps);
    expect(synthetics).toEqual([`Goal warning: ${newConversationWarning()}`]);
  });

  // The watchers are registered once per plugin load, so one `session.created` reaches
  // this several times. Live: SEVEN identical notices. Only the call that actually
  // stopped a loop may announce it.
  it("announces the pause ONCE, not once per plugin load", async () => {
    const S = "ses_dup_notice";
    const { deps, synthetics } = fakeDeps({ [goalKey(S)]: encode(createGoal("c")) });
    resumeGoal(S, "attach", deps);
    await Promise.all(
      Array.from({ length: 7 }, () => stopSessionForNewConversation(S, deps)),
    );
    expect(synthetics.filter((text) => text.includes("a new conversation started"))).toHaveLength(1);
  });

  it("does not re-announce a goal that was already dormant", async () => {
    const S = "ses_already_paused";
    const { deps, synthetics } = fakeDeps({ [goalKey(S)]: encode(createGoal("c")) });
    // No run started: the goal is set but dormant, so its pause was already reported.
    await stopSessionForNewConversation(S, deps);
    expect(synthetics).toEqual([]);
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
 * R2: the per-session lock prevents a concurrent `noteHumanPrompt` and
 * `stopSessionForNewConversation` from interleaving so a real human-prompt resume
 * is silently dropped.
 *
 * Without the lock, `noteHumanPrompt`'s IIFE can reach its `runs.has` check
 * *before* the stop's sync `abortRun` runs, see a run is still in flight, skip
 * the resume, and the stop then deletes the run — leaving the goal paused with
 * no loop. The fix wraps both bodies in `withSessionLock`, so they serialise and
 * the second one always observes the first's effects.
 */
describe("concurrent stopSessionForNewConversation + noteHumanPrompt (R2)", () => {
  it("the resume is never lost: the post-state is consistent", async () => {
    const S = "ses_race";
    const { deps, map, synthetics } = fakeDeps({
      [goalKey(S)]: encode({ ...createGoal("keep going"), consecutiveNoToolTurns: 3, turnsThisRun: 4 }),
    });
    resumeGoal(S, "attach", deps);
    expect(hasActiveRun(S)).toBe(true);

    // Fire both at once. With the lock, one wins fully before the other starts.
    await Promise.all([stopSessionForNewConversation(S, deps), noteHumanPrompt(S, deps)]);

    // Whichever order: the record is still active, the resume counters are
    // either reset (note won) or not (stop won), and exactly one announcement
    // fired.
    const record = JSON.parse(map.get(goalKey(S)) as string);
    expect(record.state).toBe("active");
    const notices = synthetics.filter((text) => text.includes("a new conversation started"));
    expect(notices.length).toBeLessThanOrEqual(1);
    // If note won, the run is alive and the counters are reset. If stop won, the
    // run is gone. Both states are consistent with the contract.
    if (record.consecutiveNoToolTurns === 0 && record.turnsThisRun === 0) {
      expect(hasActiveRun(S)).toBe(true);
      expect(notices).toHaveLength(0);
    } else {
      expect(hasActiveRun(S)).toBe(false);
      expect(notices).toHaveLength(1);
    }
  });
});

/**
 * O1: duplicate fires of the same human prompt are deduped, so the I/O cost is
 * one read + one persist regardless of how many watcher instances fire.
 * (Watchers are registered once per plugin load — 5× in this runtime — so a
 * single user action reaches `noteHumanPrompt` several times.)
 */
describe("noteHumanPrompt in-flight dedupe (O1)", () => {
  it("five duplicate fires do one read+persist, not five", async () => {
    const S = "ses_dup";
    const { deps, map } = fakeDeps({ [goalKey(S)]: encode(createGoal("c")) });
    const writes: string[] = [];
    const realSet = map.set.bind(map);
    map.set = ((key: string, value: unknown) => {
      writes.push(key);
      return realSet(key, value);
    }) as typeof map.set;
    // No run: the in-flight IIFE's `if (!runs.has) resumeGoal` would try to
    // start one. We want to test the dedupe, not the resume — so we stub the
    // resume path by NOT starting a run and accepting the writes that follow.
    for (let i = 0; i < 5; i++) noteHumanPrompt(S, deps);
    // Wait for the in-flight to settle.
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Exactly one write to the goal key — the duplicate fires were dropped.
    expect(writes.filter((key) => key === goalKey(S))).toHaveLength(1);
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
        // `fetch` rejects at once when handed a signal that is already aborted.
        if (options?.signal?.aborted === true) {
          reject(new Error("AbortError"));
          return;
        }
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

  // Review finding D2: the unbounded branch used to call `wait` with no signal at all,
  // so a run abort was not merely late — it was unobservable.
  it("turnWaitMaxMs 0 is still wired to the run abort", async () => {
    const { wait, seen } = signalAwareWait();
    const run = new AbortController();
    const pending = waitForTurnEnd(waitDeps(wait), "ses_unbounded_abort", run.signal, 0);
    run.abort();
    expect(await pending).toBe("aborted");
    expect(seen.signal).toBeDefined();
  });

  // Review finding D3: `addEventListener` on an already-aborted signal never fires.
  it("honours a run abort that landed before the wait started", async () => {
    const { wait, seen } = signalAwareWait();
    const run = new AbortController();
    run.abort();
    expect(await waitForTurnEnd(waitDeps(wait), "ses_pre_aborted", run.signal, 60_000)).toBe(
      "aborted",
    );
    expect(seen.signal?.aborted).toBe(true);
  });

  // Review finding D4: `waited` was built before the `try`, so a synchronous throw
  // skipped the `finally` and leaked the timer and the abort listener.
  it("does not leak the abort listener when wait throws synchronously", async () => {
    let added = 0;
    let removed = 0;
    const fake = {
      aborted: false,
      addEventListener: () => {
        added += 1;
      },
      removeEventListener: () => {
        removed += 1;
      },
    } as unknown as AbortSignal;
    const deps = waitDeps(() => {
      throw new Error("sync boom");
    });
    await expect(waitForTurnEnd(deps, "ses_sync", fake, 1000)).rejects.toThrow("sync boom");
    expect(added).toBe(1);
    expect(removed).toBe(1);
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
