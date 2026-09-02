import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  isVersionQualifier,
  type ModelRate,
  PRICE_TABLE_FAMILIES,
  priceFor,
} from "./pricing.js";

/** Any date inside the introductory window; the schedule tests move it deliberately. */
const TODAY = new Date("2026-09-02");

function rate(inputPerMTok: number, outputPerMTok: number): ModelRate {
  return { inputPerMTok, outputPerMTok };
}

/**
 * Every family in the table, and every id shape that must reach it.
 *
 * The table is the test. Until 2026-09-02 `priceFor` matched one exact string,
 * so `gemini-3.7-flash-preview`, `models/gemini-3.7-flash`, a capitalised id
 * and every other Gemini priced as unknown — and "cost not reported (12 calls)"
 * is an honest label carrying no information at all. A row here is a claim that
 * a real id an org can type reaches a real published rate.
 *
 * Rates were read off https://ai.google.dev/gemini-api/docs/pricing on
 * 2026-09-02 (paid tier, text input).
 */
const FAMILIES: ReadonlyArray<{
  family: string;
  expected: ModelRate;
  ids: readonly string[];
}> = [
  {
    family: "gemini-3.7-flash",
    expected: rate(0.75, 3.75),
    ids: [
      "gemini-3.7-flash",
      // The Gemini REST API's own full resource name, which is what a user
      // copies out of the API docs or a ListModels response.
      "models/gemini-3.7-flash",
      // The Settings model field is free text; people capitalise.
      "GEMINI-3.7-FLASH",
      "  gemini-3.7-flash  ",
      // Version qualifiers are the same model at the same price.
      "gemini-3.7-flash-preview",
      "gemini-3.7-flash-preview-11-20",
      "gemini-3.7-flash-001",
      "gemini-3.7-flash-latest",
    ],
  },
  {
    family: "gemini-3.6-flash",
    expected: rate(0.75, 3.75),
    ids: ["gemini-3.6-flash", "models/gemini-3.6-flash", "gemini-3.6-flash-preview"],
  },
  {
    family: "gemini-3.5-flash",
    expected: rate(1.5, 9),
    ids: ["gemini-3.5-flash", "models/gemini-3.5-flash", "gemini-3.5-flash-002"],
  },
  {
    family: "gemini-3.5-flash-lite",
    expected: rate(0.3, 2.5),
    ids: ["gemini-3.5-flash-lite", "models/gemini-3.5-flash-lite", "gemini-3.5-flash-lite-preview"],
  },
  {
    family: "gemini-3.1-flash-lite",
    expected: rate(0.25, 1.5),
    ids: ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview"],
  },
  {
    family: "gemini-3-flash-preview",
    expected: rate(0.5, 3),
    ids: ["gemini-3-flash-preview", "models/gemini-3-flash-preview"],
  },
  {
    family: "gemini-3.1-pro-preview",
    expected: {
      inputPerMTok: 2,
      outputPerMTok: 12,
      longContext: { fromInputTokens: 200_000, inputPerMTok: 4, outputPerMTok: 18 },
    },
    ids: ["gemini-3.1-pro-preview", "models/gemini-3.1-pro-preview"],
  },
  {
    family: "gemini-2.5-flash",
    expected: rate(0.3, 2.5),
    ids: ["gemini-2.5-flash", "models/gemini-2.5-flash", "gemini-2.5-flash-preview-05-20"],
  },
  {
    family: "gemini-2.5-flash-lite",
    expected: rate(0.1, 0.4),
    ids: ["gemini-2.5-flash-lite", "gemini-2.5-flash-lite-001"],
  },
  {
    family: "gemini-2.5-pro",
    expected: {
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      longContext: { fromInputTokens: 200_000, inputPerMTok: 2.5, outputPerMTok: 15 },
    },
    ids: ["gemini-2.5-pro", "models/gemini-2.5-pro"],
  },
];

describe("priceFor — every id in a family reaches that family's rate", () => {
  for (const { family, expected, ids } of FAMILIES) {
    describe(family, () => {
      it.each(ids)("prices %s", (id) => {
        expect(priceFor("google", id, TODAY)).toEqual(expected);
      });
    });
  }

  it("prices the same families through OpenRouter's `google/…` ids", () => {
    // OpenRouter reports the real cost of nearly every call and that report
    // always wins. This is the fallback for the ones where the field is simply
    // absent — the same Google model, at the list price OpenRouter's own
    // catalogue quotes for it.
    for (const { expected, family } of FAMILIES) {
      expect(priceFor("openrouter", `google/${family}`, TODAY)).toEqual(expected);
    }
  });
});

describe("the table itself", () => {
  it("has a rate row above for every family it prices, and no orphans", () => {
    // The ratchet. A family added to `pricing.ts` without a row in `FAMILIES`
    // is a rate nobody wrote down a source for; a row here for a family that no
    // longer exists is a test asserting against a table it cannot see.
    expect([...PRICE_TABLE_FAMILIES].sort()).toEqual(FAMILIES.map((f) => f.family).sort());
  });

  it("contains no family that is another family plus a version qualifier", () => {
    // What makes "first prefix match wins" safe in `familyWindowsFor`. If
    // Google ever ships a `gemini-3-flash` alongside `gemini-3-flash-preview`,
    // an id like `gemini-3-flash-preview-11-20` becomes genuinely ambiguous —
    // and this fails, rather than the matcher quietly choosing one of the two
    // rates for it. `gemini-3.5-flash-lite` is NOT such a pair: `lite` is a
    // different product, which is exactly what the qualifier rule says.
    const ambiguous = PRICE_TABLE_FAMILIES.flatMap((family) =>
      PRICE_TABLE_FAMILIES.filter(
        (other) =>
          other !== family &&
          family.startsWith(`${other}-`) &&
          isVersionQualifier(family.slice(other.length + 1)),
      ).map((other) => `${family} vs ${other}`),
    );
    expect(ambiguous).toEqual([]);
  });
});

describe("isVersionQualifier — an allowlist, because the default must be `unknown`", () => {
  it.each(["preview", "latest", "exp", "001", "preview-11-20", "2025", "exp-0827"])(
    "accepts %s as the same model at the same price",
    (suffix) => {
      expect(isVersionQualifier(suffix)).toBe(true);
    },
  );

  it.each(["lite", "pro", "image", "tts", "live", "transcribe", "thinking", "8b", "preview-tts"])(
    "refuses %s, which names a different product at a different price",
    (suffix) => {
      expect(isVersionQualifier(suffix)).toBe(false);
    },
  );
});

describe("priceFor — a family lends its rate to nobody else", () => {
  it("does not read a Lite as its Flash, in either generation", () => {
    // Longest-family-first. Matching `gemini-3.5-flash` against
    // `gemini-3.5-flash-lite` would price a Lite call at five times its rate.
    expect(priceFor("google", "gemini-3.5-flash-lite", TODAY)).toEqual(rate(0.3, 2.5));
    expect(priceFor("google", "gemini-3.5-flash", TODAY)).toEqual(rate(1.5, 9));
    expect(priceFor("google", "gemini-2.5-flash-lite", TODAY)).toEqual(rate(0.1, 0.4));
    expect(priceFor("google", "gemini-2.5-flash", TODAY)).toEqual(rate(0.3, 2.5));
  });

  it.each([
    // Neither exists. Google's Gemini 3 line is 3.1 Pro, 3.7/3.6/3.5 Flash and
    // 3.5/3.1 Flash-Lite, so both of these reach a provider as a 404. If Google
    // ever ships them, a Lite that borrowed Flash's rate would be reported at
    // several times its price — a confident wrong number, which is worse than
    // the honest gap.
    "gemini-3.7-flash-lite",
    "gemini-3.7-pro",
    // A different product at a different price, sharing a prefix with one that
    // is in the table.
    "gemini-3.1-flash-lite-image",
    "gemini-2.5-flash-preview-tts",
    "gemini-3.5-flash-thinking",
    // A generation the table has never seen.
    "gemini-4-flash",
    "gemini-9.9-imaginary",
    // A family ends at a HYPHEN, and this is the only id here that says so.
    // Every other unknown above is `<family>-<something the qualifier rule
    // refuses>`, so it is refused by the qualifier rule and would still be
    // refused if the boundary were any character at all. This one is
    // `<family><character><digits>`: with the hyphen it is not the family and
    // is priced as unknown; without it, `gemini-3.5-flash` claims the id, the
    // suffix reads as a version number, and a model nobody has read a pricing
    // page for is reported at Flash's rate.
    "gemini-3.5-flash001",
  ])("prices %s as unknown rather than lending it a neighbour's rate", (id) => {
    expect(priceFor("google", id, TODAY)).toBeNull();
  });

  it("returns null for a provider it does not know", () => {
    expect(priceFor("anthropic", "claude-opus-5", new Date())).toBeNull();
  });

  it("returns null for an OpenRouter id that is not a Google model", () => {
    expect(priceFor("openrouter", "someone/new-model", TODAY)).toBeNull();
    expect(priceFor("openrouter", "openai/gpt-5", TODAY)).toBeNull();
    // A bare Gemini id on OpenRouter is not an OpenRouter id at all.
    expect(priceFor("openrouter", "gemini-3.7-flash", TODAY)).toBeNull();
  });

  it("refuses an OpenRouter variant suffix, which routes elsewhere or is free", () => {
    // `:free` costs nothing and `:nitro`/`:floor` pick a different provider at a
    // different price. Lending any of them Google's list price would invent a
    // charge for a call that may not have carried one.
    //
    // No branch in `normalizeModelId` enforces this and none should: a colon
    // cannot be part of a version-qualifier segment, so the family matcher
    // rejects these on its own. The one that existed was unreachable — no
    // mutation of it could be detected — and this test is what keeps the
    // guarantee true after it was removed.
    expect(priceFor("openrouter", "google/gemini-3.7-flash:free", TODAY)).toBeNull();
    expect(priceFor("openrouter", "google/gemini-3.7-flash:nitro", TODAY)).toBeNull();
    expect(priceFor("openrouter", "google/gemini-3.7-flash-preview:free", TODAY)).toBeNull();
    expect(priceFor("openrouter", "google/gemini-2.5-flash-001:nitro", TODAY)).toBeNull();
  });
});

describe("priceFor — the rate schedule", () => {
  it("returns the introductory Gemini 3 Flash rate before 2027 and the standard one after", () => {
    expect(priceFor("google", "gemini-3.7-flash", new Date("2026-09-01"))).toEqual(
      rate(0.75, 3.75),
    );
    expect(priceFor("google", "gemini-3.7-flash", new Date("2027-02-01"))).toEqual(rate(1.5, 7.5));
  });

  it("switches on the stroke of the effective date, not a day either side", () => {
    expect(priceFor("google", "gemini-3.7-flash", new Date("2026-12-31T23:59:59Z"))).toEqual(
      rate(0.75, 3.75),
    );
    expect(priceFor("google", "gemini-3.7-flash", new Date("2027-01-01T00:00:00Z"))).toEqual(
      rate(1.5, 7.5),
    );
  });

  it("moves 3.6 Flash on the same date, and leaves the flat-rate families alone", () => {
    expect(priceFor("google", "gemini-3.6-flash", new Date("2027-02-01"))).toEqual(rate(1.5, 7.5));
    expect(priceFor("google", "gemini-2.5-flash", new Date("2027-02-01"))).toEqual(rate(0.3, 2.5));
  });

  it("carries the schedule through every id shape, not just the bare family id", () => {
    expect(priceFor("google", "models/gemini-3.7-flash", new Date("2027-02-01"))).toEqual(
      rate(1.5, 7.5),
    );
    expect(priceFor("openrouter", "google/gemini-3.7-flash", new Date("2027-02-01"))).toEqual(
      rate(1.5, 7.5),
    );
  });
});

describe("estimateCostUsd rounding", () => {
  it("never rounds a call that cost something down to free", () => {
    // A cheap model — $0.05/MTok is well inside OpenRouter's range — makes a
    // one-token call cost 5e-8, which numeric(12,6) cannot express. Storing
    // 0.000000 would have the UI render a definite "≈ $0.00" for a billed call,
    // so the smallest unit the column can hold is the honest floor.
    const cheap = rate(0.05, 0.05);
    expect(estimateCostUsd(cheap, { inputTokens: 1, outputTokens: 0 })).toBe(0.000001);
  });

  it("still reports a genuinely zero-token call as zero", () => {
    expect(estimateCostUsd(rate(0.75, 3.75), { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output separately, per million tokens", () => {
    // 1M input at $0.75 plus 1M output at $3.75.
    expect(
      estimateCostUsd(rate(0.75, 3.75), { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(4.5);
  });

  it("rounds to the ledger column's six decimal places", () => {
    expect(estimateCostUsd(rate(0.75, 3.75), { inputTokens: 10, outputTokens: 5 })).toBe(0.000026);
  });
});

describe("estimateCostUsd — Google's long-prompt tier", () => {
  const pro = priceFor("google", "gemini-2.5-pro", TODAY) as ModelRate;

  it("bills a prompt of exactly 200k at the low tier, and one token more at the high one", () => {
    // Google's wording is "prompts ≤200k" for the low rate, so the boundary
    // belongs to the cheap side. A `>=` here would overcharge every call that
    // lands exactly on it.
    expect(estimateCostUsd(pro, { inputTokens: 200_000, outputTokens: 0 })).toBe(0.25);
    expect(estimateCostUsd(pro, { inputTokens: 200_001, outputTokens: 0 })).toBe(0.500003);
  });

  it("moves the OUTPUT rate too, because the prompt size selects both", () => {
    // "$10.00, prompts ≤200k; $15.00, prompts >200k" — the output rate is
    // chosen by the INPUT count, which is the part a per-side table gets wrong.
    expect(estimateCostUsd(pro, { inputTokens: 1, outputTokens: 1_000_000 })).toBe(10.000001);
    expect(estimateCostUsd(pro, { inputTokens: 300_000, outputTokens: 1_000_000 })).toBe(15.75);
  });

  it("leaves a flat-rate family flat at any prompt size", () => {
    const flash = priceFor("google", "gemini-3.7-flash", TODAY) as ModelRate;
    expect(flash.longContext).toBeUndefined();
    expect(estimateCostUsd(flash, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.75);
    expect(estimateCostUsd(flash, { inputTokens: 2_000_000, outputTokens: 0 })).toBe(1.5);
  });
});

describe("estimateCostUsd — cached input", () => {
  it("charges cached input at the full input rate, which OVERSTATES a cached call", () => {
    // Documented, not hidden. Google bills a cache read at a tenth of the input
    // rate ($0.075 against $0.75 on 3.7 Flash), and this function is not told
    // how many of its input tokens were cache reads. The exposure today is zero
    // — nothing here creates a cache and the prompts are below the implicit
    // minimum, so `UsageRecord.cachedInputTokens` is 0 on every row — and the
    // error runs in the safe direction for a column the UI prefixes with "≈".
    // This test exists so that the day it stops being zero, the choice is
    // visible rather than inherited.
    const flash = priceFor("google", "gemini-3.7-flash", TODAY) as ModelRate;
    expect(estimateCostUsd(flash, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.75);
  });
});
