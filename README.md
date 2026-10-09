# opencode-goal

`/goal` for OpenCode V2 — set a completion condition, and the agent works
toward it in unattended turns until a model judges the condition met.

Ported from Claude Code's `/goal`.

## Install

```sh
opencode plugin add opencode-goal
```

Or place a local copy at `~/.config/opencode/plugins/opencode-goal/`. That
directory is a global discovery directory, so **no config entry is needed**;
`opencode plugin list` should show it.

## Usage

| Command | Effect |
|---|---|
| `/goal <condition>` | Set the condition and start the loop |
| `/goal` | Show status (condition, elapsed, turns, token spend, latest reason) |
| `/goal clear` | Stop the loop and clear the goal |

The loop starts turns on its own. It stops when the condition is judged **met**
(goal achieved), **impossible**, or a guard fires — and it stays dormant after
that, resuming on your next message.

## Configuration

Precedence, lowest to highest:

1. Built-in defaults
2. **`ctx.options`** — the documented option channel
3. `<project>/.opencode/goal.json`
4. `OPENCODE_GOAL_*` environment variables

```jsonc title="opencode.json(c)"
{
  "plugins": [
    {
      "package": "opencode-goal",
      "options": { "turnCap": 20, "evaluatorModel": "anthropic/claude-haiku" }
    }
  ]
}
```

```jsonc title=".opencode/goal.json"
{
  "antiSpinThreshold": 3,
  "turnCap": 50,
  "evaluatorModel": "anthropic/claude-haiku",
  "permissiveModePolicy": "warn",
  "transcriptMaxMessageChars": 8000,
  "transcriptMaxTotalChars": 48000,
  "evaluatorMaxAttempts": 5
}
```

| Key | Default | Meaning |
|---|---|---|
| `antiSpinThreshold` | `3` | Consecutive no-tool turns before the loop stops |
| `turnCap` | `50` | Unattended turns per run before the loop stops |
| `evaluatorModel` | auto | `provider/model` for judging; unset picks one automatically |
| `permissiveModePolicy` | `"warn"` | `"warn"` or `"refuse"` when a permissive mode is inferred |
| `transcriptMaxMessageChars` | `8000` | Per-message transcript cap sent to the evaluator |
| `transcriptMaxTotalChars` | `48000` | Total transcript budget per evaluation |
| `evaluatorMaxAttempts` | `5` | Model candidates one evaluation may try |

Environment overrides: `OPENCODE_GOAL_ANTISPIN`, `OPENCODE_GOAL_TURNCAP`,
`OPENCODE_GOAL_EVAL_MODEL`, `OPENCODE_GOAL_PERMISSIVE`,
`OPENCODE_GOAL_TRANSCRIPT_MESSAGE`, `OPENCODE_GOAL_TRANSCRIPT_TOTAL`,
`OPENCODE_GOAL_EVAL_ATTEMPTS`.

An invalid value is reported and ignored, and **any lower layer stays in
effect** — a mistyped environment variable does not discard a valid
`.opencode/goal.json` value.

### Kill switch

Stop every loop immediately, leaving goals set:

```sh
OPENCODE_GOAL_DISABLE=1   # environment
touch <project>/.opencode/goal.kill   # or a file
```

## TUI

While a goal is active an indicator renders above the composer.

| Binding | Action |
|---|---|
| `ctrl+alt+g` | Show the condition and the evaluator's latest reason |
| `ctrl+alt+shift+g` | Confirm clearing the goal |

## Safety

`/goal` is a **pacing** feature, not a sandbox. It keeps the agent working; it
does not constrain what the agent may do. Under an auto-approve or permissive
permission mode, unattended tool execution can occur, so the loop warns (or,
with `permissiveModePolicy: "refuse"`, stops) when it infers such a mode.

Guards that always apply: the anti-spin threshold, the turn cap, the out-of-band
kill switch, and a hard stop on evaluator failure.

## Requirements

The TUI entrypoint needs a `tsconfig.json` beside it pinning
`"jsxImportSource": "@opentui/solid"` — without it the JSX compiles against
React's runtime and the TUI half will not load. It ships with the package.
