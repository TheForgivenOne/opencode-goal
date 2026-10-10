/**
 * Tests for the event watcher (spec §8).
 *
 * These did not exist before 2026-10-10, which is how AC-13 shipped with an
 * unverified trigger (spec §8.4 G-1) that silently deleted the goal of the session
 * a user was working in whenever *any* session was created. The child-session case
 * below is that regression.
 */

import { describe, expect, it } from "bun:test";
import {
  EVALUATOR_SESSION_TITLE_PREFIX,
  installWatchers,
  isScratchSessionTitle,
} from "../watch";

type Ev = { type: string; data: Record<string, unknown> };

/** Faithful `ctx.event` over a fixed list; ends after the last event. */
function fakeEventDomain(events: Ev[]): unknown {
  return {
    event: {
      subscribe: async function* () {
        for (const e of events) yield e;
      },
    },
  };
}

/** Let the async consumer drain the iterator. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function wire(events: Ev[]) {
  const seen = {
    human: [] as string[],
    tool: [] as string[],
    deleted: [] as string[],
    permission: [] as string[],
    created: [] as Array<{ created: string; previous: string | undefined }>,
  };
  installWatchers(
    fakeEventDomain(events) as never,
    (id) => seen.human.push(id),
    (id) => seen.tool.push(id),
    {
      onPermissionAsk: (id) => seen.permission.push(id),
      onSessionDeleted: (id) => seen.deleted.push(id),
      onSessionCreated: (created, previous) => seen.created.push({ created, previous }),
    },
  );
  return seen;
}

describe("isScratchSessionTitle", () => {
  it("recognises our own evaluator sessions and nothing else", () => {
    expect(isScratchSessionTitle(`${EVALUATOR_SESSION_TITLE_PREFIX}ses_x`)).toBe(true);
    expect(isScratchSessionTitle("New session")).toBe(false);
    expect(isScratchSessionTitle(undefined)).toBe(false);
  });
});

describe("installWatchers — session.created (AC-13 / G-1)", () => {
  it("reports a ROOT session created while another was viewed", async () => {
    const seen = wire([
      { type: "session.viewed", data: { sessionID: "ses_A", idle: 1 } },
      { type: "session.created", data: { sessionID: "ses_B", title: "New session" } },
    ]);
    await flush();
    expect(seen.created).toEqual([{ created: "ses_B", previous: "ses_A" }]);
  });

  // The regression: a subagent/task session is created programmatically and carries
  // `parentID`. It is NOT a new conversation. Treating it as one stopped — and, before
  // the 2026-10-10 fix, deleted — the goal of the session the user was working in.
  it("IGNORES a child/subagent session", async () => {
    const seen = wire([
      { type: "session.viewed", data: { sessionID: "ses_A", idle: 1 } },
      { type: "session.created", data: { sessionID: "ses_child", parentID: "ses_A", title: "explore" } },
    ]);
    await flush();
    expect(seen.created).toEqual([]);
  });

  it("IGNORES our own scratch evaluator session", async () => {
    const seen = wire([
      { type: "session.viewed", data: { sessionID: "ses_A", idle: 1 } },
      {
        type: "session.created",
        data: { sessionID: "ses_scratch", title: `${EVALUATOR_SESSION_TITLE_PREFIX}ses_A` },
      },
    ]);
    await flush();
    expect(seen.created).toEqual([]);
  });

  it("does nothing when the created session is the one already viewed", async () => {
    const seen = wire([
      { type: "session.viewed", data: { sessionID: "ses_A", idle: 1 } },
      { type: "session.created", data: { sessionID: "ses_A", title: "New session" } },
    ]);
    await flush();
    expect(seen.created).toEqual([]);
  });

  it("does nothing when no session was viewed yet", async () => {
    const seen = wire([{ type: "session.created", data: { sessionID: "ses_B", title: "New session" } }]);
    await flush();
    expect(seen.created).toEqual([]);
  });
});

describe("installWatchers — the other signals", () => {
  it("counts only an executed tool call as tool use (A-08)", async () => {
    const seen = wire([
      { type: "session.tool.called", data: { sessionID: "ses_A", executed: true } },
      { type: "session.tool.called", data: { sessionID: "ses_A", executed: false } },
    ]);
    await flush();
    expect(seen.tool).toEqual(["ses_A"]);
  });

  it("treats a `user` inbox item as a human prompt, but not a synthetic one (ADR-0004)", async () => {
    const seen = wire([
      { type: "session.inbox.enqueued", data: { sessionID: "ses_A", item: { type: "user" } } },
      { type: "session.inbox.enqueued", data: { sessionID: "ses_A", item: { type: "synthetic" } } },
    ]);
    await flush();
    expect(seen.human).toEqual(["ses_A"]);
  });

  it("passes through session deletion and permission asks", async () => {
    const seen = wire([
      { type: "session.deleted", data: { sessionID: "ses_A" } },
      { type: "permission.asked", data: { sessionID: "ses_B" } },
    ]);
    await flush();
    expect(seen.deleted).toEqual(["ses_A"]);
    expect(seen.permission).toEqual(["ses_B"]);
  });

  it("survives a handler that throws, so the stream is never broken", async () => {
    const seen = { created: 0 };
    installWatchers(
      fakeEventDomain([
        { type: "session.viewed", data: { sessionID: "ses_A", idle: 1 } },
        { type: "session.created", data: { sessionID: "ses_B", title: "New session" } },
        { type: "session.created", data: { sessionID: "ses_C", title: "Another" } },
      ]) as never,
      () => {},
      () => {},
      {
        onSessionCreated: () => {
          seen.created += 1;
          throw new Error("boom");
        },
      },
    );
    await flush();
    expect(seen.created).toBe(2);
  });
});
