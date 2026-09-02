import {
  type AiCredential,
  generateStructured,
  type UsageRecord,
  type UsageSink,
  withRunFailure,
} from "@pubrick/ai";
import { PermanentError, TransientError } from "@pubrick/shared";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiCredentialProbe } from "./ai-credentials.probe";

/**
 * The key a provider is about to echo back at us.
 *
 * OpenAI-style bodies quote the submitted credential verbatim
 * ("Incorrect API key provided: sk-…"), and Google's quota errors quote the
 * request URL, which carries `?key=`. The Test endpoint hands its reason
 * straight to a browser, so this string must not survive the trip — and the
 * module e2e cannot prove that, because it replaces this very class.
 */
const SECRET_KEY = "sk-live-never-leak-this-0123456789";

const credential: AiCredential = {
  provider: "google",
  apiKey: SECRET_KEY,
  defaultModel: "gemini-3.7-flash",
};

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "google",
    modelId: "gemini-3.7-flash",
    attempt: 1,
    inputTokens: 12,
    outputTokens: 3,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.00002,
    costSource: "price_table",
    responseMs: 210,
    status: "ok",
    outcome: "completed",
    ...overrides,
  };
}

/**
 * Replaces the one method that reaches a provider, and nothing else: `run`'s
 * classification — the part that must never leak — is the real one.
 */
class StubbedProbe extends AiCredentialProbe {
  constructor(private readonly behaviour: (onUsage: UsageSink) => Promise<string>) {
    super();
  }

  protected override call(_credential: AiCredential, onUsage: UsageSink): Promise<string> {
    return this.behaviour(onUsage);
  }
}

function probeThatThrows(error: unknown, records: readonly UsageRecord[] = []): AiCredentialProbe {
  return new StubbedProbe(async (onUsage) => {
    for (const r of records) await onUsage(r);
    throw error;
  });
}

describe("AiCredentialProbe — a provider error can never carry the key out", () => {
  it("returns a code, not the provider's sentence, when the key is rejected", async () => {
    const outcome = await probeThatThrows(
      new PermanentError(
        `Incorrect API key provided: ${SECRET_KEY}. You can find your API key at https://example.test/keys`,
        401,
      ),
    ).run(credential);

    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(SECRET_KEY);
    expect(outcome).toEqual({ ok: false, reason: "invalid_key", records: [] });
  });

  it("keeps a rate-limit message out too, key or no key", async () => {
    const outcome = await probeThatThrows(
      new TransientError(`Rate limit reached for key ${SECRET_KEY}`, 30),
    ).run(credential);

    expect(JSON.stringify(outcome)).not.toContain(SECRET_KEY);
    expect(outcome).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("keeps an unclassifiable error's text out — the default is a code as well", async () => {
    const outcome = await probeThatThrows(
      new Error(`connect ECONNREFUSED https://example.test/v1?key=${SECRET_KEY}`),
    ).run(credential);

    expect(JSON.stringify(outcome)).not.toContain(SECRET_KEY);
    expect(outcome).toMatchObject({ ok: false, reason: "refused" });
  });

  it("does not leak the key through a SUCCESSFUL result either", async () => {
    const outcome = await new StubbedProbe(async (onUsage) => {
      await onUsage(record());
      return "gemini-3.7-flash";
    }).run(credential);

    expect(JSON.stringify(outcome)).not.toContain(SECRET_KEY);
    expect(outcome).toMatchObject({ ok: true, modelId: "gemini-3.7-flash" });
  });
});

describe("AiCredentialProbe — what the verdict says", () => {
  it("names a bad model id rather than blaming the key", async () => {
    const outcome = await probeThatThrows(new PermanentError("model not found", 404)).run(
      credential,
    );

    expect(outcome).toMatchObject({ ok: false, reason: "model_not_found" });
  });

  it("reports a model that answered but could not match the schema as exactly that", async () => {
    // The provider counted tokens, so it DID answer; the failure came from our
    // own structured-output layer. That distinction is the whole point of this
    // button, and it is read from the metered tokens, not from error prose.
    const outcome = await probeThatThrows(
      new PermanentError(
        "the model returned output that does not match the required schema, twice",
      ),
      [record({ status: "errored" }), record({ attempt: 2, status: "errored" })],
    ).run(credential);

    expect(outcome).toMatchObject({ ok: false, reason: "no_structured_output" });
  });

  it("does not blame structured output for a round trip that never counted a token", async () => {
    const outcome = await probeThatThrows(new PermanentError("socket hang up"), [
      record({ inputTokens: 0, outputTokens: 0, costUsd: null, costSource: "unknown" }),
    ]).run(credential);

    expect(outcome).toMatchObject({ ok: false, reason: "refused" });
  });

  it("calls a 4xx nobody named a refusal, even when the provider billed for it", async () => {
    // A status the closed set has no name for — 400, 429-as-permanent, 451 —
    // is a REFUSAL, and the arm that says so is load-bearing precisely because
    // the fallback underneath it looks reasonable. Delete `if (status !==
    // undefined) return "refused"` and this same error falls through to the
    // token-counting branch, which sees a metered round trip and reports
    // `no_structured_output`: "your model cannot follow a schema" told to a
    // user whose actual problem is a rejected request. Every other test in this
    // file either has no status at all or has one of the three named ones, so
    // nothing else observes this arm.
    const outcome = await probeThatThrows(new PermanentError("Unsupported parameter", 400), [
      record({ status: "errored" }),
    ]).run(credential);

    expect(outcome).toMatchObject({ ok: false, reason: "refused" });

    // Same arm from the other side: a 5xx that DID count tokens is not a schema
    // failure either.
    const server = await probeThatThrows(new PermanentError("upstream exploded", 503), [
      record({ status: "errored" }),
    ]).run(credential);

    expect(server).toMatchObject({ ok: false, reason: "refused" });
  });

  it("reports the model that actually answered, not the one we asked for", async () => {
    const outcome = await new StubbedProbe(async (onUsage) => {
      await onUsage(record({ modelId: "gemini-3.7-flash-8b" }));
      return "gemini-3.7-flash";
    }).run(credential);

    expect(outcome).toMatchObject({ ok: true, modelId: "gemini-3.7-flash-8b" });
  });
});

describe("AiCredentialProbe — every physical call is handed back to be billed", () => {
  it("keeps the repair retry's record, so a two-call Test is charged as two calls", async () => {
    // `maxRetries: 0` switches off transport retries only. A schema violation
    // still costs a second physical call — the repair — and this button exists
    // to provoke exactly that violation, so two records is the normal case, not
    // an edge one.
    const outcome = await new StubbedProbe(async (onUsage) => {
      await onUsage(record({ attempt: 1 }));
      await onUsage(record({ attempt: 2 }));
      return "gemini-3.7-flash";
    }).run(credential);

    expect(outcome.records).toHaveLength(2);
  });

  it("keeps the records of a FAILED call — the provider billed for them anyway", async () => {
    const outcome = await probeThatThrows(new PermanentError("boom", 500), [
      record({ status: "errored" }),
    ]).run(credential);

    expect(outcome.records).toHaveLength(1);
  });
});

/**
 * A provider that has stopped talking: it never answers, and the only thing
 * that can end the call is the signal it was handed. Rejecting with the
 * signal's own `reason` is what a real `fetch` does, and it is what lets
 * `classifyAiError` tell "our budget ran out" from "someone pressed stop".
 */
function hangingModel() {
  return new MockLanguageModelV4({
    modelId: "gemini-3.7-flash",
    doGenerate: async (options) =>
      await new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener("abort", () => {
          reject(options.abortSignal?.reason);
        });
      }),
  });
}

/**
 * The real `generateStructured`, on a model that never answers.
 *
 * The ONE production line replaced is `resolveModel` — everything after it is
 * the shipping code: the composite abort signal, the budget's `TimeoutError`,
 * `classifyAiError`'s tag, `run`'s catch, and `classifyProbeFailure`'s lookup.
 * Stubbing the thrown error instead would test this file's idea of what a
 * timeout looks like, which is precisely the kind of second copy that let a
 * timeout be reported as a rate limit in the first place.
 */
class TimingOutProbe extends AiCredentialProbe {
  protected override async call(_credential: AiCredential, onUsage: UsageSink): Promise<string> {
    await generateStructured({
      model: hangingModel(),
      provider: "google",
      schema: z.object({ ok: z.literal(true) }),
      instructions: "irrelevant",
      prompt: "Say ok",
      onUsage,
      maxRetries: 0,
      timeoutMs: 30,
    });
    return "gemini-3.7-flash";
  }
}

describe("AiCredentialProbe — a call that ran out of time", () => {
  it("says the call timed out, end to end, and never that the provider was busy", async () => {
    const outcome = await new TimingOutProbe().run(credential);

    // The bug this closes: the budget landed with no member meaning "ran out of
    // time" in either closed set, so the Test button reported `rate_limited` —
    // "The provider is rate-limiting or temporarily unavailable. Try again
    // shortly." The provider said nothing at all, and waiting is not the fix.
    expect(outcome).toMatchObject({ ok: false, reason: "timed_out" });
    expect(outcome).not.toMatchObject({ reason: "rate_limited" });
  });

  it("still hands back the round trip it gave up on, because it may have been billed", async () => {
    // The provider can have finished generating and been billing while we hung
    // up. The row carries no tokens and no price, so the org's total has to say
    // "≥" rather than quietly stay an estimate.
    const outcome = await new TimingOutProbe().run(credential);

    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]).toMatchObject({
      status: "errored",
      costUsd: null,
      costSource: "unknown",
      outcome: "unknown",
    });
  });
});

describe("AiCredentialProbe — the verdict is read from the classifier's tag", () => {
  /**
   * The mapping used to be re-derived here from the HTTP status, in parallel
   * with `classifyAiError`'s own. Two copies of one mapping is how `timed_out`
   * arrived in `RUN_FAILURES` and never reached this file. These four throw
   * what the SDK really throws and let the real classifier tag it, so the tag
   * is what the assertions observe.
   */
  function apiError(statusCode: number) {
    return new APICallError({
      message: `status ${statusCode}`,
      url: "https://example.invalid/v1/models",
      requestBodyValues: {},
      statusCode,
    });
  }

  it("trusts the tag over the meter when the two could disagree", () => {
    // `generateStructured` tags its own schema failures, and that tag is read
    // before the token-counting fallback. The arm is load-bearing rather than
    // belt-and-braces: a repair attempt that threw before the provider reported
    // usage leaves ZERO metered tokens, and the meter alone would then call a
    // schema failure a refusal — "the provider refused the request, check your
    // key" told to someone whose key is fine and whose model cannot follow a
    // schema.
    const tagged = withRunFailure(
      new PermanentError(
        "the model returned output that does not match the required schema, twice",
      ),
      "no_structured_output",
    );

    return probeThatThrows(tagged, [
      record({ inputTokens: 0, outputTokens: 0, costUsd: null, costSource: "unknown" }),
    ])
      .run(credential)
      .then((outcome) => {
        expect(outcome).toMatchObject({ ok: false, reason: "no_structured_output" });
      });
  });

  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [404, "model_not_found"],
    [400, "refused"],
    [429, "rate_limited"],
  ] as const)("maps a real %i the way the run pipeline does: %s", async (status, reason) => {
    const outcome = await probeThatThrows(apiError(status)).run(credential);

    expect(outcome).toMatchObject({ ok: false, reason });
  });
});
