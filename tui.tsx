/**
 * TUI entrypoint (spec §2, §6.3, REQ-12) — loaded by the CLI process.
 *
 * Discovered by filename: `Host.resolve` tries `<plugin-dir>/tui` for this
 * entrypoint (spec §3.3), so this file must be named `tui.tsx`/`tui.ts`.
 * `cli-plugins.md` confirms project `.opencode/plugins/<name>/` with both
 * `index.ts` and `tui.ts` is a supported discovery path.
 *
 * The TUI holds no loop logic and no goal truth: it renders state read over RPC
 * and issues `clear` through the same definition the server registered.
 */

import { Plugin } from "@opencode/plugin/tui";
import { GoalIndicator } from "./tui/indicator";
import { installGoalKeymap } from "./tui/keymap";

export default Plugin.define({
  id: "opencode-goal.tui",
  setup(context) {
    // REQ-12 status indicator. `keymap.layer` returns void and is disposed with
    // this scope, so only the slot needs its release function.
    context.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => <GoalIndicator sessionID={sessionID} />,
    });

    installGoalKeymap(context);
  },
});
