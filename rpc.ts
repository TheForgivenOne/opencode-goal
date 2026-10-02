/**
 * Shared RPC definition for the `/goal` plugin (spec §6.2).
 *
 * Imported by both the server entrypoint (`index.ts`) and the TUI entrypoint
 * (`tui.tsx`): the server registers this definition with `ctx.rpc.register` and
 * emits through `registration.events.emit`; the TUI consumes the same
 * definition. No I/O, no state.
 *
 * Schemas use the `effect` `Schema` module, which is what `Plugin.Rpc.define`
 * accepts (`Tool.ValueSchema = Schema.Codec<...> | StandardSchemaV1 | JsonSchema`).
 * The spec's §6.2 sketch is reproduced faithfully here.
 *
 * T-8: `setConfig` is deliberately absent. The RPC exposes no mutator of the
 * feature's own safety limits — only `status`, `clear` (authority-reducing) and
 * read-only `config`. Those limits are set only through the file/env surface of
 * spec §9.
 */

import { Schema } from "effect";
import { Rpc } from "@opencode/plugin/rpc";

/** The single RPC definition shared by the server and the TUI (spec §6.2). */
export const goalRpc = Rpc.define({
  id: "goal",
  methods: {
    status: {
      input: Schema.Struct({ sessionID: Schema.String }),
      output: Schema.Struct({
        kind: Schema.Literals(["none", "active", "achieved", "failed"]),
        condition: Schema.optional(Schema.String),
        elapsedMs: Schema.optional(Schema.Number),
        turnsEvaluated: Schema.optional(Schema.Number),
        tokensSpent: Schema.optional(Schema.Number),
        lastReason: Schema.optional(Schema.String),
        state: Schema.optional(Schema.String),
      }),
    },
    clear: {
      input: Schema.Struct({ sessionID: Schema.String }),
      output: Schema.Struct({
        cleared: Schema.Boolean,
        condition: Schema.optional(Schema.String),
        /** Exactly the AC-9 / AC-10 text. */
        message: Schema.String,
      }),
    },
    config: {
      input: Schema.Struct({}),
      output: Schema.Struct({
        antiSpinThreshold: Schema.Number,
        turnCap: Schema.Number,
        evaluatorModel: Schema.optional(Schema.String),
        /** Spec §7.2: the resolved `provider/model`, surfaced for the TUI. */
        resolvedEvaluatorModel: Schema.optional(Schema.String),
        evaluatorProvider: Schema.optional(Schema.String),
        permissiveModePolicy: Schema.String,
      }),
    },
  },
  events: {
    changed: {
      schema: Schema.Struct({
        sessionID: Schema.String,
        kind: Schema.String,
        condition: Schema.optional(Schema.String),
        reason: Schema.optional(Schema.String),
      }),
    },
    warning: {
      schema: Schema.Struct({
        sessionID: Schema.String,
        reason: Schema.String,
      }),
    },
  },
});

/** The definition's inferred type, for later server/TUI phases. */
export type GoalRpc = typeof goalRpc;
