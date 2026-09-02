/**
 * Local price table.
 *
 * Rates are stored with an effective date rather than as bare numbers because
 * Gemini 3.7 and 3.6 Flash are on an explicitly introductory price that doubles
 * on 2027-01-01. Storing the future rate now makes that change data, not a code
 * change made in a hurry on a January morning.
 *
 * A model the table does not know returns `null`, and the caller records the
 * ledger row with `cost_source: "unknown"` and `cost_usd: null`. That is a real
 * outcome — OpenRouter's catalogue has a long tail and Google adds models — and
 * it is why the ledger column is nullable: a missing cost summed as zero renders
 * a confident, wrong number.
 *
 * WHAT IS DELIBERATELY MISSING IS AS LOAD-BEARING AS WHAT IS HERE. Every rate
 * below was read off Google's own pricing page
 * (https://ai.google.dev/gemini-api/docs/pricing) on 2026-09-02; a model whose
 * rate could not be confirmed there is absent, and prices as unknown. "Cost not
 * reported" carries no information, but it is at least true — a number invented
 * for a model nobody checked would be believed.
 *
 * Until 2026-09-02 this table held ONE key, `gemini-3.7-flash`, matched as an
 * exact string. Everything else an org could type into the Settings model field
 * — every other Flash, every Pro, `models/gemini-3.7-flash` (the Gemini REST
 * full resource name), `GEMINI-3.7-FLASH`, and OpenRouter's `google/…` ids on
 * the calls OpenRouter reported no cost for — priced as unknown for ever.
 */

/**
 * Dollars per million tokens.
 *
 * `longContext` exists because Google's Pro models charge by PROMPT SIZE: the
 * rate above 200k input tokens is roughly double, and it moves the output rate
 * too, not just the input one. A table that stored only the small-prompt rate
 * would understate a long call — the direction of error this whole module is
 * built to avoid — so the threshold travels with the rate and
 * `estimateCostUsd` applies it.
 */
export type ModelRate = {
  inputPerMTok: number;
  outputPerMTok: number;
  longContext?: {
    /** Prompts STRICTLY LARGER than this bill at the rates below ("≤ 200k" is the low tier). */
    fromInputTokens: number;
    inputPerMTok: number;
    outputPerMTok: number;
  };
};

type RateWindow = ModelRate & {
  /** ISO date. The window applies from this instant until the next window starts. */
  effectiveFrom: string;
};

/** Before any window we would ever write; the opening window of every schedule. */
const ALWAYS = "1970-01-01";

/** The day Google's introductory Gemini 3 Flash pricing ends and the rate doubles. */
const INTRO_ENDS = "2027-01-01";

/**
 * The Gemini 3 Flash tier — 3.7 and 3.6, which Google prices identically.
 * $0.75 / $3.75 per 1M is introductory "through December 31, 2026" and becomes
 * $1.50 / $7.50 on 2027-01-01, per Google's own pricing page.
 */
const GEMINI_3_FLASH_TIER: RateWindow[] = [
  { effectiveFrom: ALWAYS, inputPerMTok: 0.75, outputPerMTok: 3.75 },
  { effectiveFrom: INTRO_ENDS, inputPerMTok: 1.5, outputPerMTok: 7.5 },
];

/** One flat rate, for ever. Most of the table. */
function flat(inputPerMTok: number, outputPerMTok: number): RateWindow[] {
  return [{ effectiveFrom: ALWAYS, inputPerMTok, outputPerMTok }];
}

/**
 * Google's Gemini rates, keyed by MODEL FAMILY rather than by exact id — see
 * `familyWindowsFor` for what a family accepts.
 *
 * Text-input rates throughout. Google charges more for AUDIO input on four of
 * these (2.5 Flash $1.00, 2.5 Flash-Lite $0.30, 3.1 Flash-Lite $0.50,
 * 3-flash-preview $1.00 per 1M), and this package has no audio path at all:
 * `generateStructured` takes an `instructions` string and a `prompt` string and
 * nothing else. Whoever adds a file part to that call has to come back here,
 * because the ledger row does not record modality and this table would quietly
 * undercharge it.
 *
 * `gemini-3.7-flash-lite` and `gemini-3.7-pro` are NOT here and are not
 * oversights: neither exists. Google's model list for the 3 family is 3.1 Pro,
 * 3.7/3.6/3.5 Flash and 3.5/3.1 Flash-Lite, so those two ids reach a provider
 * as a 404 (`model_not_found`) rather than as a run to price. Should Google
 * ship a 3.7 Lite, the family rule below refuses to lend it Flash's rate — a
 * Lite has been between two and eight times cheaper than its Flash in every
 * generation, and guessing high is still guessing.
 */
const GOOGLE_RATES: Record<string, RateWindow[]> = {
  "gemini-3.7-flash": GEMINI_3_FLASH_TIER,
  "gemini-3.6-flash": GEMINI_3_FLASH_TIER,
  "gemini-3.5-flash": flat(1.5, 9),
  "gemini-3.5-flash-lite": flat(0.3, 2.5),
  "gemini-3.1-flash-lite": flat(0.25, 1.5),
  "gemini-3-flash-preview": flat(0.5, 3),
  "gemini-3.1-pro-preview": [
    {
      effectiveFrom: ALWAYS,
      inputPerMTok: 2,
      outputPerMTok: 12,
      longContext: { fromInputTokens: 200_000, inputPerMTok: 4, outputPerMTok: 18 },
    },
  ],
  "gemini-2.5-flash": flat(0.3, 2.5),
  "gemini-2.5-flash-lite": flat(0.1, 0.4),
  "gemini-2.5-pro": [
    {
      effectiveFrom: ALWAYS,
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      longContext: { fromInputTokens: 200_000, inputPerMTok: 2.5, outputPerMTok: 15 },
    },
  ],
};

/**
 * Suffix segments that mean "a version of the same model", and therefore the
 * same price: `-preview`, `-latest`, `-exp`, and any pure-number segment
 * (`-001`, `-preview-11-20`).
 *
 * An ALLOWLIST, not a denylist, and that is the whole safety argument. A
 * denylist prices `gemini-3.7-flash-<anything Google invents next>` at Flash's
 * rate and only stops being wrong when someone remembers to add a word;
 * an allowlist prices it as unknown until someone reads the pricing page.
 * `-lite`, `-pro`, `-image`, `-tts`, `-live`, `-transcribe` are all different
 * products at different prices, and all of them are rejected by not being
 * mentioned here.
 */
const VERSION_QUALIFIERS = new Set(["preview", "latest", "exp"]);

/**
 * Exported for `pricing.test.ts` (never from the package index): the family
 * matcher's safety rests entirely on this predicate, and on the invariant —
 * checked there — that no family in the table is another family plus a
 * qualifier. Both need to be testable directly, not only through their effect
 * on a rate.
 */
export function isVersionQualifier(suffix: string): boolean {
  return suffix
    .split("-")
    .every((segment) => VERSION_QUALIFIERS.has(segment) || /^\d+$/.test(segment));
}

/**
 * Reduce whatever the org typed, or whatever the SDK reported, to a bare Gemini
 * model id — or `null` when this table has no business pricing it.
 *
 * Three steps, each closing a way the exact-string lookup used to miss:
 *
 * 1. Case. The Settings model field is free text validated only by the Test
 *    button, so `Gemini-3.7-Flash` is a thing a person types.
 * 2. `models/`. Gemini's REST API names a model `models/gemini-3.7-flash`, and
 *    that is the string a user copies out of the API docs or a `ListModels`
 *    response.
 * 3. The vendor prefix. OpenRouter reports the real cost of nearly every call
 *    in `providerMetadata`, and that report always wins. This is the fallback
 *    for the calls where the field is simply absent: a `google/…` id is the
 *    same Google model, and OpenRouter's own catalogue lists it at Google's
 *    list price. Every other vendor's rates are not in this file, so every
 *    other vendor is `null`.
 *
 * There is deliberately NO branch for OpenRouter's `:` variants (`:free`,
 * `:nitro`, `:floor`), which must never be priced from this table — a `:free`
 * call costs nothing and the others route to a different provider at a
 * different rate. One was written, and removing it is the point: a colon can
 * never be part of a version qualifier, so `gemini-3.7-flash:free` matches no
 * family and prices as unknown without any help. Mutation testing found the
 * branch unreachable — no test could tell it from its own absence — and an arm
 * nothing can reach is the same defect as a code nothing can produce, which is
 * what this commit is about. `pricing.test.ts` keeps the GUARANTEE pinned; only
 * the redundant arm is gone.
 */
function normalizeModelId(provider: string, modelId: string): string | null {
  const id = modelId.trim().toLowerCase();
  const bare = id.startsWith("models/") ? id.slice("models/".length) : id;

  if (provider === "google") return bare;
  if (provider !== "openrouter") return null;
  return bare.startsWith("google/") ? bare.slice("google/".length) : null;
}

/**
 * Every family the table prices. Exported for `pricing.test.ts`, and not from
 * the package index: a family added without a row in that file's rate table is
 * a failing gate, which is the only thing standing between "we added a model"
 * and "we added a number nobody checked against Google's page".
 */
export const PRICE_TABLE_FAMILIES: readonly string[] = Object.keys(GOOGLE_RATES);

/**
 * The rate schedule for a normalised id, matched by family.
 *
 * An exact id wins outright, and that arm is load-bearing rather than a fast
 * path: `gemini-3.5-flash-lite` would otherwise be tested against the
 * `gemini-3.5-flash` family, whose `-lite` suffix the qualifier rule refuses —
 * so a Flash-Lite would price as unknown instead of as itself.
 *
 * Below that, the FIRST prefix match wins, and it can only ever be the only
 * one: `pricing.test.ts` pins that no family in this table is another family
 * plus a version qualifier. Ranking candidates by length instead would look
 * safer and be worse — it would silently pick one of two plausible rates the
 * day such a pair appeared, where the invariant makes that day a red test.
 */
function familyWindowsFor(id: string): RateWindow[] | null {
  const exact = GOOGLE_RATES[id];
  if (exact !== undefined) return exact;

  for (const [family, windows] of Object.entries(GOOGLE_RATES)) {
    if (!id.startsWith(`${family}-`)) continue;
    if (isVersionQualifier(id.slice(family.length + 1))) return windows;
  }
  return null;
}

/**
 * The rates in force for `modelId` at `at`, or `null` if the table has never
 * heard of the model.
 */
export function priceFor(provider: string, modelId: string, at: Date): ModelRate | null {
  const id = normalizeModelId(provider, modelId);
  if (id === null) return null;

  const windows = familyWindowsFor(id);
  if (windows === null) return null;

  // The latest window that has already started — picked by date, not by array
  // position, so a rate appended out of order cannot silently misprice a call.
  let current: RateWindow | null = null;
  let currentStart = Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    const start = Date.parse(window.effectiveFrom);
    if (start <= at.getTime() && start >= currentStart) {
      current = window;
      currentStart = start;
    }
  }
  if (current === null) return null;

  // Returned without `effectiveFrom`: callers compare rates, not provenance.
  return {
    inputPerMTok: current.inputPerMTok,
    outputPerMTok: current.outputPerMTok,
    ...(current.longContext === undefined ? {} : { longContext: current.longContext }),
  };
}

/**
 * Cost of one call from the price table, in dollars.
 *
 * `outputTokens` already includes reasoning tokens (the SDK's flat total is the
 * sum of its `outputTokenDetails`), and on Gemini 3.x thinking bills at the
 * output rate — so reasoning needs no separate term here.
 *
 * CACHED INPUT IS STILL CHARGED AT THE FULL INPUT RATE, and that is now a
 * measured decision rather than the guess this comment used to record. Google
 * bills cache reads at a tenth of the input rate (3.7 Flash: $0.075 against
 * $0.75), so a heavily cached call is overstated — but the exposure is not
 * "small", it is zero: nothing in this package creates an explicit cache, and
 * implicit caching needs a shared prefix longer than the minimum this
 * product's prompts reach, so `cachedInputTokens` is 0 on every row it writes.
 * Discounting a number that is always zero would be untestable against any real
 * call, and it would cost a second half-confirmed column: Google publishes no
 * cache rate at all for 3.5 Flash-Lite. The moment a step starts caching — an
 * explicit cache, or a brand voice long enough to trip the implicit one — this
 * is the first thing to fix, and `UsageRecord.cachedInputTokens` is already
 * recorded so the size of the error can be measured before it is.
 */
export function estimateCostUsd(
  rate: ModelRate,
  tokens: { inputTokens: number; outputTokens: number },
): number {
  // Google's Pro tiers price by prompt size, and the tier moves the OUTPUT rate
  // as well: "$12.00, prompts ≤200k; $18.00, prompts >200k". So the input count
  // selects both rates.
  const tier =
    rate.longContext !== undefined && tokens.inputTokens > rate.longContext.fromInputTokens
      ? rate.longContext
      : rate;

  const dollars =
    (tokens.inputTokens * tier.inputPerMTok + tokens.outputTokens * tier.outputPerMTok) / 1_000_000;
  // The ledger column is numeric(12,6); rounding here keeps the stored value and
  // the value we just computed identical.
  const rounded = Math.round(dollars * 1_000_000) / 1_000_000;

  // A call that cost something must never store 0.000000. The column cannot hold
  // the true figure, and the UI renders a `price_table` row as a definite "≈ $0.00"
  // — a call that was billed reported as free. The smallest unit the column can
  // express is the honest floor.
  if (dollars > 0 && rounded === 0) return 0.000001;
  return rounded;
}
