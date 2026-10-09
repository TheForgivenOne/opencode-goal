/**
 * Tests for `core/shared.ts` — the cross-instance state registry.
 *
 * The behaviour these protect was measured live, not invented: the plugin
 * entrypoint was loaded 5 times in a single server process with 33 watcher
 * subscriptions for it, and because each load re-evaluates the module, the
 * per-instance `runs` map let a human prompt start a second loop for a session
 * (every evaluation doubled, two directives injected with no turn between them).
 */
import { describe, expect, test } from "bun:test";
import { sharedMap } from "../shared";

const host = globalThis as unknown as Record<string, unknown>;

describe("sharedMap", () => {
  test("returns the same map for the same name, so two instances share it", () => {
    const first = sharedMap<string, number>("regression-same");
    const second = sharedMap<string, number>("regression-same");
    expect(second).toBe(first);
  });

  test("state written through one lookup is visible through the next", () => {
    sharedMap<string, number>("regression-visible").set("k", 7);
    expect(sharedMap<string, number>("regression-visible").get("k")).toBe(7);
  });

  test("the registry lives on globalThis, which is what makes it process-wide", () => {
    const map = sharedMap<string, number>("regression-host");
    expect(host["__opencodeGoalShared__regression-host"]).toBe(map);
  });

  test("different names are isolated", () => {
    expect(sharedMap("regression-a")).not.toBe(sharedMap("regression-b"));
  });

  test("a map left on globalThis is reused rather than replaced", () => {
    const name = "regression-reuse";
    const seeded = new Map<string, string>([["seeded", "yes"]]);
    host[`__opencodeGoalShared__${name}`] = seeded;
    expect(sharedMap<string, string>(name)).toBe(seeded);
    expect(sharedMap<string, string>(name).get("seeded")).toBe("yes");
  });

  test("a non-map value on globalThis is replaced, not trusted", () => {
    const name = "regression-junk";
    host[`__opencodeGoalShared__${name}`] = "not-a-map";
    const map = sharedMap<string, string>(name);
    expect(map).toBeInstanceOf(Map);
    expect(host[`__opencodeGoalShared__${name}`]).toBe(map);
  });
});
