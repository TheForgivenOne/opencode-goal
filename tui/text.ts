/**
 * Pure helpers for the TUI half: semantic theme resolution and width fitting.
 *
 * Kept free of Solid and of the plugin context so they can be unit-tested
 * without a renderer (tests live in `tui/__tests__/`).
 *
 * Theme token names verified against the published theme tool bundle
 * (`text.{base,muted,action,formfield,feedback.{error,warning,success,info}}`);
 * see https://opencode.ai/v2/docs/cli/theme.
 */

/**
 * Resolve a semantic theme token such as `text.feedback.success.base`.
 *
 * Defensive by design: a token that is absent, or a theme that is missing
 * entirely, yields `undefined` rather than throwing. An absent colour leaves the
 * element's default foreground, which is far better than breaking the composer
 * because a theme renamed a token.
 */
export function themeToken(theme: unknown, ...path: readonly string[]): string | undefined {
  let node: unknown = theme;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * The colour for a goal-state label. `active` is informational, not an error;
 * a running unattended loop is signalled by the condition text, not by red.
 */
export function statusColour(theme: unknown, kind: "active" | "achieved" | "failed"): string | undefined {
  const feedback = kind === "achieved" ? "success" : kind === "failed" ? "error" : "info";
  return themeToken(theme, "text", "feedback", feedback, "base");
}

/**
 * Fit `value` into `width` columns, cutting with an ellipsis when necessary.
 *
 * Counts Unicode **code points**, matching the project's discipline everywhere
 * else (parser and evaluator caps), so a wide character is never split into a
 * lone surrogate. Returns `""` for a non-positive width, which lets a caller
 * render nothing rather than overflow.
 */
export function fitToWidth(value: string, width: number, ellipsis = "…"): string {
  if (Number.isNaN(width) || width <= 0) return "";
  // +Infinity is a meaningful "unbounded" width from a renderer that has not
  // measured yet; it must not hide the label.
  if (!Number.isFinite(width)) return value;
  const chars = [...value];
  if (chars.length <= width) return value;
  const marker = [...ellipsis];
  if (width <= marker.length) return chars.slice(0, width).join("");
  return chars.slice(0, width - marker.length).join("") + ellipsis;
}

/** Columns to leave free so the indicator never touches the terminal edge. */
export const WIDTH_MARGIN = 4;
