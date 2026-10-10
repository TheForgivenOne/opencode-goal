/**
 * Tests for the pure TUI helpers in `tui/text.ts`.
 *
 * Run with the plugin-wide glob so this directory is included:
 *   bun test ./plugin-src/opencode-goal/
 * (the older core-only glob, `…/core/__tests__/`, will not pick these up).
 */
import { describe, expect, test } from "bun:test";
import {
  fitToWidth,
  indicatorElapsed,
  indicatorLabel,
  statusColour,
  statusColourKind,
  themeToken,
  WIDTH_MARGIN,
} from "../text";

const theme = {
  text: {
    base: "#eeeeee",
    muted: "#999999",
    feedback: {
      error: { base: "#ff0000" },
      success: { base: "#00ff00" },
      info: { base: "#0000ff" },
      warning: { base: "#ffff00" },
    },
  },
};

describe("themeToken", () => {
  test("resolves a nested token", () => {
    expect(themeToken(theme, "text", "base")).toBe("#eeeeee");
    expect(themeToken(theme, "text", "feedback", "success", "base")).toBe("#00ff00");
  });

  test("an absent path yields undefined rather than throwing", () => {
    expect(themeToken(theme, "text", "nope")).toBeUndefined();
    expect(themeToken(theme, "nope", "base")).toBeUndefined();
    expect(themeToken(theme, "text", "base", "deeper")).toBeUndefined();
  });

  test("a missing theme yields undefined (the plugin must not break the composer)", () => {
    expect(themeToken(undefined, "text", "base")).toBeUndefined();
    expect(themeToken(null, "text", "base")).toBeUndefined();
    expect(themeToken("a-string", "text")).toBeUndefined();
    expect(themeToken(42, "text")).toBeUndefined();
  });

  test("a non-string leaf yields undefined", () => {
    expect(themeToken({ text: { base: 5 } }, "text", "base")).toBeUndefined();
    expect(themeToken({ text: { base: {} } }, "text", "base")).toBeUndefined();
  });
});

describe("statusColour", () => {
  test("maps each goal state to its semantic feedback token", () => {
    expect(statusColour(theme, "active")).toBe("#0000ff");
    expect(statusColour(theme, "achieved")).toBe("#00ff00");
    expect(statusColour(theme, "failed")).toBe("#ff0000");
  });

  test("degrades to undefined when the token is missing", () => {
    expect(statusColour({}, "achieved")).toBeUndefined();
    expect(statusColour(undefined, "failed")).toBeUndefined();
  });
});

describe("fitToWidth", () => {
  test("a value that fits is returned unchanged", () => {
    expect(fitToWidth("short", 10)).toBe("short");
    expect(fitToWidth("exactly10!", 10)).toBe("exactly10!");
  });

  test("an overflowing value is cut and marked with an ellipsis within the width", () => {
    const out = fitToWidth("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect([...out].length).toBeLessThanOrEqual(5);
  });

  test("a non-positive or non-finite width yields the empty string (render nothing, never overflow)", () => {
    expect(fitToWidth("abc", 0)).toBe("");
    expect(fitToWidth("abc", -1)).toBe("");
    expect(fitToWidth("abc", Number.NaN)).toBe("");
    expect(fitToWidth("abc", Number.POSITIVE_INFINITY)).toBe("abc");
  });

  test("a width at or below the ellipsis length degrades to a hard cut", () => {
    expect(fitToWidth("abcdef", 1)).toBe("a");
    expect(fitToWidth("abcdef", 1, "...")).toBe("a");
  });

  test("counts code points, so an astral character is neither split nor double-counted", () => {
    // 4 emoji are 4 code points but 8 UTF-16 units and (usually) 8 columns wide.
    const value = "😀😀😀😀";
    const out = fitToWidth(value, 4);
    expect(out).toBe(value); // fits as code points
    expect([...out].length).toBeLessThanOrEqual(4);
    // No lone surrogate: every code point is a complete one.
    for (const ch of out) expect([...ch].length).toBe(1);
  });

  test("a multi-character ellipsis is respected", () => {
    const out = fitToWidth("abcdefghij", 6, "...");
    expect(out).toBe("abc...");
    expect(out.length).toBeLessThanOrEqual(6);
  });
});

describe("WIDTH_MARGIN", () => {
  test("leaves a usable gap at the terminal edge", () => {
    expect(WIDTH_MARGIN).toBeGreaterThan(0);
    expect(WIDTH_MARGIN).toBeLessThan(20);
  });
});

/**
 * §6.3 indicator content. `active` is the goal; `running` is the loop. They differ
 * whenever the loop has stopped and the goal remains set, and conflating them is what
 * produced the live report "`turn 0, 0 tokens, 34s`" — a ticking clock for a loop that
 * had already been paused.
 */
describe("indicatorLabel / indicatorElapsed (§6.3)", () => {
  const running = {
    kind: "active" as const,
    running: true,
    condition: "say hi",
    elapsedMs: 5000,
    turnsEvaluated: 2,
    tokensSpent: 1500,
  };
  const paused = { ...running, running: false };

  test("a running goal shows the live line, and its clock ticks locally", () => {
    expect(indicatorLabel(running, 34_000)).toBe("[goal] say hi — turn 2, 1500 tokens, 34s");
    expect(indicatorElapsed(running, 5000, 1000, 7000)).toBe(11_000);
  });

  test("a paused goal says so, and its clock does NOT tick", () => {
    const label = indicatorLabel(paused, 5000);
    expect(label).toContain("paused");
    expect(label).toContain("send a message to resume");
    // The regression: this used to advance to 44s while nothing was running.
    expect(indicatorElapsed(paused, 5000, 1000, 40_000)).toBe(5000);
  });

  test("an older server that omits `running` keeps the previous ticking behaviour", () => {
    const legacy = { kind: "active" as const, condition: "c", elapsedMs: 1000 };
    expect(indicatorElapsed(legacy, 1000, 1000, 5000)).toBe(5000);
    expect(indicatorLabel(legacy, 5000)).not.toContain("paused");
  });

  test("terminal states ignore the clock", () => {
    expect(indicatorElapsed({ kind: "achieved", elapsedMs: 9000 }, 0, 0, 10 ** 9)).toBe(9000);
    expect(
      indicatorLabel({ kind: "achieved", condition: "c", turnsEvaluated: 3, tokensSpent: 9 }, 0),
    ).toBe("[goal] achieved: c — 3 turn(s), 9 tokens");
    expect(indicatorLabel({ kind: "failed", condition: "c", lastReason: "nope" }, 0)).toBe(
      "[goal] failed: c — nope",
    );
  });

  test("none renders nothing", () => {
    expect(indicatorLabel({ kind: "none" }, 0)).toBe("");
  });

  test("a dormant active goal is coloured as a warning, not as info", () => {
    expect(statusColourKind(running)).toBe("active");
    expect(statusColourKind(paused)).toBe("paused");
    expect(statusColourKind({ kind: "none" })).toBe("active");
    expect(statusColour(theme, "paused")).toBe("#ffff00");
    expect(statusColour(theme, "active")).toBe("#0000ff");
  });
});
