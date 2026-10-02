/**
 * Independent acceptance tests for core/config.ts.
 *
 * Expectations derived from acceptance criteria AC-38 / AC-39 and spec §9
 * (defaults, bounds, the T-3 ceilings, and the default permissive policy).
 */
import { describe, expect, test } from "bun:test";
import {
  ANTI_SPIN_MAX,
  ANTI_SPIN_MIN,
  DEFAULT_CONFIG,
  loadConfig,
  TURN_CAP_MAX,
  TURN_CAP_MIN,
} from "../config";

const DOCUMENTED_DEFAULT = {
  antiSpinThreshold: 3,
  turnCap: 50,
  evaluatorModel: undefined,
  permissiveModePolicy: "warn",
} as const;

describe("defaults (AC-38, spec §9)", () => {
  test("missing config (undefined) → documented defaults, no warnings", () => {
    const { config, warnings } = loadConfig(undefined);
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toEqual([]);
  });

  test("missing config (null) → defaults silently", () => {
    const { config, warnings } = loadConfig(null);
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toEqual([]);
  });

  test("empty object → defaults silently", () => {
    const { config, warnings } = loadConfig({});
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toEqual([]);
  });

  test("null on each known key is present-and-invalid (default + one warning per key naming the value)", () => {
    const { config, warnings } = loadConfig({
      antiSpinThreshold: null,
      turnCap: null,
      evaluatorModel: null,
      permissiveModePolicy: null,
    });
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toHaveLength(4);
    for (const warning of warnings) {
      expect(warning).toContain("null");
    }
    const joined = warnings.join("\n");
    expect(joined).toContain("antiSpinThreshold");
    expect(joined).toContain("turnCap");
    expect(joined).toContain("evaluatorModel");
    expect(joined).toContain("permissiveModePolicy");
  });

  test("DEFAULT_CONFIG carries the documented defaults", () => {
    expect(DEFAULT_CONFIG).toEqual(DOCUMENTED_DEFAULT);
  });

  test("documented bounds are 1..25 and 1..500 (spec §9)", () => {
    expect(ANTI_SPIN_MIN).toBe(1);
    expect(ANTI_SPIN_MAX).toBe(25);
    expect(TURN_CAP_MIN).toBe(1);
    expect(TURN_CAP_MAX).toBe(500);
  });
});

describe("valid values are accepted silently (AC-38)", () => {
  test("antiSpinThreshold 1 (min) accepted", () => {
    const { config, warnings } = loadConfig({ antiSpinThreshold: 1 });
    expect(config.antiSpinThreshold).toBe(1);
    expect(warnings).toEqual([]);
  });

  test("antiSpinThreshold 25 (max) accepted", () => {
    const { config, warnings } = loadConfig({ antiSpinThreshold: 25 });
    expect(config.antiSpinThreshold).toBe(25);
    expect(warnings).toEqual([]);
  });

  test("turnCap 1 (min) accepted", () => {
    const { config, warnings } = loadConfig({ turnCap: 1 });
    expect(config.turnCap).toBe(1);
    expect(warnings).toEqual([]);
  });

  test("turnCap 500 (max) accepted", () => {
    const { config, warnings } = loadConfig({ turnCap: 500 });
    expect(config.turnCap).toBe(500);
    expect(warnings).toEqual([]);
  });

  test("permissiveModePolicy 'warn' accepted", () => {
    const { config, warnings } = loadConfig({ permissiveModePolicy: "warn" });
    expect(config.permissiveModePolicy).toBe("warn");
    expect(warnings).toEqual([]);
  });

  test("permissiveModePolicy 'refuse' accepted", () => {
    const { config, warnings } = loadConfig({ permissiveModePolicy: "refuse" });
    expect(config.permissiveModePolicy).toBe("refuse");
    expect(warnings).toEqual([]);
  });

  test("evaluatorModel non-empty string passed through", () => {
    const { config, warnings } = loadConfig({ evaluatorModel: "anthropic/claude-haiku" });
    expect(config.evaluatorModel).toBe("anthropic/claude-haiku");
    expect(warnings).toEqual([]);
  });

  test("all valid values together, no warnings", () => {
    const { config, warnings } = loadConfig({
      antiSpinThreshold: 25,
      turnCap: 500,
      evaluatorModel: "x/y",
      permissiveModePolicy: "refuse",
    });
    expect(config).toEqual({
      antiSpinThreshold: 25,
      turnCap: 500,
      evaluatorModel: "x/y",
      permissiveModePolicy: "refuse",
    });
    expect(warnings).toEqual([]);
  });
});

describe("antiSpinThreshold out of range → default + warning naming the value (AC-39)", () => {
  for (const bad of [0, 26, -1, 100, 1000]) {
    test(`antiSpinThreshold ${bad}`, () => {
      const { config, warnings } = loadConfig({ antiSpinThreshold: bad });
      expect(config.antiSpinThreshold).toBe(3);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(String(bad));
    });
  }
});

describe("turnCap out of range → default + warning naming the value (AC-39)", () => {
  for (const bad of [0, 501, -5, 100000]) {
    test(`turnCap ${bad}`, () => {
      const { config, warnings } = loadConfig({ turnCap: bad });
      expect(config.turnCap).toBe(50);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(String(bad));
    });
  }
});

describe("wrong types → default + warning (AC-39)", () => {
  const wrongTypes: Array<[string, unknown]> = [
    ["string numeric", "3"],
    ["non-integer float", 2.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["boolean", true],
    ["array", []],
    ["object", {}],
  ];

  for (const [label, bad] of wrongTypes) {
    test(`antiSpinThreshold accepts only integers: ${label}`, () => {
      const { config, warnings } = loadConfig({ antiSpinThreshold: bad });
      expect(config.antiSpinThreshold).toBe(3);
      expect(warnings).toHaveLength(1);
    });

    test(`turnCap accepts only integers: ${label}`, () => {
      const { config, warnings } = loadConfig({ turnCap: bad });
      expect(config.turnCap).toBe(50);
      expect(warnings).toHaveLength(1);
    });
  }
});

describe("permissiveModePolicy invalid → default 'warn' + warning (AC-39, spec §9)", () => {
  for (const bad of ["banana", "WARN", "Refuse", "", 7, true]) {
    test(`permissiveModePolicy ${JSON.stringify(bad)}`, () => {
      const { config, warnings } = loadConfig({ permissiveModePolicy: bad });
      expect(config.permissiveModePolicy).toBe("warn");
      expect(warnings).toHaveLength(1);
    });
  }

  test("the warning names the offending value", () => {
    const { warnings } = loadConfig({ permissiveModePolicy: "banana" });
    expect(warnings[0]).toContain("banana");
  });
});

describe("evaluatorModel invalid → undefined + warning (AC-39, spec §9)", () => {
  for (const bad of ["", "   ", 42, true, {}]) {
    test(`evaluatorModel ${JSON.stringify(bad)}`, () => {
      const { config, warnings } = loadConfig({ evaluatorModel: bad });
      expect(config.evaluatorModel).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });
  }
});

describe("multiple invalid values each warn once, naming the value (AC-39)", () => {
  test("four invalid values → four warnings", () => {
    const { config, warnings } = loadConfig({
      antiSpinThreshold: 999,
      turnCap: 777,
      evaluatorModel: "",
      permissiveModePolicy: "nope",
    });
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toHaveLength(4);

    const joined = warnings.join("\n");
    expect(joined).toContain("999");
    expect(joined).toContain("777");
    expect(joined).toContain("nope");
    // The empty evaluatorModel has no value token; the warning must at least
    // identify which setting was invalid.
    expect(joined).toContain("evaluatorModel");
  });
});
