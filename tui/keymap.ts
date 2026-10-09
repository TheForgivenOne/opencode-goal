/**
 * REQ-12 keybindings (spec §6.3).
 *
 * `keymap.layer` returns `void`, not a cleanup: the layer is owned by the
 * calling component and is disposed with it (shipped `Keymap` type —
 * `layer(input: () => KeymapLayer): void`). The plugin's setup scope owns it, so
 * unloading the plugin removes the bindings. Bindings are user-overridable
 * through OpenCode's keymap config.
 */

import type { Context } from "@opencode/plugin/tui/context";
import { confirmClear, showReason } from "./dialog";

/**
 * The session the TUI is currently showing. `ui.router.current()` is the route;
 * `ui.tabs.list()` covers the tabbed case. `undefined` when not in a session,
 * which the callers report rather than guessing a target.
 */
export function currentSessionID(context: Context): string | undefined {
  const route = context.ui.router.current();
  if (route.type === "session") return route.sessionID;
  return context.ui.tabs.list().find((tab) => tab.active)?.sessionID;
}

/** Registers the two `goal` commands. Complements the `/goal` slash command. */
export function installGoalKeymap(context: Context): void {
  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: "goal.showReason",
        title: "Goal: show reason",
        group: "Goal",
        bind: "ctrl+alt+g",
        // Discoverable in the command palette (Ctrl+P), not just by binding.
        palette: true,
        run: () => {
          void showReason(context, currentSessionID(context));
        },
      },
      {
        id: "goal.clear",
        title: "Goal: clear",
        group: "Goal",
        bind: "ctrl+alt+shift+g",
        palette: true,
        run: () => {
          void confirmClear(context, currentSessionID(context));
        },
      },
    ],
    bindings: ["goal.showReason", "goal.clear"],
  }));
}
