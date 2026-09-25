import { PROMPT_ROLES } from "@pubrick/shared";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "./index.js";

describe("template decision attribution schema", () => {
  it("requires an organization and one closed role on each decision link", () => {
    const child = schema.promptDecisionTemplateRevisions;
    expect(child.orgId.notNull).toBe(true);
    expect(child.decisionId.notNull).toBe(true);
    expect(child.role.enumValues).toEqual(PROMPT_ROLES);
    expect(child.isDefault.notNull).toBe(true);
    expect(child.decidedAt.notNull).toBe(true);
    expect(child.revisionId.notNull).toBe(false);
    expect(child.version.notNull).toBe(false);
  });

  it("pins the owning decision and optional revision through organization and role", () => {
    const config = getTableConfig(schema.promptDecisionTemplateRevisions);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "prompt_decision_template_revisions_decision_role_idx",
        "prompt_decision_template_revisions_cohort_idx",
      ]),
    );
    const decision = config.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === "prompt_decision_template_revisions_decision_fk",
    );
    expect(decision?.reference().columns.map((column) => column.name)).toEqual([
      "org_id",
      "decision_id",
    ]);
    expect(decision?.reference().foreignColumns.map((column) => column.name)).toEqual([
      "org_id",
      "id",
    ]);
    const revision = config.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === "prompt_decision_template_revisions_revision_fk",
    );
    expect(revision?.reference().columns.map((column) => column.name)).toEqual([
      "org_id",
      "role",
      "revision_id",
    ]);
    expect(revision?.reference().foreignColumns.map((column) => column.name)).toEqual([
      "org_id",
      "role",
      "id",
    ]);
  });
});
