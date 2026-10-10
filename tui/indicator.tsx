/**
 * REQ-12 status indicator (spec §6.3).
 *
 * Claims `session.composer.top` and renders the session's goal state. The TUI
 * holds **no goal truth**: the state is read over RPC and re-read on the
 * `changed` event. Reads are best-effort — a failed RPC must never break the
 * composer.
 *
 * Presentation notes:
 *  - Colours come from semantic theme tokens so the indicator follows the active
 *    theme, and degrade to the default foreground if a token is missing.
 *  - The elapsed time ticks locally between RPC reads, **but only while the loop is
 *    actually running**. A goal can be `active` and dormant at the same time, and a
 *    ticking clock for a stopped loop was read as work in progress (live report:
 *    "`turn 0, 0 tokens, 34s`"). The label logic lives in `./text` so it is testable
 *    without a renderer.
 *  - The line is fitted to the terminal width; an unknown width renders
 *    untruncated rather than hiding the indicator.
 */

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { usePlugin } from "@opencode/plugin/tui";
import { portableGoalRpc } from "../rpc";
import {
  fitToWidth,
  indicatorElapsed,
  indicatorLabel,
  statusColour,
  statusColourKind,
  type GoalStatusView,
  WIDTH_MARGIN,
} from "./text";

export function GoalIndicator(props: { sessionID: string }) {
  const context = usePlugin();
  const [status, setStatus] = createSignal<GoalStatusView>({ kind: "none" });
  /** Ticking clock; only read while a goal is active *and* running. */
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

  /** Fit to the composer width; an unknown width renders the label whole. */
  const fitted = (): string => {
    const current = status();
    const text = indicatorLabel(
      current,
      indicatorElapsed(current, baseElapsedMs, baseAt, clock()),
    );
    const columns = context.renderer?.width ?? 0;
    if (!Number.isFinite(columns) || columns <= WIDTH_MARGIN) return text;
    return fitToWidth(text, columns - WIDTH_MARGIN);
  };

  return (
    <Show when={status().kind !== "none"}>
      <text fg={statusColour(context.theme, statusColourKind(status()))}>{fitted()}</text>
    </Show>
  );
}
