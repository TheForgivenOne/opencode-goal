/**
 * Tests for the loop's storage-mutating entry points.
 *
 * `stopSessionForNewConversation` is the AC-13 path. Before 2026-10-10 it called
 * `clearGoal`, which DELETED the record — so a goal vanished with no notice whenever
 * a session was created. The first test here is that regression.
 */

import { describe, expect, it } from "bun:test";
import { hasActiveRun, newConversationWarning, stopSessionForNewConversation } from "../loop";
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
