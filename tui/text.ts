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
 * `paused` — a goal that is set but has no loop running — is a warning: nothing is
 * happening, and that is exactly what the user needs to see.
 */
export function statusColour(
  theme: unknown,
  kind: "active" | "paused" | "achieved" | "failed",
): string | undefined {
  const feedback =
    kind === "achieved"
      ? "success"
      : kind === "failed"
        ? "error"
        : kind === "paused"
          ? "warning"
          : "info";
  return themeToken(theme, "text", "feedback", feedback, "base");
}

/**
 * The status view the indicator renders. Mirrors the RPC `status` output (§6.2).
 */
export interface GoalStatusView {
  readonly kind: "none" | "active" | "achieved" | "failed";
  /** `false` means the goal is set but its loop is not running (§6.3). */
  readonly running?: boolean;
  readonly condition?: string;
  readonly elapsedMs?: number;
  readonly turnsEvaluated?: number;
  readonly tokensSpent?: number;
  readonly lastReason?: string;
}

/** Compact duration, as the indicator shows it. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  if (totalSeconds < 1) return `${Math.round(clamped)}ms`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * The elapsed time to show.
 *
 * Only a **running** goal ticks. A goal that is `active` but dormant — paused by a
 * new conversation, anti-spin, the turn cap or a kill switch — has no work in
 * progress, and a locally-ticking clock made it look busy. That is the live report
 * "`turn 0, 0 tokens, 34s`": the loop had been paused 4 seconds in, and the display
 * kept counting for half a minute as though it were still working.
 *
 * `running === undefined` (an older server that does not send the field) ticks, which
 * is the previous behaviour.
 */
export function indicatorElapsed(
  view: GoalStatusView,
  baseElapsedMs: number,
  baseAt: number,
  now: number,
): number {
  if (view.kind !== "active") return view.elapsedMs ?? 0;
  if (view.running === false) return view.elapsedMs ?? 0;
  return baseElapsedMs + Math.max(0, now - baseAt);
}

/** The indicator's one-line label (§6.3). */
export function indicatorLabel(view: GoalStatusView, elapsedMs: number): string {
  if (view.kind === "none") return "";
  const turns = view.turnsEvaluated ?? 0;
  const spend = view.tokensSpent ?? 0;
  const condition = view.condition ?? "";
  switch (view.kind) {
    case "active":
      return view.running === false
        ? `[goal] paused: ${condition} — ${turns} turn(s), ${spend} tokens, ${formatDuration(elapsedMs)}; send a message to resume`
        : `[goal] ${condition} — turn ${turns}, ${spend} tokens, ${formatDuration(elapsedMs)}`;
    case "achieved":
      return `[goal] achieved: ${condition} — ${turns} turn(s), ${spend} tokens`;
    case "failed":
      return `[goal] failed: ${condition} — ${view.lastReason ?? ""}`;
    default:
      return "";
  }
}

/** The colour kind for a status view; a dormant active goal is `paused`. */
export function statusColourKind(
  view: GoalStatusView,
): "active" | "paused" | "achieved" | "failed" {
  if (view.kind === "active" && view.running === false) return "paused";
  return view.kind === "none" ? "active" : view.kind;
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
