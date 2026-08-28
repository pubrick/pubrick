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
});
