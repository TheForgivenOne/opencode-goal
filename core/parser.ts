/**
 * Pure `/goal` argument parser.
 *
 * Contract: spec §6.1; acceptance criteria E1, E2, E3, E16, AC-2, AC-9, AC-10,
 * AC-12, AC-14, AC-15, E12.
 *
 * This module performs no I/O and imports nothing from `@opencode/*`. It is the
 * single source of truth for both the parse result *and* the exact user-facing
 * strings the criteria test, so no caller can invent different wording.
 */

/** Reserved words that mean "clear" only when they are the *entire* argument. */
export const CLEAR_WORDS = Object.freeze([
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel",
] as const);

export type ClearWord = (typeof CLEAR_WORDS)[number];

/**
 * The condition length limit. Counted in Unicode **code points** (`[...s].length`),
 * not UTF-16 units or bytes — acceptance criteria E12 / assumption A-14.
 */
export const CONDITION_MAX_CODE_POINTS = 4000;

export type ParseResult =
  | { readonly kind: "status" }
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly condition: string }
  | { readonly kind: "too-long"; readonly length: number };

// ---------------------------------------------------------------------------
// Exact user-facing strings (criteria AC-8, AC-9, AC-10, AC-15).
// Keep every user-visible message here.
// ---------------------------------------------------------------------------

/** AC-8 / AC-10. */
export const STATUS_NO_GOAL = "No goal set";

/** AC-9: `Goal cleared: <condition>` with the condition verbatim. */
export function clearConfirmation(condition: string): string {
  return `Goal cleared: ${condition}`;
}

/** AC-15: explain the over-length refusal, naming the limit and the value. */
export function tooLongMessage(codePoints: number): string {
  return `Goal not set: condition exceeds the ${CONDITION_MAX_CODE_POINTS}-character limit (${codePoints} code points).`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function isClearWord(lower: string): boolean {
  return (CLEAR_WORDS as readonly string[]).includes(lower);
}

/**
 * Parse the argument text that follows `/goal`.
 *
 * - empty / whitespace-only → `status`
 * - the entire argument is exactly a reserved word (trimmed, case-folded) → `clear`
 * - anything else → `set` with the outer-trimmed condition preserved byte-for-byte
 * - more than {@link CONDITION_MAX_CODE_POINTS} code points → `too-long`
 *
 * `condition` is never case-folded; only the reserved-word *match* is. Extra
 * tokens make the argument a condition (E1/E16): `/goal clear please` sets a
 * goal, only a bare `clear` clears.
 *
 * E15 (no session context) is a caller concern and is deliberately not handled
 * here.
 */
export function parseGoalArg(arg: string): ParseResult {
  const trimmed = arg.trim();
  if (trimmed === "") return { kind: "status" };

  if (isClearWord(trimmed.toLowerCase())) return { kind: "clear" };

  // Outer trim only; inner bytes and case are preserved (E1, AC-2).
  const condition = arg.trim();
  if (condition === "") return { kind: "status" };

  const codePoints = [...condition].length;
  if (codePoints > CONDITION_MAX_CODE_POINTS) {
    return { kind: "too-long", length: codePoints };
  }

  return { kind: "set", condition };
}
