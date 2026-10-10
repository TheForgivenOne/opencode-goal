/**
 * The `/goal` driver loop (spec §4, §8).
 *
 * Owns the per-session run-state map (one loop per session, AC-19), the loop
 * shape of §4.2, and every guard in §8: anti-spin (N consecutive no-tool turns),
 * the hard turn cap (T loop-started turns), the in-band kill switch, the
 * out-of-band stop (`OPENCODE_GOAL_DISABLE=1` / `.opencode/goal.kill`), the
 * permission-mode inference gate, and evaluator-failure handling.
 *
 * Correctness notes carried from phase 1/2a:
 *  - `applyVerdict` is **pure and returns a new record**; its result is always
 *    assigned. A missing assignment is a silent no-op that loops forever on a
 *    stale record.
 *  - `turnsThisRun` is **loop-owned**; `applyVerdict` never touches it. It is
 *    incremented only when the loop starts a turn (AC-34).
 *  - Cooperative cancellation only: `wait` carries no abort signal, so
 *    `signal.aborted` (and the run-identity guard) is checked after **every**
 *    await, and no further turn is started.
 *
 * Design divergence, resolved toward the ADR (see `watch.ts` header): loop
 * directives are injected as **synthetic** messages (ADR-0004, spec §8.2), not
 * `session.prompt` as the §4.2 pseudocode writes. This is what makes a human
 * prompt a `type:"user"` discriminator.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "@opencode/plugin";
import {
  DISABLE_ENV,
  resolveConfigFrom,
  type ConfigLoadResult,
  type RawConfig,
} from "./config";
import { sharedMap } from "./shared";
import {
  crossProviderWarning,
  evaluate,
  removeEvaluatorSession,
  resolveEvaluatorModel,
  type WorkingModelRef,
} from "./evaluator";
import {
  applyVerdict,
  createGoal,
  isActive,
  type GoalRecord,
  type Verdict,
} from "./record";
import { deleteGoal, readGoal, writeGoal } from "./store";

// ---------------------------------------------------------------------------
// Context + dependency seams
// ---------------------------------------------------------------------------

/** The slice of the plugin context the loop needs (a superset of the evaluator's). */
export interface LoopContext {
  readonly location: Plugin.Context["location"];
  readonly session: Plugin.Context["session"];
  readonly model: Plugin.Context["model"];
  readonly storage: Plugin.Context["storage"];
}

export interface LoopChangedPayload {
  readonly sessionID: string;
  readonly kind: string;
  readonly condition?: string;
  readonly reason?: string;
}

export interface LoopWarningPayload {
  readonly sessionID: string;
  readonly reason: string;
}

/**
 * Emission channels. The RPC path was removed in the zero-import rewrite
 * (local plugins cannot resolve bare specifiers), so warnings surface as
 * synthetic transcript entries instead.
 */
export interface LoopNotifications {
  readonly changed?: (payload: LoopChangedPayload) => void;
  readonly warning?: (payload: LoopWarningPayload) => void;
}

/** Injects text into a session; the seam lets a harness observe directives/output. */
export type TextInjection = (sessionID: string, text: string) => Promise<void>;

export interface GoalLoopDeps {
  readonly ctx: LoopContext;
  /** Workspace root: config at `<root>/.opencode/goal.json`, sentinel at `<root>/.opencode/goal.kill`. */
  readonly rootDir: string;
  /**
   * `ctx.options` from the plugin entry — the documented V2 option channel
   * (`{ "plugins": [{ "package": "opencode-goal", "options": { … } }] }`). It is the
   * lowest of the explicit configuration layers (spec §9).
   */
  readonly pluginOptions?: unknown;
  readonly notify?: LoopNotifications;
  /** Injection seam: a loop **directive** (schedules a turn). Defaults to `session.synthetic`. */
  readonly injectDirective?: TextInjection;
  /** Injection seam: a **non-directive** entry (warning/terminal/status; no turn). Defaults to `session.synthetic` with `resume:false`. */
  readonly emitSynthetic?: TextInjection;
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Run state (module-level: the one-loop-per-session invariant, AC-19)
// ---------------------------------------------------------------------------

type RunPhase = "starting" | "prompting" | "waiting" | "evaluating";
type PermissionMode = "guarded" | "permissive" | "unknown";

interface RunState {
  readonly abort: AbortController;
  phase: RunPhase;
  promise: Promise<void>;
  /** Did the loop start the turn currently being awaited? */
  turnStartedByLoop: boolean;
  /** Set by the `session.tool.called` watcher (§8.1). */
  toolUsedThisTurn: boolean;
  /** Persisted per turn: did a `permission.asked` arrive during it? */
  permissionAskedThisTurn: boolean;
  /** Inference from §8.6; starts `unknown`, which proceeds. */
  permissionMode: PermissionMode;
  /** Emit the permissive warning once per run. */
  warnedPermissive: boolean;
  /** Emit the busy-session warning once per run (§4.2). */
  warnedBusy: boolean;
  /** Working-turn token watermark (cumulative `SessionInfo.tokens`). */
  tokenBaseline: number;
  /** Newest transcript message time seen at the last evaluation. */
  lastEvalMessageTime: number;
}

/**
 * Live loops, one per session **process-wide**.
 *
 * Not a module-level `const`: the entrypoint is loaded more than once per server
 * process and each load re-evaluates the module, so module state would be
 * per-instance and a human prompt would start a second loop for the same
 * session. See `core/shared.ts`.
 */
const runs = sharedMap<string, RunState>("runs");

// Serialize per-session storage mutations. A superseded loop may have a write
// already in flight when `startGoal`/`clearGoal` mutates the same key; chaining
// mutations per session guarantees the replacement (or the delete) lands *after*
// the superseded write, closing the AC-4/AC-9 resurrection race.
const writeChains = new Map<string, Promise<void>>();

function enqueueMutation(sessionID: string, operation: () => Promise<void>): Promise<void> {
  const previous = writeChains.get(sessionID) ?? Promise.resolve();
  const next = previous.then(operation, operation).catch(() => undefined);
  writeChains.set(sessionID, next);
  void next.then(() => {
    if (writeChains.get(sessionID) === next) writeChains.delete(sessionID);
  });
  return next;
}

function persist(sessionID: string, record: GoalRecord, deps: GoalLoopDeps): Promise<void> {
  return enqueueMutation(sessionID, () => writeGoal(sessionID, record, deps.ctx));
}

function persistDelete(sessionID: string, deps: GoalLoopDeps): Promise<void> {
  return enqueueMutation(sessionID, () => deleteGoal(sessionID, deps.ctx));
}

/** Test hook: number of live runs (should be at most one per session). */
export function activeRunCount(): number {
  return runs.size;
}

/** Test hook: whether a run is live for `sessionID`. */
export function hasActiveRun(sessionID: string): boolean {
  return runs.has(sessionID);
}

function isCurrentRun(sessionID: string, run: RunState): boolean {
  return runs.get(sessionID) === run;
}

/**
 * Abort and forget a session's run. The in-flight turn is not interrupted.
 *
 * Returns whether a run was actually stopped. That is what lets a caller announce a
 * stop exactly once: the watchers are registered once per plugin load, so a single
 * `session.created` reaches them several times (live: **seven** identical notices).
 */
function abortRun(sessionID: string): boolean {
  const run = runs.get(sessionID);
  if (run === undefined) return false;
  runs.delete(sessionID);
  run.abort.abort();
  return true;
}

// ---------------------------------------------------------------------------
// Watcher ingress (called by index.ts, which owns the watcher wiring)
// ---------------------------------------------------------------------------

/** `session.tool.called` with `executed === true` (AC-30/31). */
export function noteToolUse(sessionID: string): void {
  const run = runs.get(sessionID);
  if (run !== undefined) run.toolUsedThisTurn = true;
}

/** `permission.asked` during a goal turn (§8.6 inference evidence). */
export function notePermissionAsk(sessionID: string): void {
  const run = runs.get(sessionID);
  if (run !== undefined) run.permissionAskedThisTurn = true;
}

/**
 * A human `"user"` inbox item (AC-33/E14). Resets the run counters and, when the
 * loop is dormant, resumes evaluation in attach mode.
 */
export function noteHumanPrompt(sessionID: string, deps: GoalLoopDeps): void {
  void (async () => {
    const { record } = await readGoal(sessionID, deps.ctx);
    if (record === null || !isActive(record)) return;
    const reset: GoalRecord = {
      ...record,
      consecutiveNoToolTurns: 0,
      turnsThisRun: 0,
    };
    await persist(sessionID, reset, deps);
    if (!runs.has(sessionID)) resumeGoal(sessionID, "attach", deps);
  })().catch(() => {
    // A watcher-triggered resume must never surface an error.
  });
}

// ---------------------------------------------------------------------------
// start / resume / clear / abortAll
// ---------------------------------------------------------------------------

/**
 * Set a goal and start its loop immediately (AC-17). Replaces any existing goal
 * in the session, aborting its loop first (AC-3/AC-4).
 */
export async function startGoal(
  sessionID: string,
  condition: string,
  deps: GoalLoopDeps,
): Promise<void> {
  // AC-4: terminate the previous loop (not just its display) before starting one.
  abortRun(sessionID);

  const now = deps.now?.() ?? Date.now();
  const record = createGoal(condition, now);
  await persist(sessionID, record, deps);

  await emitSynthetic(deps, sessionID, `Goal set: ${condition}`);
  deps.notify?.changed?.({ sessionID, kind: "active", condition });

  await emitProviderWarning(sessionID, deps);
  await emitConfigWarnings(sessionID, deps);

  // §8.6 gate at goal set: a fresh goal is `unknown`, which proceeds.
  resumeGoal(sessionID, "prompt", deps);
}

/**
 * Attach a loop to a session. `mode:"prompt"` starts the first turn (AC-17);
 * `mode:"attach"` assumes a human turn is already running and awaits it.
 *
 * Returns synchronously; the loop runs in the background. A second call for a
 * session with a live run is a no-op (AC-19).
 */
export function resumeGoal(
  sessionID: string,
  mode: "prompt" | "attach",
  deps: GoalLoopDeps,
): void {
  if (runs.has(sessionID)) return; // AC-19

  const run: RunState = {
    abort: new AbortController(),
    phase: "starting",
    promise: Promise.resolve(),
    turnStartedByLoop: false,
    toolUsedThisTurn: false,
    permissionAskedThisTurn: false,
    permissionMode: "unknown",
    warnedPermissive: false,
    warnedBusy: false,
    tokenBaseline: 0,
    lastEvalMessageTime: deps.now?.() ?? Date.now(),
  };
  runs.set(sessionID, run);
  run.promise = driveLoop(sessionID, mode, deps, run).catch(() => {
    // `driveLoop` handles its own errors; this is belt-and-braces against a leak.
  });
}

/**
 * Clear the goal (AC-9..AC-12, AC-35). Deletes the record, aborts the loop, and
 * removes the scratch evaluator session. The in-flight turn finishes; no further
 * turn starts.
 */
export async function clearGoal(
  sessionID: string,
  deps: GoalLoopDeps,
): Promise<{ cleared: boolean; condition?: string }> {
  const { record } = await readGoal(sessionID, deps.ctx);
  abortRun(sessionID);
  if (record === null) return { cleared: false };

  await persistDelete(sessionID, deps);
  const warning = await removeEvaluatorSession(sessionID, deps.ctx);
  if (warning !== undefined) deps.notify?.warning?.({ sessionID, reason: warning });
  deps.notify?.changed?.({ sessionID, kind: "none", condition: record.condition });
  return { cleared: true, condition: record.condition };
}

/** Abort every live loop (plugin unload / reload, E11). Starts no further turn. */
export function abortAll(): void {
  for (const run of runs.values()) run.abort.abort();
  runs.clear();
}

/**
 * AC-13: a new conversation stops the previously-viewed session's loop.
 *
 * It must **not** delete the goal. Until 2026-10-10 this called `clearGoal`, and a
 * live session showed what that cost: `session.created` also fires for programmatic
 * sessions (subagent/task sessions carry `parentID`; see `watch.ts` G-1), so any
 * session creation — a subagent, an API client, a probe — silently removed the goal
 * of the session the user was working in. That is the reported "the goal just
 * disappears, it is not persisting". The trigger is now root-sessions-only in
 * `watch.ts`, and here the stop leaves the goal set but dormant, exactly like every
 * other non-user stop, and says so. A human prompt resumes it (`noteHumanPrompt`).
 */
export async function stopSessionForNewConversation(
  sessionID: string,
  deps: GoalLoopDeps,
): Promise<void> {
  const hadRun = abortRun(sessionID);
  const { record } = await readGoal(sessionID, deps.ctx);
  if (record === null || !isActive(record)) return;
  // Only the call that actually stopped a loop announces it. The watchers are
  // registered once per plugin load, so one `session.created` reaches this several
  // times; the rest find the goal already paused and would repeat the same line.
  // Live report: seven identical "a new conversation started" notices.
  if (!hadRun) return;
  await warn(deps, sessionID, newConversationWarning());
}

/** E10: session deleted — stop the loop and expire the terminal record. */
export async function onSessionDeleted(
  sessionID: string,
  deps: GoalLoopDeps,
): Promise<void> {
  abortRun(sessionID);
  await persistDelete(sessionID, deps);
  await removeEvaluatorSession(sessionID, deps.ctx);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function driveLoop(
  sessionID: string,
  mode: "prompt" | "attach",
  deps: GoalLoopDeps,
  run: RunState,
): Promise<void> {
  let record: GoalRecord | null = null;

  try {
    // A scheduled loop may start after a replacement already aborted this run.
    if (run.abort.signal.aborted || !isCurrentRun(sessionID, run)) return;

    const initial = await readGoal(sessionID, deps.ctx);
    record = initial.record;
    if (record === null || !isActive(record)) return;

    // Re-check after the read: a replacement/clear during it must not let this
    // superseded loop write.
    if (run.abort.signal.aborted || !isCurrentRun(sessionID, run)) return;

    run.tokenBaseline = await readSessionTokens(sessionID, deps.ctx);
    if (run.abort.signal.aborted || !isCurrentRun(sessionID, run)) return;

    if (mode === "prompt") {
      // The loop starts this turn (AC-17): it counts toward the cap (AC-34).
      record = { ...record, turnsThisRun: record.turnsThisRun + 1 };
      await persist(sessionID, record, deps);
      run.turnStartedByLoop = true;
      startTurn(run);
      run.phase = "prompting";
      await injectDirective(deps, sessionID, buildDirective(record));
      if (!isCurrentRun(sessionID, run)) return;
    } else {
      // A human turn is already running; the loop starts none (E5).
      run.turnStartedByLoop = false;
      startTurn(run);
    }

    while (!run.abort.signal.aborted && isCurrentRun(sessionID, run)) {
      // §8.5 out-of-band stop, checked before every wait. Independent of the evaluator.
      if (outOfBandStop(deps)) {
        await warn(deps, sessionID, KILL_SENTINEL_WARNING);
        break;
      }

      // §8.6 permission gate: refuses only on positive evidence of permissive.
      const gateCfg = resolveConfig(deps.rootDir, deps.pluginOptions).config;
      if (run.permissionMode === "permissive") {
        if (gateCfg.permissiveModePolicy === "refuse") {
          await warn(deps, sessionID, permissiveRefusalWarning());
          break;
        }
        if (!run.warnedPermissive) {
          run.warnedPermissive = true;
          await warn(deps, sessionID, permissiveWarning());
        }
      }

      // Turn end (§4.2). Bounded: `wait` returns at *global* loop idle, so a
      // session the human keeps working in may never go idle — a live session
      // shows the loop blocked there for 12+ minutes with no verdict and no
      // counters moving. `wait` accepts an AbortSignal, so the wait is capped
      // (and a run abort cancels it) and the turn is evaluated as it stands.
      run.phase = "waiting";
      const turnWaitMaxMs = resolveConfig(deps.rootDir, deps.pluginOptions).config.turnWaitMaxMs;
      const waitOutcome = await waitForTurnEnd(deps, sessionID, run.abort.signal, turnWaitMaxMs);
      if (run.abort.signal.aborted || !isCurrentRun(sessionID, run)) break;
      if (waitOutcome === "timeout" && !run.warnedBusy) {
        run.warnedBusy = true;
        await warn(deps, sessionID, busySessionWarning(turnWaitMaxMs));
      }

      // Authoritative read at the turn boundary.
      const read = await readGoal(sessionID, deps.ctx);
      if (read.record === null || !isActive(read.record)) break; // cleared/deleted mid-turn (E10, E13)
      record = read.record;

      // Annotate: human-prompt scan resets counters (AC-33/AC-34); tool use is
      // already on the run from the watcher (AC-30/31).
      record = await annotateTurn(record, run, deps, sessionID);

      // Hard cap, before evaluation (AC-34, §4.2 ordering).
      const cfg = resolveConfig(deps.rootDir, deps.pluginOptions).config;
      if (record.turnsThisRun >= cfg.turnCap && run.turnStartedByLoop) {
        await warn(deps, sessionID, capWarning(cfg.turnCap));
        break;
      }

      run.phase = "evaluating";
      let verdict: Verdict;
      try {
        verdict = await evaluate(sessionID, record, cfg, deps.ctx, (message) => {
          deps.notify?.warning?.({ sessionID, reason: message });
          void emitSynthetic(deps, sessionID, `Goal warning: ${message}`);
        });
      } catch (err) {
        // E8 / A-09: no further turn; goal stays active and dormant.
        await warn(deps, sessionID, evaluationFailureWarning(err));
        break;
      }

      // E13: a verdict in flight must not re-activate a cleared goal.
      if (run.abort.signal.aborted || !isCurrentRun(sessionID, run)) break;

      // Annotate the evaluated turn for `applyVerdict`.
      verdict.toolUsedThisTurn = run.toolUsedThisTurn;
      verdict.tokensSpentDelta = await consumeTokenDelta(sessionID, deps, run);
      verdict.now = deps.now?.() ?? Date.now();

      // Re-check after the token read: a clear/replacement during it must not let
      // a stale verdict be applied (E13).
      if (run.abort.signal.aborted || !isCurrentRun(sessionID, run)) break;

      // §8.6: a completed tool-using turn with no `permission.asked` is positive
      // evidence of permissive; with one, guarded. No tool use leaves it as-is.
      if (run.toolUsedThisTurn) {
        run.permissionMode = run.permissionAskedThisTurn ? "guarded" : "permissive";
      }

      // applyVerdict is pure — the assignment is load-bearing.
      record = applyVerdict(record, verdict);
      await persist(sessionID, record, deps);

      if (verdict.kind !== "not-yet-met") {
        await emitTerminal(deps, sessionID, record, verdict);
        break;
      }

      // REQ-12 (§6.3): the indicator holds no goal truth — it re-reads on `changed`,
      // and `changed` was emitted only at goal set, clear and terminal. So the counts
      // sat frozen at "turn 0, 0 tokens" for an entire run (live report). Announce
      // progress at every non-terminal verdict.
      deps.notify?.changed?.({
        sessionID,
        kind: "active",
        condition: record.condition,
      });

      // Anti-spin (AC-30/31/32).
      if (record.consecutiveNoToolTurns >= cfg.antiSpinThreshold) {
        await warn(deps, sessionID, antiSpinWarning(cfg.antiSpinThreshold));
        break;
      }

      if (run.abort.signal.aborted || !isCurrentRun(sessionID, run)) break;

      // Start the next turn (AC-16, AC-25).
      record = { ...record, turnsThisRun: record.turnsThisRun + 1 };
      await persist(sessionID, record, deps);
      run.turnStartedByLoop = true;
      startTurn(run);
      run.phase = "prompting";
      await injectDirective(deps, sessionID, buildDirective(record));
    }
  } catch (err) {
    await safeWarn(deps, sessionID, unexpectedLoopWarning(err));
  } finally {
    if (isCurrentRun(sessionID, run)) runs.delete(sessionID);
    if (record !== null && !isActive(record)) {
      // Resolved (met/impossible): the scratch session is no longer needed.
      await removeEvaluatorSession(sessionID, deps.ctx);
    }
  }
}

function startTurn(run: RunState): void {
  run.toolUsedThisTurn = false;
  run.permissionAskedThisTurn = false;
}

/**
 * Wait for the turn to end, but never longer than `maxMs` (§4.2).
 *
 * `ctx.session.wait` resolves when the session's agent loop becomes **idle** — not
 * when the loop's own turn ends. That is the right signal while the loop drives the
 * session and the wrong one the moment a human works in the same session: the
 * session never goes idle, so the wait never returns, no verdict is reached, and
 * `turnsEvaluated`/`tokensSpent` stay at zero. Nothing else can observe an abort
 * either, because every abort check sits *after* this await — a live session shows
 * a loop wedged here for 12+ minutes while the user worked.
 *
 * `wait` takes `RequestOptions.signal`, so the wait is raced against a timer and the
 * request is aborted when the timer wins. The race is deliberate belt-and-braces: if
 * a runtime ignored the signal, the race would still return and the loop would still
 * make progress. `maxMs <= 0` restores the unbounded wait.
 *
 * Returns `"idle"` (normal turn end), `"timeout"` (cap reached) or `"aborted"` (the
 * run was aborted). A genuine wait error is rethrown so the §8/E8 failure path still
 * handles it.
 *
 * Exported for tests (the `wait` seam is otherwise unreachable without a live
 * session); it is not part of the module's public contract.
 */
export async function waitForTurnEnd(
  deps: GoalLoopDeps,
  sessionID: string,
  runAbort: AbortSignal,
  maxMs: number,
): Promise<"idle" | "timeout" | "aborted"> {
  const controller = new AbortController();
  const onRunAbort = (): void => controller.abort();
  // An abort that already happened must be honoured too: `addEventListener` on an
  // already-aborted signal never fires, so the wait would run to its cap instead.
  if (runAbort.aborted) controller.abort();
  else runAbort.addEventListener("abort", onRunAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // `maxMs <= 0` is the documented escape hatch back to an unbounded wait — still
    // wired to the run's abort, so `clear` can cancel it.
    const timedOut =
      maxMs > 0
        ? new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), maxMs);
          })
        : undefined;

    // Built inside the `try`: a synchronous throw from `wait` (or a non-promise
    // return) must still run the cleanup below rather than leak the timer and the
    // abort listener.
    const waited = deps.ctx.session
      .wait({ sessionID }, { signal: controller.signal })
      .then(() => "idle" as const)
      .catch((error: unknown) => {
        if (runAbort.aborted) return "aborted" as const;
        throw error;
      });

    const outcome =
      timedOut === undefined ? await waited : await Promise.race([waited, timedOut]);
    // Cancel the request when the cap wins. The race holds a handler for `waited`,
    // so a late rejection cannot surface as unhandled — which also means an error
    // that arrives *after* the cap is treated as a turn end (see the note below).
    if (outcome === "timeout") controller.abort();
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    runAbort.removeEventListener("abort", onRunAbort);
  }
}

// ---------------------------------------------------------------------------
// Turn annotation
// ---------------------------------------------------------------------------

/**
 * §8.2: detect a human prompt as a `type:"user"` message created since the last
 * evaluation, and reset the run counters (AC-33/AC-34). Loop directives are
 * synthetic, so they are never counted. Never throws.
 */
async function annotateTurn(
  record: GoalRecord,
  run: RunState,
  deps: GoalLoopDeps,
  sessionID: string,
): Promise<GoalRecord> {
  let messages: Awaited<ReturnType<LoopContext["session"]["context"]>>;
  try {
    messages = await deps.ctx.session.context({ sessionID });
  } catch {
    return record;
  }

  let newest = run.lastEvalMessageTime;
  let humanPrompt = false;
  for (const message of messages) {
    const created = messageTime(message);
    if (created === undefined) continue;
    if (message.type === "user" && created > run.lastEvalMessageTime) {
      humanPrompt = true;
    }
    if (created > newest) newest = created;
  }
  run.lastEvalMessageTime = newest;

  if (!humanPrompt) return record;
  const reset: GoalRecord = { ...record, consecutiveNoToolTurns: 0, turnsThisRun: 0 };
  await persist(sessionID, reset, deps);
  return reset;
}

function messageTime(message: { type: string; time?: { created?: number } }): number | undefined {
  const created = message.time?.created;
  return typeof created === "number" ? created : undefined;
}

// ---------------------------------------------------------------------------
// Directive + entry text
// ---------------------------------------------------------------------------

/** AC-17: the first turn's input is the condition itself; later turns carry guidance + progress. */
export function buildDirective(record: GoalRecord): string {
  if (record.turnsEvaluated === 0 && record.lastReason === "") {
    return record.condition;
  }
  const bound = extractTurnBound(record.condition);
  const progress =
    bound !== undefined
      ? `PROGRESS: turn ${record.turnsThisRun}/${bound}`
      : `PROGRESS: turn ${record.turnsThisRun}`;
  const guidance = record.lastReason !== "" ? record.lastReason : "(no evaluator reason yet)";
  return `Goal still active: ${record.condition}\n${guidance}\n${progress}`;
}

/**
 * AC-36: a condition may carry a turn bound (`... or stop after 20 turns`).
 * Extraction is deliberately conservative — only an explicit `stop after N
 * turns` phrase — because the bound is natural language judged by the evaluator,
 * not a structure the plugin owns. Absent/malformed → no `/bound`.
 */
export function extractTurnBound(condition: string): number | undefined {
  const match = /\bstop\s+after\s+(\d+)\s+turns?\b/i.exec(condition);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Config + out-of-band stop
// ---------------------------------------------------------------------------

export const KILL_SENTINEL_WARNING =
  "Goal loop stopped by the out-of-band kill sentinel (OPENCODE_GOAL_DISABLE=1 or .opencode/goal.kill). The goal remains set.";

export function capWarning(turnCap: number): string {
  return `Goal loop stopped: the unattended turn cap (${turnCap}) was reached. The goal remains set; send a message to resume.`;
}

export function antiSpinWarning(threshold: number): string {
  return `Goal loop stopped: no tool use across ${threshold} consecutive turns. The goal remains set; send a message to resume.`;
}

/** AC-13: a new conversation paused the goal (root sessions only; see `watch.ts`). */
export function newConversationWarning(): string {
  return "Goal loop stopped: a new conversation started. The goal remains set; send a message to resume.";
}

/**
 * §4.2: the turn-end wait hit its cap. Not a stop — the turn is evaluated as it
 * stands and the loop continues — so this says what happened, not what ended.
 */
export function busySessionWarning(maxMs: number): string {
  return `the session did not go idle within ${Math.round(maxMs / 1000)}s, so the turn was evaluated as it stands. Raise or disable turnWaitMaxMs to change this.`;
}

export function evaluationFailureWarning(err: unknown): string {
  return `Goal loop stopped: evaluation failed (${describeError(err)}). The goal remains set; send a message to resume.`;
}

export function permissiveWarning(): string {
  return "this session appears to be in a permissive/auto-approve mode. /goal is a pacing feature, not a sandbox — unattended tool execution may occur.";
}

export function permissiveRefusalWarning(): string {
  return "Goal loop stopped: a permissive/auto-approve mode was inferred and permissiveModePolicy is \"refuse\". The goal remains set but dormant.";
}

function unexpectedLoopWarning(err: unknown): string {
  return `Goal loop stopped unexpectedly (${describeError(err)}). The goal remains set.`;
}

/**
 * Read config from `ctx.options`, the environment and `<root>/.opencode/goal.json`,
 * then validate (spec §9). Never throws; a malformed file yields a warning and the
 * other layers still apply (AC-39).
 *
 * Precedence, lowest → highest: defaults → `ctx.options` → `goal.json` → environment.
 * The layering and validation live in {@link resolveConfigFrom}; this function only
 * performs the I/O (read the file, read `process.env`).
 */
export function resolveConfig(rootDir: string, pluginOptions?: unknown): ConfigLoadResult {
  const warnings: string[] = [];
  let file: unknown;

  const filePath = join(rootDir, ".opencode", "goal.json");
  try {
    if (existsSync(filePath)) {
      const text = readFileSync(filePath, "utf8");
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          file = parsed;
        } else {
          warnings.push(
            `Invalid goal config ${filePath}: expected a JSON object; using plugin options, environment and defaults.`,
          );
        }
      } catch (err) {
        warnings.push(
          `Invalid goal config ${filePath}: ${describeError(err)}; using plugin options, environment and defaults.`,
        );
      }
    }
  } catch (err) {
    warnings.push(`Could not read goal config ${filePath}: ${describeError(err)}`);
  }

  const result = resolveConfigFrom({
    options: pluginOptions,
    file,
    env: typeof process === "undefined" ? undefined : process.env,
  });
  return { config: result.config, warnings: [...warnings, ...result.warnings] };
}

/** `OPENCODE_GOAL_DISABLE=1` or `<root>/.opencode/goal.kill` exists (spec §8.5). */
export function outOfBandStop(deps: Pick<GoalLoopDeps, "rootDir">): boolean {
  if (typeof process !== "undefined" && process.env?.[DISABLE_ENV] === "1") {
    return true;
  }
  return existsSync(join(deps.rootDir, ".opencode", "goal.kill"));
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

function injectionSeam(deps: GoalLoopDeps): TextInjection {
  return async (sessionID, text) => {
    await deps.ctx.session.synthetic({ sessionID, text });
  };
}

async function injectDirective(deps: GoalLoopDeps, sessionID: string, text: string): Promise<void> {
  const inject = deps.injectDirective ?? injectionSeam(deps);
  await inject(sessionID, text);
}

async function emitSynthetic(deps: GoalLoopDeps, sessionID: string, text: string): Promise<void> {
  if (deps.emitSynthetic !== undefined) {
    await deps.emitSynthetic(sessionID, text);
    return;
  }
  try {
    // `resume:false`: a warning/terminal/status entry must not schedule a turn.
    await deps.ctx.session.synthetic({ sessionID, text, resume: false });
  } catch {
    // Output is best-effort; never fail the loop on a delivery error.
  }
}

async function warn(deps: GoalLoopDeps, sessionID: string, reason: string): Promise<void> {
  await emitSynthetic(deps, sessionID, `Goal warning: ${reason}`);
  deps.notify?.warning?.({ sessionID, reason });
}

async function safeWarn(deps: GoalLoopDeps, sessionID: string, reason: string): Promise<void> {
  try {
    await warn(deps, sessionID, reason);
  } catch {
    // Swallow: the loop is already unwinding.
  }
}

async function emitTerminal(
  deps: GoalLoopDeps,
  sessionID: string,
  record: GoalRecord,
  verdict: Verdict,
): Promise<void> {
  const text =
    verdict.kind === "met"
      ? `Goal achieved: ${record.condition}`
      : `Goal failed: ${record.condition} — ${record.lastReason}`;
  await emitSynthetic(deps, sessionID, text);
  deps.notify?.changed?.({
    sessionID,
    kind: verdict.kind === "met" ? "achieved" : "failed",
    condition: record.condition,
    reason: record.lastReason,
  });
}

async function emitConfigWarnings(sessionID: string, deps: GoalLoopDeps): Promise<void> {
  for (const message of resolveConfig(deps.rootDir, deps.pluginOptions).warnings) {
    await warn(deps, sessionID, message);
  }
}

/** T-2: warn once at goal set when the evaluator egresses to another provider. */
async function emitProviderWarning(sessionID: string, deps: GoalLoopDeps): Promise<void> {
  try {
    const cfg = resolveConfig(deps.rootDir, deps.pluginOptions).config;
    const info = await deps.ctx.session.get({ sessionID });
    const workingModel: WorkingModelRef | undefined =
      info.model !== undefined
        ? { providerID: info.model.providerID, modelID: info.model.id }
        : undefined;
    const resolved = await resolveEvaluatorModel(workingModel, cfg, deps.ctx);
    const message = crossProviderWarning(workingModel, resolved.model);
    if (message !== undefined) await warn(deps, sessionID, message);
  } catch {
    // A warning-only path; never block goal set on it.
  }
}

// ---------------------------------------------------------------------------
// Token accounting (working turns only; the evaluator is a separate session)
// ---------------------------------------------------------------------------

/**
 * A-N10: the working-turn spend proxy is the goal session's cumulative
 * `SessionInfo.tokens`. Evaluator tokens live in the scratch session, so they are
 * excluded by construction (AC-29). The delta since the last evaluation is added
 * to `tokensSpent`.
 */
async function consumeTokenDelta(
  sessionID: string,
  deps: GoalLoopDeps,
  run: RunState,
): Promise<number> {
  const current = await readSessionTokens(sessionID, deps.ctx);
  const delta = Math.max(0, current - run.tokenBaseline);
  run.tokenBaseline = current;
  return delta;
}

async function readSessionTokens(sessionID: string, ctx: LoopContext): Promise<number> {
  try {
    const info = await ctx.session.get({ sessionID });
    const tokens = info.tokens;
    if (tokens === undefined) return 0;
    return (
      numberOr0(tokens.input) +
      numberOr0(tokens.output) +
      numberOr0(tokens.reasoning) +
      numberOr0(tokens.cache?.read) +
      numberOr0(tokens.cache?.write)
    );
  } catch {
    return 0;
  }
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
