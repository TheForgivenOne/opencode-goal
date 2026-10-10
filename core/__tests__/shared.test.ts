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
import { isDuplicateInvocation, sharedMap } from "../shared";

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

/**
 * The `/goal` command handler is registered once per plugin load, so a single
 * invocation runs it several times. A live session shows the cost: `Goal set:
 * inspect` twice, ~50 ms apart, each with its own directive.
 */
describe("isDuplicateInvocation", () => {
  test("first sight is not a duplicate; the immediate repeat is", () => {
    expect(isDuplicateInvocation("dedupe-basic", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-basic", 2000, 1050)).toBe(true); // ~50 ms, as observed
  });

  test("outside the window is a fresh invocation again", () => {
    expect(isDuplicateInvocation("dedupe-window", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-window", 2000, 3001)).toBe(false);
  });

  test("the window is inclusive at its boundary", () => {
    expect(isDuplicateInvocation("dedupe-boundary", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-boundary", 2000, 3000)).toBe(true);
  });

  test("a different key is never suppressed, so `/goal a` then `/goal b` applies b", () => {
    expect(isDuplicateInvocation("dedupe-ses\u0000/goal a", 2000, 1000)).toBe(false);
    expect(isDuplicateInvocation("dedupe-ses\u0000/goal b", 2000, 1010)).toBe(false);
  });

  test("state is process-wide, so a second plugin load sees the first's record", () => {
    const key = "dedupe-cross-instance";
    expect(isDuplicateInvocation(key, 2000, 1000)).toBe(false);
    expect(sharedMap<string, number>("invocations").has(key)).toBe(true);
    expect(isDuplicateInvocation(key, 2000, 1010)).toBe(true);
  });
});
