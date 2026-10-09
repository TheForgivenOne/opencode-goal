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
  EVALUATOR_ATTEMPTS_MAX,
  EVALUATOR_ATTEMPTS_MIN,
  loadConfig,
  resolveConfigFrom,
  TRANSCRIPT_MESSAGE_MAX,
  TRANSCRIPT_MESSAGE_MIN,
  TRANSCRIPT_TOTAL_MAX,
  TRANSCRIPT_TOTAL_MIN,
  TURN_CAP_MAX,
  TURN_CAP_MIN,
} from "../config";

const DOCUMENTED_DEFAULT = {
  antiSpinThreshold: 10,
  turnCap: 50,
  evaluatorModel: undefined,
  permissiveModePolicy: "warn",
  transcriptMaxMessageChars: 8000,
  transcriptMaxTotalChars: 48000,
  evaluatorMaxAttempts: 5,
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
      transcriptMaxMessageChars: 1000,
      transcriptMaxTotalChars: 9000,
      evaluatorMaxAttempts: 2,
    });
    expect(config).toEqual({
      antiSpinThreshold: 25,
      turnCap: 500,
      evaluatorModel: "x/y",
      permissiveModePolicy: "refuse",
      transcriptMaxMessageChars: 1000,
      transcriptMaxTotalChars: 9000,
      evaluatorMaxAttempts: 2,
    });
    expect(warnings).toEqual([]);
  });
});

describe("antiSpinThreshold out of range → default + warning naming the value (AC-39)", () => {
  for (const bad of [0, 26, -1, 100, 1000]) {
    test(`antiSpinThreshold ${bad}`, () => {
      const { config, warnings } = loadConfig({ antiSpinThreshold: bad });
      expect(config.antiSpinThreshold).toBe(10);
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
      expect(config.antiSpinThreshold).toBe(10);
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

// ---------------------------------------------------------------------------
// Cost / egress caps (added 2026-10-09): transcript bounds and candidate attempts
// ---------------------------------------------------------------------------

describe("cost and egress caps (defaults, bounds, validation)", () => {
  test("documented defaults are the evaluator's own constants", () => {
    expect(DEFAULT_CONFIG.transcriptMaxMessageChars).toBe(8000);
    expect(DEFAULT_CONFIG.transcriptMaxTotalChars).toBe(48000);
    expect(DEFAULT_CONFIG.evaluatorMaxAttempts).toBe(5);
  });

  test("bounds are sane and ordered", () => {
    expect(TRANSCRIPT_MESSAGE_MIN).toBeLessThan(TRANSCRIPT_MESSAGE_MAX);
    expect(TRANSCRIPT_TOTAL_MIN).toBeLessThan(TRANSCRIPT_TOTAL_MAX);
    expect(EVALUATOR_ATTEMPTS_MIN).toBe(1);
    expect(EVALUATOR_ATTEMPTS_MAX).toBeGreaterThan(EVALUATOR_ATTEMPTS_MIN);
  });

  test("in-range values are accepted silently", () => {
    const { config, warnings } = loadConfig({
      transcriptMaxMessageChars: TRANSCRIPT_MESSAGE_MIN,
      transcriptMaxTotalChars: TRANSCRIPT_TOTAL_MAX,
      evaluatorMaxAttempts: EVALUATOR_ATTEMPTS_MIN,
    });
    expect(config.transcriptMaxMessageChars).toBe(TRANSCRIPT_MESSAGE_MIN);
    expect(config.transcriptMaxTotalChars).toBe(TRANSCRIPT_TOTAL_MAX);
    expect(config.evaluatorMaxAttempts).toBe(EVALUATOR_ATTEMPTS_MIN);
    expect(warnings).toEqual([]);
  });

  test("out of range → default + warning naming the value", () => {
    const cases: Array<[keyof typeof DEFAULT_CONFIG, number, number]> = [
      ["transcriptMaxMessageChars", 10, 8000],
      ["transcriptMaxMessageChars", 10_000_000, 8000],
      ["transcriptMaxTotalChars", 0, 48000],
      ["transcriptMaxTotalChars", 10_000_000, 48000],
      ["evaluatorMaxAttempts", 0, 5],
      ["evaluatorMaxAttempts", 100, 5],
    ];
    for (const [key, bad, fallback] of cases) {
      const { config, warnings } = loadConfig({ [key]: bad });
      expect(config[key]).toBe(fallback);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(String(bad));
    }
  });

  test("wrong types → default + warning", () => {
    for (const bad of ["8000", 1.5, Number.NaN, true, {}, []]) {
      const { config, warnings } = loadConfig({ evaluatorMaxAttempts: bad });
      expect(config.evaluatorMaxAttempts).toBe(5);
      expect(warnings).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Layered resolution: defaults < options < goal.json < environment (spec §9)
// ---------------------------------------------------------------------------

describe("resolveConfigFrom — precedence", () => {
  test("no sources → defaults, no warnings", () => {
    const { config, warnings } = resolveConfigFrom({});
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toEqual([]);
  });

  test("plugin options alone are applied", () => {
    const { config, warnings } = resolveConfigFrom({ options: { turnCap: 7 } });
    expect(config.turnCap).toBe(7);
    expect(warnings).toEqual([]);
  });

  test("the file overrides plugin options", () => {
    const { config } = resolveConfigFrom({
      options: { turnCap: 7 },
      file: { turnCap: 9 },
    });
    expect(config.turnCap).toBe(9);
  });

  test("the environment overrides the file", () => {
    const { config } = resolveConfigFrom({
      options: { turnCap: 7 },
      file: { turnCap: 9 },
      env: { OPENCODE_GOAL_TURNCAP: "11" },
    });
    expect(config.turnCap).toBe(11);
  });

  test("every environment variable maps to its key", () => {
    const { config, warnings } = resolveConfigFrom({
      env: {
        OPENCODE_GOAL_ANTISPIN: "5",
        OPENCODE_GOAL_TURNCAP: "6",
        OPENCODE_GOAL_EVAL_MODEL: "p/m",
        OPENCODE_GOAL_PERMISSIVE: "refuse",
        OPENCODE_GOAL_TRANSCRIPT_MESSAGE: "1000",
        OPENCODE_GOAL_TRANSCRIPT_TOTAL: "2000",
        OPENCODE_GOAL_EVAL_ATTEMPTS: "4",
      },
    });
    expect(config.antiSpinThreshold).toBe(5);
    expect(config.turnCap).toBe(6);
    expect(config.evaluatorModel).toBe("p/m");
    expect(config.permissiveModePolicy).toBe("refuse");
    expect(config.transcriptMaxMessageChars).toBe(1000);
    expect(config.transcriptMaxTotalChars).toBe(2000);
    expect(config.evaluatorMaxAttempts).toBe(4);
    expect(warnings).toEqual([]);
  });
});

describe("resolveConfigFrom — the ignored-invalid-env-override defect (regression)", () => {
  test("an invalid env value must NOT erase a valid file value", () => {
    const { config, warnings } = resolveConfigFrom({
      file: { turnCap: 9 },
      env: { OPENCODE_GOAL_TURNCAP: "50x" },
    });
    // Before the fix this returned the built-in default 50: the raw env string was
    // written into the merge map and failed validation later.
    expect(config.turnCap).toBe(9);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OPENCODE_GOAL_TURNCAP");
    expect(warnings[0]).toContain("ignoring this environment override");
  });

  test("an invalid env value must NOT erase a valid plugin option", () => {
    const { config } = resolveConfigFrom({
      options: { turnCap: 8 },
      env: { OPENCODE_GOAL_TURNCAP: "" },
    });
    expect(config.turnCap).toBe(8);
  });

  test("with no lower layer, an invalid env value falls back to the default", () => {
    const { config, warnings } = resolveConfigFrom({ env: { OPENCODE_GOAL_TURNCAP: "nope" } });
    expect(config.turnCap).toBe(50);
    expect(warnings).toHaveLength(1);
  });

  test("an out-of-range env value is rejected like a malformed one", () => {
    const { config, warnings } = resolveConfigFrom({
      file: { antiSpinThreshold: 4 },
      env: { OPENCODE_GOAL_ANTISPIN: "999" },
    });
    expect(config.antiSpinThreshold).toBe(4);
    expect(warnings[0]).toContain("OPENCODE_GOAL_ANTISPIN");
  });

  test("an invalid env policy falls back to the file policy, not 'warn'", () => {
    const { config } = resolveConfigFrom({
      file: { permissiveModePolicy: "refuse" },
      env: { OPENCODE_GOAL_PERMISSIVE: "banana" },
    });
    expect(config.permissiveModePolicy).toBe("refuse");
  });
});

describe("resolveConfigFrom — malformed layers", () => {
  test("non-object options and file are ignored (not crashed on)", () => {
    const { config, warnings } = resolveConfigFrom({
      options: "not-an-object",
      file: [1, 2, 3],
    });
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toEqual([]);
  });

  test("null options and file are ignored", () => {
    const { config, warnings } = resolveConfigFrom({ options: null, file: null });
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toEqual([]);
  });

  test("an invalid value in the file still falls back to the default with a warning", () => {
    const { config, warnings } = resolveConfigFrom({ file: { turnCap: null } });
    expect(config.turnCap).toBe(50);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("turnCap");
  });

  test("unknown keys in any layer are ignored", () => {
    const { config, warnings } = resolveConfigFrom({
      options: { nope: 1 },
      file: { alsoNope: true },
      env: { OPENCODE_GOAL_UNKNOWN: "x" },
    });
    expect(config).toEqual(DOCUMENTED_DEFAULT);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bounds pinned BY VALUE — the tests above use the constants as both input and
// expected, so they cannot detect a wrong bound. These can (review finding T1).
// ---------------------------------------------------------------------------

describe("documented bounds are pinned by value, not self-referentially (regression)", () => {
  test("the transcript and attempt bounds cannot drift unnoticed", () => {
    expect(TRANSCRIPT_MESSAGE_MIN).toBe(200);
    expect(TRANSCRIPT_MESSAGE_MAX).toBe(200_000);
    expect(TRANSCRIPT_TOTAL_MIN).toBe(200);
    expect(TRANSCRIPT_TOTAL_MAX).toBe(2_000_000);
    expect(EVALUATOR_ATTEMPTS_MIN).toBe(1);
    expect(EVALUATOR_ATTEMPTS_MAX).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// An invalid value in a HIGHER layer must not erase a valid LOWER layer.
// The env layer was fixed first; the options/file layers had the same defect
// (independent-review finding 1) and are fixed here.
// ---------------------------------------------------------------------------

describe("resolveConfigFrom — a higher invalid layer must not erase a lower valid one (regression)", () => {
  test("an invalid file value leaves a valid ctx.options value in effect", () => {
    const { config, warnings } = resolveConfigFrom({
      options: { turnCap: 7 },
      file: { turnCap: null },
    });
    expect(config.turnCap).toBe(7);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("turnCap");
    expect(warnings[0]).toContain("the goal config file");
  });

  test("an out-of-range file value likewise leaves the option in effect", () => {
    const { config, warnings } = resolveConfigFrom({
      options: { turnCap: 7 },
      file: { turnCap: 9999 },
    });
    expect(config.turnCap).toBe(7);
    expect(warnings).toHaveLength(1);
  });

  test("an invalid option falls through to the built-in default (nothing below it)", () => {
    const { config, warnings } = resolveConfigFrom({ options: { turnCap: "x" } });
    expect(config.turnCap).toBe(50);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the plugin options");
  });

  test("an invalid file value warns and names its layer", () => {
    const { config, warnings } = resolveConfigFrom({ file: { antiSpinThreshold: -1 } });
    expect(config.antiSpinThreshold).toBe(10);
    expect(warnings[0]).toContain("the goal config file");
  });

  test("a valid env value still wins over both lower layers", () => {
    const { config } = resolveConfigFrom({
      options: { turnCap: 7 },
      file: { turnCap: 8 },
      env: { OPENCODE_GOAL_TURNCAP: "9" },
    });
    expect(config.turnCap).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// A `__proto__` key in a parsed JSON file must not inject configuration
// (independent-review finding 3).
// ---------------------------------------------------------------------------

describe("resolveConfigFrom — prototype safety (regression)", () => {
  test("a __proto__ payload in the parsed file is ignored", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"turnCap":123}}');
    const { config, warnings } = resolveConfigFrom({ file: parsed });
    expect(config.turnCap).toBe(50);
    expect(warnings).toEqual([]);
  });

  test("the accumulator is not given a polluted prototype", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"turnCap":123}}');
    const { config } = resolveConfigFrom({ file: parsed, options: { turnCap: 6 } });
    expect(config.turnCap).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Cross-field: a per-message cap above the total budget would leave the
// evaluator judging from nothing (independent-review finding 2).
// ---------------------------------------------------------------------------

describe("transcript caps — the total must not be smaller than the per-message cap", () => {
  test("a total below the per-message cap is clamped with a warning", () => {
    const { config, warnings } = loadConfig({
      transcriptMaxMessageChars: 200_000,
      transcriptMaxTotalChars: 200,
    });
    expect(config.transcriptMaxMessageChars).toBe(200);
    expect(config.transcriptMaxTotalChars).toBe(200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("transcriptMaxTotalChars");
  });

  test("equal values are accepted silently", () => {
    const { config, warnings } = loadConfig({
      transcriptMaxMessageChars: 1000,
      transcriptMaxTotalChars: 1000,
    });
    expect(config.transcriptMaxMessageChars).toBe(1000);
    expect(warnings).toEqual([]);
  });

  test("the default pair is not clamped", () => {
    const { config, warnings } = loadConfig({});
    expect(warnings).toEqual([]);
    expect(config.transcriptMaxMessageChars).toBeLessThanOrEqual(config.transcriptMaxTotalChars);
  });
});

describe("null on each of the three new keys is present-and-invalid (review finding T3)", () => {
  test("each defaults with one warning naming the value", () => {
    const { config, warnings } = loadConfig({
      transcriptMaxMessageChars: null,
      transcriptMaxTotalChars: null,
      evaluatorMaxAttempts: null,
    });
    expect(config.transcriptMaxMessageChars).toBe(8000);
    expect(config.transcriptMaxTotalChars).toBe(48000);
    expect(config.evaluatorMaxAttempts).toBe(5);
    expect(warnings).toHaveLength(3);
    for (const warning of warnings) expect(warning).toContain("null");
  });
});
