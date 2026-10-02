/**
 * Independent tests for phase 2a's storage adapter (spec §5.1, §5.2).
 *
 * Expectations are derived from `docs/specs/goal-plugin-v1.md` §5.1 (key
 * scheme, decode-is-validation-boundary, out-of-domain counters rejected,
 * "no record + warning, never a throw") and the criteria's persisted-record
 * field table.
 */

import { describe, expect, it } from "bun:test";
import {
  GOAL_KEY_PREFIX,
  deleteGoal,
  goalKey,
  readGoal,
  scanGoals,
  writeGoal,
  type StorageContext,
} from "../store";
import { createGoal, type GoalRecord } from "../record";

/** Minimal faithful `ctx.storage` over a Map (the shipped StorageDomain). */
function fakeStorage(seed: Record<string, unknown> = {}): StorageContext {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    storage: {
      get: async (key: string) => map.get(key) as never,
      set: async (key: string, value: never) => {
        map.set(key, value);
      },
      remove: async (key: string) => {
        map.delete(key);
      },
      scan: async (options: { prefix: string; after?: string }) => {
        const keys = [...map.keys()]
          .filter((k) => k.startsWith(options.prefix))
          .sort();
        const start = options.after === undefined ? 0 : keys.indexOf(options.after) + 1;
        const entries = keys.slice(start).map((key) => ({ key, value: map.get(key) as never }));
        return { entries };
      },
    } as never,
  };
}

const base: GoalRecord = {
  condition: "all tests pass",
  state: "active",
  setAt: 1_700_000_000_000,
  turnsEvaluated: 2,
  tokensSpent: 1234,
  lastVerdict: "not-yet-met",
  lastReason: "still failing",
  consecutiveNoToolTurns: 1,
  turnsThisRun: 2,
};

const seeded = (record: unknown, sessionID = "s1") =>
  fakeStorage({ [goalKey(sessionID)]: JSON.stringify(record) });

describe("store key scheme (spec §5.1)", () => {
  it("uses goal:v1:<sessionID>", () => {
    expect(GOAL_KEY_PREFIX).toBe("goal:v1:");
    expect(goalKey("abc")).toBe("goal:v1:abc");
  });
});

describe("readGoal / writeGoal round-trip (spec §5.1)", () => {
  it("round-trips a record", async () => {
    const ctx = fakeStorage();
    await writeGoal("s1", base, ctx);
    const result = await readGoal("s1", ctx);
    expect(result.record).toEqual(base);
    expect(result.warning).toBeUndefined();
  });

  it("returns no record and no warning when the session has no goal", async () => {
    const result = await readGoal("nobody", fakeStorage());
    expect(result.record).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  it("round-trips a freshly created goal", async () => {
    const ctx = fakeStorage();
    const goal = createGoal("do the thing", 42);
    await writeGoal("s1", goal, ctx);
    expect((await readGoal("s1", ctx)).record).toEqual(goal);
  });
});

describe("readGoal decode failures are no-record + warning, never a throw (spec §5.1)", () => {
  it("rejects invalid JSON", async () => {
    const result = await readGoal("s1", fakeStorage({ [goalKey("s1")]: "{not json" }));
    expect(result.record).toBeNull();
    expect(typeof result.warning).toBe("string");
    expect(result.warning!.length).toBeGreaterThan(0);
  });

  it("rejects valid JSON that is not a goal record", async () => {
    const result = await readGoal("s1", seeded({ foo: 1 }));
    expect(result.record).toBeNull();
    expect(result.warning).toBeDefined();
  });

  it("rejects a non-string stored value", async () => {
    const result = await readGoal("s1", fakeStorage({ [goalKey("s1")]: 12345 }));
    expect(result.record).toBeNull();
    expect(result.warning).toBeDefined();
  });

  it("rejects an unknown state enum", async () => {
    const result = await readGoal("s1", seeded({ ...base, state: "zombie" }));
    expect(result.record).toBeNull();
    expect(result.warning).toBeDefined();
  });

  it("rejects an unknown lastVerdict enum", async () => {
    const result = await readGoal("s1", seeded({ ...base, lastVerdict: "maybe" }));
    expect(result.record).toBeNull();
    expect(result.warning).toBeDefined();
  });

  it("rejects a non-numeric setAt", async () => {
    const result = await readGoal("s1", seeded({ ...base, setAt: "yesterday" }));
    expect(result.record).toBeNull();
    expect(result.warning).toBeDefined();
  });

  it("rejects a string counter", async () => {
    const result = await readGoal("s1", seeded({ ...base, turnsEvaluated: "2" }));
    expect(result.record).toBeNull();
    expect(result.warning).toBeDefined();
  });
});

describe("readGoal rejects out-of-domain counters (spec §5.1, phase-1 ruled defect)", () => {
  const counters = [
    "turnsEvaluated",
    "tokensSpent",
    "consecutiveNoToolTurns",
    "turnsThisRun",
  ] as const;

  for (const counter of counters) {
    it(`rejects ${counter} = -1`, async () => {
      const result = await readGoal("s1", seeded({ ...base, [counter]: -1 }));
      expect(result.record).toBeNull();
      expect(result.warning).toBeDefined();
    });

    it(`rejects ${counter} = 1.5 (non-integer)`, async () => {
      const result = await readGoal("s1", seeded({ ...base, [counter]: 1.5 }));
      expect(result.record).toBeNull();
      expect(result.warning).toBeDefined();
    });
  }

  it("still accepts a valid record with counters at zero", async () => {
    const zeroed = {
      ...base,
      turnsEvaluated: 0,
      tokensSpent: 0,
      consecutiveNoToolTurns: 0,
      turnsThisRun: 0,
      lastVerdict: undefined,
      lastReason: "",
      endedAt: undefined,
    };
    const result = await readGoal("s1", seeded(zeroed));
    expect(result.record).not.toBeNull();
    expect(result.warning).toBeUndefined();
  });
});

describe("deleteGoal (spec §5.3 clear)", () => {
  it("removes the record", async () => {
    const ctx = fakeStorage();
    await writeGoal("s1", base, ctx);
    await deleteGoal("s1", ctx);
    const result = await readGoal("s1", ctx);
    expect(result.record).toBeNull();
    expect(result.warning).toBeUndefined();
  });
});

describe("scanGoals (spec §5.1)", () => {
  it("returns valid goals keyed by sessionID and skips undecodable entries with warnings", async () => {
    const ctx = fakeStorage({
      [goalKey("good")]: JSON.stringify({ ...base, condition: "good" }),
      [goalKey("bad")]: "{oops",
    });
    const { goals, warnings } = await scanGoals(ctx);
    expect(goals.map((g) => g.sessionID)).toEqual(["good"]);
    expect(goals[0].record.condition).toBe("good");
    expect(warnings.length).toBe(1);
  });

  it("returns nothing for empty storage", async () => {
    const { goals, warnings } = await scanGoals(fakeStorage());
    expect(goals).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
