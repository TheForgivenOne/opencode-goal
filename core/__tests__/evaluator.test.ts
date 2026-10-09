/**
 * Independent tests for phase 2a's evaluator (spec §7, §5).
 *
 * Every expectation below is derived from `docs/specs/goal-plugin-v1.md`
 * (§7.2–§7.5, T-2, T-5) and `docs/requirements/acceptance-criteria-core-loop.md`
 * (AC-22, AC-27, AC-28, E6, E7). None was read off the implementation.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  NO_TOOLS,
  TRANSCRIPT_MAX_MESSAGE_CHARS,
  TRANSCRIPT_MAX_TOTAL_CHARS,
  TRANSCRIPT_TRUNCATION_MARKER,
  buildEvaluatorPrompt,
  clearEvaluatorSessionCache,
  crossProviderWarning,
  ensureEvaluatorSession,
  evaluate,
  findModelById,
  parseVerdict,
  removeEvaluatorSession,
  renderTranscript,
  resolveEvaluatorModel,
  selectEvaluatorModel,
  selectEvaluatorCandidates,
  isModelUnusableError,
  type EvaluatorContext,
  type SelectableModel,
  type WorkingModelRef,
} from "../evaluator";
import type { ResolvedConfig } from "../config";
import { createGoal } from "../record";

/** True if `s` contains an unpaired UTF-16 surrogate (i.e. a split code point). */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // low surrogate not preceded by a high one
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// §7.5 — parseVerdict: exactly three outcomes, leading-label precedence (E6/E7)
// ---------------------------------------------------------------------------

describe("parseVerdict (spec §7.5, E6/E7)", () => {
  it("parses MET and extracts the reason after the label", () => {
    const r = parseVerdict("MET: the tests all pass");
    expect(r.kind).toBe("met");
    expect(r.reason).toBe("the tests all pass");
  });

  it("is case-insensitive for the MET label", () => {
    expect(parseVerdict("met: done").kind).toBe("met");
    expect(parseVerdict("Met: done").kind).toBe("met");
  });

  it("parses IMPOSSIBLE", () => {
    const r = parseVerdict("IMPOSSIBLE: the file does not exist and cannot");
    expect(r.kind).toBe("impossible");
    expect(r.reason).toBe("the file does not exist and cannot");
  });

  it("is case-insensitive for the IMPOSSIBLE label", () => {
    expect(parseVerdict("impossible: nope").kind).toBe("impossible");
  });

  it("parses NOT YET MET", () => {
    const r = parseVerdict("NOT YET MET: keep going");
    expect(r.kind).toBe("not-yet-met");
    expect(r.reason).toBe("keep going");
  });

  it("is case-insensitive for the NOT YET MET label", () => {
    expect(parseVerdict("Not Yet Met: keep going").kind).toBe("not-yet-met");
  });

  it("gives leading-label precedence: 'Not yet met. If it turns out impossible…' is not-yet-met (E7)", () => {
    const r = parseVerdict("Not yet met. If it turns out impossible, stop.");
    expect(r.kind).toBe("not-yet-met");
  });

  it("gives leading-label precedence: an 'impossible' later in the text does not override MET", () => {
    const r = parseVerdict("MET: done. Though it would have been impossible.");
    expect(r.kind).toBe("met");
  });

  it("treats an unparseable reply as not-yet-met with the raw response as the reason (E6)", () => {
    const r = parseVerdict("banana split");
    expect(r.kind).toBe("not-yet-met");
    expect(r.reason).toBe("banana split");
  });

  it("only ever yields one of the three verdict kinds", () => {
    const samples = [
      "MET: x",
      "IMPOSSIBLE: x",
      "NOT YET MET: x",
      "met",
      "impossible",
      "not yet met",
      "",
      "gibberish",
      "12345",
    ];
    for (const s of samples) {
      expect(["not-yet-met", "met", "impossible"]).toContain(parseVerdict(s).kind);
    }
  });

  it("trims whitespace before matching the label", () => {
    expect(parseVerdict("   MET: yes").kind).toBe("met");
  });

  it("falls back to the trimmed label when no reason follows", () => {
    expect(parseVerdict("MET:").reason).toBe("MET:");
    expect(parseVerdict("NOT YET MET").reason).toBe("NOT YET MET");
  });

  it("exposes the original untrimmed reply as raw", () => {
    const raw = "  MET: yes  ";
    expect(parseVerdict(raw).raw).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// §7.4 — renderTranscript: all 11 union members, bounding, marker (AC-22)
// ---------------------------------------------------------------------------

describe("renderTranscript (spec §7.4, AC-22)", () => {
  it("exposes the specified budgets and marker", () => {
    expect(TRANSCRIPT_MAX_MESSAGE_CHARS).toBe(8000);
    expect(TRANSCRIPT_MAX_TOTAL_CHARS).toBe(48000);
    expect(TRANSCRIPT_TRUNCATION_MARKER).toBe("[...earlier messages omitted...]");
  });

  it("renders user as 'User: <text>'", () => {
    expect(renderTranscript([{ type: "user", text: "hello" }])).toBe("User: hello");
  });

  it("renders synthetic and system as 'System: <text>'", () => {
    expect(renderTranscript([{ type: "synthetic", text: "note" }])).toBe("System: note");
    expect(renderTranscript([{ type: "system", text: "note" }])).toBe("System: note");
  });

  it("renders skill as '[skill <name>]'", () => {
    expect(renderTranscript([{ type: "skill", name: "my-skill" }])).toBe("[skill my-skill]");
  });

  it("renders shell as '[shell <command> → <status>]'", () => {
    expect(renderTranscript([{ type: "shell", command: "ls -la", status: "ok" }])).toBe(
      "[shell ls -la → ok]",
    );
  });

  it("renders compaction as '[context compacted: <summary>]'", () => {
    expect(renderTranscript([{ type: "compaction", summary: "earlier work" }])).toBe(
      "[context compacted: earlier work]",
    );
  });

  it("omits idle, agent-switched, model-switched and location-switched", () => {
    for (const type of ["idle", "agent-switched", "model-switched", "location-switched"]) {
      expect(renderTranscript([{ type }])).toBe("");
    }
  });

  it("renders an assistant's text and tool items, omitting reasoning", () => {
    const out = renderTranscript([
      {
        type: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "tool", name: "bash", executed: true },
          { type: "tool", name: "read", executed: false },
          { type: "reasoning", text: "SECRET-REASONING" },
        ],
      },
    ]);
    expect(out).toBe("hello\n[tool bash]\n[tool read (denied)]");
    expect(out).not.toContain("SECRET-REASONING");
  });

  it("renders a tool marker with name only, discarding args and results (AC-22)", () => {
    const out = renderTranscript([
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "bash",
            executed: true,
            args: { command: "SECRET-ARGS" },
            result: "SECRET-RESULT",
          } as never,
        ],
      },
    ]);
    expect(out).toBe("[tool bash]");
    expect(out).not.toContain("SECRET-ARGS");
    expect(out).not.toContain("SECRET-RESULT");
  });

  it("joins kept messages oldest-first, newest last", () => {
    const out = renderTranscript([
      { type: "user", text: "first" },
      { type: "user", text: "second" },
    ]);
    expect(out).toBe("User: first\nUser: second");
  });

  it("caps a single message at the per-message budget", () => {
    const tail = "Z".repeat(200);
    const text = "A".repeat(9200) + tail;
    const out = renderTranscript([{ type: "user", text }]);
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_MESSAGE_CHARS);
    expect(out.startsWith("User: ")).toBe(true);
    expect(out).not.toContain(tail);
  });

  it("caps in code points and does not split a code point (no lone surrogate)", () => {
    // Non-BMP characters are two UTF-16 units; the ruled cap counts code points
    // (spec §7.4; phase-2a ruling), so 9 000 emoji is 9 000 code points and the
    // 8 000-code-point cap must clip it without bisecting a character.
    const out = renderTranscript([{ type: "user", text: "😀".repeat(9000) }]);
    expect([...out].length).toBeLessThanOrEqual(TRANSCRIPT_MAX_MESSAGE_CHARS);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("adds no marker when nothing was dropped", () => {
    const out = renderTranscript([
      { type: "user", text: "a" },
      { type: "user", text: "b" },
    ]);
    expect(out).not.toContain(TRANSCRIPT_TRUNCATION_MARKER);
  });

  it("adds no marker when a single message is clipped by the per-message cap but no messages are dropped", () => {
    const out = renderTranscript([{ type: "user", text: "A".repeat(9000) }]);
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_MESSAGE_CHARS);
    expect(out).not.toContain(TRANSCRIPT_TRUNCATION_MARKER);
  });

  it("truncates newest-first and marks it when the total budget is exceeded", () => {
    // 7 messages, each rendered 8000 chars (7994 text + "User: "), total 56006 > 48000.
    const text = (i: number) => `MSG${i} ` + "x".repeat(7994 - `MSG${i} `.length);
    const messages = Array.from({ length: 7 }, (_, i) => ({ type: "user", text: text(i) }));
    const out = renderTranscript(messages);
    expect(out).toContain(TRANSCRIPT_TRUNCATION_MARKER);
    expect(out).toContain("MSG6"); // newest kept
    expect(out).not.toContain("MSG0 "); // oldest dropped
    // every kept message is still within the per-message cap
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_TOTAL_CHARS + TRANSCRIPT_TRUNCATION_MARKER.length + 1);
  });

  it("keeps both messages when their rendered total exactly fits the budget", () => {
    // rendered: "User: aaaa" (10) + newline (1) + "User: bbbb" (10) = 21
    const out = renderTranscript(
      [
        { type: "user", text: "aaaa" },
        { type: "user", text: "bbbb" },
      ],
      { maxMessageChars: 10, maxTotalChars: 21 },
    );
    expect(out).toBe("User: aaaa\nUser: bbbb");
    expect(out).not.toContain(TRANSCRIPT_TRUNCATION_MARKER);
  });

  it("drops the oldest and marks it when one char over budget", () => {
    const out = renderTranscript(
      [
        { type: "user", text: "aaaa" },
        { type: "user", text: "bbbb" },
      ],
      { maxMessageChars: 10, maxTotalChars: 20 },
    );
    expect(out).toContain(TRANSCRIPT_TRUNCATION_MARKER);
    expect(out).toContain("User: bbbb");
    expect(out).not.toContain("User: aaaa");
  });

  it("counts the total budget in code points for non-BMP input (no lone surrogate)", () => {
    // 12 messages, each rendered 4 010 code points ("User: " = 6, label = 4,
    // 4 000 emoji = 4 000 code points) but 8 010 UTF-16 units. Code-point total
    // after 11 messages is 44 120; the 12th would make 48 131 > 48 000, so the
    // oldest is dropped. Counting UTF-16 units instead would fit only five
    // messages, dropping M06 — so retaining M06 pins the ruled code-point unit.
    const label = (i: number) => `M${String(i).padStart(2, "0")}:`;
    const messages = Array.from({ length: 12 }, (_, i) => ({
      type: "user",
      text: label(i) + "😀".repeat(4000),
    }));
    const out = renderTranscript(messages);
    expect(out).toContain(TRANSCRIPT_TRUNCATION_MARKER);
    expect([...out].length).toBeLessThanOrEqual(
      TRANSCRIPT_MAX_TOTAL_CHARS + TRANSCRIPT_TRUNCATION_MARKER.length + 1,
    );
    expect(out).toContain("M06:"); // kept under code points, dropped under UTF-16 units
    expect(out).not.toContain("M00:"); // oldest message, over budget
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("renders all 11 union members without throwing and omits exactly the four non-rendering ones", () => {
    const messages = [
      { type: "user", text: "u" },
      { type: "assistant", content: [{ type: "text", text: "a" }] },
      { type: "synthetic", text: "s" },
      { type: "system", text: "y" },
      { type: "skill", name: "k" },
      { type: "shell", command: "c", status: "ok" },
      { type: "idle" },
      { type: "agent-switched" },
      { type: "model-switched" },
      { type: "location-switched" },
      { type: "compaction", summary: "m" },
    ];
    const out = renderTranscript(messages);
    expect(out).toBe(
      [
        "User: u",
        "a",
        "System: s",
        "System: y",
        "[skill k]",
        "[shell c → ok]",
        "[context compacted: m]",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// §7.3 — buildEvaluatorPrompt: condition verbatim, transcript, three labels
// ---------------------------------------------------------------------------

describe("buildEvaluatorPrompt (spec §7.3)", () => {
  it("carries the condition verbatim, including punctuation and newlines", () => {
    const condition = "when the parser handles a[b[c]] and the word clear\nappears, done — 100%";
    const prompt = buildEvaluatorPrompt(condition, "TRANSCRIPT-BODY");
    expect(prompt).toContain(condition);
    expect(prompt).toContain("CONDITION (verbatim):\n" + condition + "\n");
  });

  it("includes the rendered transcript", () => {
    const prompt = buildEvaluatorPrompt("c", "User: hello\nSystem: note");
    expect(prompt).toContain("User: hello\nSystem: note");
    expect(prompt).toContain("TRANSCRIPT SO FAR");
  });

  it("names all three verdict labels (E7 exact-format requirement)", () => {
    const prompt = buildEvaluatorPrompt("c", "t");
    expect(prompt).toContain("MET");
    expect(prompt).toContain("IMPOSSIBLE");
    expect(prompt).toContain("NOT YET MET");
  });

  it("places the condition before the transcript", () => {
    const prompt = buildEvaluatorPrompt("THE-CONDITION", "THE-TRANSCRIPT");
    expect(prompt.indexOf("THE-CONDITION")).toBeLessThan(prompt.indexOf("THE-TRANSCRIPT"));
  });
});

// ---------------------------------------------------------------------------
// §7.2 — selectEvaluatorModel / findModelById (AC-27/28)
// ---------------------------------------------------------------------------

const REF = { providerID: "acme", modelID: "cheap" };

function model(over: Partial<SelectableModel> & { providerID: string; modelID: string }): SelectableModel {
  return { enabled: true, status: "stable", capabilities: { output: ["text"] }, ...over };
}

describe("selectEvaluatorModel (spec §7.2, AC-27/28)", () => {
  it("picks the cheapest enabled, non-deprecated, text-capable model by cost[0].output", () => {
    const models = [
      model({ providerID: "a", modelID: "pricey", cost: [{ output: 30 }] }),
      model({ providerID: "b", modelID: "cheap", cost: [{ output: 5 }] }),
      model({ providerID: "c", modelID: "mid", cost: [{ output: 10 }] }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "b", modelID: "cheap" });
  });

  it("excludes the working session's model (AC-28)", () => {
    const working: WorkingModelRef = { providerID: "b", modelID: "cheap" };
    const models = [
      model({ providerID: "b", modelID: "cheap", cost: [{ output: 5 }] }),
      model({ providerID: "c", modelID: "mid", cost: [{ output: 10 }] }),
    ];
    expect(selectEvaluatorModel(models, working)).toEqual({ providerID: "c", modelID: "mid" });
  });

  it("does not exclude a model with the same modelID under a different provider", () => {
    const working: WorkingModelRef = { providerID: "b", modelID: "cheap" };
    const models = [
      model({ providerID: "z", modelID: "cheap", cost: [{ output: 5 }] }),
      model({ providerID: "c", modelID: "mid", cost: [{ output: 10 }] }),
    ];
    expect(selectEvaluatorModel(models, working)).toEqual({ providerID: "z", modelID: "cheap" });
  });

  it("excludes disabled models", () => {
    const models = [
      model({ providerID: "a", modelID: "off", enabled: false, cost: [{ output: 1 }] }),
      model({ providerID: "b", modelID: "on", cost: [{ output: 9 }] }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "b", modelID: "on" });
  });

  it("excludes deprecated models", () => {
    const models = [
      model({ providerID: "a", modelID: "old", status: "deprecated", cost: [{ output: 1 }] }),
      model({ providerID: "b", modelID: "new", status: "stable", cost: [{ output: 9 }] }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "b", modelID: "new" });
  });

  it("excludes models that are not text-capable", () => {
    const models = [
      model({ providerID: "a", modelID: "img", capabilities: { output: ["image"] }, cost: [{ output: 1 }] }),
      model({ providerID: "b", modelID: "txt", cost: [{ output: 9 }] }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "b", modelID: "txt" });
  });

  it("breaks a cost tie in favour of the larger limit.context", () => {
    const models = [
      model({ providerID: "a", modelID: "small-ctx", cost: [{ output: 5 }], limit: { context: 8000 } }),
      model({ providerID: "b", modelID: "big-ctx", cost: [{ output: 5 }], limit: { context: 128000 } }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "b", modelID: "big-ctx" });
  });

  it("returns undefined for an empty model list", () => {
    expect(selectEvaluatorModel([])).toBeUndefined();
  });

  it("returns undefined when the only candidate is the working model", () => {
    const working: WorkingModelRef = { providerID: "b", modelID: "cheap" };
    const models = [model({ providerID: "b", modelID: "cheap", cost: [{ output: 5 }] })];
    expect(selectEvaluatorModel(models, working)).toBeUndefined();
  });

  it("returns undefined when every model is unusable", () => {
    const models = [
      model({ providerID: "a", modelID: "off", enabled: false }),
      model({ providerID: "b", modelID: "old", status: "deprecated" }),
      model({ providerID: "c", modelID: "img", capabilities: { output: ["image"] } }),
    ];
    expect(selectEvaluatorModel(models)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Paid-model preference. Live 2026-10-09: cost-ascending alone put a retired
// free model first and the loop died after one turn. Free models are demoted
// when any paid candidate exists, and kept only when nothing else is available.
// ---------------------------------------------------------------------------

describe("evaluator selection — paid preference", () => {
  it("prefers a paid model over a cheaper free one", () => {
    const models = [
      model({ providerID: "a", modelID: "totally-free", cost: [{ output: 0 }] }),
      model({ providerID: "b", modelID: "paid", cost: [{ output: 9 }] }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "b", modelID: "paid" });
  });

  it("still picks the cheapest PAID model", () => {
    const models = [
      model({ providerID: "a", modelID: "free", cost: [{ output: 0 }] }),
      model({ providerID: "b", modelID: "pricey", cost: [{ output: 30 }] }),
      model({ providerID: "c", modelID: "cheap", cost: [{ output: 0.5 }] }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "c", modelID: "cheap" });
  });

  it("drops free models from the whole candidate list when paid ones exist", () => {
    const models = [
      model({ providerID: "a", modelID: "free-1", cost: [{ output: 0 }] }),
      model({ providerID: "b", modelID: "free-2", cost: [{ output: 0 }] }),
      model({ providerID: "c", modelID: "paid", cost: [{ output: 4 }] }),
    ];
    const ids = selectEvaluatorCandidates(models).map((m) => m.modelID);
    expect(ids).toEqual(["paid"]);
  });

  it("falls back to free models when NOTHING paid is available", () => {
    const models = [
      model({ providerID: "a", modelID: "free-b", cost: [{ output: 0 }] }),
      model({ providerID: "a", modelID: "free-a", cost: [{ output: 0 }] }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "a", modelID: "free-a" });
  });

  it("treats a missing cost as paid (not dropped)", () => {
    const models = [
      model({ providerID: "a", modelID: "free", cost: [{ output: 0 }] }),
      model({ providerID: "b", modelID: "unknown-cost" }),
    ];
    expect(selectEvaluatorModel(models)).toEqual({ providerID: "b", modelID: "unknown-cost" });
  });

  it("excludes the working model, then falls back to a free candidate as a last resort", () => {
    const working: WorkingModelRef = { providerID: "b", modelID: "paid" };
    const models = [
      model({ providerID: "a", modelID: "free", cost: [{ output: 0 }] }),
      model({ providerID: "b", modelID: "paid", cost: [{ output: 4 }] }),
    ];
    // The paid working model is excluded; nothing paid remains, so the free
    // model is returned rather than yielding no evaluator at all.
    expect(selectEvaluatorModel(models, working)).toEqual({ providerID: "a", modelID: "free" });
  });

  it("returns undefined when the working model is the only paid candidate and free ones are excluded", () => {
    const working: WorkingModelRef = { providerID: "b", modelID: "paid" };
    const models = [model({ providerID: "b", modelID: "paid", cost: [{ output: 4 }] })];
    expect(selectEvaluatorModel(models, working)).toBeUndefined();
  });
});

describe("findModelById (spec §7.2)", () => {
  const models = [
    model({ providerID: "openai", modelID: "gpt-4o", cost: [{ output: 10 }] }),
    model({ providerID: "anthropic", modelID: "claude", cost: [{ output: 20 }] }),
  ];

  it("resolves a provider/model id", () => {
    expect(findModelById(models, "anthropic/claude")?.modelID).toBe("claude");
  });

  it("resolves a bare model id", () => {
    expect(findModelById(models, "gpt-4o")?.providerID).toBe("openai");
  });

  it("returns undefined for an unknown id", () => {
    expect(findModelById(models, "nope/nope")).toBeUndefined();
  });

  it("returns undefined for an empty id", () => {
    expect(findModelById(models, "   ")).toBeUndefined();
  });

  it("requires the provider to match for a provider/model id", () => {
    expect(findModelById(models, "openai/claude")).toBeUndefined();
  });
});

describe("resolveEvaluatorModel (spec §7.2 rules 1–3)", () => {
  const models = [
    model({ providerID: "a", modelID: "cheap", cost: [{ output: 5 }] }),
    model({ providerID: "b", modelID: "mid", cost: [{ output: 10 }] }),
  ];
  const ctxOf = (data: SelectableModel[]): EvaluatorContext =>
    ({ model: { list: async () => ({ location: {}, data }) } } as unknown as EvaluatorContext);

  const cfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    antiSpinThreshold: 3,
    turnCap: 50,
    evaluatorModel: undefined,
    permissiveModePolicy: "warn",
    ...over,
  });

  it("uses the configured model when resolvable", async () => {
    const r = await resolveEvaluatorModel(
      { providerID: "b", modelID: "mid" },
      cfg({ evaluatorModel: "b/mid" }),
      ctxOf(models),
    );
    expect(r.model).toEqual({ providerID: "b", modelID: "mid" });
    expect(r.autoSelected).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it("falls back to auto-selection with a warning when the configured model is unresolvable", async () => {
    const r = await resolveEvaluatorModel(undefined, cfg({ evaluatorModel: "ghost/none" }), ctxOf(models));
    expect(r.model).toEqual({ providerID: "a", modelID: "cheap" });
    expect(r.autoSelected).toBe(true);
    expect(r.warning).toContain("ghost/none");
  });

  it("auto-selects excluding the working model when nothing is configured", async () => {
    const r = await resolveEvaluatorModel({ providerID: "a", modelID: "cheap" }, cfg(), ctxOf(models));
    expect(r.model).toEqual({ providerID: "b", modelID: "mid" });
    expect(r.autoSelected).toBe(true);
  });

  it("warns and resolves no model when nothing is selectable", async () => {
    const r = await resolveEvaluatorModel(
      { providerID: "a", modelID: "cheap" },
      cfg(),
      ctxOf([model({ providerID: "a", modelID: "cheap" })]),
    );
    expect(r.model).toBeUndefined();
    expect(typeof r.warning).toBe("string");
    expect(r.warning!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T-2 — crossProviderWarning
// ---------------------------------------------------------------------------

describe("crossProviderWarning (T-2)", () => {
  it("fires when the evaluator provider differs from the working provider", () => {
    const msg = crossProviderWarning(
      { providerID: "anthropic", modelID: "claude" },
      { providerID: "openai", modelID: "gpt-4o" },
    );
    expect(msg).toBe(
      "Goal evaluator runs on openai/gpt-4o, a different provider from this session; the transcript is sent to it on each evaluation.",
    );
  });

  it("is suppressed when the providers match", () => {
    expect(
      crossProviderWarning({ providerID: "openai", modelID: "a" }, { providerID: "openai", modelID: "b" }),
    ).toBeUndefined();
  });

  it("is suppressed when either side is unknown", () => {
    expect(crossProviderWarning(undefined, REF)).toBeUndefined();
    expect(crossProviderWarning(REF, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-5 — NO_TOOLS claim: deny-all wildcard
// ---------------------------------------------------------------------------

describe("NO_TOOLS (spec §7.1, T-5)", () => {
  it("is the deny-all wildcard form {action:'*',resource:'*',effect:'deny'}", () => {
    expect(Array.isArray(NO_TOOLS)).toBe(true);
    expect(NO_TOOLS).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    expect(NO_TOOLS[0].effect).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// §7.1 / T-5 — the scratch evaluator session: tool-less by construction
// ---------------------------------------------------------------------------

interface FakeEvalCtx {
  ctx: EvaluatorContext;
  creates: Record<string, unknown>[];
  generates: { sessionID: string; prompt: string }[];
  removes: string[];
}

function evalCtx(
  models: SelectableModel[] = [],
  onGenerate?: (input: { sessionID: string; prompt: string }, callIndex: number) => { text: string },
): FakeEvalCtx {
  const creates: Record<string, unknown>[] = [];
  const generates: { sessionID: string; prompt: string }[] = [];
  const removes: string[] = [];
  const alive = new Set<string>(["goal-1"]);
  const ctx = {
    location: { directory: "/repo" },
    model: { list: async () => ({ location: {}, data: models }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!alive.has(sessionID)) throw new Error("session is gone");
        return {
          id: sessionID,
          location: { directory: "/repo" },
          model: { id: "work", providerID: "wp" },
        };
      },
      create: async (input: Record<string, unknown>) => {
        const id = `eval-${creates.length}`;
        creates.push(input);
        alive.add(id);
        return { id };
      },
      remove: async ({ sessionID }: { sessionID: string }) => {
        removes.push(sessionID);
        alive.delete(sessionID);
      },
      context: async () => [{ type: "user", text: "hello" }],
      generate: async (input: { sessionID: string; prompt: string }) => {
        generates.push(input);
        if (onGenerate !== undefined) return onGenerate(input, generates.length - 1);
        return { text: "MET: done" };
      },
    },
  } as unknown as EvaluatorContext;
  return { ctx, creates, generates, removes };
}

const EVAL_REF = { providerID: "ep", modelID: "em" };

describe("ensureEvaluatorSession (spec §7.1, T-5)", () => {
  beforeEach(() => clearEvaluatorSessionCache());

  it("creates the scratch session with the deny-all permission set (T-5)", async () => {
    const { ctx, creates } = evalCtx();
    const id = await ensureEvaluatorSession("goal-1", EVAL_REF, ctx);
    expect(typeof id).toBe("string");
    expect(creates.length).toBe(1);
    expect(creates[0].permissions).toEqual(NO_TOOLS);
  });

  it("creates the session on the evaluator model, in the goal directory", async () => {
    const { ctx, creates } = evalCtx();
    await ensureEvaluatorSession("goal-1", { providerID: "p", modelID: "m" }, ctx);
    expect(creates[0].model).toEqual({ id: "m", providerID: "p" });
    expect(creates[0].location).toEqual({ directory: "/repo" });
  });

  it("reuses a live scratch session for the same goal and model", async () => {
    const { ctx, creates } = evalCtx();
    const a = await ensureEvaluatorSession("goal-1", EVAL_REF, ctx);
    const b = await ensureEvaluatorSession("goal-1", EVAL_REF, ctx);
    expect(b).toBe(a);
    expect(creates.length).toBe(1);
  });

  it("replaces the scratch session when the evaluator model changes", async () => {
    const { ctx, creates } = evalCtx();
    const a = await ensureEvaluatorSession("goal-1", EVAL_REF, ctx);
    const b = await ensureEvaluatorSession("goal-1", { providerID: "ep", modelID: "other" }, ctx);
    expect(b).not.toBe(a);
    expect(creates.length).toBe(2);
  });

  it("removes the scratch session on resolution", async () => {
    const { ctx, creates } = evalCtx();
    await ensureEvaluatorSession("goal-1", EVAL_REF, ctx);
    await removeEvaluatorSession("goal-1", ctx);
    // after removal, the next ensure must create a fresh session
    await ensureEvaluatorSession("goal-1", EVAL_REF, ctx);
    expect(creates.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §7 composition — evaluate: separate scratch call, both inputs carried (AC-20/21)
// ---------------------------------------------------------------------------

describe("evaluate (spec §7, AC-20/AC-21/AC-28)", () => {
  beforeEach(() => clearEvaluatorSessionCache());

  it("evaluates through the scratch session, not the goal session, and parses the verdict", async () => {
    const models = [
      model({ providerID: "wp", modelID: "work", cost: [{ output: 1 }] }),
      model({ providerID: "ep", modelID: "em", cost: [{ output: 5 }] }),
    ];
    const { ctx, creates, generates } = evalCtx(models);
    const cfg: ResolvedConfig = {
      antiSpinThreshold: 3,
      turnCap: 50,
      evaluatorModel: undefined,
      permissiveModePolicy: "warn",
    };
    const verdict = await evaluate("goal-1", createGoal("the token BANANA is written"), cfg, ctx);
    expect(verdict).toEqual({ kind: "met", reason: "done" });
    // evaluation is a separate call on the scratch session (AC-20/21/28)
    expect(generates.length).toBe(1);
    expect(generates[0].sessionID).not.toBe("goal-1");
    expect(generates[0].sessionID).toBe(creates[0].title === "goal-evaluator:goal-1" ? "eval-0" : "MISSING");
    // prompt carries the condition verbatim and the transcript
    expect(generates[0].prompt).toContain("the token BANANA is written");
    expect(generates[0].prompt).toContain("User: hello");
  });
});

// ---------------------------------------------------------------------------
// §7 + E8 — fall back to the next candidate when a model is unusable
// ---------------------------------------------------------------------------

describe("evaluate — fall back to the next candidate on an unusable model", () => {
  beforeEach(() => clearEvaluatorSessionCache());

  const cfg: ResolvedConfig = {
    antiSpinThreshold: 3,
    turnCap: 50,
    evaluatorModel: undefined,
    permissiveModePolicy: "warn",
  };

  const twoCandidates = (): SelectableModel[] => [
    model({ providerID: "a", modelID: "first", cost: [{ output: 1 }] }),
    model({ providerID: "b", modelID: "second", cost: [{ output: 5 }] }),
  ];

  it("happy path is unchanged: the first candidate succeeds with one generate call", async () => {
    const { ctx, generates } = evalCtx(twoCandidates());
    const verdict = await evaluate("goal-1", createGoal("the token is present"), cfg, ctx);
    expect(verdict).toEqual({ kind: "met", reason: "done" });
    expect(generates.length).toBe(1);
  });

  it("retries the next candidate when the first is reported deprecated, and warns", async () => {
    const { ctx, generates } = evalCtx(twoCandidates(), (_input, i) => {
      if (i === 0) throw new Error("Model first has been deprecated.");
      return { text: "MET: done" };
    });
    const warnings: string[] = [];
    const verdict = await evaluate("goal-1", createGoal("c"), cfg, ctx, (m) => warnings.push(m));
    expect(verdict).toEqual({ kind: "met", reason: "done" });
    expect(generates.length).toBe(2);
    // the retry ran on a fresh scratch session for the second candidate
    expect(generates[0].sessionID).not.toBe(generates[1].sessionID);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("a/first is unusable");
    expect(warnings[0]).toContain("retrying with b/second");
  });

  it("does not fall back on an unrelated error: it propagates with no second call", async () => {
    const { ctx, generates } = evalCtx(twoCandidates(), () => {
      throw new Error("network unreachable");
    });
    await expect(evaluate("goal-1", createGoal("c"), cfg, ctx)).rejects.toThrow(
      "network unreachable",
    );
    expect(generates.length).toBe(1);
  });

  it("throws the last failure when every candidate is unusable", async () => {
    const models = [
      model({ providerID: "a", modelID: "one", cost: [{ output: 0.5 }] }),
      model({ providerID: "b", modelID: "two", cost: [{ output: 1 }] }),
      model({ providerID: "c", modelID: "three", cost: [{ output: 2 }] }),
    ];
    const { ctx, generates } = evalCtx(models, (_input, i) => {
      throw new Error(`Model ${["one", "two", "three"][i]} has been deprecated.`);
    });
    await expect(evaluate("goal-1", createGoal("c"), cfg, ctx)).rejects.toThrow(
      "last failure: Model three has been deprecated.",
    );
    expect(generates.length).toBe(3);
  });

  it("caps attempts at five even when more candidates are listed", async () => {
    const models = Array.from({ length: 7 }, (_, i) =>
      model({ providerID: "p", modelID: `m${i}`, cost: [{ output: i + 1 }] }),
    );
    const { ctx, generates } = evalCtx(models, () => {
      throw new Error("Model m0 has been retired.");
    });
    await expect(evaluate("goal-1", createGoal("c"), cfg, ctx)).rejects.toThrow("retired");
    expect(generates.length).toBe(5);
  });

  it("handles a non-Error throw (a thrown string) without crashing", async () => {
    const { ctx, generates } = evalCtx(twoCandidates(), (_input, i) => {
      if (i === 0) throw "Model first has been deprecated.";
      return { text: "MET: done" };
    });
    const warnings: string[] = [];
    const verdict = await evaluate("goal-1", createGoal("c"), cfg, ctx, (m) => warnings.push(m));
    expect(verdict).toEqual({ kind: "met", reason: "done" });
    expect(generates.length).toBe(2);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("has been deprecated.");
  });

  it("tries an explicitly configured model first, then falls back with a warning", async () => {
    const models = [
      model({ providerID: "ep", modelID: "pinned", cost: [{ output: 99 }] }),
      model({ providerID: "a", modelID: "cheap", cost: [{ output: 0.5 }] }),
    ];
    const pinned: ResolvedConfig = { ...cfg, evaluatorModel: "ep/pinned" };
    const { ctx, generates } = evalCtx(models, (_input, i) => {
      if (i === 0) throw new Error("Model pinned has been deprecated.");
      return { text: "MET: done" };
    });
    const warnings: string[] = [];
    const verdict = await evaluate("goal-1", createGoal("c"), pinned, ctx, (m) => warnings.push(m));
    expect(verdict).toEqual({ kind: "met", reason: "done" });
    expect(generates.length).toBe(2);
    expect(
      warnings.some((w) => w.includes("ep/pinned is unusable") && w.includes("a/cheap")),
    ).toBe(true);
  });

  it("falls back past a free-tier restriction (observed live)", async () => {
    const { ctx, generates } = evalCtx(twoCandidates(), (_input, i) => {
      if (i === 0) {
        throw new Error("OpenCode's free tier can only be used from within OpenCode.");
      }
      return { text: "MET: done" };
    });
    const warnings: string[] = [];
    const verdict = await evaluate("goal-1", createGoal("c"), cfg, ctx, (m) => warnings.push(m));
    expect(verdict).toEqual({ kind: "met", reason: "done" });
    expect(generates.length).toBe(2);
    expect(warnings.length).toBe(1);
  });

  it("falls back past a privacy/training opt-in refusal (observed live)", async () => {
    const { ctx, generates } = evalCtx(twoCandidates(), (_input, i) => {
      if (i === 0) {
        throw new Error(
          "Upstream request failed: This Go model trains on request data. Allow paid " +
            "endpoints that train on request data in your workspace's Privacy settings to use it.",
        );
      }
      return { text: "MET: done" };
    });
    const warnings: string[] = [];
    const verdict = await evaluate("goal-1", createGoal("c"), cfg, ctx, (m) => warnings.push(m));
    expect(verdict).toEqual({ kind: "met", reason: "done" });
    expect(generates.length).toBe(2);
    expect(warnings.length).toBe(1);
  });

  it("removes the superseded scratch session when a fallback switches model", async () => {
    const { ctx, generates, removes, creates } = evalCtx(twoCandidates(), (_input, i) => {
      if (i === 0) throw new Error("Model first has been deprecated.");
      return { text: "MET: done" };
    });
    await evaluate("goal-1", createGoal("c"), cfg, ctx);
    // one scratch session per candidate ...
    expect(creates.length).toBe(2);
    // ... and the abandoned one is removed, not orphaned
    expect(removes).toEqual([generates[0].sessionID]);
    expect(generates[0].sessionID).not.toBe(generates[1].sessionID);
  });

  it("reuses the scratch session when the model is unchanged", async () => {
    const { ctx, removes, creates } = evalCtx(twoCandidates());
    await evaluate("goal-1", createGoal("c"), cfg, ctx);
    await evaluate("goal-1", createGoal("c"), cfg, ctx);
    expect(creates.length).toBe(1);
    expect(removes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isModelUnusableError — the retryable/terminal split (live-observed causes)
// ---------------------------------------------------------------------------

describe("isModelUnusableError", () => {
  it("is retryable for every cause observed live", () => {
    expect(isModelUnusableError(new Error("Model exo-free has been deprecated."))).toBe(true);
    expect(isModelUnusableError(new Error("Model X has been retired."))).toBe(true);
    expect(
      isModelUnusableError(new Error("OpenCode's free tier can only be used from within OpenCode.")),
    ).toBe(true);
    expect(
      isModelUnusableError(new Error("This Go model trains on request data.")),
    ).toBe(true);
    expect(
      isModelUnusableError(new Error("Allow paid endpoints ... Privacy settings to use it.")),
    ).toBe(true);
    expect(isModelUnusableError(new Error("unknown model"))).toBe(true);
  });

  it("is terminal for transport and unrelated errors", () => {
    expect(isModelUnusableError(new Error("network unreachable"))).toBe(false);
    expect(isModelUnusableError(new Error("rate limit exceeded"))).toBe(false);
    expect(isModelUnusableError(new Error("Invalid prompt schema"))).toBe(false);
  });

  it("does not crash on a non-Error throw", () => {
    expect(isModelUnusableError("Model X has been deprecated.")).toBe(true);
    expect(isModelUnusableError(undefined)).toBe(false);
    expect(isModelUnusableError({ nope: 1 })).toBe(false);
  });
});
