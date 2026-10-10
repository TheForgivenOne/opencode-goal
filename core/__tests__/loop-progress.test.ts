/**
 * §6.3 — the loop must announce **progress**, not only goal set / clear / terminal.
 *
 * The indicator holds no goal truth: it re-reads the status RPC on the `changed`
 * event. Because `changed` was emitted only at goal set, clear and terminal, the
 * counts sat frozen at "turn 0, 0 tokens" for an entire run — the live report that
 * prompted this test.
 *
 * This drives ONE real loop iteration (real `driveLoop`, real `evaluate`) against a
 * fake context and watches the notification channel. Deleting the `notify.changed`
 * call after a non-terminal verdict fails it.
 */

import { describe, expect, it } from "bun:test";
import { _getReArmCount, resumeGoal, type GoalLoopDeps, type LoopNotifications } from "../loop";
import { createGoal, encode } from "../record";
import { goalKey } from "../store";

function fakeDeps() {
  const store = new Map<string, unknown>();
  const changed: Array<{ kind: string; sessionID: string }> = [];
  const injected: string[] = [];
  const emitted: string[] = [];

  const ctx = {
    location: { directory: "/tmp/opencode/loop-progress-root" },
    storage: {
      get: async (key: string) => store.get(key) as never,
      set: async (key: string, value: never) => {
        store.set(key, value);
      },
      remove: async (key: string) => {
        store.delete(key);
      },
      scan: async (options: { prefix: string }) => ({
        entries: [...store.keys()]
          .filter((key) => key.startsWith(options.prefix))
          .sort()
          .map((key) => ({ key, value: store.get(key) as never })),
      }),
    },
    model: {
      list: async () => ({
        location: {},
        data: [
          {
            providerID: "acme",
            modelID: "judge",
            enabled: true,
            status: "stable",
            capabilities: { output: ["text"] },
            cost: [{ output: 5 }],
          },
        ],
      }),
    },
    session: {
      get: async () => ({
        model: { providerID: "acme", id: "worker" },
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      context: async () => [
        { type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "hi" }] },
      ],
      create: async () => ({ id: "ses_scratch" }),
      generate: async () => ({ text: "NOT YET MET: nothing has happened yet." }),
      wait: async () => {},
      synthetic: async () => {},
      prompt: async () => {},
      remove: async () => {},
    },
  };

  const notify: LoopNotifications = {
    changed: (payload) => {
      changed.push({ kind: String(payload.kind), sessionID: String(payload.sessionID) });
    },
  };

  const deps = {
    ctx,
    rootDir: "/tmp/opencode/loop-progress-root",
    // Anti-spin stops the loop after this first no-tool turn, so the test ends.
    pluginOptions: { antiSpinThreshold: 1 },
    notify,
    injectDirective: async (sessionID: string, text: string) => {
      injected.push(`${sessionID}:${text}`);
    },
    emitSynthetic: async (sessionID: string, text: string) => {
      emitted.push(`${sessionID}:${text}`);
    },
  } as unknown as GoalLoopDeps;

  return { deps, changed, injected, emitted };
}

/** Wait for the background loop to produce a notification (or give up). */
async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("loop progress notifications (§6.3)", () => {
  it("emits `changed` after a NON-terminal verdict, so the indicator updates", async () => {
    const S = "ses_progress";
    const { deps, changed, injected } = fakeDeps();
    const record = { ...createGoal("keep going"), turnsThisRun: 0 };
    await deps.ctx.storage.set(goalKey(S), encode(record) as never);

    resumeGoal(S, "prompt", deps);
    await waitFor(() => changed.length > 0);

    expect(injected).toHaveLength(1); // the loop really started a turn
    expect(changed).toEqual([{ kind: "active", sessionID: S }]);
  });

  it("still emits the terminal notification for a resolved goal", async () => {
    const S = "ses_progress_terminal";
    const { deps, changed } = fakeDeps();
    // A met verdict ends the loop instead of continuing it.
    deps.ctx.session.generate = async () => ({ text: "MET: done." });
    await deps.ctx.storage.set(goalKey(S), encode(createGoal("keep going")) as never);

    resumeGoal(S, "prompt", deps);
    await waitFor(() => changed.some((entry) => entry.kind !== "active"));

    expect(changed.some((entry) => entry.kind === "achieved")).toBe(true);
    // The non-terminal announcement must not fire for a terminal verdict.
    expect(changed.filter((entry) => entry.kind === "active")).toHaveLength(0);
  });
});

/**
 * Auto-resume: an active goal that the loop drops for a *transient* reason
 * re-arms on its own. This drives a real infrastructure failure (the evaluator
 * throws a non-unusable error) and checks the re-arm budget was consumed.
 *
 * Without the fix, `turnsEvaluated` sits still and the user has to send a
 * message to resume — the reported "not logical" behaviour.
 */
describe("auto-resume after an infrastructure failure", () => {
  it("increments the re-arm counter when the evaluator fails for an infra reason", async () => {
    const S = "ses_auto_infra";
    const { deps, emitted } = fakeDeps();
    // A non-unusable error (ECONNRESET-shaped) must NOT be treated as a
    // candidate failure; it propagates to the loop's catch and stops the run.
    deps.ctx.session.generate = async () => {
      throw new Error("ECONNRESET: socket closed");
    };
    await deps.ctx.storage.set(goalKey(S), encode(createGoal("keep going")) as never);

    resumeGoal(S, "prompt", deps);
    // Wait for the loop to stop (the evaluation failure warning is emitted).
    await waitFor(() => emitted.some((line) => line.includes("evaluation failed")));

    // The goal is still active, so the loop scheduled a re-arm.
    expect(_getReArmCount(S)).toBe(1);
  });

  it("does NOT re-arm after a terminal verdict (the goal is resolved)", async () => {
    const S = "ses_auto_terminal";
    const { deps, changed } = fakeDeps();
    deps.ctx.session.generate = async () => ({ text: "MET: done." });
    await deps.ctx.storage.set(goalKey(S), encode(createGoal("keep going")) as never);

    resumeGoal(S, "prompt", deps);
    await waitFor(() => changed.some((entry) => entry.kind === "achieved"));

    expect(_getReArmCount(S)).toBe(0);
  });

  it("does NOT re-arm after a clear (the user chose to stop)", async () => {
    const S = "ses_auto_clear";
    const { deps, emitted } = fakeDeps();
    deps.ctx.session.generate = async () => {
      throw new Error("ECONNRESET: socket closed");
    };
    await deps.ctx.storage.set(goalKey(S), encode(createGoal("keep going")) as never);

    resumeGoal(S, "prompt", deps);
    await waitFor(() => emitted.some((line) => line.includes("evaluation failed")));
    // The re-arm is scheduled, but the user clears before it fires.
    const { clearGoal } = await import("../loop");
    await clearGoal(S, deps);
    expect(_getReArmCount(S)).toBe(0);
  });
});
