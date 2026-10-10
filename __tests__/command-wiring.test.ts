/**
 * Integration test for the `/goal` command **wiring** in `index.ts`.
 *
 * `core/__tests__/shared.test.ts` unit-tests `isDuplicateInvocation`, but that does
 * not pin the claim the fix makes. An independent review (2026-10-10) pointed out
 * the hole: deleting the `isDuplicateInvocation` call from `index.ts` would leave
 * every other test green, because nothing drove the real handler.
 *
 * This drives the real `setup()` and the real registered command handler, which is
 * what "one `/goal` invocation starts one goal" is actually about.
 */

import { describe, expect, it } from "bun:test";
import plugin from "../index";

interface AddedCommand {
  readonly name: string;
  readonly execute: (input: unknown) => Promise<void>;
}

/** The subset of the plugin context `setup` touches, with the command captured. */
function fakeContext() {
  const synthetics: Array<{ text: string; resume?: boolean }> = [];
  const store = new Map<string, unknown>();
  const added: AddedCommand[] = [];
  let subscriptions = 0;

  const ctx = {
    location: { directory: "/tmp/opencode/command-wiring-root" },
    options: undefined,
    storage: {
      get: async (key: string) => store.get(key) as never,
      set: async (key: string, value: never) => {
        store.set(key, value);
      },
      remove: async (key: string) => {
        store.delete(key);
      },
      scan: async (options: { prefix: string }) => ({
        entries: [...store.keys()]
          .filter((key) => key.startsWith(options.prefix))
          .sort()
          .map((key) => ({ key, value: store.get(key) as never })),
      }),
    },
    session: {
      synthetic: async ({ text, resume }: { text: string; resume?: boolean }) => {
        synthetics.push({ text, resume });
      },
      // Never settles: the driver loop parks here, so this test observes goal-set
      // only and never reaches an evaluation.
      wait: () => new Promise<void>(() => {}),
      context: async () => [],
      get: async () => ({
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      prompt: async () => {},
      create: async () => ({ id: "ses_scratch" }),
      remove: async () => {},
      generate: async () => ({ text: "" }),
    },
    model: { list: async () => ({ location: {}, data: [] }) },
    command: {
      transform: async (fn: (editor: { add: (definition: AddedCommand) => void }) => void) => {
        fn({
          add: (definition: AddedCommand) => {
            added.push(definition);
          },
        });
        return { dispose: () => {} };
      },
    },
    event: {
      subscribe: async () => {
        subscriptions += 1;
        return { dispose: () => {} };
      },
    },
  };

  return { ctx: ctx as never, synthetics, added, subscriptions: () => subscriptions };
}

describe("/goal command wiring (index.ts)", () => {
  it("registers exactly one `goal` command", async () => {
    const { ctx, added } = fakeContext();
    await plugin.setup(ctx);
    expect(added.filter((command) => command.name === "goal")).toHaveLength(1);
  });

  it("one invocation delivered twice starts ONE goal — the duplicate is collapsed at the call site", async () => {
    const { ctx, synthetics, added } = fakeContext();
    await plugin.setup(ctx);

    const command = added.find((candidate) => candidate.name === "goal");
    expect(command).toBeDefined();

    const invocation = {
      sessionID: "ses_wire",
      prompt: { text: "/goal say BANANA" },
      delivery: {},
    };

    // The runtime delivers a single user action to every registered handler; a second
    // `execute` with the identical invocation is that duplicate.
    await command?.execute(invocation);
    await command?.execute(invocation);

    const goalSets = synthetics.filter((entry) => entry.text.startsWith("Goal set: "));
    expect(goalSets).toHaveLength(1);
  });

  it("a DIFFERENT condition still runs, so the guard is not a blanket rate limit", async () => {
    const { ctx, synthetics, added } = fakeContext();
    await plugin.setup(ctx);
    const command = added.find((candidate) => candidate.name === "goal");

    await command?.execute({ sessionID: "ses_wire2", prompt: { text: "/goal say BANANA" } });
    await command?.execute({ sessionID: "ses_wire2", prompt: { text: "/goal say MANGO" } });

    const goalSets = synthetics.filter((entry) => entry.text.startsWith("Goal set: "));
    expect(goalSets).toHaveLength(2);
    expect(goalSets[1]?.text).toContain("MANGO");
  });

  it("`/goal clear` then a re-set of the SAME condition runs (review finding D1)", async () => {
    const { ctx, synthetics, added } = fakeContext();
    await plugin.setup(ctx);
    const command = added.find((candidate) => candidate.name === "goal");

    await command?.execute({ sessionID: "ses_wire3", prompt: { text: "/goal say BANANA" } });
    await command?.execute({ sessionID: "ses_wire3", prompt: { text: "/goal clear" } });
    await command?.execute({ sessionID: "ses_wire3", prompt: { text: "/goal say BANANA" } });

    const goalSets = synthetics.filter((entry) => entry.text.startsWith("Goal set: "));
    expect(goalSets).toHaveLength(2); // the re-set after the clear must not be swallowed
  });
});
