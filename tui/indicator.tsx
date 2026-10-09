/**
 * REQ-12 status indicator (spec §6.3).
 *
 * Claims `session.composer.top` and renders the session's goal state. The TUI
 * holds **no goal truth**: the state is read over RPC and re-read on the
 * `changed` event. Reads are best-effort — a failed RPC must never break the
 * composer.
 */

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { usePlugin } from "@opencode/plugin/tui";
import { portableGoalRpc } from "../rpc";

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

  onMount(() => {
    const goal = context.client.rpc(portableGoalRpc);
    let alive = true;

    const refresh = async () => {
      try {
        const next = (await goal.status({ sessionID: props.sessionID })) as GoalStatusView;
        if (alive) setStatus(next);
      } catch {
        // Best-effort: the indicator is decorative, the loop is authoritative.
      }
    };

    void refresh();
    const unsubscribe = goal.events.on("changed", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh();
    });

    onCleanup(() => {
      alive = false;
      unsubscribe();
    });
  });

  const label = (): string => {
    const current = status();
    if (current.kind === "none") return "";
    const turns = current.turnsEvaluated ?? 0;
    const spend = current.tokensSpent ?? 0;
    const condition = current.condition ?? "";
    switch (current.kind) {
      case "active":
        return `[goal] ${condition} — turn ${turns}, ${spend} tokens, ${formatDuration(
          current.elapsedMs ?? 0,
        )}`;
      case "achieved":
        return `[goal] achieved: ${condition} — ${turns} turn(s), ${spend} tokens`;
      case "failed":
        return `[goal] failed: ${condition} — ${current.lastReason ?? ""}`;
      default:
        return "";
    }
  };

  return (
    <Show when={status().kind !== "none"}>
      <text>{label()}</text>
    </Show>
  );
}
