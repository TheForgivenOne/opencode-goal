/**
 * The `/goal` server entrypoint (spec §2, §3, §6.1, §8).
 *
 * **Zero-import shape.** Plain `export default { id, setup }` — the shape round
 * 1's spike proved loads and round 2 proved can register a command via
 * `ctx.command.transform`. It is deliberately **not** `Plugin.define`, and it
 * imports **no bare specifier**. A plugin loaded from a local directory cannot
 * resolve bare specifiers (`@opencode/plugin`, `effect`): the resolution base is
 * the binary's own module graph, not the plugin directory, so any such import
 * makes the plugin fail to load and the loader retries on every request
 * (progress.md, "INCIDENT" and "The architectural blocker — local plugins cannot
 * import"). Only relative imports into `core/` are used here.
 *
 * **RPC is restored (2026-10-09).** It was dropped during the zero-import rewrite
 * under a ruling since RETRACTED: bare specifiers DO resolve from a discovered
 * plugin directory, because the upward walk reaches `<repo>/node_modules`
 * (progress.md, "RETRACTED"). Registration degrades gracefully — if `ctx.rpc` is
 * absent or `register` throws, the loop and `/goal` still work and only the TUI
 * bridge is missing.
 *
 * Setup registers the `/goal` command and the event watchers, then returns a
 * `Cleanup` that disposes the registrations, aborts every live loop, and removes
 * the scratch evaluator sessions. It **never starts a loop at setup**: after a
 * reload the goal remains set but dormant (E11) and is resumed by the next human
 * prompt (AC-33).
 *
 * Setup is **defensive**: on a runtime where the context lacks a domain this
 * plugin needs, it logs and returns rather than throwing. A throw at load time
 * is not free on this runtime.
 *
 * G-4 defense. It was never verified what `invocation.prompt.text` contains when
 * arguments are supplied. Two readings are defended against:
 *   (a) the bare argument following `/goal` (A-N7's assumption), or
 *   (b) the argument *including* the leading `/goal` token.
 * {@link stripCommandToken} removes a leading `/goal` token (case-insensitive,
 * followed by whitespace or end-of-string) when present and otherwise passes the
 * text through unchanged, so both readings parse identically for an ordinary
 * invocation. A bare `goal` token without a slash is **not** stripped, because a
 * condition may legitimately begin with the word "goal"; the slash decides.
 *
 * Command output channel: the shipped `CommandDefinition.execute` returns
 * `Promise<void>` (contracts: `command.d.ts:14`), so the output strings of
 * AC-6..AC-10 are emitted as synthetic transcript entries (`resume:false`, so no
 * turn starts). This is a type-level correction of the spec's assumption A-N7
 * that `execute` returns the output string.
 */

import {
  abortAll,
  clearGoal,
  noteHumanPrompt,
  notePermissionAsk,
  noteToolUse,
  onSessionDeleted,
  resolveConfig,
  startGoal,
  stopSessionForNewConversation,
  type GoalLoopDeps,
  type LoopContext,
  type LoopNotifications,
} from "./core/loop";
import {
  formatEvaluatorModel,
  removeEvaluatorSession,
  resolveEvaluatorModel,
} from "./core/evaluator";
import {
  clearConfirmation,
  parseGoalArg,
  STATUS_NO_GOAL,
  tooLongMessage,
} from "./core/parser";
import { readGoal, scanGoals } from "./core/store";
import { installWatchers, type WatchContext } from "./core/watch";

import type { Plugin } from "@opencode/plugin";
import type { RpcRegistration } from "@opencode/plugin/promise/rpc";
import { portableGoalRpc } from "./rpc";

// ---------------------------------------------------------------------------
// Local structural typing (no bare imports)
// ---------------------------------------------------------------------------

/**
 * The command-invocation fields this entrypoint reads (spec §6.1). Declared
 * locally so the file needs no `@opencode/plugin` import; the shipped
 * `CommandInvocation` is `{ sessionID, prompt, delivery }`.
 */
interface GoalCommandInvocation {
  readonly sessionID: string;
  readonly prompt?: { readonly text?: string } | undefined;
}

interface GoalCommandEditor {
  add(definition: {
    readonly name: string;
    readonly description?: string;
    readonly execute: (input: GoalCommandInvocation) => Promise<void>;
  }): void;
}

interface GoalCommandContext {
  readonly transform: (
    callback: (editor: GoalCommandEditor) => void,
  ) => Promise<{ readonly dispose: () => Promise<void> }>;
}

/**
 * The slice of the plugin context this entrypoint uses. `LoopContext` and
 * `WatchContext` come from `core/`, whose domain types derive from the shipped
 * `@opencode/plugin` types via **type-only** imports. Type-only imports are
 * erased at runtime, so they add no bare specifier to this module's load graph.
 */
type GoalSetupContext = LoopContext &
  WatchContext & {
    readonly command: GoalCommandContext;
    /** `ctx.options` — the documented V2 option channel (spec §9). */
    readonly options?: Readonly<Record<string, unknown>>;
    /**
     * Present on the shipped server context. Optional here so registration can
     * degrade gracefully rather than fail the whole plugin: the round-2 spike
     * observed the RPC surface blocked, and the loop and `/goal` must still work
     * without the TUI bridge.
     */
    readonly rpc?: Plugin.Context["rpc"];
  };

/** A plugin cleanup, matching the shipped `Cleanup` shape. */
type Cleanup = () => Promise<void> | void;

/** Domains this plugin needs; a missing one is reported, never thrown over. */
const REQUIRED_DOMAINS = ["location", "session", "model", "storage", "command", "event"] as const;

/**
 * Return the names of required domains absent (or unusable) on `ctx`. Runtime
 * guard only — the static type says they exist; the runtime is what matters.
 */
function missingDomains(ctx: unknown): string[] {
  const record = (ctx ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  for (const name of REQUIRED_DOMAINS) {
    const value = record[name];
    if (value === undefined || value === null) {
      missing.push(name);
      continue;
    }
    // For the two domains we call a method on, requiring the method is more
    // honest than merely requiring the domain object.
    if (name === "command" && typeof (value as { transform?: unknown }).transform !== "function") {
      missing.push(name);
    }
    if (name === "event" && typeof (value as { subscribe?: unknown }).subscribe !== "function") {
      missing.push(name);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Command-argument handling (G-4)
// ---------------------------------------------------------------------------

/**
 * Return the argument text following `/goal`. If `raw` begins with the command
 * token `/goal` (optionally surrounded by leading whitespace), the token is
 * removed; otherwise `raw` is treated as the already-stripped argument.
 */
export function stripCommandToken(raw: string): string {
  const leading = raw.replace(/^\s+/, "");
  const match = /^\/goal(?:\s+|$)/i.exec(leading);
  if (match !== null) return leading.slice(match[0].length);
  return raw;
}

// ---------------------------------------------------------------------------
// Status formatting (AC-6/AC-7/AC-8)
// ---------------------------------------------------------------------------

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

async function statusText(sessionID: string, deps: GoalLoopDeps): Promise<string> {
  const { record } = await readGoal(sessionID, deps.ctx);
  if (record === null) return STATUS_NO_GOAL;

  const now = Date.now();
  if (record.state === "active") {
    // AC-6: five labelled, non-empty lines. "Latest reason" is never empty.
    return [
      `Condition: ${record.condition}`,
      `Elapsed: ${formatDuration(now - record.setAt)}`,
      `Turns evaluated: ${record.turnsEvaluated}`,
      `Token spend: ${record.tokensSpent}`,
      `Latest reason: ${record.lastReason !== "" ? record.lastReason : "(no evaluation yet)"}`,
    ].join("\n");
  }

  const duration = formatDuration((record.endedAt ?? now) - record.setAt);
  if (record.state === "achieved") {
    // AC-7: achieved condition, duration, turn count, spend; no "active" claim.
    return [
      `Goal achieved: ${record.condition}`,
      `Duration: ${duration}`,
      `Turns evaluated: ${record.turnsEvaluated}`,
      `Token spend: ${record.tokensSpent}`,
    ].join("\n");
  }

  return [
    `Goal failed: ${record.condition}`,
    `Reason: ${record.lastReason !== "" ? record.lastReason : "(none provided)"}`,
    `Duration: ${duration}`,
    `Turns evaluated: ${record.turnsEvaluated}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default {
  id: "opencode-goal",
  async setup(ctx: GoalSetupContext): Promise<Cleanup | void> {
    const missing = missingDomains(ctx);
    if (missing.length > 0) {
      console.warn(
        `[goal] setup skipped: plugin context is missing ${missing.join(", ")}; no command or watcher installed.`,
      );
      return;
    }

    const rootDir = String(ctx.location.directory);
    // `ctx.options` — the documented V2 option channel, read as the lowest
    // explicit configuration layer (spec §9).
    const pluginOptions: unknown = ctx.options;

    let rpcRegistration: RpcRegistration<typeof portableGoalRpc> | undefined;

    // RPC emissions are best-effort: a failed emit must never affect the loop.
    const notify: LoopNotifications = {
      changed: (payload) => {
        try {
          void rpcRegistration?.events.emit("changed", payload)?.catch?.(() => {});
        } catch {
          // Best effort.
        }
      },
      warning: (payload) => {
        try {
          void rpcRegistration?.events.emit("warning", payload)?.catch?.(() => {});
        } catch {
          // Best effort.
        }
      },
    };

    const deps: GoalLoopDeps = { ctx, rootDir, pluginOptions, notify };

    // --- RPC registration (spec §6.2). Degrades gracefully if unavailable. ---
    try {
      rpcRegistration = await ctx.rpc?.register(portableGoalRpc, {
        status: async (input) => {
          const { record } = await readGoal(input.sessionID, deps.ctx);
          if (record === null) return { kind: "none" as const };
          const now = Date.now();
          const base = {
            condition: record.condition,
            turnsEvaluated: record.turnsEvaluated,
            tokensSpent: record.tokensSpent,
            lastReason: record.lastReason,
            state: record.state,
          };
          if (record.state === "active") {
            return { kind: "active" as const, ...base, elapsedMs: now - record.setAt };
          }
          return {
            kind: record.state === "achieved" ? ("achieved" as const) : ("failed" as const),
            ...base,
            elapsedMs: (record.endedAt ?? now) - record.setAt,
          };
        },
        clear: async (input) => {
          const result = await clearGoal(input.sessionID, deps);
          return {
            cleared: result.cleared,
            ...(result.condition !== undefined ? { condition: result.condition } : {}),
            message:
              result.cleared && result.condition !== undefined
                ? clearConfirmation(result.condition)
                : STATUS_NO_GOAL,
          };
        },
        config: async () => {
          const { config } = resolveConfig(rootDir, pluginOptions);
          let resolvedEvaluatorModel: string | undefined;
          let evaluatorProvider: string | undefined;
          try {
            const resolved = await resolveEvaluatorModel(undefined, config, ctx);
            if (resolved.model !== undefined) {
              resolvedEvaluatorModel = formatEvaluatorModel(resolved.model);
              evaluatorProvider = resolved.model.providerID;
            }
          } catch {
            // Read-only surface; resolution failure leaves the fields absent.
          }
          return {
            antiSpinThreshold: config.antiSpinThreshold,
            turnCap: config.turnCap,
            ...(config.evaluatorModel !== undefined ? { evaluatorModel: config.evaluatorModel } : {}),
            ...(resolvedEvaluatorModel !== undefined ? { resolvedEvaluatorModel } : {}),
            ...(evaluatorProvider !== undefined ? { evaluatorProvider } : {}),
            permissiveModePolicy: config.permissiveModePolicy,
            transcriptMaxMessageChars: config.transcriptMaxMessageChars,
            transcriptMaxTotalChars: config.transcriptMaxTotalChars,
            evaluatorMaxAttempts: config.evaluatorMaxAttempts,
          };
        },
      });
    } catch {
      // RPC unavailable: the loop and command still work; the TUI bridge is absent.
      rpcRegistration = undefined;
    }

    // Emit the exact command-output strings as synthetic transcript entries. These
    // must not start a turn (AC-8), hence `resume:false`.
    const output = async (sessionID: string, text: string): Promise<void> => {
      try {
        await ctx.session.synthetic({ sessionID, text, resume: false });
      } catch {
        // Best-effort command output; never fail the command on delivery.
      }
    };

    // --- `/goal` command (spec §6.1). ---
    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description:
          "Set, inspect, or clear an autonomous goal. /goal <condition> starts working toward it; /goal clear (or stop/off/reset/none/cancel) stops the loop.",
        execute: async (invocation) => {
          const sessionID = invocation.sessionID !== undefined ? String(invocation.sessionID) : "";
          if (sessionID === "") {
            // E15: no session context — fail clearly rather than set an unevaluable goal.
            console.warn("[goal] /goal requires a session context; no goal was set.");
            return;
          }

          // G-4: tolerate either reading of `prompt.text`.
          const arg = stripCommandToken(invocation.prompt?.text ?? "");
          const parsed = parseGoalArg(arg);

          switch (parsed.kind) {
            case "status":
              await output(sessionID, await statusText(sessionID, deps));
              return;

            case "clear": {
              const result = await clearGoal(sessionID, deps);
              await output(
                sessionID,
                result.cleared && result.condition !== undefined
                  ? clearConfirmation(result.condition)
                  : STATUS_NO_GOAL,
              );
              return;
            }

            case "too-long":
              await output(sessionID, tooLongMessage(parsed.length));
              return;

            case "set":
              await startGoal(sessionID, parsed.condition, deps);
              return;
          }
        },
      });
    });

    // --- Event watchers (spec §8). ---
    const cleanupWatchers = installWatchers(
      ctx,
      (sessionID) => noteHumanPrompt(sessionID, deps),
      (sessionID) => noteToolUse(sessionID),
      {
        onPermissionAsk: (sessionID) => notePermissionAsk(sessionID),
        onSessionDeleted: (sessionID) => {
          void onSessionDeleted(sessionID, deps);
        },
        onSessionCreated: (_created, previousViewedSessionID) => {
          if (previousViewedSessionID !== undefined) {
            void stopSessionForNewConversation(previousViewedSessionID, deps);
          }
        },
      },
    );

    // E11: on reload the superseded instance aborts every loop and starts none.
    return async () => {
      cleanupWatchers();
      abortAll();
      try {
        await commandRegistration.dispose();
      } catch {
        // Disposal is best-effort.
      }
      try {
        await rpcRegistration?.dispose();
      } catch {
        // Disposal is best-effort.
      }
      rpcRegistration = undefined;
      // Remove scratch evaluator sessions for any surviving (dormant) record.
      try {
        const { goals } = await scanGoals(ctx);
        for (const goal of goals) {
          await removeEvaluatorSession(goal.sessionID, ctx);
        }
      } catch {
        // Unload cleanup is best-effort.
      }
    };
  },
};
