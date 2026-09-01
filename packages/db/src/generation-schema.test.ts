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

  it("keeps run statuses free of a status nothing can reach", () => {
    // awaiting_review arrives with increment 2, when something transitions into it.
    expect(schema.RUN_STATUSES).toEqual(["queued", "running", "succeeded", "failed", "cancelled"]);
  });

  it("leaves cost nullable so an unpriced call cannot read as free", () => {
    expect(schema.usageLedger.costUsd.notNull).toBe(false);
    expect(schema.COST_SOURCES).toEqual(["provider_reported", "price_table", "unknown"]);
  });

  it("defaults existing rows to human origin", () => {
    expect(schema.contentItems.origin.default).toBe("human");
    expect(schema.adaptations.origin.default).toBe("human");
  });

  // `full` is the default because it is what every row written before fragments
  // existed already means: a whole body, restorable and listable as history.
  it("gives every existing version row the meaning it already had", () => {
    expect(schema.VERSION_SCOPES).toEqual(["full", "fragment"]);
    expect(schema.contentVersions.scope.notNull).toBe(true);
    expect(schema.contentVersions.scope.default).toBe("full");
    // The column is bounded BY that list, not merely alongside it. Without
    // this, `text("scope")` with no enum — or one spelled out a second time and
    // left to drift — stores whatever a caller sends, and the badge's deletion
    // clause silently stops finding the level's `full` row.
    expect(schema.contentVersions.scope.enumValues).toEqual(schema.VERSION_SCOPES);
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
