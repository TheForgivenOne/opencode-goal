/**
 * REQ-12 dialogs (spec §6.3): the reason modal and the kill-switch dialog.
 *
 * The kill switch's primary entry point is the `/goal clear` command; this
 * dialog is a second, equivalent path. Its message states the loop-stop (not
 * turn-stop) guarantee of spec §4.3 so the dialog does not overstate it.
 */

import type { Context } from "@opencode/plugin/tui/context";
import { portableGoalRpc } from "../rpc";

const NO_SESSION_MESSAGE = "No session is focused.";
const NO_GOAL_MESSAGE = "No goal set";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** REQ-12 — the reason modal: the condition plus the evaluator's latest reason. */
export async function showReason(
  context: Context,
  sessionID: string | undefined,
): Promise<void> {
  if (sessionID === undefined) {
    context.ui.toast.show({ message: NO_SESSION_MESSAGE, variant: "info" });
    return;
  }

  const goal = context.client.rpc(portableGoalRpc);
  let message: string;
  try {
    const status = await goal.status({ sessionID });
    if (status.kind === "none") {
      message = NO_GOAL_MESSAGE;
    } else {
      const reason =
        status.lastReason !== undefined && status.lastReason !== ""
          ? status.lastReason
          : "(no evaluation yet)";
      message = `${status.condition ?? "(no condition)"}\n\nLatest reason: ${reason}`;
    }
  } catch (err) {
    message = `Could not read the goal: ${describe(err)}`;
  }

  await context.ui.dialog.alert({ title: "Goal — latest reason", message });
}

/** REQ-12 — the kill-switch dialog, equivalent to `/goal clear`. */
export async function confirmClear(
  context: Context,
  sessionID: string | undefined,
): Promise<void> {
  if (sessionID === undefined) {
    context.ui.toast.show({ message: NO_SESSION_MESSAGE, variant: "info" });
    return;
  }

  const goal = context.client.rpc(portableGoalRpc);

  let condition: string;
  try {
    const status = await goal.status({ sessionID });
    if (status.kind === "none") {
      context.ui.toast.show({ message: NO_GOAL_MESSAGE, variant: "info" });
      return;
    }
    condition = status.condition ?? "(no condition)";
  } catch (err) {
    context.ui.toast.show({
      message: `Could not read the goal: ${describe(err)}`,
      variant: "error",
    });
    return;
  }

  const confirmed = await context.ui.dialog.confirm({
    title: "Clear the active goal?",
    message: `${condition}\n\nStops the loop; the turn already running finishes.`,
    label: { confirm: "Clear", cancel: "Keep" },
  });
  if (!confirmed) return;

  try {
    const result = await goal.clear({ sessionID });
    context.ui.toast.show({
      message: result.message,
      variant: result.cleared ? "success" : "info",
    });
  } catch (err) {
    context.ui.toast.show({
      message: `Could not clear the goal: ${describe(err)}`,
      variant: "error",
    });
  }
}
