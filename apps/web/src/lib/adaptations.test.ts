import { DELIVERY_OUTCOMES, PUBLISH_FAILURE_REASONS } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { POLL_INTERVAL_MS } from "@/hooks/use-poll";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import ru from "../../messages/ru.json";
import {
  ADAPTATION_STATUSES,
  CONTENT_BADGE_STATUS,
  CONTENT_LIST_POLL_INTERVAL_MS,
  CONTENT_STATUSES,
  DELIVERY_BADGE_STATUS,
  failureReasonKey,
  failureSentence,
  hasAdaptationInFlight,
  isAdaptationInFlight,
} from "./adaptations";

/** Walks a dotted message key into the `Content` namespace of `en.json`. */
function messageAt(namespace: unknown, key: string): string | undefined {
  const found = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      namespace,
    );
  return typeof found === "string" ? found : undefined;
}

/**
 * What used to be here: a ratchet that read `apps/worker/src/publish/
 * publish.service.ts` off disk and asserted the English sentence this module
 * matched on was still spelled that way. It existed because nothing in the
 * response said whether a failed adaptation's send had actually left, so the
 * screen recognised an unknown delivery by `startsWith` on a log line, and a
 * reworded sentence would have turned every one of them back into a plain red
 * "Failed" with no test anywhere noticing.
 *
 * The api ships `deliveryOutcome` now, so there is no sentence to pin and
 * nothing to read the worker's source for. What is left to check is that the
 * values the wire can carry all have a color.
 *
 * ALSO DELETED, on 2026-09-04: "is the one outcome the adaptation column cannot
 * hold", which asserted `DELIVERY_OUTCOMES === [...ADAPTATION_STATUSES,
 * "unknown"]` while those were a web copy and a `@pubrick/shared` list. Both
 * names are the shared package's now and the union is literally that spread, so
 * the assertion compared a value with itself. The relation it guarded is
 * asserted where it can still fail — `packages/shared/src/dto/content.test.ts`,
 * "adds exactly one value to the adaptation column's own".
 */
describe("the unknown delivery outcome", () => {
  it("gives every value the api can send a color, and no value it cannot", () => {
    expect(Object.keys(DELIVERY_BADGE_STATUS).sort()).toEqual([...DELIVERY_OUTCOMES].sort());
  });

  it("wears review's brick, not failed's red and not published's green", () => {
    expect(DELIVERY_BADGE_STATUS.unknown).toBe("review");
    expect(DELIVERY_BADGE_STATUS.unknown).not.toBe(DELIVERY_BADGE_STATUS.failed);
    expect(DELIVERY_BADGE_STATUS.unknown).not.toBe(DELIVERY_BADGE_STATUS.published);
  });
});

describe("what counts as in flight", () => {
  it("is exactly the two statuses the server moves on its own", () => {
    const inFlight = ADAPTATION_STATUSES.filter(isAdaptationInFlight);
    expect(inFlight).toEqual(["queued", "publishing"]);
  });

  it("leaves a scheduled adaptation out: its due time can be days away", () => {
    expect(isAdaptationInFlight("scheduled")).toBe(false);
    expect(hasAdaptationInFlight([{ status: "scheduled" }, { status: "pending" }])).toBe(false);
  });

  it("is true when any one adaptation of a fan-out is still going", () => {
    expect(
      hasAdaptationInFlight([{ status: "published" }, { status: "failed" }, { status: "queued" }]),
    ).toBe(true);
    expect(hasAdaptationInFlight([{ status: "published" }, { status: "failed" }])).toBe(false);
    expect(hasAdaptationInFlight([])).toBe(false);
  });
});

/**
 * The list itself is `@pubrick/shared`'s and is asserted there. What only this
 * app can answer is whether every member of it has been given one of the five
 * colors — and the runtime check earns its place beside the `Record<
 * ContentStatus, …>` annotation, because this app resolves the shared package
 * from its BUILD: a stale `dist` type-checks against the old union while the
 * screen runs against the new list.
 */
describe("the status unions", () => {
  it("keeps every content status colored", () => {
    expect(Object.keys(CONTENT_BADGE_STATUS).sort()).toEqual([...CONTENT_STATUSES].sort());
  });

  /**
   * THE KEY BEING MANDATORY IS NOT THE CLAIM. `Record<ContentStatus, …>` forces
   * a new status to be given SOME colour and cannot say which, so the one
   * decision this status exists to carry — that a half-sent post must not wear
   * `approved`'s blue, the colour of work in flight, when nothing is in flight
   * — was revertible in silence: the mutation to `"scheduled"` survived the
   * whole web suite 3/3.
   *
   * Asserted as a RELATION rather than as the literal `"review"` alone: what
   * matters is that it differs from `approved`, and pinning only the literal
   * would go green again if `approved` were one day painted brick too.
   */
  it("does not paint a half-sent post in approve's colour", () => {
    expect(CONTENT_BADGE_STATUS.partially_published).toBe("review");
    expect(CONTENT_BADGE_STATUS.partially_published).not.toBe(CONTENT_BADGE_STATUS.approved);
    expect(CONTENT_BADGE_STATUS.partially_published).not.toBe(CONTENT_BADGE_STATUS.published);
    expect(CONTENT_BADGE_STATUS.partially_published).not.toBe(CONTENT_BADGE_STATUS.failed);
  });
});

/**
 * The number itself is a tuning value and is deliberately NOT pinned: 5s or 6s
 * is a judgement about load, and a test that fails when someone changes it
 * asserts nothing except that nobody changed it. `content/page.test.tsx`
 * advances the clock BY this constant, so it proves the loop runs at whatever
 * the constant says and can never disagree with it.
 *
 * What is not a judgement is the RELATION the constant is documented by. This
 * list is polled by everyone with the main screen open; the item screen is
 * polled by the one person who just pressed the button. Setting the list to the
 * item screen's interval — or below it — multiplies the busiest screen's
 * request rate by the number of people watching, which is the one way to change
 * this number that is a defect rather than a preference.
 */
describe("how often the queue re-reads itself", () => {
  it("re-reads the LIST more slowly than the item screen re-reads one row", () => {
    expect(CONTENT_LIST_POLL_INTERVAL_MS).toBeGreaterThan(POLL_INTERVAL_MS);
  });
});

/**
 * THE CATALOGUE IS TOTAL, AND A TENTH REASON MUST BREAK THIS BUILD.
 *
 * `PUBLISH_FAILURE_REASONS` lives in `@pubrick/shared` and is written by the
 * worker; the sentences live here. A reason added there with no sentence here
 * would reach a reader as a blank line under a red badge — the failure states
 * nothing, which is the silence the column was added to end. The `Record` in
 * `failureReasonKey` makes that a compile error; this makes it a red test as
 * well, because the web resolves `@pubrick/shared` from `dist` and a stale
 * `dist` is a typecheck that never sees the new member.
 */
describe("every failure reason has a sentence", () => {
  it("maps all of PUBLISH_FAILURE_REASONS to a key that exists in en.json", () => {
    const missing = PUBLISH_FAILURE_REASONS.filter(
      (reason) => messageAt(en.Content, failureReasonKey(reason)) === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("gives each reason its OWN key — no two failures read the same", () => {
    const keys = PUBLISH_FAILURE_REASONS.map(failureReasonKey);
    expect(new Set(keys).size).toBe(PUBLISH_FAILURE_REASONS.length);
  });

  /**
   * The map is not an alphabet soup: each of the nine is named here against the
   * English sentence it must produce, so a mutation that swaps two keys — a
   * missed slot captioned "reconnect the channel on the brand's page" — is red
   * rather than merely different.
   */
  it.each([
    ["schedule_missed", "Missed its slot"],
    ["no_adapter", "cannot post to"],
    ["credentials_unreadable", "could not be read"],
    ["credentials_missing", "no longer connected"],
    ["credentials_invalid", "not what the platform expects"],
    ["platform_rejected", "The platform refused"],
    ["retries_exhausted", "did not accept this post"],
    ["send_abandoned", "stopped before it reached the platform"],
    ["outcome_unknown", "never confirmed it"],
  ] as const)("%s reads about %s", (reason, fragment) => {
    const text = messageAt(en.Content, failureReasonKey(reason));
    expect(text).toContain(fragment);
  });
});

/**
 * THE ATTEMPT COUNT IS PLURALISED BY ICU, IN EVERY LANGUAGE.
 *
 * The sentence was "after {attempts} attempts" in all four, which reads "after
 * 1 attempts" in English — `markExhausted` guards on `publishing` alone, so a
 * one-attempt row is renderable — and is ungrammatical in Russian for anything
 * ending in 2, 3 or 4 ("за 2 попыток"). The number is interpolated, so this is
 * `plural` or it is a copy of the bug in each locale.
 */
describe("the attempts in a give-up sentence", () => {
  it.each(["en", "ru", "es", "pt"] as const)("%s pluralises them with ICU", (name) => {
    const messages = { en, ru, es, pt }[name];
    const sentence = messageAt(messages.Content, "failureReason.retriesExhausted");
    expect(sentence).toContain("{attempts, plural,");
  });

  /**
   * Russian needs all three forms plus `other`; a `one`/`other` pair copied
   * from English is wrong for 2-4 and for the decimal `other`.
   */
  it("gives Russian its few and many forms", () => {
    const sentence = messageAt(ru.Content, "failureReason.retriesExhausted") ?? "";
    expect(sentence).toContain("few {");
    expect(sentence).toContain("many {");
  });
});

/**
 * THE SCREEN IT SENDS THE READER TO HAS TO BE THE SCREEN THAT CAN DO IT.
 *
 * The three credential sentences are the only ones that ask for an action, and
 * they used to ask for it in Settings. Channels are not in Settings: they are
 * on the brand's own page (`app/[locale]/brands/[id]/page.tsx` — add, edit,
 * test connection, remove), and Settings holds appearance, the AI provider,
 * the account and the workspace. The shell offers exactly three destinations,
 * so the sentence named the wrong one of three for the one class of failure
 * where the reader has something to do about it.
 *
 * Asserted per LOCALE and against the app's own nav words rather than against
 * the English string, because the destination is what has to be right in all
 * four — a page test can only see one of them, and it was a page test asserting
 * the word "Settings" that let this ship.
 */
describe("a credential failure sends the reader to the brand screen", () => {
  const LOCALES = [
    // The settings word is given as a STEM: Russian inflects it inside the
    // sentence ("в настройках"), so the nav label itself would never match.
    { name: "en", messages: en, settingsStem: "settings" },
    { name: "ru", messages: ru, settingsStem: "настройк" },
    { name: "es", messages: es, settingsStem: "ajustes" },
    { name: "pt", messages: pt, settingsStem: "configuraç" },
  ] as const;

  const CREDENTIAL_REASONS = [
    "credentials_unreadable",
    "credentials_missing",
    "credentials_invalid",
  ] as const;

  it.each(LOCALES)("$name names Brands and never Settings", ({ messages, settingsStem }) => {
    const brands = messages.Nav.brands.toLowerCase();
    for (const reason of CREDENTIAL_REASONS) {
      const sentence = messageAt(messages.Content, failureReasonKey(reason))?.toLowerCase();
      expect(sentence).toBeDefined();
      expect(sentence).toContain(brands);
      expect(sentence).not.toContain(settingsStem);
    }
  });
});

/**
 * WHAT A FAILED ROW SAYS, and where the numbers in it come from.
 *
 * The translator here is a recorder rather than next-intl: what is being
 * pinned is the KEY and the VALUES this module chooses per reason, which is
 * the whole of its behaviour. The sentences themselves are pinned against
 * `en.json` above, and rendered for real in the two page tests.
 */
describe("failureSentence", () => {
  const recorder = () => {
    const calls: { key: string; values?: Record<string, string | number> }[] = [];
    const t = (key: string, values?: Record<string, string | number>) => {
      calls.push({ key, values });
      return `${key}:${JSON.stringify(values ?? {})}`;
    };
    return { calls, t };
  };

  const row = (over: Partial<Parameters<typeof failureSentence>[0]> = {}) => ({
    failureReason: null,
    lastError: null,
    lateBySeconds: null,
    attemptCount: 0,
    ...over,
  });

  it("says how late a missed slot was, from the SERVER's seconds", () => {
    const { calls, t } = recorder();
    failureSentence(
      row({ failureReason: "schedule_missed", lateBySeconds: 26 * 3600 }),
      t,
      "#news",
    );
    expect(calls).toEqual([{ key: "failureReason.scheduleMissed", values: { hours: "26.0" } }]);
  });

  /**
   * ROUNDED UP, never to nearest: "missed its slot by {hours} h" is a claim
   * about how long the reader's post sat there, and a number rounded down
   * understates it — a post 6.9 h past a 6 h bound would read "6 h late",
   * which is the bound itself and reads as "only just".
   */
  it("rounds the lateness UP to a tenth of an hour", () => {
    const { calls, t } = recorder();
    failureSentence(
      row({ failureReason: "schedule_missed", lateBySeconds: 6 * 3600 + 1 }),
      t,
      "#news",
    );
    expect(calls[0]?.values).toEqual({ hours: "6.1" });
  });

  it("falls back to a sentence with no hours when the receipt cannot say", () => {
    const { calls, t } = recorder();
    failureSentence(row({ failureReason: "schedule_missed", lateBySeconds: null }), t, "#news");
    expect(calls).toEqual([{ key: "failureReason.scheduleMissedNoHours", values: undefined }]);
  });

  /**
   * THE ONE REASON THAT STILL PRINTS THE WORKER'S TEXT, because the platform
   * wrote it: our sentence frames it, the platform's own words follow.
   */
  it("carries the platform's own words when the platform is what refused", () => {
    const { calls, t } = recorder();
    failureSentence(
      row({ failureReason: "platform_rejected", lastError: "Bad Request: message is too long" }),
      t,
      "#news",
    );
    expect(calls).toEqual([
      {
        key: "failureReason.platformRejected",
        values: { error: "Bad Request: message is too long" },
      },
    ]);
  });

  it("still frames a platform refusal that came with no text", () => {
    const { calls, t } = recorder();
    failureSentence(row({ failureReason: "platform_rejected", lastError: null }), t, "#news");
    expect(calls[0]?.key).toBe("failureReason.platformRejectedNoText");
  });

  it("counts the attempts when the queue gave up", () => {
    const { calls, t } = recorder();
    failureSentence(row({ failureReason: "retries_exhausted", attemptCount: 6 }), t, "#news");
    expect(calls).toEqual([{ key: "failureReason.retriesExhausted", values: { attempts: 6 } }]);
  });

  it("names the channel where the reader has to go and look", () => {
    const { calls, t } = recorder();
    failureSentence(row({ failureReason: "credentials_unreadable" }), t, "#news");
    expect(calls[0]?.values).toEqual({ channel: "#news" });
  });

  /**
   * NEVER THE WORKER'S PROSE WHEN A CODE IS THERE. The sentence the worker
   * froze into `last_error` is an English log line; the reader may not read
   * English, and this product ships in four languages. The code is what the
   * screen speaks from.
   */
  it("ignores last_error entirely when a reason is present", () => {
    const { t } = recorder();
    const text = failureSentence(
      row({
        failureReason: "schedule_missed",
        lateBySeconds: 3600,
        lastError: "Missed its scheduled slot: this post was due at 2026-09-10T09:00:00.000Z…",
      }),
      t,
      "#news",
    );
    expect(text).not.toContain("Missed its scheduled slot: this post was due");
  });

  /**
   * ONE POPULATION KEEPS THE OLD BEHAVIOUR: rows that failed before the column
   * existed. They have prose and nothing else, and printing it is still better
   * than printing nothing.
   */
  it("prints last_error for a row that failed before the column existed", () => {
    const { calls, t } = recorder();
    expect(
      failureSentence(row({ lastError: "Could not load credentials: nope" }), t, "#news"),
    ).toBe("Could not load credentials: nope");
    expect(calls).toEqual([]);
  });

  it("says nothing at all when there is neither a reason nor a sentence", () => {
    const { t } = recorder();
    expect(failureSentence(row(), t, "#news")).toBeNull();
  });
});
