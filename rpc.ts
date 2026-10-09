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
 * read-only `config`. Those limits are set only through the configuration
 * surface of spec §9: `ctx.options`, `.opencode/goal.json`, then the
 * `OPENCODE_GOAL_*` environment (lowest to highest).
 *
 * NOTE (2026-10-09): was deleted during the zero-import rewrite under a ruling
 * that has since been RETRACTED — bare specifiers DO resolve from a discovered
 * plugin directory (progress.md, "RETRACTED"). Restored verbatim from `ab7b678^`.
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
        /** Cost/egress caps (spec §9), added 2026-10-09. */
        transcriptMaxMessageChars: Schema.Number,
        transcriptMaxTotalChars: Schema.Number,
        evaluatorMaxAttempts: Schema.Number,
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

// ---------------------------------------------------------------------------
// Portable form — the shape both endpoints actually need
// ---------------------------------------------------------------------------
//
// `Rpc.define` accepts Effect `Schema` values, but **every consumer requires a
// `Rpc.PortableDefinition`** whose schemas are `StandardSchemaV1 | JsonSchema`:
//
//   - `RpcDomain.register`  → `register<const D extends Rpc.PortableDefinition>`
//   - `RpcApi` (the client) → `<D extends Rpc.PortableDefinition>(definition: D)`
//
// Effect schemas are not structurally `StandardSchemaV1` (they carry no
// `~standard` until converted), so the definition is converted once, here, and
// both the server (`index.ts`) and the TUI (`tui.tsx`) import this form. The
// contracts document's worked example passes raw Effect schemas to `register`;
// the installed `.d.ts` rejects that — verified by compiling this file.

type PortableInputSchema = Parameters<typeof Schema.toStandardSchemaV1>[0];

function toPortable<const S extends PortableInputSchema>(schema: S) {
  return Schema.toStandardSchemaV1(schema);
}

export const portableGoalRpc = {
  id: goalRpc.id,
  methods: {
    status: {
      input: toPortable(goalRpc.methods.status.input),
      output: toPortable(goalRpc.methods.status.output),
    },
    clear: {
      input: toPortable(goalRpc.methods.clear.input),
      output: toPortable(goalRpc.methods.clear.output),
    },
    config: {
      input: toPortable(goalRpc.methods.config.input),
      output: toPortable(goalRpc.methods.config.output),
    },
  },
  events: {
    changed: { schema: toPortable(goalRpc.events.changed.schema) },
    warning: { schema: toPortable(goalRpc.events.warning.schema) },
  },
};

/** The portable definition's inferred type. */
export type PortableGoalRpc = typeof portableGoalRpc;
