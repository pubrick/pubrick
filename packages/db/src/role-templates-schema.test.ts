import { PROMPT_ROLES } from "@pubrick/shared";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "./index.js";

describe("role template persistence schema", () => {
  it("keeps revisions and heads organization scoped with closed roles", () => {
    for (const table of [schema.roleTemplateRevisions, schema.roleTemplateHeads]) {
      expect(table.orgId.notNull).toBe(true);
      expect(table.role.enumValues).toEqual(PROMPT_ROLES);
    }
    const revisions = getTableConfig(schema.roleTemplateRevisions);
    expect(revisions.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "role_template_revisions_org_role_version_idx",
        "role_template_revisions_org_role_id_idx",
      ]),
    );
  });

  it("pins an active revision through organization, role, and ID together", () => {
    const heads = getTableConfig(schema.roleTemplateHeads);
    const active = heads.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === "role_template_heads_active_revision_fk",
    );
    expect(active).toBeDefined();
    expect(active?.reference().columns.map((column) => column.name)).toEqual([
      "org_id",
      "role",
      "active_revision_id",
    ]);
    expect(active?.reference().foreignColumns.map((column) => column.name)).toEqual([
      "org_id",
      "role",
      "id",
    ]);
    expect(schema.roleTemplateHeads.activeRevisionId.notNull).toBe(false);
    expect(schema.roleTemplateHeads.generation.default).toBe(0);
  });

  it("starts activation off and leaves historical runs unpinned", () => {
    expect(schema.roleTemplateActivationGate.activationEnabled.default).toBe(false);
    expect(schema.roleTemplateActivationGate.releaseEpoch.default).toBe(0);
    expect(schema.pipelineRuns.templateSnapshot.notNull).toBe(false);
    expect(schema.pipelineRuns.templateSnapshot.default).toBeUndefined();
  });

  it("indexes only pinned runs for tenant and brand outcome cohorts", () => {
    const runs = getTableConfig(schema.pipelineRuns);
    const cohort = runs.indexes.find(
      (index) => index.config.name === "pipeline_runs_template_cohort_idx",
    );
    expect(cohort?.config.columns.map((column) => "name" in column && column.name)).toEqual([
      "org_id",
      "brand_id",
      "created_at",
      "id",
    ]);
    expect(cohort?.config.where).toBeDefined();
  });
});
