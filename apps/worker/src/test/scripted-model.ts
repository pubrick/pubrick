import { MockLanguageModelV4 } from "ai/test";

/**
 * A mock model that answers each of the five roles differently, and records
 * which of them were actually asked.
 *
 * Test support only — nothing imports it from `main.ts`, so it never reaches the
 * bundle. It exists because the interesting assertions in this task are about
 * calls that must NOT happen: a resumed step whose model is invoked again is a
 * step being paid for twice, and a fenced-out handler that calls a model at all
 * is the double spend the fence exists to prevent. Counting calls per ROLE is
 * what makes those assertions say something; a total count cannot tell "skipped
 * the writer" from "ran a shorter pipeline".
 *
 * NO TEST MAY CALL A PROVIDER. The shape below is the one the V4 provider spec
 * requires and the one the whole codebase's mocks repeat: TEXT content (a
 * tool-call part makes `Output.object` throw `NoOutputGeneratedError`), the
 * NESTED usage shape, and `finishReason` as an object — a bare string passes
 * vitest and fails `tsc`.
 */
export type StepRole = "researcher" | "writer" | "editor" | "factcheck" | "adapter";

/**
 * What a role replies with. A string is sent verbatim (for malformed-output
 * tests); anything else is JSON-encoded. Async so a test can make the world
 * change DURING a model call — which is how a race between two handlers, or a
 * cancellation landing mid-run, is reproduced deterministically.
 */
export type RoleReply = (system: string, user: string) => unknown | Promise<unknown>;

export type ScriptedModel = {
  model: MockLanguageModelV4;
  /** Every call, in order, with the role it was made for. */
  calls: Array<{ role: StepRole; system: string; user: string }>;
  callsFor(role: StepRole): number;
  /** The channel names the adapter was invoked for, in order. */
  adaptedChannels(): string[];
};

const usage = {
  inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 60, text: 60, reasoning: 0 },
};
const stop = { unified: "stop" as const, raw: undefined };

/**
 * Which role's instructions these are.
 *
 * Matched on the role lines the steps actually ship, so a reworded step breaks
 * this loudly (with the prompt in the message) rather than silently answering
 * every call as a researcher.
 */
const ROLE_MARKERS: ReadonlyArray<[StepRole, string]> = [
  ["researcher", "You plan a social post before anyone writes it."],
  ["writer", "You write the master draft of a social post"],
  ["editor", "You edit a draft post into the brand's voice."],
  ["factcheck", "You read a draft post and list the factual claims"],
  ["adapter", "You rewrite an approved post for one channel:"],
];

function roleOf(system: string): StepRole {
  for (const [role, marker] of ROLE_MARKERS) {
    if (system.includes(marker)) return role;
  }
  throw new Error(`scriptedModel: no role matches these instructions:\n${system}`);
}

/** The channel an adapter call is for, read back out of its own instructions. */
export function channelOf(system: string): string {
  return /You rewrite an approved post for one channel: (.+?), on /.exec(system)?.[1] ?? "";
}

type PromptMessage = { role: string; content: unknown };

function halvesOf(prompt: readonly PromptMessage[]): { system: string; user: string } {
  const render = (messages: readonly PromptMessage[]) =>
    messages
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
  return {
    system: render(prompt.filter((m) => m.role === "system")),
    user: render(prompt.filter((m) => m.role !== "system")),
  };
}

const DEFAULT_REPLIES: Record<StepRole, RoleReply> = {
  researcher: () => ({ angle: "An angle", keyPoints: ["A key point"], avoid: [] }),
  writer: () => ({ body: "A first draft." }),
  editor: () => ({ body: "An edited draft.", changes: ["Tightened the opening."] }),
  factcheck: () => ({ claims: [{ text: "A claim.", needsCheck: true }] }),
  adapter: (system) => ({ body: `An adaptation for ${channelOf(system)}.` }),
};

export function scriptedModel(replies: Partial<Record<StepRole, RoleReply>> = {}): ScriptedModel {
  const calls: ScriptedModel["calls"] = [];
  const answer = { ...DEFAULT_REPLIES, ...replies };

  const model = new MockLanguageModelV4({
    // The id the price table knows, so ledger rows come out priced rather than
    // `unknown` — which is what the cost assertions need to mean anything.
    modelId: "gemini-3.7-flash",
    doGenerate: async (options) => {
      const { system, user } = halvesOf(options.prompt as unknown as PromptMessage[]);
      const role = roleOf(system);
      calls.push({ role, system, user });
      const reply = await answer[role](system, user);
      return {
        content: [
          {
            type: "text" as const,
            text: typeof reply === "string" ? reply : JSON.stringify(reply),
          },
        ],
        finishReason: stop,
        usage,
        warnings: [],
      };
    },
  });

  return {
    model,
    calls,
    callsFor: (role) => calls.filter((call) => call.role === role).length,
    adaptedChannels: () =>
      calls.filter((call) => call.role === "adapter").map((call) => channelOf(call.system)),
  };
}
