# opencode-goal

[![test](https://github.com/TheForgivenOne/opencode-goal/actions/workflows/test.yml/badge.svg)](https://github.com/TheForgivenOne/opencode-goal/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`/goal` for OpenCode V2 — set a completion condition, and the agent works
toward it in unattended turns until a model judges the condition met.

Ported from Claude Code's `/goal`.

You set the finish line once. Instead of you prompting, checking, and prompting
again, the loop keeps the agent working and asks a **separate evaluator model**
whether you're there yet.

## Install

```sh
opencode plugin add github:TheForgivenOne/opencode-goal
```

Or clone this repo and place the directory at
`~/.config/opencode/plugins/opencode-goal/`. That directory is a global
discovery directory, so **no config entry is needed**; `opencode plugin list`
should show it.

> **Not on npm.** The name `opencode-goal` on npm belongs to an unrelated
> V1-era plugin, so `opencode plugin add opencode-goal` would install *that*
> one rather than this. Install from GitHub as shown above.

## Usage

| Command | Effect |
|---|---|
| `/goal <condition>` | Set the condition and start the loop |
| `/goal` | Show status (condition, elapsed, turns, token spend, latest reason) |
| `/goal clear` | Stop the loop and clear the goal |

The loop starts turns on its own. It stops when the condition is judged **met**
(goal achieved), **impossible**, or a guard fires — and it stays dormant after
that, resuming on your next message.

## How it works

```
  /goal "tests pass"          the condition is stored, state = active
        │
        ▼
  inject a directive ───────► schedules one turn for the agent
        │                          │
        │                          ▼
        │                    the agent takes the turn
        ▼                          │
  wait for the turn to end ◄───────┘
        │
        ▼
  EVALUATE ──► a tool-less scratch session, a separate evaluator model
               transcript + your condition  ──►  MET | IMPOSSIBLE | NOT YET MET
        │
        ├── MET / IMPOSSIBLE ──► done: the goal is achieved, or ruled out
        │
        └── NOT YET MET ──► inject the next directive ──┐
                                                         │
                            └────────────────────────────┘
```

Three decisions worth knowing:

1. **Directives are sent as synthetic messages, not prompts.** That is what makes
   *your* messages distinguishable from the loop's: a real user message means a
   human spoke, so the counters reset and the loop gets a fresh budget.
2. **Evaluation runs in its own tool-less session** (`goal-evaluator:<session>`),
   so the evaluator never touches your repo and never contaminates the working
   session's context.
3. **The evaluator is a separate model, picked automatically** — preferring
   available paid models over free ones, excluding the model the working session
   is using, and falling back to the next candidate when one is deprecated or
   unusable.

`IMPOSSIBLE` is deliberately narrow: it means the transcript already establishes
that the condition can never hold. Being large, slow, expensive, or needing many
turns is **not** impossible — the loop accumulates work across turns.

## What stops it

| Stop | When | Result |
|---|---|---|
| verdict | evaluator says MET or IMPOSSIBLE | resolved |
| anti-spin | N turns in a row with **no tool call at all** | stops, goal stays set |
| turn cap | N turns started by the loop | stops, goal stays set |
| `/goal clear` | you ask | goal removed |
| kill switch | `OPENCODE_GOAL_DISABLE=1` or `.opencode/goal.kill` | stops, goal stays set |
| evaluator failure | transport or unexpected error | stops, goal stays set |

Every stop except the first **leaves the goal set but dormant** — your next
message resumes it.

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
  "antiSpinThreshold": 10,
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
| `antiSpinThreshold` | `10` | Consecutive **no-tool** turns before the loop stops |
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

An invalid value is reported and ignored, and **the next lower layer stays in
effect** — in every layer, not just the environment. A mistyped
`OPENCODE_GOAL_TURNCAP` does not discard a valid `.opencode/goal.json` or
`ctx.options` value; the built-in default applies only when no layer supplies a
valid value.

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

**What stops a run.** `antiSpinThreshold` counts consecutive turns in which the
agent used **no tool at all**. A goal whose turns call tools never reaches it;
it fires when the agent keeps answering without doing anything — which usually
means it cannot make progress on that condition. Reaching it is not a failure:
the goal stays set and a plain message from you resumes the loop with a fresh
budget. Raise `antiSpinThreshold` (up to 25) for goals that legitimately reason
for many turns before acting.

## Requirements

The TUI entrypoint needs a `tsconfig.json` beside it pinning
`"jsxImportSource": "@opentui/solid"` — without it the JSX compiles against
React's runtime and the TUI half will not load. It ships with the package.
