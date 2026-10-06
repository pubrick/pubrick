import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../channels/meta-runtime-config", () => ({
  metaRuntimeConfiguration: (provider: string, application: unknown) =>
    application
      ? {
          provider,
          application,
          redirectUri: `https://fixture.example.com/en/connections/meta/${provider}`,
        }
      : undefined,
}));
const url = process.env.TEST_DATABASE_URL;
const key = process.env.APP_ENCRYPTION_KEY ?? "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
describe.skipIf(!url)("native Meta approval admission (real HTTP and PostgreSQL)", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;
  let workerPool: ReturnType<typeof createDb>["pool"] | undefined;
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= key;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    for (const prefix of ["THREADS", "INSTAGRAM", "FACEBOOK"]) {
      vi.stubEnv(`${prefix}_CLIENT_ID`, "123456");
      vi.stubEnv(`${prefix}_CLIENT_SECRET`, "synthetic-app-secret");
    }
    const { AppModule } = await import("../app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    direct = createDb(url as string);
  });
  afterAll(async () => {
    await app?.close();
    await workerPool?.end();
    await direct?.pool.end();
    vi.unstubAllEnvs();
  });
  async function fixture(
    platform: "threads" | "instagram_native" | "facebook_page",
    text = "Reviewed by a person",
  ) {
    const agent = request.agent(app.getHttpServer());
    const uniq = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: `native-approval-${uniq}@example.com`,
        password: "password1234",
        name: "Writer",
      })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Native admission", slug: `native-approval-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Studio" }).expect(201);
    const channelId = randomUUID();
    const prefix =
      platform === "instagram_native"
        ? "instagram"
        : platform === "facebook_page"
          ? "facebook-page"
          : "threads";
    await direct.db.insert(schema.channels).values({
      id: channelId,
      orgId: org.body.id,
      brandId: brand.body.id,
      platform,
      name: "Native fixture",
      credentialsEncrypted: encryptJson(
        {
          accessToken: "synthetic-token",
          ...(platform === "facebook_page"
            ? { pageId: "654321", userAccessToken: "synthetic-user-token" }
            : { accountId: "654321" }),
          scopes:
            platform === "threads"
              ? "threads_basic threads_content_publish"
              : platform === "instagram_native"
                ? "instagram_business_basic instagram_business_content_publish"
                : "pages_show_list pages_read_engagement pages_manage_posts",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        key,
      ),
      connectionTarget: `${prefix}:654321`,
      connectionApplicationId: "123456",
      connectionGeneration: 1,
      connectionExpiresAt: new Date(Date.now() + 3600000),
    });
    const item = await agent
      .post("/api/content")
      .send({ brandId: brand.body.id, body: text, channelIds: [channelId] })
      .expect(201);
    return {
      agent,
      orgId: org.body.id as string,
      brandId: brand.body.id as string,
      channelId,
      itemId: item.body.id as string,
    };
  }
  async function approvedImage(
    f: Awaited<ReturnType<typeof fixture>>,
    patch: Partial<typeof schema.mediaAssets.$inferInsert> = {},
  ) {
    const mediaId = randomUUID();
    await direct.db.insert(schema.mediaAssets).values({
      id: mediaId,
      orgId: f.orgId,
      brandId: f.brandId,
      name: "Reviewed image",
      kind: "image",
      mimeType: "image/jpeg",
      width: 1080,
      height: 1080,
      byteSize: 12345,
      ...patch,
    });
    // A historical metadata fixture can bypass attachment admission; final approval must still refuse it.
    await direct.db
      .update(schema.contentItems)
      .set({ coverMediaId: mediaId })
      .where(and(eq(schema.contentItems.orgId, f.orgId), eq(schema.contentItems.id, f.itemId)));
    return mediaId;
  }
  async function assertNoJob(f: Awaited<ReturnType<typeof fixture>>) {
    const [adaptation] = await direct.db
      .select({ status: schema.adaptations.status, attempt: schema.adaptations.attemptCount })
      .from(schema.adaptations)
      .where(
        and(eq(schema.adaptations.orgId, f.orgId), eq(schema.adaptations.contentItemId, f.itemId)),
      );
    expect(adaptation).toEqual({ status: "pending", attempt: 0 });
    const jobs = await direct.pool.query(
      "select id from pgboss.job where name='publish' and data->>'orgId'=$1",
      [f.orgId],
    );
    expect(jobs.rows).toEqual([]);
  }
  it.each(["threads", "facebook_page"] as const)(
    "queues a reviewed supported %s post atomically",
    async (platform) => {
      const f = await fixture(platform);
      await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(200);
      const rows = await direct.pool.query(
        "select a.status,a.attempt_count,j.data from adaptations a join pgboss.job j on j.data->>'adaptationId'=a.id::text where a.org_id=$1 and a.content_item_id=$2",
        [f.orgId, f.itemId],
      );
      expect(rows.rows).toEqual([
        {
          status: "queued",
          attempt_count: 0,
          data: { orgId: f.orgId, adaptationId: expect.any(String) },
        },
      ]);
    },
  );
  it("queues native Instagram only with one supported reviewed JPEG", async () => {
    const f = await fixture("instagram_native");
    await approvedImage(f);
    await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(200);
    const rows = await direct.pool.query(
      "select status,attempt_count from adaptations where org_id=$1 and content_item_id=$2",
      [f.orgId, f.itemId],
    );
    expect(rows.rows).toEqual([{ status: "queued", attempt_count: 0 }]);
  });
  it("refuses a historical same-org cross-brand destination without changing the post", async () => {
    const f = await fixture("threads");
    const other = await f.agent.post("/api/brands").send({ name: "Other studio" }).expect(201);
    await direct.db
      .update(schema.channels)
      .set({ brandId: other.body.id })
      .where(and(eq(schema.channels.orgId, f.orgId), eq(schema.channels.id, f.channelId)));
    const before = await direct.pool.query(
      "select status,body,body_revision from content_items where org_id=$1 and id=$2",
      [f.orgId, f.itemId],
    );
    const response = await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(409);
    expect(response.body.code).toBe("content_meta_invalid");
    expect(
      (
        await direct.pool.query(
          "select status,body,body_revision from content_items where org_id=$1 and id=$2",
          [f.orgId, f.itemId],
        )
      ).rows,
    ).toEqual(before.rows);
    await assertNoJob(f);
  });
  it("refuses missing Instagram media before approval or enqueue", async () => {
    const f = await fixture("instagram_native");
    const response = await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(409);
    expect(response.body.code).toBe("content_meta_invalid");
    await assertNoJob(f);
  });
  it.each([{ width: 1441 }, { height: 1351 }, { byteSize: 8_000_001 }])(
    "refuses invalid historic Instagram image metadata %j",
    async (patch) => {
      const f = await fixture("instagram_native");
      await approvedImage(f, patch);
      await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(409);
      await assertNoJob(f);
    },
  );
  it("uses the exact channel override when checking text length", async () => {
    const f = await fixture("threads");
    await direct.db
      .update(schema.adaptations)
      .set({ body: "x".repeat(501) })
      .where(
        and(eq(schema.adaptations.orgId, f.orgId), eq(schema.adaptations.contentItemId, f.itemId)),
      );
    const response = await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(409);
    expect(response.body.code).toBe("content_meta_invalid");
    await assertNoJob(f);
  });
  it.each(["expired", "other_application", "disconnected"])(
    "requires current native credentials: %s",
    async (kind) => {
      const f = await fixture("threads");
      await direct.db
        .update(schema.channels)
        .set(
          kind === "expired"
            ? { connectionExpiresAt: sql`clock_timestamp() - interval '1 second'` }
            : kind === "disconnected"
              ? { credentialsEncrypted: null }
              : { connectionApplicationId: "999999" },
        )
        .where(and(eq(schema.channels.orgId, f.orgId), eq(schema.channels.id, f.channelId)));
      const response = await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(409);
      expect(response.body.code).toBe("meta_reconnect_required");
      await assertNoJob(f);
    },
  );
  it("admits a new physical Meta attempt only after the exact old final outcome is resolved through HTTP", async () => {
    const f = await fixture("threads");
    const { StagedPublicationRepository, metaPublicationInputHash } = await import(
      "../../../worker/src/publish/staged-publication.repository"
    );
    workerPool = (await import("../../../worker/src/db")).pool;
    const stages = new StagedPublicationRepository();
    const [adaptation] = await direct.db
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(
        and(eq(schema.adaptations.orgId, f.orgId), eq(schema.adaptations.contentItemId, f.itemId)),
      );
    if (!adaptation) throw new Error("Owned native adaptation is missing");
    const receiptId = randomUUID();
    const oldStageId = randomUUID();
    const frozen = {
      version: 1 as const,
      platform: "threads" as const,
      text: "Reviewed by a person",
    };
    await direct.db
      .update(schema.adaptations)
      .set({ status: "failed", attemptCount: 1, failureReason: "outcome_unknown" })
      .where(and(eq(schema.adaptations.orgId, f.orgId), eq(schema.adaptations.id, adaptation.id)));
    await direct.db
      .update(schema.contentItems)
      .set({ status: "failed" })
      .where(and(eq(schema.contentItems.orgId, f.orgId), eq(schema.contentItems.id, f.itemId)));
    await direct.db.insert(schema.publications).values({
      id: receiptId,
      orgId: f.orgId,
      adaptationId: adaptation.id,
      channelId: f.channelId,
      status: "unknown",
      attempt: 1,
    });
    await direct.db.insert(schema.metaPublicationStages).values({
      id: oldStageId,
      orgId: f.orgId,
      brandId: f.brandId,
      contentItemId: f.itemId,
      adaptationId: adaptation.id,
      channelId: f.channelId,
      platform: "threads",
      attempt: 1,
      inputHash: metaPublicationInputHash(frozen),
      frozenInput: frozen,
      target: "threads:654321",
      credentialGeneration: 1,
      phase: "final_unknown",
      containerId: "777",
      finalPublicationId: receiptId,
      failureReason: "final_outcome_unknown",
      preparationDeadline: new Date(Date.now() + 3_600_000),
    });
    const oldStage = (
      await direct.pool.query("select * from meta_publication_stages where org_id=$1 and id=$2", [
        f.orgId,
        oldStageId,
      ])
    ).rows[0];
    const oldReceipt = (
      await direct.pool.query("select * from publications where org_id=$1 and id=$2", [
        f.orgId,
        receiptId,
      ])
    ).rows[0];
    const view = await f.agent.get(`/api/content/${f.itemId}`).expect(200);
    expect(view.body.adaptations[0]).toMatchObject({
      deliveryOutcome: "unknown",
      deliveryReceipt: { id: receiptId, attempt: 1 },
    });
    await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(409);
    await f.agent
      .post(`/api/content/${f.itemId}/adaptations/${adaptation.id}/delivery`)
      .send({
        delivered: false,
        expectedReceipt: { id: receiptId, attempt: 1 },
      })
      .expect(200);
    const human = await direct.pool.query(
      "select id, status, attempt, asserted_at = created_at same_clock, created_at > (select created_at from publications where id=$3 and org_id=$1) later_than_unknown from publications where org_id=$1 and adaptation_id=$2 and asserted_at is not null",
      [f.orgId, adaptation.id, receiptId],
    );
    expect(human.rows).toEqual([
      {
        id: expect.any(String),
        status: "failed",
        attempt: 1,
        same_clock: true,
        later_than_unknown: true,
      },
    ]);
    await f.agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(200);

    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    const queue = `meta-http-retry-${randomUUID()}`;
    const ready = `${queue}-ready`;
    await boss.start();
    try {
      await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 600 });
      await boss.createQueue(ready, { retryLimit: 0, expireInSeconds: 600 });
      // Preserve the actual HTTP-enqueued job and payload, but fetch it in an
      // owned queue so this test never consumes another API fixture's delivery.
      const moved = await direct.pool.query(
        "update pgboss.job set name=$3 where name='publish' and data->>'orgId'=$1 and data->>'adaptationId'=$2 and state='created' returning id,data",
        [f.orgId, adaptation.id, queue],
      );
      expect(moved.rows).toHaveLength(1);
      const [job] = await boss.fetch<{ orgId: string; adaptationId: string }>(queue, {
        includeMetadata: true,
      });
      if (!job || job.id !== moved.rows[0]?.id)
        throw new Error("The HTTP-enqueued job was not fetched");
      const execution = {
        jobId: job.id,
        queue,
        startedOn: job.startedOn,
        retryCount: job.retryCount,
        readinessQueue: ready,
      };
      const expected = await stages.load(f.orgId, adaptation.id);
      if (!expected) throw new Error("The human-approved native delivery was not loaded");
      expect(expected).toMatchObject({ status: "queued", attemptCount: 1, itemStatus: "approved" });
      const policy = { delayMs: 30_000, maxPolls: 120, deadlineMs: 3_600_000 };
      const second = await stages.begin(f.orgId, expected, frozen, policy, execution);
      expect(second?.identity.attempt).toBe(2);
      if (!second)
        throw new Error("Retained human-resolved history blocked the new physical attempt");
      // The provider boundary is a synthetic preparation receipt; all job,
      // stage and final-claim transitions below are the production repository.
      expect(await stages.prepared(f.orgId, second, "888", policy, boss)).toBe(true);
      await boss.complete(queue, job.id);
      await direct.pool.query(
        "update meta_publication_stages set next_poll_at=clock_timestamp()-interval '1 second' where org_id=$1 and id=$2",
        [f.orgId, second.id],
      );
      await direct.pool.query(
        "update pgboss.job set start_after=clock_timestamp()-interval '1 second' where name=$1 and data->>'orgId'=$2",
        [ready, f.orgId],
      );
      const [readyJob] = await boss.fetch<{ orgId: string; adaptationId: string; stageId: string }>(
        ready,
        { includeMetadata: true },
      );
      if (!readyJob || readyJob.data.stageId !== second.id)
        throw new Error("The actual readiness incarnation was not fetched");
      const readyExecution = {
        jobId: readyJob.id,
        queue: ready,
        startedOn: readyJob.startedOn,
        retryCount: readyJob.retryCount,
        readinessQueue: ready,
      };
      const acquired = await stages.acquire(f.orgId, readyJob.data, policy, readyExecution);
      if (!acquired) throw new Error("The same second attempt could not resume readiness");
      const claim = await stages.finalIntent(f.orgId, acquired);
      expect(claim).toEqual({ id: expect.any(String), attempt: 2 });
      expect(
        (
          await direct.pool.query(
            "select phase,container_id,final_publication_id from meta_publication_stages where org_id=$1 and id=$2",
            [f.orgId, second.id],
          )
        ).rows,
      ).toEqual([{ phase: "final_intent", container_id: "888", final_publication_id: claim?.id }]);
      expect(
        (
          await direct.pool.query(
            "select * from meta_publication_stages where org_id=$1 and id=$2",
            [f.orgId, oldStageId],
          )
        ).rows[0],
      ).toEqual(oldStage);
      expect(
        (
          await direct.pool.query("select * from publications where org_id=$1 and id=$2", [
            f.orgId,
            receiptId,
          ])
        ).rows[0],
      ).toEqual(oldReceipt);
    } finally {
      await boss.stop({ graceful: false, timeout: 5000 });
      await direct.pool.query("delete from pgboss.job where name=any($1::text[])", [
        [queue, ready],
      ]);
    }
  });
});
