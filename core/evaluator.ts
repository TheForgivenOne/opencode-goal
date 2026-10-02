/**
 * Evaluator service (spec §7).
 *
 * Owns the **tool-less scratch evaluator session** (§7.1), evaluator **model
 * resolution** (§7.2), the evaluator **prompt** (§7.3), **transcript
 * rendering** (§7.4) and **verdict parsing** (§7.5).
 *
 * Everything that can be pure is exported as a pure function so a later phase's
 * tests can exercise it without a runtime: transcript rendering, verdict
 * parsing, model selection given a model list, prompt building, and the
 * cross-provider warning text. `evaluate` itself takes `ctx` as a parameter and
 * imports no global.
 *
 * Divergences from the spec's prose, resolved in favour of the shipped
 * `.d.ts` (contracts file §3/§5; verified against the installed package):
 *  - `ctx.session.create` returns `SessionInfo` directly, whose id field is
 *    `id`, **not** the spec pseudocode's `.sessionID`.
 *  - `SessionCreateInput` is a flattened optional-key struct: the scratch
 *    session's model/title/location live under the top-level `id` key, while
 *    `permissions` is a top-level `ReadonlyArray<{action,resource,effect}>`.
 *  - Model listing at runtime is `ctx.model.list()` -> `{ location, data:
 *    ModelInfo[] }`; the spec's `ModelEditor.list()` is the transform-editor
 *    view and is not reachable from `ctx.model` directly.
 *  - `SessionMessageInfo` is the 11-member union from contracts §3g.
 */

import type { Plugin } from "@opencode/plugin";
import type { ResolvedConfig } from "./config";
import { type GoalRecord, type Verdict, type VerdictKind } from "./record";

// ---------------------------------------------------------------------------
// Context slice
// ---------------------------------------------------------------------------

/** The slice of the plugin context the evaluator needs. */
export interface EvaluatorContext {
  readonly location: Plugin.Context["location"];
  readonly session: Plugin.Context["session"];
  readonly model: Plugin.Context["model"];
}

// ---------------------------------------------------------------------------
// Transcript rendering (spec §7.4) — pure
// ---------------------------------------------------------------------------

/** Per-message cap, in characters (A-N3). */
export const TRANSCRIPT_MAX_MESSAGE_CHARS = 8000;
/** Total transcript budget, in characters (A-N3). */
export const TRANSCRIPT_MAX_TOTAL_CHARS = 48000;
/** Prefixed exactly once when anything was dropped. */
export const TRANSCRIPT_TRUNCATION_MARKER = "[...earlier messages omitted...]";

/**
 * Structural view of the `SessionMessageInfo` union members this module reads.
 * Every field except `type` is optional, so a real `SessionMessageInfo` (whose
 * members carry a string-literal discriminant plus their own fields) is
 * assignable. The renderer switches on `type`; unlisted types render empty and
 * are omitted.
 */
export interface RenderableContentItem {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly executed?: boolean;
}

export interface RenderableMessage {
  readonly type: string;
  readonly text?: string;
  readonly content?: readonly RenderableContentItem[];
  readonly command?: string;
  readonly status?: string;
  readonly skill?: string;
  readonly name?: string;
  readonly summary?: string;
}

export interface RenderTranscriptOptions {
  readonly maxMessageChars?: number;
  readonly maxTotalChars?: number;
}

/**
 * Flatten a transcript to plain text per the spec §7.4 table, bounded by
 * newest-first truncation (A-N3): 8 000 chars per message, 48 000 chars total,
 * with {@link TRANSCRIPT_TRUNCATION_MARKER} prepended when anything is dropped.
 * The condition and progress line are prompt-level and are not counted here.
 */
export function renderTranscript(
  messages: readonly RenderableMessage[],
  options?: RenderTranscriptOptions,
): string {
  const maxMessageChars = options?.maxMessageChars ?? TRANSCRIPT_MAX_MESSAGE_CHARS;
  const maxTotalChars = options?.maxTotalChars ?? TRANSCRIPT_MAX_TOTAL_CHARS;

  // Render newest-first so the budget keeps the most recent context.
  const newestFirst: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const rendered = renderMessage(messages[i]);
    if (rendered === "") continue;
    newestFirst.push(capChars(rendered, maxMessageChars));
  }

  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (const message of newestFirst) {
    // A-N3: the total budget counts code points, as the per-message cap does.
    const cost = [...message].length + (kept.length === 0 ? 0 : 1); // +1 for the joining newline
    if (used + cost > maxTotalChars) {
      truncated = true;
      break;
    }
    kept.push(message);
    used += cost;
  }

  const body = kept.slice().reverse().join("\n");
  if (!truncated) return body;
  return body === ""
    ? TRANSCRIPT_TRUNCATION_MARKER
    : `${TRANSCRIPT_TRUNCATION_MARKER}\n${body}`;
}

/** Render one message; `""` means "omit" (unlisted types, empty content). */
function renderMessage(message: RenderableMessage): string {
  switch (message.type) {
    case "user":
      return text(`User: `, message.text);
    case "assistant":
      return (message.content ?? [])
        .map(renderAssistantContent)
        .filter((part) => part !== "")
        .join("\n");
    case "synthetic":
    case "system":
      return text(`System: `, message.text);
    case "skill":
      return `[skill ${message.name ?? message.skill ?? ""}]`;
    case "shell":
      return `[shell ${message.command ?? ""} → ${message.status ?? ""}]`;
    case "compaction":
      return `[context compacted: ${message.summary ?? ""}]`;
    // "idle", "agent-switched", "model-switched", "location-switched" are omitted.
    default:
      return "";
  }
}

function renderAssistantContent(item: RenderableContentItem): string {
  switch (item.type) {
    case "text":
      return item.text ?? "";
    case "tool":
      // Name only: the union carries no args/results (AC-22).
      return `[tool ${item.name ?? ""}${item.executed === true ? "" : " (denied)"}]`;
    // "reasoning" is omitted by default.
    default:
      return "";
  }
}

function text(prefix: string, value: string | undefined): string {
  return `${prefix}${value ?? ""}`;
}

/**
 * Cap `value` to at most `max` Unicode **code points** (A-N3; spec §7.4). The
 * slice lands on a code-point boundary, so no lone surrogate is produced, and
 * the `…` marker is counted inside the cap. The same discipline as the
 * condition limit in `parser.ts` (`[...s].length`): code points, not UTF-16
 * code units.
 */
function capChars(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  const marker = "…";
  const keep = Math.max(0, max - [...marker].length);
  return chars.slice(0, keep).join("") + marker;
}

// ---------------------------------------------------------------------------
// Evaluator prompt (spec §7.3) — pure
// ---------------------------------------------------------------------------

/** The exact evaluator prompt (spec §7.3). */
export function buildEvaluatorPrompt(condition: string, transcript: string): string {
  return [
    "You are a strict goal evaluator for a coding session. Decide whether the CONDITION is satisfied.",
    "",
    "Reply with EXACTLY ONE first token, then a one-sentence reason:",
    "  MET:            the condition is satisfied",
    "  IMPOSSIBLE:     the condition cannot be satisfied",
    "  NOT YET MET:    more work is needed",
    "Your first token must be one of those three labels. Do not use tools. Judge only from the transcript.",
    "",
    "CONDITION (verbatim):",
    condition,
    "",
    "TRANSCRIPT SO FAR (may be truncated; newest last):",
    transcript,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Verdict parsing (spec §7.5) — pure
// ---------------------------------------------------------------------------

export interface ParsedVerdict {
  readonly kind: VerdictKind;
  readonly reason: string;
  readonly raw: string;
}

/**
 * Parse the evaluator's reply. Exactly three outcomes; leading-label
 * precedence (`not yet met` > `impossible` > `met`), so E7's
 * `"Not yet met. If it turns out impossible…"` is `not-yet-met`. An
 * unparseable reply is `not-yet-met` (E6) so a broken evaluator stops within N
 * rather than looping forever.
 */
export function parseVerdict(reply: string): ParsedVerdict {
  const trimmed = reply.trim();
  const lower = trimmed.toLowerCase();

  let kind: VerdictKind;
  let label: string;
  if (lower.startsWith("not yet met")) {
    kind = "not-yet-met";
    label = "not yet met";
  } else if (lower.startsWith("impossible")) {
    kind = "impossible";
    label = "impossible";
  } else if (lower.startsWith("met")) {
    kind = "met";
    label = "met";
  } else {
    return { kind: "not-yet-met", reason: trimmed, raw: reply };
  }

  const remainder = trimmed.slice(label.length).replace(/^:/, "").trim();
  return { kind, reason: remainder === "" ? trimmed : remainder, raw: reply };
}

// ---------------------------------------------------------------------------
// Evaluator model resolution (spec §7.2) — pure selector + ctx-dependent resolve
// ---------------------------------------------------------------------------

/** Structural view of `ModelInfo` fields used for selection. */
export interface SelectableModel {
  readonly providerID: string;
  readonly modelID?: string;
  readonly id?: string;
  readonly enabled?: boolean;
  readonly status?: string;
  readonly capabilities?: { readonly output?: readonly string[] };
  readonly cost?: readonly { readonly output?: number }[];
  readonly limit?: { readonly context?: number };
}

export interface EvaluatorModelRef {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
}

export interface WorkingModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

export interface ResolvedEvaluatorModel {
  /** Absent only when nothing resolved; the caller follows E8 (warn, no turn). */
  readonly model?: EvaluatorModelRef;
  readonly autoSelected: boolean;
  /** Resolution warning(s): unresolved configured id, or total failure. */
  readonly warning?: string;
}

/** `"provider/model"`, the form surfaced to the user and the TUI config output. */
export function formatEvaluatorModel(ref: EvaluatorModelRef): string {
  return `${ref.providerID}/${ref.modelID}`;
}

export function modelIdOf(model: SelectableModel): string {
  return model.modelID ?? model.id ?? "";
}

function isTextCapable(model: SelectableModel): boolean {
  return model.capabilities?.output?.includes("text") === true;
}

/**
 * The AC-27 / AC-28 selection rule: enabled, not deprecated, text-capable,
 * excluding the working session's model, sorted by `cost[0].output` ascending,
 * tie-break by larger `limit.context`, then a deterministic id tie-break.
 */
export function selectEvaluatorModel(
  models: readonly SelectableModel[],
  workingModel?: WorkingModelRef | null,
): EvaluatorModelRef | undefined {
  const candidates = models.filter(
    (model) =>
      model.enabled === true &&
      model.status !== "deprecated" &&
      isTextCapable(model) &&
      modelIdOf(model) !== "" &&
      !(
        workingModel != null &&
        model.providerID === workingModel.providerID &&
        modelIdOf(model) === workingModel.modelID
      ),
  );
  if (candidates.length === 0) return undefined;

  const sorted = [...candidates].sort((a, b) => {
    const byCost = outputCost(a) - outputCost(b);
    if (byCost !== 0) return byCost;
    const byContext = (b.limit?.context ?? 0) - (a.limit?.context ?? 0);
    if (byContext !== 0) return byContext;
    return modelIdOf(a).localeCompare(modelIdOf(b));
  });

  const chosen = sorted[0];
  return { providerID: chosen.providerID, modelID: modelIdOf(chosen) };
}

function outputCost(model: SelectableModel): number {
  const cost = model.cost?.[0]?.output;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY;
}

/** Resolve a configured evaluator id (`provider/model`, or a bare model id). */
export function findModelById(
  models: readonly SelectableModel[],
  id: string,
): SelectableModel | undefined {
  const trimmed = id.trim();
  if (trimmed === "") return undefined;
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const providerID = trimmed.slice(0, slash);
    const modelID = trimmed.slice(slash + 1);
    return models.find(
      (model) => model.providerID === providerID && modelIdOf(model) === modelID,
    );
  }
  return models.find((model) => modelIdOf(model) === trimmed);
}

/**
 * Spec §7.2 resolution:
 *  1. `cfg.evaluatorModel`, if resolvable via the model domain;
 *  2. else the auto-selection of {@link selectEvaluatorModel};
 *  3. else no model + a warning (the caller follows E8).
 *
 * `cfg.evaluatorModel` is passed through unvalidated by `loadConfig` (phase 1),
 * so resolvability is checked here: an unresolvable id falls back to auto with
 * a warning rather than failing.
 */
export async function resolveEvaluatorModel(
  workingModel: WorkingModelRef | undefined,
  cfg: ResolvedConfig,
  ctx: EvaluatorContext,
): Promise<ResolvedEvaluatorModel> {
  const models = await listSelectableModels(ctx);

  const configured = cfg.evaluatorModel?.trim();
  if (configured !== undefined && configured !== "") {
    const found = findModelById(models, configured);
    if (found !== undefined) {
      return {
        model: {
          providerID: found.providerID,
          modelID: modelIdOf(found),
        },
        autoSelected: false,
      };
    }
    const auto = selectEvaluatorModel(models, workingModel);
    if (auto === undefined) {
      return {
        autoSelected: true,
        warning: `Configured evaluatorModel "${configured}" is not resolvable, and no evaluator model could be auto-selected.`,
      };
    }
    return {
      model: auto,
      autoSelected: true,
      warning: `Configured evaluatorModel "${configured}" is not resolvable; using auto-selected ${formatEvaluatorModel(auto)}.`,
    };
  }

  const auto = selectEvaluatorModel(models, workingModel);
  if (auto === undefined) {
    return {
      autoSelected: true,
      warning: "No evaluator model could be auto-selected (no enabled, non-deprecated, text-capable model other than the working model).",
    };
  }
  return { model: auto, autoSelected: true };
}

async function listSelectableModels(ctx: EvaluatorContext): Promise<readonly SelectableModel[]> {
  const result = await ctx.model.list();
  return result.data as readonly SelectableModel[];
}

/**
 * T-2: the cross-provider egress warning. Emitted at goal set by the loop, but
 * defined here beside the resolution it describes. `undefined` when the
 * providers match (or either side is unknown).
 */
export function crossProviderWarning(
  workingModel: WorkingModelRef | undefined,
  evaluatorModel: EvaluatorModelRef | undefined,
): string | undefined {
  if (workingModel === undefined || evaluatorModel === undefined) return undefined;
  if (workingModel.providerID === evaluatorModel.providerID) return undefined;
  return `Goal evaluator runs on ${formatEvaluatorModel(evaluatorModel)}, a different provider from this session; the transcript is sent to it on each evaluation.`;
}

// ---------------------------------------------------------------------------
// Scratch evaluator session (spec §7.1, T-5) — one per active goal
// ---------------------------------------------------------------------------

/**
 * T-5: the scratch session is tool-less **by construction**. The `permissions`
 * ruleset denies everything (the shipped default agent uses the same
 * `{action:"*",resource:"*"}` wildcard with `effect:"allow"`), so the evaluator
 * model cannot execute a tool even if it emits one.
 */
export const NO_TOOLS = Object.freeze([
  Object.freeze({ action: "*", resource: "*", effect: "deny" as const }),
]);

interface CachedEvaluatorSession {
  readonly sessionID: string;
  readonly modelKey: string;
}

/** One scratch session per goal session (spec §7.1). */
const evaluatorSessions = new Map<string, CachedEvaluatorSession>();

/** Test hook: drop all cached evaluator sessions without touching the runtime. */
export function clearEvaluatorSessionCache(): void {
  evaluatorSessions.clear();
}

/**
 * Ensure the scratch evaluator session for a goal exists and is on the resolved
 * model, creating it in one call (spec §7.1). A cached session whose model no
 * longer matches — or that is no longer alive — is replaced.
 */
export async function ensureEvaluatorSession(
  goalSessionID: string,
  model: EvaluatorModelRef,
  ctx: EvaluatorContext,
): Promise<string> {
  const modelKey = formatEvaluatorModel(model);
  const cached = evaluatorSessions.get(goalSessionID);

  if (cached !== undefined && cached.modelKey === modelKey) {
    const alive = await ctx.session
      .get({ sessionID: cached.sessionID })
      .then(() => true)
      .catch(() => false);
    if (alive) return cached.sessionID;
    evaluatorSessions.delete(goalSessionID);
  } else if (cached !== undefined) {
    evaluatorSessions.delete(goalSessionID);
  }

  const directory = await resolveLocation(goalSessionID, ctx);
  // Shipped `SessionCreateInput`: `title` / `model` / `location` / `permissions`
  // are top-level optional fields (`id` is the session id string, not a nested
  // options object). Diverges from the spec §7.1 pseudocode; types win.
  const info = await ctx.session.create({
    title: `goal-evaluator:${goalSessionID}`,
    model: {
      id: model.modelID,
      providerID: model.providerID,
      ...(model.variant !== undefined ? { variant: model.variant } : {}),
    },
    ...(directory !== undefined ? { location: { directory } } : {}),
    permissions: NO_TOOLS,
  });

  const sessionID = info.id;
  evaluatorSessions.set(goalSessionID, { sessionID, modelKey });
  return sessionID;
}

/** Remove and forget a goal's scratch evaluator session. Returns a warning on failure. */
export async function removeEvaluatorSession(
  goalSessionID: string,
  ctx: EvaluatorContext,
): Promise<string | undefined> {
  const cached = evaluatorSessions.get(goalSessionID);
  if (cached === undefined) return undefined;
  evaluatorSessions.delete(goalSessionID);
  try {
    await ctx.session.remove({ sessionID: cached.sessionID });
    return undefined;
  } catch (err) {
    return `Failed to remove evaluator session ${cached.sessionID}: ${describeError(err)}`;
  }
}

/** The goal session's directory when readable, else the plugin location. */
async function resolveLocation(
  goalSessionID: string,
  ctx: EvaluatorContext,
): Promise<string | undefined> {
  const info = await ctx.session
    .get({ sessionID: goalSessionID })
    .catch(() => undefined);
  const directory = info?.location?.directory;
  if (typeof directory === "string" && directory !== "") return directory;
  const pluginDirectory = ctx.location?.directory;
  return typeof pluginDirectory === "string" && pluginDirectory !== ""
    ? pluginDirectory
    : undefined;
}

// ---------------------------------------------------------------------------
// evaluate (spec §7)
// ---------------------------------------------------------------------------

/**
 * Run one evaluation: resolve the model, ensure the tool-less scratch session,
 * render the goal session's transcript, ask the evaluator, and parse the reply.
 *
 * The returned `Verdict` carries `kind` and `reason`; the loop owns the
 * per-turn counters (`tokensSpentDelta`, `toolUsedThisTurn`) and terminal
 * bookkeeping. Any failure throws, which the loop maps to E8.
 *
 * `onWarning` is the emission channel available in this phase (the RPC
 * registration is a later phase): it receives model-resolution warnings. The
 * T-2 cross-provider message is exposed as {@link crossProviderWarning} for the
 * loop to emit once at goal set.
 */
export async function evaluate(
  goalSessionID: string,
  record: GoalRecord,
  cfg: ResolvedConfig,
  ctx: EvaluatorContext,
  onWarning?: (message: string) => void,
): Promise<Verdict> {
  const workingModel = await readWorkingModel(goalSessionID, ctx);
  const resolved = await resolveEvaluatorModel(workingModel, cfg, ctx);

  if (resolved.warning !== undefined && onWarning !== undefined) {
    onWarning(resolved.warning);
  }
  if (resolved.model === undefined) {
    throw new Error(
      resolved.warning ?? "No evaluator model could be resolved.",
    );
  }

  const evaluatorSessionID = await ensureEvaluatorSession(
    goalSessionID,
    resolved.model,
    ctx,
  );

  const messages = await ctx.session.context({ sessionID: goalSessionID });
  const transcript = renderTranscript(messages);
  const prompt = buildEvaluatorPrompt(record.condition, transcript);
  const { text } = await ctx.session.generate({
    sessionID: evaluatorSessionID,
    prompt,
  });

  const parsed = parseVerdict(text);
  return { kind: parsed.kind, reason: parsed.reason };
}

async function readWorkingModel(
  goalSessionID: string,
  ctx: EvaluatorContext,
): Promise<WorkingModelRef | undefined> {
  const info = await ctx.session
    .get({ sessionID: goalSessionID })
    .catch(() => undefined);
  const ref = info?.model;
  if (ref === undefined) return undefined;
  return { providerID: ref.providerID, modelID: ref.id };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
