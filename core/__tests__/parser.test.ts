/**
 * Independent acceptance tests for core/parser.ts.
 *
 * Every expectation below is derived from the acceptance criteria
 * (docs/requirements/acceptance-criteria-core-loop.md) and spec §6.1 — NOT
 * from the implementation. See the field comments for the source.
 */
import { describe, expect, test } from "bun:test";
import {
  CLEAR_WORDS,
  CONDITION_MAX_CODE_POINTS,
  parseGoalArg,
} from "../parser";

// Criteria AC-12 heading / spec §6.1: clear, stop, off, reset, none, cancel.
const RESERVED = ["clear", "stop", "off", "reset", "none", "cancel"] as const;

describe("status (AC-8 / §6.1)", () => {
  test("empty argument is status", () => {
    expect(parseGoalArg("")).toEqual({ kind: "status" });
  });

  test("whitespace-only argument is status", () => {
    expect(parseGoalArg("   \t\n  ")).toEqual({ kind: "status" });
  });
});

describe("reserved words (E2, E3, AC-12)", () => {
  for (const word of RESERVED) {
    test(`bare "${word}" is clear`, () => {
      expect(parseGoalArg(word)).toEqual({ kind: "clear" });
    });

    test(`"  ${word.toUpperCase()}  " is clear (E3: trim + casefold)`, () => {
      expect(parseGoalArg(`  ${word.toUpperCase()}  `)).toEqual({ kind: "clear" });
    });
  }

  test("mixed case reserved word is clear", () => {
    expect(parseGoalArg("cLeAr")).toEqual({ kind: "clear" });
  });

  test("reserved word with surrounding newlines is clear", () => {
    expect(parseGoalArg("\nclear\n")).toEqual({ kind: "clear" });
  });

  test("exported CLEAR_WORDS lists exactly the six reserved words", () => {
    expect([...CLEAR_WORDS].sort()).toEqual([...RESERVED].sort());
  });
});

describe("conditions that merely begin with a reserved word (E1, E16)", () => {
  const conditions = [
    "clear all failing tests",
    "stop the server before midnight",
    "none of the tests may fail",
    "off you go",
    "reset the counter",
    "cancel the request",
    "clear please",
  ];

  for (const condition of conditions) {
    test(`"${condition}" is a condition, not clear`, () => {
      expect(parseGoalArg(condition)).toEqual({ kind: "set", condition });
    });
  }

  test("a reserved word plus only whitespace stays clear", () => {
    expect(parseGoalArg("clear   ")).toEqual({ kind: "clear" });
  });
});

describe("condition fidelity (AC-2)", () => {
  test("outer whitespace trimmed, internal bytes/case preserved", () => {
    const inner =
      "when the parser handles a[b[c]] and the word clear appears mid-sentence, done";
    expect(parseGoalArg(`   ${inner}   `)).toEqual({
      kind: "set",
      condition: inner,
    });
  });

  test("newlines, tabs, mixed case and non-ASCII inside the condition preserved", () => {
    const inner = "Keep IMPROVING the Parser.\nsecond line — Ñoño ✓\tend";
    expect(parseGoalArg(`\n${inner}\n`)).toEqual({
      kind: "set",
      condition: inner,
    });
  });

  test("internal runs of spaces are preserved", () => {
    expect(parseGoalArg("clear  please")).toEqual({
      kind: "set",
      condition: "clear  please",
    });
  });

  test("a condition is never case-folded", () => {
    expect(parseGoalArg("CLEAR ALL TESTS")).toEqual({
      kind: "set",
      condition: "CLEAR ALL TESTS",
    });
  });
});

describe("4,000 code-point limit (AC-14, AC-15, E12 / A-14)", () => {
  test("exported limit is 4,000", () => {
    expect(CONDITION_MAX_CODE_POINTS).toBe(4000);
  });

  test("exactly 4,000 ASCII code points is set (AC-14)", () => {
    const condition = "a".repeat(4000);
    const result = parseGoalArg(condition);
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect([...result.condition].length).toBe(4000);
      expect(result.condition).toBe(condition);
    }
  });

  test("4,001 ASCII code points is too-long with length 4,001 (AC-15)", () => {
    expect(parseGoalArg("a".repeat(4001))).toEqual({
      kind: "too-long",
      length: 4001,
    });
  });

  test("4,000 emoji (8,000 UTF-16 units) is accepted — limit is code points (E12)", () => {
    const condition = "😀".repeat(4000);
    // Guard the premise: this string is 8,000 UTF-16 units long.
    expect(condition.length).toBe(8000);
    const result = parseGoalArg(condition);
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect([...result.condition].length).toBe(4000);
    }
  });

  test("4,001 emoji is too-long reported as 4,001 code points (E12)", () => {
    expect(parseGoalArg("😀".repeat(4001))).toEqual({
      kind: "too-long",
      length: 4001,
    });
  });

  test("2,001 emoji = 4,002 UTF-16 units but 2,001 code points is accepted (E12)", () => {
    const condition = "😀".repeat(2001);
    expect(condition.length).toBe(4002); // would trip a UTF-16-unit counter
    expect(parseGoalArg(condition).kind).toBe("set");
  });

  test("3,999 ASCII + 1 emoji = 4,000 code points is accepted (E12)", () => {
    const condition = "a".repeat(3999) + "😀";
    expect(condition.length).toBe(4001); // UTF-16 units exceed 4,000
    expect(parseGoalArg(condition).kind).toBe("set");
  });

  test("4,000 code points with surrounding whitespace is accepted (limit applies to the trimmed condition)", () => {
    expect(parseGoalArg("  " + "a".repeat(4000) + "  ").kind).toBe("set");
  });

  test("a reserved word followed by >4,000 code points is too-long, not clear", () => {
    expect(parseGoalArg("none " + "z".repeat(5000))).toEqual({
      kind: "too-long",
      length: 5005,
    });
  });
});
