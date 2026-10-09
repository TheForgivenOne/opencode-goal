/**
 * REQ-12 status indicator (spec §6.3).
 *
 * Claims `session.composer.top` and renders the session's goal state. The TUI
 * holds **no goal truth**: the state is read over RPC and re-read on the
 * `changed` event. Reads are best-effort — a failed RPC must never break the
 * composer.
 *
 * Presentation notes (2026-10-09):
 *  - Colours come from semantic theme tokens so the indicator follows the active
 *    theme, and degrade to the default foreground if a token is missing.
 *  - The elapsed time ticks locally between RPC reads. Without it a long
 *    unattended turn looks frozen, because the RPC only reports elapsed time
 *    when it is polled.
 *  - The line is fitted to the terminal width; an unknown width renders
 *    untruncated rather than hiding the indicator.
 */

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { usePlugin } from "@opencode/plugin/tui";
import { portableGoalRpc } from "../rpc";
import { fitToWidth, statusColour, WIDTH_MARGIN } from "./text";

type GoalStatusView = {
  kind: "none" | "active" | "achieved" | "failed";
  condition?: string;
  elapsedMs?: number;
  turnsEvaluated?: number;
  tokensSpent?: number;
  lastReason?: string;
};

function formatDuration(ms: number): string {
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

export function GoalIndicator(props: { sessionID: string }) {
  const context = usePlugin();
  const [status, setStatus] = createSignal<GoalStatusView>({ kind: "none" });
  /** Ticking clock; only read while a goal is active. */
  const [clock, setClock] = createSignal(Date.now());
  /** Elapsed time reported by the last successful read, and when it was read. */
  let baseElapsedMs = 0;
  let baseAt = Date.now();

  onMount(() => {
    const goal = context.client.rpc(portableGoalRpc);
    let alive = true;

    const refresh = async () => {
      try {
        const next = (await goal.status({ sessionID: props.sessionID })) as GoalStatusView;
        if (!alive) return;
        baseElapsedMs = next.elapsedMs ?? 0;
        baseAt = Date.now();
        setStatus(next);
      } catch {
        // Best-effort: the indicator is decorative, the loop is authoritative.
      }
    };

    void refresh();
    const unsubscribe = goal.events.on("changed", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh();
    });
    // 1s is a display refresh only; it does not poll the server.
    const timer = setInterval(() => setClock(Date.now()), 1000);

    onCleanup(() => {
      alive = false;
      unsubscribe();
      clearInterval(timer);
    });
  });

  /** Elapsed time, advanced locally while a goal is active. */
  const elapsed = (): number => {
    const current = status();
    if (current.kind !== "active") return current.elapsedMs ?? 0;
    return baseElapsedMs + Math.max(0, clock() - baseAt);
  };

  const label = (): string => {
    const current = status();
    if (current.kind === "none") return "";
    const turns = current.turnsEvaluated ?? 0;
    const spend = current.tokensSpent ?? 0;
    const condition = current.condition ?? "";
    switch (current.kind) {
      case "active":
        return `[goal] ${condition} — turn ${turns}, ${spend} tokens, ${formatDuration(elapsed())}`;
      case "achieved":
        return `[goal] achieved: ${condition} — ${turns} turn(s), ${spend} tokens`;
      case "failed":
        return `[goal] failed: ${condition} — ${current.lastReason ?? ""}`;
      default:
        return "";
    }
  };

  const colour = (): string | undefined => {
    const kind = status().kind;
    if (kind === "none") return undefined;
    return statusColour(context.theme, kind);
  };

  /** Fit to the composer width; an unknown width renders the label whole. */
  const fitted = (): string => {
    const text = label();
    const columns = context.renderer?.width ?? 0;
    if (!Number.isFinite(columns) || columns <= WIDTH_MARGIN) return text;
    return fitToWidth(text, columns - WIDTH_MARGIN);
  };

  return (
    <Show when={status().kind !== "none"}>
      <text fg={colour()}>{fitted()}</text>
    </Show>
  );
}
