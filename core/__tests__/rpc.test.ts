/**
 * Independent tests for the shared RPC definition (spec §6.2, T-8).
 *
 * Expectations from `docs/specs/goal-plugin-v1.md` §6.2: the method/event set,
 * each method has input and output, each event has a schema, `setConfig` is
 * removed (T-8), and the schemas validate at runtime.
 */

import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { goalRpc } from "../../rpc";

const decode = (schema: never) => Schema.decodeSync(schema as never) as (v: unknown) => unknown;

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
    expect(
      d({ antiSpinThreshold: 3, turnCap: 50, permissiveModePolicy: "warn" }),
    ).toEqual({ antiSpinThreshold: 3, turnCap: 50, permissiveModePolicy: "warn" });
    expect(() => d({ antiSpinThreshold: "3", turnCap: 50, permissiveModePolicy: "warn" })).toThrow();
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
