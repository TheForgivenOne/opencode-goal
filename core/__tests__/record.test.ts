/**
 * Independent acceptance tests for core/record.ts.
 *
 * Expectations derived from the acceptance criteria's persisted-record field
 * table and the three-verdict contract (docs/requirements/acceptance-criteria-core-loop.md),
 * plus the spec §5.1–§5.3 and the formal adjudication recorded in progress.md:
 * `turnsEvaluated` increments on EVERY evaluation, including terminal ones;
 * the criteria are binding over the spec. `turnsThisRun` is loop-owned and
 * must NOT be touched by applyVerdict.
 */
import { describe, expect, test } from "bun:test";
import { applyVerdict, createGoal, decode, encode, isActive } from "../record";

const VALID_BASE = {
  condition: "c",
  state: "active",
  setAt: 1,
  turnsEvaluated: 0,
  tokensSpent: 0,
  lastReason: "",
  consecutiveNoToolTurns: 0,
  turnsThisRun: 0,
} as const;

function omit<T extends Record<string, unknown>>(obj: T, key: keyof T): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key as string];
  return copy;
}

describe("createGoal (spec §5.2, field table)", () => {
  test("fresh active record with zeroed counters and no terminal fields", () => {
    const record = createGoal("all unit tests pass", 1000);
    expect(record).toEqual({
      condition: "all unit tests pass",
      state: "active",
      setAt: 1000,
      turnsEvaluated: 0,
      tokensSpent: 0,
      lastReason: "",
      consecutiveNoToolTurns: 0,
      turnsThisRun: 0,
    });
    expect(record.endedAt).toBeUndefined();
    expect(record.lastVerdict).toBeUndefined();
  });
});

describe("encode / decode round-trip (spec §5.1)", () => {
  test("active record round-trips", () => {
    const record = createGoal("cond", 5);
    expect(decode(encode(record))).toEqual({ record });
  });

  test("terminal record round-trips (endedAt + lastVerdict)", () => {
    const record = applyVerdict(createGoal("cond", 5), {
      kind: "met",
      reason: "done",
      now: 99,
    });
    expect(decode(encode(record))).toEqual({ record });
  });
});

describe("decode: absence is not an error (spec §5.1)", () => {
  test("null → no record, no warning", () => {
    expect(decode(null)).toEqual({ record: null });
  });

  test("undefined → no record, no warning", () => {
    expect(decode(undefined)).toEqual({ record: null });
  });
});

describe("decode: malformed input → no record + warning, never throws (spec §5.1)", () => {
  const malformed = ["", "{", "not json at all", "{'a':1}", "NaN"];

  for (const raw of malformed) {
    test(`decode(${JSON.stringify(raw)})`, () => {
      let result: ReturnType<typeof decode>;
      expect(() => {
        result = decode(raw);
      }).not.toThrow();
      expect(result!.record).toBeNull();
      expect(typeof result!.warning).toBe("string");
      expect((result!.warning ?? "").length).toBeGreaterThan(0);
    });
  }
});

describe("decode: wrong-shape input → no record + warning (spec §5.1)", () => {
  const invalidShapes: Array<[string, unknown]> = [
    ["empty object", {}],
    ["array", []],
    ["string literal", "hello"],
    ["number literal", 123],
    ["boolean literal", true],
    ["null literal", null],
    ["condition wrong type", { ...VALID_BASE, condition: 7 }],
    ["state not a known value", { ...VALID_BASE, state: "bogus" }],
    ["setAt wrong type", { ...VALID_BASE, setAt: "1" }],
    ["endedAt wrong type", { ...VALID_BASE, endedAt: "soon" }],
    ["turnsEvaluated wrong type", { ...VALID_BASE, turnsEvaluated: "0" }],
    ["tokensSpent wrong type", { ...VALID_BASE, tokensSpent: null }],
    ["lastVerdict not a known value", { ...VALID_BASE, lastVerdict: "maybe" }],
    ["lastReason wrong type", { ...VALID_BASE, lastReason: 5 }],
    ["consecutiveNoToolTurns wrong type", { ...VALID_BASE, consecutiveNoToolTurns: "0" }],
    ["turnsThisRun wrong type", { ...VALID_BASE, turnsThisRun: "0" }],
    ["missing condition", omit(VALID_BASE, "condition")],
    ["missing turnsEvaluated", omit(VALID_BASE, "turnsEvaluated")],
    ["missing tokensSpent", omit(VALID_BASE, "tokensSpent")],
    ["missing lastReason", omit(VALID_BASE, "lastReason")],
  ];

  for (const [label, value] of invalidShapes) {
    test(`rejects ${label}`, () => {
      const result = decode(JSON.stringify(value));
      expect(result.record).toBeNull();
      expect(typeof result.warning).toBe("string");
    });
  }

  test("a fully valid record whose lastVerdict/endedAt are absent is accepted", () => {
    expect(decode(JSON.stringify(VALID_BASE))).toEqual({
      record: VALID_BASE as unknown as ReturnType<typeof createGoal>,
    });
  });
});

describe("decode: field-domain validation of the record contract (field table)", () => {
  // The criteria's field table types every counter as a "non-negative integer".
  // Note: spec §5.1 only mandates JSON.parse failure handling, so whether the
  // decoder must also reject a parsed-but-out-of-domain value is borderline.
  const outOfDomain: Array<[string, unknown]> = [
    ["negative turnsEvaluated", { ...VALID_BASE, turnsEvaluated: -1 }],
    ["non-integer turnsEvaluated", { ...VALID_BASE, turnsEvaluated: 1.5 }],
    ["negative tokensSpent", { ...VALID_BASE, tokensSpent: -5 }],
    ["negative consecutiveNoToolTurns", { ...VALID_BASE, consecutiveNoToolTurns: -1 }],
    ["non-integer turnsThisRun", { ...VALID_BASE, turnsThisRun: 0.5 }],
  ];

  for (const [label, value] of outOfDomain) {
    test(`rejects ${label} as not a non-negative integer`, () => {
      const result = decode(JSON.stringify(value));
      expect(result.record).toBeNull();
      expect(typeof result.warning).toBe("string");
    });
  }
});

describe("isActive (spec §5.3)", () => {
  test("true only for state === active", () => {
    expect(isActive(createGoal("c"))).toBe(true);
    expect(
      isActive(applyVerdict(createGoal("c"), { kind: "met", reason: "r" })),
    ).toBe(false);
    expect(
      isActive(applyVerdict(createGoal("c"), { kind: "impossible", reason: "r" })),
    ).toBe(false);
  });

  test("false for null / undefined", () => {
    expect(isActive(null)).toBe(false);
    expect(isActive(undefined)).toBe(false);
  });
});

describe("applyVerdict — not yet met (verdict 1)", () => {
  test("stays active; sets verdict/reason; increments turnsEvaluated; adds tokens; increments no-tool counter", () => {
    const base = {
      ...createGoal("c", 1),
      turnsEvaluated: 2,
      tokensSpent: 30,
      consecutiveNoToolTurns: 1,
      turnsThisRun: 4,
    };

    const next = applyVerdict(base, {
      kind: "not-yet-met",
      reason: "keep going",
      tokensSpentDelta: 7,
    });

    expect(next).toEqual({
      ...base,
      lastVerdict: "not-yet-met",
      lastReason: "keep going",
      turnsEvaluated: 3,
      tokensSpent: 37,
      consecutiveNoToolTurns: 2,
    });
    expect(next.endedAt).toBeUndefined();
    expect(next.turnsThisRun).toBe(4);
  });

  test("a tool-using turn resets consecutiveNoToolTurns to 0 (AC-31)", () => {
    const base = { ...createGoal("c"), consecutiveNoToolTurns: 2 };
    const next = applyVerdict(base, {
      kind: "not-yet-met",
      reason: "r",
      toolUsedThisTurn: true,
    });
    expect(next.consecutiveNoToolTurns).toBe(0);
  });

  test("a missing tokensSpentDelta adds zero", () => {
    const base = { ...createGoal("c"), tokensSpent: 12 };
    const next = applyVerdict(base, { kind: "not-yet-met", reason: "r" });
    expect(next.tokensSpent).toBe(12);
  });
});

describe("applyVerdict — met (verdict 2, incl. adjudication)", () => {
  test("achieved + endedAt=now + turnsEvaluated incremented ON the terminal evaluation", () => {
    const base = {
      ...createGoal("c", 1),
      turnsEvaluated: 3,
      tokensSpent: 100,
      turnsThisRun: 9,
    };

    const next = applyVerdict(base, {
      kind: "met",
      reason: "satisfied",
      tokensSpentDelta: 5,
      toolUsedThisTurn: true,
      now: 4242,
    });

    expect(next.state).toBe("achieved");
    expect(next.lastVerdict).toBe("met");
    expect(next.lastReason).toBe("satisfied");
    expect(next.endedAt).toBe(4242);
    // Criteria: "incremented on each evaluation"; adjudication confirms the
    // terminal evaluation counts too. 3 -> 4.
    expect(next.turnsEvaluated).toBe(4);
    expect(next.tokensSpent).toBe(105);
    // Loop-owned counter is untouched by applyVerdict.
    expect(next.turnsThisRun).toBe(9);
  });

  test("endedAt defaults to the current epoch ms when `now` is omitted", () => {
    const before = Date.now();
    const next = applyVerdict(createGoal("c"), { kind: "met", reason: "r" });
    const after = Date.now();
    expect(next.endedAt).toBeGreaterThanOrEqual(before);
    expect(next.endedAt).toBeLessThanOrEqual(after);
  });
});

describe("applyVerdict — impossible (verdict 3)", () => {
  test("failed + endedAt=now + turnsEvaluated incremented on the terminal evaluation", () => {
    const base = {
      ...createGoal("c", 1),
      turnsEvaluated: 0,
      tokensSpent: 4,
      turnsThisRun: 2,
    };

    const next = applyVerdict(base, {
      kind: "impossible",
      reason: "cannot be done",
      now: 777,
    });

    expect(next.state).toBe("failed");
    expect(next.lastVerdict).toBe("impossible");
    expect(next.lastReason).toBe("cannot be done");
    expect(next.endedAt).toBe(777);
    expect(next.turnsEvaluated).toBe(1);
    expect(next.tokensSpent).toBe(4);
    expect(next.turnsThisRun).toBe(2);
  });
});

describe("applyVerdict is pure — never mutates its argument (spec §4.2 call site)", () => {
  test("not-yet-met leaves the argument deep-equal to its snapshot", () => {
    const base = {
      ...createGoal("c", 1),
      consecutiveNoToolTurns: 5,
      turnsEvaluated: 2,
    };
    const snapshot = JSON.parse(JSON.stringify(base));

    applyVerdict(base, { kind: "not-yet-met", reason: "r", toolUsedThisTurn: true });

    expect(base).toEqual(snapshot);
    expect(base.consecutiveNoToolTurns).toBe(5);
  });

  test("terminal verdict leaves the argument deep-equal to its snapshot", () => {
    const base = { ...createGoal("c", 1), turnsEvaluated: 1, tokensSpent: 8 };
    const snapshot = JSON.parse(JSON.stringify(base));

    applyVerdict(base, { kind: "met", reason: "r", tokensSpentDelta: 9, now: 5 });

    expect(base).toEqual(snapshot);
    expect(base.state).toBe("active");
    expect(base.turnsEvaluated).toBe(1);
  });

  test("works on a frozen input object (no in-place write)", () => {
    const base = Object.freeze({ ...createGoal("c", 1), turnsEvaluated: 2 });
    expect(() =>
      applyVerdict(base, { kind: "not-yet-met", reason: "r" }),
    ).not.toThrow();
  });
});
