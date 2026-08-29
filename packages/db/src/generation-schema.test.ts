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
});
