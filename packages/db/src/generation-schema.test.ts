import {
  ADAPTATION_STATUSES,
  AI_CALL_OUTCOMES,
  AI_COST_SOURCES,
  CONTENT_STATUSES,
  RUN_STATUSES,
  VERSION_SCOPES,
} from "@pubrick/shared";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "./index.js";

describe("generation schema", () => {
  it("declares every new table with org scoping", () => {
    for (const table of [
      schema.aiCredentials,
      schema.usageLedger,
      schema.pipelineRuns,
      schema.contentVersions,
    ]) {
      expect(table.orgId.notNull).toBe(true);
    }
  });

  it("gives content items and adaptations an origin", () => {
    expect(schema.contentItems.origin.notNull).toBe(true);
    expect(schema.adaptations.origin.notNull).toBe(true);
  });

  /**
   * The ratchet `enumCheck`'s docstring argues for: a status arrives with a
   * migration, or it does not arrive. The list itself lives in
   * `@pubrick/shared` now — this asserts the SET, from the package whose
   * migrations are the cost of changing it.
   */
  it("keeps run statuses free of a status nothing can reach", () => {
    // awaiting_review arrives with increment 2, when something transitions into it.
    expect(RUN_STATUSES).toEqual(["queued", "running", "succeeded", "failed", "cancelled"]);
    // And the column is bounded BY that list rather than merely alongside it.
    expect(schema.pipelineRuns.status.enumValues).toEqual(RUN_STATUSES);
  });

  /**
   * The two lists a refactor moved into `@pubrick/shared` and, in moving them,
   * stopped pinning here. `CONTENT_STATUSES` and `ADAPTATION_STATUSES` are as
   * load-bearing as `RUN_STATUSES` above — `PINNED_ITEM_MESSAGE` and
   * `PINNED_ADAPTATION_MESSAGE` in apps/api are `Record`s over them precisely so
   * a status added without a decision is a compile error — and nothing named
   * their actual members. Measured: dropping `publishing` from
   * `ADAPTATION_STATUSES`, or `failed` from `CONTENT_STATUSES`, survived every
   * test in both this package and `@pubrick/shared`.
   *
   * The STRUCTURAL half of "bounded BY that list rather than merely alongside
   * it" — that a column's own TypeScript enum still matches its CHECK — is
   * `schema-invariants.test.ts`'s job now: it derives the set of enum columns
   * AND the set of enum CHECKS from the schema itself, in both directions, so a
   * column added later is covered without a new `it` block here. What only a
   * literal can prove is that the SOURCE array still has the members product
   * vocabulary says it should — deriving that would just compare the array to
   * itself.
   */
  it("keeps content and adaptation statuses free of a status nothing can reach", () => {
    expect(CONTENT_STATUSES).toEqual(["draft", "approved", "rejected", "published", "failed"]);
    expect(schema.contentItems.status.enumValues).toEqual(CONTENT_STATUSES);

    expect(ADAPTATION_STATUSES).toEqual([
      "pending",
      "scheduled",
      "queued",
      "publishing",
      "published",
      "failed",
    ]);
    expect(schema.adaptations.status.enumValues).toEqual(ADAPTATION_STATUSES);
  });

  it("leaves cost nullable so an unpriced call cannot read as free", () => {
    expect(schema.usageLedger.costUsd.notNull).toBe(false);
    expect(AI_COST_SOURCES).toEqual(["provider_reported", "price_table", "unknown"]);
    expect(schema.usageLedger.costSource.enumValues).toEqual(AI_COST_SOURCES);
  });

  /**
   * The column that separates a call the provider refused from one it may have
   * generated, billed, and never delivered. Both write a zero-token row with no
   * cost; without this they are the same row, and both readers of the ledger
   * file such a row as free.
   */
  it("lets a ledger row say we do not know what became of the call", () => {
    expect(AI_CALL_OUTCOMES).toEqual(["completed", "refused", "unknown"]);
    // Bounded BY that list rather than merely alongside it — `text("outcome")`
    // with no enum stores whatever a caller sends, and a value outside the set
    // reads as `completed` to both readers: silently free.
    expect(schema.usageLedger.outcome.enumValues).toEqual(AI_CALL_OUTCOMES);
  });

  /**
   * NULLABLE, and it must stay that way for a reason that outlives the
   * migration: it is what every row written before the column carries, and
   * NULL is read as `completed` — the meaning those rows already had. A
   * `notNull` with a default of `unknown` would stamp "≥" on every existing
   * org's lifetime total; one of `completed` would be a claim nothing checked.
   */
  it("leaves the outcome nullable, because history cannot be re-derived", () => {
    expect(schema.usageLedger.outcome.notNull).toBe(false);
    expect(schema.usageLedger.outcome.default).toBeUndefined();
  });

  it("defaults existing rows to human origin", () => {
    expect(schema.contentItems.origin.default).toBe("human");
    expect(schema.adaptations.origin.default).toBe("human");
  });

  // `full` is the default because it is what every row written before fragments
  // existed already means: a whole body, restorable and listable as history.
  it("gives every existing version row the meaning it already had", () => {
    expect(VERSION_SCOPES).toEqual(["full", "fragment"]);
    expect(schema.contentVersions.scope.notNull).toBe(true);
    expect(schema.contentVersions.scope.default).toBe("full");
    // The column is bounded BY that list, not merely alongside it. Without
    // this, `text("scope")` with no enum — or one spelled out a second time and
    // left to drift — stores whatever a caller sends, and the badge's deletion
    // clause silently stops finding the level's `full` row.
    expect(schema.contentVersions.scope.enumValues).toEqual(VERSION_SCOPES);
  });

  // A refine call has no run, so `run_id` alone cannot answer what refining a
  // draft cost. Nullable because most rows are made inside a run and name none.
  it("lets a ledger row name the draft it was spent on", () => {
    expect(schema.usageLedger.contentItemId.notNull).toBe(false);
    expect(schema.usageLedger.adaptationId.notNull).toBe(false);
  });

  /**
   * The per-draft cost query "what did refining this draft cost" filters on
   * `content_item_id` and nothing else — `spend()` sums by `org_id` alone, so
   * the ledger's existing indexes cannot serve it. It is added while the
   * column's own migration lane is open, before the ledger is large enough for
   * the sequential scan to be noticed as a bug rather than a slow page.
   *
   * `adaptation_id` deliberately gets NO index. Every index is paid for on
   * INSERT, and the ledger's insert path is the hot one — one row per physical
   * model call, written in its own transaction before the step's checkpoint. A
   * btree also indexes NULLs, so an index on a column no writer sets is a
   * per-row cost bought for one entry: the all-NULL leaf. Whoever lets a refine
   * target an adaptation writes that column, and should add the index in the
   * same change — deleting the second assertion here, deliberately.
   */
  it("indexes the draft a ledger row names, and only that", () => {
    const indexes = getTableConfig(schema.usageLedger).indexes.map((i) => i.config.name);
    expect(indexes).toContain("usage_ledger_content_item_id_idx");
    expect(indexes).not.toContain("usage_ledger_adaptation_id_idx");
  });
});
