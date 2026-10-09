/**
 * Independent tests for the shared RPC definition (spec §6.2, T-8).
 *
 * Expectations from `docs/specs/goal-plugin-v1.md` §6.2: the method/event set,
 * each method has input and output, each event has a schema, `setConfig` is
 * removed (T-8), and the schemas validate at runtime.
 */

import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { goalRpc, portableGoalRpc } from "../../rpc";

// `Schema.decodeSync` is generic over the codec type; the tests only care that
// the schema validates, so the codec is erased here. Typed `unknown` rather than
// `never` so the call sites below typecheck.
const decode = (schema: unknown) =>
  Schema.decodeSync(schema as never) as unknown as (v: unknown) => unknown;

describe("goalRpc surface (spec §6.2)", () => {
  it("has id 'goal'", () => {
    expect(goalRpc.id).toBe("goal");
  });

  it("exposes exactly the methods status, clear and config", () => {
    expect(Object.keys(goalRpc.methods).sort()).toEqual(["clear", "config", "status"]);
  });

  it("exposes exactly the events changed and warning", () => {
    expect(Object.keys(goalRpc.events).sort()).toEqual(["changed", "warning"]);
  });

  it("does NOT expose setConfig (T-8: the RPC cannot raise the feature's own limits)", () => {
    expect("setConfig" in goalRpc.methods).toBe(false);
    expect((goalRpc.methods as Record<string, unknown>).setConfig).toBeUndefined();
  });

  it("gives every method a non-null input and output", () => {
    for (const [name, method] of Object.entries(goalRpc.methods)) {
      expect(method.input, `${name}.input`).toBeDefined();
      expect(method.input, `${name}.input`).not.toBeNull();
      expect(method.output, `${name}.output`).toBeDefined();
      expect(method.output, `${name}.output`).not.toBeNull();
    }
  });

  it("gives every event a schema", () => {
    for (const [name, event] of Object.entries(goalRpc.events)) {
      expect(event.schema, `${name}.schema`).toBeDefined();
      expect(event.schema, `${name}.schema`).not.toBeNull();
    }
  });
});

describe("goalRpc schemas validate at runtime (spec §6.2)", () => {
  it("status input accepts {sessionID} and rejects a missing/non-string sessionID", () => {
    const d = decode(goalRpc.methods.status.input);
    expect(d({ sessionID: "s1" })).toEqual({ sessionID: "s1" });
    expect(() => d({})).toThrow();
    expect(() => d({ sessionID: 123 })).toThrow();
  });

  it("status output accepts 'none' and rejects an unknown kind literal", () => {
    const d = decode(goalRpc.methods.status.output);
    expect(d({ kind: "none" })).toEqual({ kind: "none" });
    expect(d({ kind: "active", condition: "c", turnsEvaluated: 1 })).toEqual({
      kind: "active",
      condition: "c",
      turnsEvaluated: 1,
    });
    expect(() => d({ kind: "bogus" })).toThrow();
  });

  it("clear input/output validate and reject malformed values", () => {
    expect(decode(goalRpc.methods.clear.input)({ sessionID: "s1" })).toEqual({ sessionID: "s1" });
    const out = decode(goalRpc.methods.clear.output);
    expect(out({ cleared: true, message: "No goal set" })).toEqual({
      cleared: true,
      message: "No goal set",
    });
    expect(() => out({ cleared: "yes", message: "x" })).toThrow();
    expect(() => out({ cleared: true })).toThrow(); // message required
  });

  it("config output validates and rejects a wrong-typed field", () => {
    const d = decode(goalRpc.methods.config.output);
    const valid = {
      antiSpinThreshold: 3,
      turnCap: 50,
      permissiveModePolicy: "warn",
      transcriptMaxMessageChars: 8000,
      transcriptMaxTotalChars: 48000,
      evaluatorMaxAttempts: 5,
    };
    expect(d(valid)).toEqual(valid);
    expect(() => d({ ...valid, antiSpinThreshold: "3" })).toThrow();
    // The cost/egress caps are part of the contract and typed too.
    expect(() => d({ ...valid, evaluatorMaxAttempts: "5" })).toThrow();
    expect(() => d({ ...valid, transcriptMaxTotalChars: null })).toThrow();
  });

  it("changed event schema accepts a valid payload and rejects a missing sessionID", () => {
    const d = decode(goalRpc.events.changed.schema);
    expect(d({ sessionID: "s1", kind: "active" })).toEqual({ sessionID: "s1", kind: "active" });
    expect(() => d({ kind: "active" })).toThrow();
  });

  it("warning event schema accepts a valid payload and rejects a missing reason", () => {
    const d = decode(goalRpc.events.warning.schema);
    expect(d({ sessionID: "s1", reason: "boom" })).toEqual({ sessionID: "s1", reason: "boom" });
    expect(() => d({ sessionID: "s1" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// portableGoalRpc — the form BOTH consumers require
// ---------------------------------------------------------------------------
//
// `RpcDomain.register` and `RpcApi` (the TUI client) are both constrained to
// `Rpc.PortableDefinition`, whose schemas are `StandardSchemaV1 | JsonSchema`.
// Effect schemas are not structurally StandardSchemaV1 until converted, so this
// exported form is what the server registers and what the TUI passes to
// `context.client.rpc(...)`.

describe("portableGoalRpc (spec §6.2)", () => {
  it("mirrors the definition's id, methods and events", () => {
    expect(portableGoalRpc.id).toBe(goalRpc.id);
    expect(Object.keys(portableGoalRpc.methods).sort()).toEqual(
      Object.keys(goalRpc.methods).sort(),
    );
    expect(Object.keys(portableGoalRpc.events).sort()).toEqual(
      Object.keys(goalRpc.events).sort(),
    );
  });

  it("exposes every schema as a StandardSchemaV1 (~standard present)", () => {
    type Standard = { "~standard"?: unknown };
    for (const [name, method] of Object.entries(portableGoalRpc.methods)) {
      expect((method.input as Standard)["~standard"], `${name}.input`).toBeDefined();
      expect((method.output as Standard)["~standard"], `${name}.output`).toBeDefined();
    }
    for (const [name, event] of Object.entries(portableGoalRpc.events)) {
      expect((event.schema as Standard)["~standard"], `${name}.schema`).toBeDefined();
    }
  });

  it("validates through ~standard: accepts a good status input, rejects a bad one", () => {
    type Standard = {
      "~standard": { validate: (value: unknown) => { issues?: readonly unknown[] } };
    };
    const schema = portableGoalRpc.methods.status.input as unknown as Standard;
    expect(schema["~standard"].validate({ sessionID: "s1" }).issues).toBeUndefined();
    expect((schema["~standard"].validate({}).issues ?? []).length).toBeGreaterThan(0);
  });

  it("still does NOT expose setConfig (T-8)", () => {
    expect("setConfig" in portableGoalRpc.methods).toBe(false);
  });
});
