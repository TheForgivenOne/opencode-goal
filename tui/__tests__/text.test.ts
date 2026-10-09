/**
 * Tests for the pure TUI helpers in `tui/text.ts`.
 *
 * Run with the plugin-wide glob so this directory is included:
 *   bun test ./plugin-src/opencode-goal/
 * (the older core-only glob, `…/core/__tests__/`, will not pick these up).
 */
import { describe, expect, test } from "bun:test";
import { fitToWidth, statusColour, themeToken, WIDTH_MARGIN } from "../text";

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
