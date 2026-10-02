/**
 * Event subscriptions for the `/goal` plugin (spec §2, §8.1, §8.2, §8.4, §8.6).
 *
 * `installWatchers` consumes the session event stream and surfaces:
 *  - **tool use** for anti-spin — `session.tool.called` with `data.executed === true`
 *    (AC-30/31, A-08);
 *  - **human prompt** detection — `session.inbox.enqueued` carrying a `"user"` item
 *    (AC-33/E14). Loop directives are injected as **synthetic** messages (ADR-0004),
 *    so a `"user"` inbox item is a human turn;
 *  - **session deletion** — `session.deleted` (E10);
 *  - **new conversation** — `session.created` while a previously-viewed session is
 *    known (AC-13/REQ-10), with the plugin's own scratch evaluator sessions excluded;
 *  - **`permission.asked`** for the §8.6 permissive-mode inference.
 *
 * A subscriber that throws breaks the event pipeline (project spike). Every
 * handler call here is individually guarded, and the whole iteration is wrapped,
 * so nothing this module does can propagate into the stream.
 *
 * Divergences / findings (types beat prose):
 *  - The spec/gap-closures name `session.new` as an event. The shipped `V2Event`
 *    union has **no `session.new` event**; `"session.new"` occurs only as a TUI
 *    *command* name (`tui.command.execute`). The creation event is
 *    `session.created` (and `session.viewed` tracks the viewed session).
 *  - The spec §4.2 pseudocode injects loop directives with `session.prompt`;
 *    §8.2 and ADR-0004 require them to be **synthetic** so a human prompt is a
 *    `type:"user"` discriminator. This module implements the ADR-0004 reading.
 *  - The spec §2 boundary is `installWatchers(ctx, onHumanPrompt, onToolUse,
 *    onPermissionAsk)`. This module keeps the three positional parameters exactly
 *    and passes the remaining signals (permission/deletion/creation) through an
 *    optional fourth `callbacks` object, so the loop and index can consume them
 *    without a second subscription.
 */

import type { Plugin } from "@opencode/plugin";

type EventDomain = Plugin.Context["event"];

/** The event union produced by `ctx.event.subscribe`, derived from the shipped type. */
type Subscribed = ReturnType<EventDomain["subscribe"]>;
export type GoalEvent = Subscribed extends AsyncIterable<infer E> ? E : never;

/** Synchronous cleanup returned by {@link installWatchers}. */
export type WatchCleanup = () => void;

export interface WatchContext {
  readonly event: EventDomain;
}

/** A handler keyed by session id. */
export type SessionHandler = (sessionID: string) => void;

/**
 * The signals beyond human-prompt and tool-use. An optional fourth argument so
 * the primary signature stays `installWatchers(ctx, onHumanPrompt, onToolUse)`.
 */
export interface WatchCallbacks {
  readonly onPermissionAsk?: SessionHandler;
  readonly onSessionDeleted?: SessionHandler;
  /** `newSessionID` was created; `previousViewedSessionID` is the session the user was viewing. */
  readonly onSessionCreated?: (newSessionID: string, previousViewedSessionID: string | undefined) => void;
}

/**
 * The title prefix used by `core/evaluator.ts` when it creates the scratch
 * evaluator session (`goal-evaluator:<goalSessionID>`). AC-13's "exclude our own
 * scratch evaluator sessions by id" is implemented over the session's title,
 * because a created session's own id is not yet known to the evaluator cache at
 * event time. Coupling to the evaluator's title format is deliberate; it is the
 * only stable, event-visible identifier the scratch session carries.
 */
export const EVALUATOR_SESSION_TITLE_PREFIX = "goal-evaluator:";

/** True when a `session.created` event describes one of our scratch evaluator sessions. */
export function isScratchSessionTitle(title: string | undefined): boolean {
  return typeof title === "string" && title.startsWith(EVALUATOR_SESSION_TITLE_PREFIX);
}

/**
 * Subscribe to the session event stream. Returns a synchronous cleanup that
 * aborts the subscription. Never throws into the event stream.
 */
export function installWatchers(
  ctx: WatchContext,
  onHumanPrompt: SessionHandler,
  onToolUse: SessionHandler,
  callbacks: WatchCallbacks = {},
): WatchCleanup {
  const controller = new AbortController();

  // The session the user was last viewing; `session.created` uses it to stop the
  // loop the user has navigated away from (AC-13).
  let lastViewedSessionID: string | undefined;

  const safe = <A extends unknown[]>(fn: ((...args: A) => void) | undefined, ...args: A): void => {
    if (fn === undefined) return;
    try {
      fn(...args);
    } catch {
      // A subscriber must never throw into the event pipeline.
    }
  };

  const dispatch = (event: GoalEvent): void => {
    switch (event.type) {
      case "session.viewed":
        lastViewedSessionID = event.data.sessionID;
        return;

      case "session.created": {
        if (isScratchSessionTitle(event.data.title)) return;
        const previous = lastViewedSessionID;
        const created = event.data.sessionID;
        // Only a genuine new-conversation event stops the previously-viewed loop.
        if (previous !== undefined && previous !== created) {
          safe(callbacks.onSessionCreated, created, previous);
        }
        return;
      }

      case "session.deleted":
        safe(callbacks.onSessionDeleted, event.data.sessionID);
        return;

      case "session.tool.called":
        // A-08: only a tool call that reached execution counts as tool use.
        if (event.data.executed === true) safe(onToolUse, event.data.sessionID);
        return;

      case "permission.asked":
        safe(callbacks.onPermissionAsk, event.data.sessionID);
        return;

      case "session.inbox.enqueued":
        // Loop directives are synthetic (ADR-0004), so a "user" item is a human turn.
        if (event.data.item.type === "user") safe(onHumanPrompt, event.data.sessionID);
        return;

      default:
        return;
    }
  };

  const consume = async (): Promise<void> => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          dispatch(event);
        } catch {
          // Guarded per event; keep consuming.
        }
      }
    } catch {
      // Stream ended, aborted, or transport error: the watcher simply stops.
    }
  };

  void consume();

  return () => controller.abort();
}
