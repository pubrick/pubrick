import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithRequestAuthority } from "../request-authority";
import type { RunsRepository } from "../runs/runs.repository";
import type { ContentRepository } from "./content.repository";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("internal reuse source erasure", () => {
  let connection: ReturnType<typeof createDb>;
  let content: ContentRepository;
  let runs: RunsRepository;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "synthetic-reuse-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64");
    connection = createDb(url as string);
    const c = await import("./content.repository");
    const r = await import("../runs/runs.repository");
    content = new c.ContentRepository(
      ...(Array(8).fill(undefined) as ConstructorParameters<typeof c.ContentRepository>),
    );
    runs = new r.RunsRepository(
      undefined as unknown as ConstructorParameters<typeof r.RunsRepository>[0],
    );
  });
  afterAll(async () => {
    if (!connection) return;
    for (const id of orgIds)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, id));
    for (const id of userIds) await connection.db.delete(schema.user).where(eq(schema.user.id, id));
    await connection.pool.end();
    await (await import("../db")).pool.end();
  });
  async function fixture(status: "succeeded" | "queued" = "succeeded") {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Reuse erasure", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning();
    const [source] = await connection.db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId: brand.id,
        title: "Private source title",
        body: "Private saved source",
        status: "archived",
        archivedFromStatus: "draft",
        origin: "human",
      })
      .returning();
    const [output] = await connection.db
      .insert(schema.contentItems)
      .values({ orgId, brandId: brand.id, body: "Independent generated output", origin: "ai" })
      .returning();
    const [run] = await connection.db
      .insert(schema.pipelineRuns)
      .values({
        orgId,
        brandId: brand.id,
        status,
        contentItemId: output.id,
        input: {
          kind: "source",
          title: "Private source title",
          material: "Private saved source",
          text: "Frozen brief",
          sourceUrl: null,
          channelIds: [],
        },
        steps: { writer: { status: "succeeded", output: { material: "Private saved source" } } },
        guidanceSnapshot: {
          writer: { revisionId: randomUUID(), version: 1, text: "Private guidance" },
        },
        templateSnapshot: sql`'{"private":"Private template"}'::jsonb`,
        error: "provider private material",
        currentStep: "draft",
      })
      .returning();
    await connection.db.insert(schema.runSourceLineage).values({
      orgId,
      brandId: brand.id,
      derivedRunId: run.id,
      sourceContentId: source.id,
      sourceRevision: 2,
      sourceTitle: source.title,
      sourceDigest: "a".repeat(64),
      sourceOrigin: "human",
    });
    return { orgId, brand, source, output, run };
  }
  it("refuses deletion while a source reuse is queued without changing source or lineage", async () => {
    const f = await fixture("queued");
    await expect(content.delete(f.orgId, f.source.id)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "content_delete_reuse_active",
        runIds: [f.run.id],
      }),
    });
    const [source] = await connection.db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, f.source.id));
    expect(source.body).toBe("Private saved source");
    const [lineage] = await connection.db
      .select()
      .from(schema.runSourceLineage)
      .where(eq(schema.runSourceLineage.derivedRunId, f.run.id));
    expect(lineage.sourceRedactedAt).toBeNull();
  });
  it("erases all frozen terminal run inputs and source attribution while retaining independent output", async () => {
    const f = await fixture();
    const [retry] = await connection.db
      .insert(schema.pipelineRuns)
      .values({
        orgId: f.orgId,
        brandId: f.brand.id,
        status: "failed",
        input: f.run.input,
        steps: f.run.steps,
        error: "Private failed checkpoint",
      })
      .returning();
    await connection.db.insert(schema.runSourceLineage).values({
      orgId: f.orgId,
      brandId: f.brand.id,
      derivedRunId: retry.id,
      sourceContentId: f.source.id,
      sourceRevision: 2,
      sourceTitle: f.source.title,
      sourceDigest: "a".repeat(64),
      sourceOrigin: "human",
    });
    const [direct] = await connection.db
      .insert(schema.pipelineRuns)
      .values({
        orgId: f.orgId,
        brandId: f.brand.id,
        status: "succeeded",
        contentItemId: f.source.id,
        input: f.run.input,
        steps: f.run.steps,
      })
      .returning();
    const [usage] = await connection.db
      .insert(schema.usageLedger)
      .values({
        orgId: f.orgId,
        runId: f.run.id,
        step: "writer",
        provider: "google",
        modelId: "synthetic-model",
        costUsd: "0.010000",
        costSource: "provider_reported",
        status: "ok",
      })
      .returning();
    await content.delete(f.orgId, f.source.id);
    for (const id of [retry.id, direct.id]) {
      const [erased] = await connection.db
        .select()
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.id, id));
      expect(erased.input).toEqual({ kind: "redacted" });
      expect(erased.steps).toEqual({});
      expect(erased.error).toBeNull();
    }
    const [retainedUsage] = await connection.db
      .select()
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.id, usage.id));
    expect(retainedUsage).toEqual(usage);
    const [run] = await connection.db
      .select()
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, f.run.id));
    expect(run).toMatchObject({
      input: { kind: "redacted" },
      steps: {},
      error: null,
      currentStep: null,
      topicId: null,
      guidanceSnapshot: null,
      templateSnapshot: null,
      activeJobId: null,
      leaseExpiresAt: null,
      contentItemId: f.output.id,
    });
    expect(run.updatedAt).toEqual(f.run.updatedAt);
    const [lineage] = await connection.db
      .select()
      .from(schema.runSourceLineage)
      .where(eq(schema.runSourceLineage.derivedRunId, f.run.id));
    expect(lineage).toMatchObject({
      sourceContentId: f.source.id,
      sourceRevision: 2,
      sourceTitle: null,
      sourceDigest: null,
      sourceOrigin: null,
    });
    expect(lineage.sourceRedactedAt).toBeInstanceOf(Date);
    const detail = await content.get(f.orgId, f.output.id);
    expect(detail).toMatchObject({
      body: "Independent generated output",
      runInput: null,
      internalSource: { state: "redacted", sourceRevision: 2 },
    });
    await expect(
      connection.db.transaction((tx) => runs.prepareReuseRetryInTx(tx, f.orgId, f.run.id)),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "run_redacted" }) });
  });
  it("does not reveal frozen source material/title/checkpoints to actorless detail readers", async () => {
    const f = await fixture();
    const run = await runs.get(f.orgId, f.run.id);
    expect(run).toMatchObject({
      input: { kind: "redacted" },
      steps: {},
      internalSource: { state: "unavailable", sourceRevision: 2 },
    });
    expect(JSON.stringify(run)).not.toContain("Private saved source");
    const detail = await content.get(f.orgId, f.output.id);
    expect(detail.runInput).toBeNull();
    expect(detail.internalSource).toEqual({ state: "unavailable", sourceRevision: 2 });
    expect(detail.body).toBe("Independent generated output");
  });
  it("withholds source identity and frozen input from API-key authority", async () => {
    const f = await fixture();
    const detail = await runWithRequestAuthority(
      { kind: "api-key", orgId: f.orgId, keyId: randomUUID(), scope: "content:read" },
      () => runs.get(f.orgId, f.run.id),
    );
    expect(detail.internalSource).toEqual({ state: "unavailable", sourceRevision: 2 });
    expect(detail.input).toEqual({ kind: "redacted" });
    expect(detail.steps).toEqual({});
    expect(JSON.stringify(detail)).not.toContain(f.source.id);
    expect(JSON.stringify(detail)).not.toContain("Private source title");
  });
  it("refuses a foreign tenant lineage instead of silently erasing the source", async () => {
    const source = await fixture();
    const foreign = await fixture();
    const [run] = await connection.db
      .insert(schema.pipelineRuns)
      .values({
        orgId: foreign.orgId,
        brandId: foreign.brand.id,
        status: "succeeded",
        input: foreign.run.input,
      })
      .returning();
    await connection.db.insert(schema.runSourceLineage).values({
      orgId: foreign.orgId,
      brandId: foreign.brand.id,
      derivedRunId: run.id,
      sourceContentId: source.source.id,
      sourceRevision: 2,
      sourceDigest: "a".repeat(64),
      sourceOrigin: "human",
    });
    await expect(content.delete(source.orgId, source.source.id)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "content_delete_run_tenant_mismatch" }),
    });
    const [retained] = await connection.db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, source.source.id));
    expect(retained.body).toBe("Private saved source");
  });
  it("shows frozen attribution only to a current scoped member and removes it after membership revocation", async () => {
    const f = await fixture();
    const userId = randomUUID();
    userIds.push(userId);
    await connection.db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.test`, emailVerified: true });
    const memberId = randomUUID();
    await connection.db
      .insert(schema.member)
      .values({ id: memberId, organizationId: f.orgId, userId, role: "owner" });
    const actor = {
      kind: "session",
      orgId: f.orgId,
      sessionId: randomUUID(),
      userId,
      scope: { kind: "brand", source: "param" },
      capability: undefined,
      mutation: false,
      brandId: f.brand.id,
      resourceId: undefined,
    } as const;
    const available = await runWithRequestAuthority(actor, () => runs.get(f.orgId, f.run.id));
    expect(available.internalSource).toEqual({
      state: "available",
      sourceContentId: f.source.id,
      sourceRevision: 2,
      title: f.source.title,
      origin: "human",
    });
    await connection.db
      .delete(schema.member)
      .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, f.orgId)));
    const unavailable = await runWithRequestAuthority(actor, () => runs.get(f.orgId, f.run.id));
    expect(unavailable.internalSource).toEqual({ state: "unavailable", sourceRevision: 2 });
    expect(unavailable.input).toEqual({ kind: "redacted" });
  });
});
