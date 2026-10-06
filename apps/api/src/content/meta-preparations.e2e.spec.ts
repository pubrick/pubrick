import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { metaPreparationsPageSchema } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "explicit nonpublic Meta preparation recovery (real HTTP and PostgreSQL)",
  () => {
    let app: INestApplication;
    let direct: ReturnType<typeof createDb>;
    beforeAll(async () => {
      process.env.DATABASE_URL = url as string;
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
      await direct?.pool.end();
    });

    async function person() {
      const agent = request.agent(app.getHttpServer());
      const result = await agent
        .post("/api/auth/sign-up/email")
        .send({
          email: `meta-preparation-${randomUUID()}@example.com`,
          password: "Preparation-test-123!",
          name: "Editor",
        })
        .expect(200);
      return { agent, userId: result.body.user.id as string };
    }
    async function fixture() {
      const owner = await person();
      const org = await owner.agent
        .post("/api/auth/organization/create")
        .send({ name: "Preparation recovery", slug: `preparation-${randomUUID()}` })
        .expect(200);
      const orgId = org.body.id as string;
      await owner.agent
        .post("/api/auth/organization/set-active")
        .send({ organizationId: orgId })
        .expect(200);
      const brand = await owner.agent.post("/api/brands").send({ name: "Studio" }).expect(201);
      const brandId = brand.body.id as string;
      const channelId = randomUUID();
      const itemId = randomUUID();
      const adaptationId = randomUUID();
      const stageId = randomUUID();
      const inputHash = "a".repeat(64);
      await direct.db.insert(schema.channels).values({
        id: channelId,
        orgId,
        brandId,
        platform: "threads",
        name: "Studio Threads",
        connectionTarget: "threads:123",
        connectionApplicationId: "123456",
        connectionGeneration: 1,
      });
      await direct.db.insert(schema.contentItems).values({
        id: itemId,
        orgId,
        brandId,
        title: "Reviewed post",
        body: "Human reviewed content",
        status: "failed",
      });
      await direct.db.insert(schema.adaptations).values({
        id: adaptationId,
        orgId,
        contentItemId: itemId,
        channelId,
        status: "failed",
        attemptCount: 1,
        lastError: "Preparation response was lost",
        failureReason: "platform_rejected",
      });
      await direct.db.insert(schema.metaPublicationStages).values({
        id: stageId,
        orgId,
        brandId,
        contentItemId: itemId,
        adaptationId,
        channelId,
        platform: "threads",
        attempt: 1,
        inputHash,
        frozenInput: { version: 1, platform: "threads", text: "Human reviewed content" },
        target: "threads:123",
        credentialGeneration: 1,
        phase: "preparation_unknown",
        containerId: "456",
        failureReason: "preparation_receipt_lost",
        preparationDeadline: new Date(Date.now() + 3_600_000),
      });
      return { ...owner, orgId, brandId, channelId, itemId, adaptationId, stageId, inputHash };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const endpoint = (f: Fixture, stageId = f.stageId) =>
      `/api/content/${f.itemId}/meta-preparations/${stageId}/discard`;
    const input = (f: Fixture) => ({
      expectedAttempt: 1,
      expectedInputHash: f.inputHash,
      acknowledgeNonpublicPreparation: true,
    });
    async function snapshot(f: Fixture) {
      const [stage] = await direct.db
        .select({
          phase: schema.metaPublicationStages.phase,
          containerId: schema.metaPublicationStages.containerId,
          inputHash: schema.metaPublicationStages.inputHash,
          frozenInput: schema.metaPublicationStages.frozenInput,
          finalPublicationId: schema.metaPublicationStages.finalPublicationId,
          reason: schema.metaPublicationStages.failureReason,
          updatedAt: schema.metaPublicationStages.updatedAt,
        })
        .from(schema.metaPublicationStages)
        .where(eq(schema.metaPublicationStages.id, f.stageId));
      const [adaptation] = await direct.db
        .select({
          status: schema.adaptations.status,
          attemptCount: schema.adaptations.attemptCount,
          body: schema.adaptations.body,
          lastError: schema.adaptations.lastError,
          updatedAt: schema.adaptations.updatedAt,
        })
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, f.adaptationId));
      const [item] = await direct.db
        .select({
          status: schema.contentItems.status,
          body: schema.contentItems.body,
          updatedAt: schema.contentItems.updatedAt,
        })
        .from(schema.contentItems)
        .where(eq(schema.contentItems.id, f.itemId));
      const jobs = await direct.pool.query(
        "select id, state, data from pgboss.job where data->>'orgId' = $1 and data->>'adaptationId' = $2 order by id",
        [f.orgId, f.adaptationId],
      );
      const receipts = await direct.db
        .select({
          id: schema.publications.id,
          status: schema.publications.status,
          externalId: schema.publications.externalId,
        })
        .from(schema.publications)
        .where(
          and(
            eq(schema.publications.orgId, f.orgId),
            eq(schema.publications.adaptationId, f.adaptationId),
          ),
        );
      const decisions = await direct.db
        .select({ id: schema.promptDecisions.id })
        .from(schema.promptDecisions)
        .where(
          and(
            eq(schema.promptDecisions.orgId, f.orgId),
            eq(schema.promptDecisions.contentItemId, f.itemId),
          ),
        );
      return { stage, adaptation, item, jobs: jobs.rows, receipts, decisions };
    }
    async function refused(f: Fixture, status = 409, patch: Record<string, unknown> = {}) {
      const before = await snapshot(f);
      const result = await f.agent
        .post(endpoint(f))
        .send({ ...input(f), ...patch })
        .expect(status);
      expect(await snapshot(f)).toEqual(before);
      return result;
    }

    it("lists actual preparation evidence with a closed public projection and no final-post claims", async () => {
      const f = await fixture();
      const response = await f.agent.get(`/api/content/${f.itemId}/meta-preparations`).expect(200);
      const page = metaPreparationsPageSchema.parse(response.body);
      expect(page.stages).toEqual([
        {
          stageId: f.stageId,
          adaptationId: f.adaptationId,
          platform: "threads",
          phase: "preparation_unknown",
          attempt: 1,
          inputHash: f.inputHash,
          containerId: "456",
          channelName: "Studio Threads",
          reason: "preparation_receipt_lost",
          recoverable: true,
          createdAt: expect.any(String),
        },
      ]);
      expect(page.nextCursor).toBeNull();
      expect(JSON.stringify(response.body)).not.toMatch(
        /accessToken|frozenInput|finalPublicationId|externalUrl|credentials|https:/,
      );
    });
    it("cancels only the acknowledged preparation while preserving body, failed attempt, receipts and queue", async () => {
      const f = await fixture();
      const before = await snapshot(f);
      const result = await f.agent.post(endpoint(f)).send(input(f)).expect(200);
      expect(result.body).toEqual({ stageId: f.stageId, phase: "cancelled" });
      const after = await snapshot(f);
      expect(after).toMatchObject({
        adaptation: before.adaptation,
        item: before.item,
        jobs: before.jobs,
        receipts: before.receipts,
        decisions: before.decisions,
      });
      expect(after.stage).toMatchObject({
        ...before.stage,
        phase: "cancelled",
        updatedAt: expect.any(Date),
      });
      const page = metaPreparationsPageSchema.parse(
        (await f.agent.get(`/api/content/${f.itemId}/meta-preparations`).expect(200)).body,
      );
      expect(page.stages[0]?.recoverable).toBe(false);
    });
    it("allows a later preparation discard after actual human removal of a prior accepted final record", async () => {
      const f = await fixture();
      const [uncertain] = await direct.db
        .insert(schema.publications)
        .values({
          orgId: f.orgId,
          adaptationId: f.adaptationId,
          channelId: f.channelId,
          attempt: 1,
          status: "unknown",
          externalId: "789",
        })
        .returning({ id: schema.publications.id, attempt: schema.publications.attempt });
      if (!uncertain) throw new Error("The final receipt fixture is missing");
      await direct.db
        .update(schema.metaPublicationStages)
        .set({
          phase: "final_unknown",
          finalPublicationId: uncertain.id,
          externalId: "789",
          failureReason: "final_outcome_unknown",
        })
        .where(eq(schema.metaPublicationStages.id, f.stageId));
      await f.agent
        .post(`/api/content/${f.itemId}/adaptations/${f.adaptationId}/delivery`)
        .send({ delivered: false, expectedReceipt: uncertain, acceptedResolution: "removed" })
        .expect(200);
      const old = await direct.pool.query(
        "select id,phase,container_id,final_publication_id,external_id,frozen_input,created_at,updated_at from meta_publication_stages where org_id=$1 and id=$2",
        [f.orgId, f.stageId],
      );
      const next = { ...f, stageId: randomUUID(), inputHash: "b".repeat(64) };
      // The next worker attempt lost only its nonpublic preparation response.
      await direct.db.insert(schema.metaPublicationStages).values({
        id: next.stageId,
        orgId: f.orgId,
        brandId: f.brandId,
        contentItemId: f.itemId,
        adaptationId: f.adaptationId,
        channelId: f.channelId,
        platform: "threads",
        attempt: 2,
        inputHash: next.inputHash,
        frozenInput: { version: 1, platform: "threads", text: "Human reviewed content" },
        target: "threads:123",
        credentialGeneration: 1,
        phase: "preparation_unknown",
        containerId: "790",
        failureReason: "preparation_receipt_lost",
        preparationDeadline: new Date(Date.now() + 3_600_000),
      });
      await direct.db
        .update(schema.adaptations)
        .set({ attemptCount: 2 })
        .where(eq(schema.adaptations.id, f.adaptationId));
      await direct.db.insert(schema.publications).values({
        orgId: f.orgId,
        adaptationId: f.adaptationId,
        channelId: f.channelId,
        attempt: 2,
        status: "failed",
      });
      const page = metaPreparationsPageSchema.parse(
        (await f.agent.get(`/api/content/${f.itemId}/meta-preparations`).expect(200)).body,
      );
      expect(page.stages.find((stage) => stage.stageId === next.stageId)?.recoverable).toBe(true);
      const before = await snapshot(next);
      await next.agent
        .post(endpoint(next))
        .send({ ...input(next), expectedAttempt: 2 })
        .expect(200);
      const after = await snapshot(next);
      expect(after.stage?.phase).toBe("cancelled");
      expect(after.adaptation).toEqual(before.adaptation);
      expect(after.receipts).toEqual(before.receipts);
      expect(after.jobs).toEqual([]);
      const retained = await direct.pool.query(
        "select id,phase,container_id,final_publication_id,external_id,frozen_input,created_at,updated_at from meta_publication_stages where org_id=$1 and id=$2",
        [f.orgId, f.stageId],
      );
      expect(retained.rows).toEqual(old.rows);
    });
    it("requires explicit acknowledgment and makes an acknowledged confirmation single-use", async () => {
      const f = await fixture();
      await refused(f, 400, { acknowledgeNonpublicPreparation: false });
      await f.agent.post(endpoint(f)).send(input(f)).expect(200);
      expect((await refused(f)).body.code).toBe("meta_preparation_changed");
    });
    it.each([{ expectedAttempt: 2 }, { expectedInputHash: "b".repeat(64) }])(
      "refuses one changed displayed fingerprint field: %j",
      async (patch) => {
        const f = await fixture();
        expect((await refused(f, 409, patch)).body.code).toBe("meta_preparation_changed");
      },
    );
    it("refuses a later failed adaptation attempt even while the old stage still looks uncertain", async () => {
      const f = await fixture();
      await direct.db
        .update(schema.adaptations)
        .set({ attemptCount: 2 })
        .where(eq(schema.adaptations.id, f.adaptationId));
      await refused(f);
    });
    it("refuses a newly queued adaptation decision even before its job or final claim exists", async () => {
      const f = await fixture();
      await direct.db
        .update(schema.adaptations)
        .set({ status: "queued" })
        .where(eq(schema.adaptations.id, f.adaptationId));
      await refused(f);
    });
    it("refuses an active worker lease before any public claim exists", async () => {
      const f = await fixture();
      await direct.db
        .update(schema.metaPublicationStages)
        .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) })
        .where(eq(schema.metaPublicationStages.id, f.stageId));
      await refused(f);
    });
    it("refuses an unfinished job even when the adaptation and preparation look failed", async () => {
      const f = await fixture();
      await direct.pool.query(
        "insert into pgboss.job(id,name,data,state) values($1,'publish',$2::jsonb,'active')",
        [randomUUID(), JSON.stringify({ orgId: f.orgId, adaptationId: f.adaptationId })],
      );
      await refused(f);
    });
    it.each(["unknown", "in_flight", "published"] as const)(
      "does not abandon preparation when a %s final receipt exists",
      async (status) => {
        const f = await fixture();
        await direct.db.insert(schema.publications).values({
          orgId: f.orgId,
          adaptationId: f.adaptationId,
          channelId: f.channelId,
          status,
          attempt: 1,
        });
        await refused(f);
      },
    );
    it.each(["final_unknown", "published_without_receipt"] as const)(
      "never treats %s as nonpublic preparation recovery",
      async (phase) => {
        const f = await fixture();
        await direct.db
          .update(schema.metaPublicationStages)
          .set({ phase, finalPublicationId: randomUUID() })
          .where(eq(schema.metaPublicationStages.id, f.stageId));
        await refused(f);
      },
    );
    it.each([
      { finalPublicationId: "9d9684be-7a08-4d66-9797-ae352e645c8e" },
      { externalId: "987" },
    ])(
      "refuses final evidence even if a retained phase still says preparation_unknown: %j",
      async (patch) => {
        const f = await fixture();
        await direct.db
          .update(schema.metaPublicationStages)
          .set(patch)
          .where(eq(schema.metaPublicationStages.id, f.stageId));
        await refused(f);
      },
    );
    it("keeps audit history visible after a channel is removed but never offers orphan recovery", async () => {
      const f = await fixture();
      await direct.db.delete(schema.channels).where(eq(schema.channels.id, f.channelId));
      const page = metaPreparationsPageSchema.parse(
        (await f.agent.get(`/api/content/${f.itemId}/meta-preparations`).expect(200)).body,
      );
      expect(page.stages[0]).toMatchObject({
        stageId: f.stageId,
        containerId: "456",
        channelName: null,
        recoverable: false,
      });
      await refused(f);
    });
    it("refuses an unrelated current final claim even if the selected old preparation has no receipt", async () => {
      const f = await fixture();
      await direct.db.insert(schema.metaPublicationStages).values({
        orgId: f.orgId,
        brandId: f.brandId,
        contentItemId: f.itemId,
        adaptationId: f.adaptationId,
        channelId: f.channelId,
        platform: "threads",
        attempt: 2,
        inputHash: "b".repeat(64),
        frozenInput: { version: 1, platform: "threads", text: "Later prepared content" },
        target: "threads:123",
        credentialGeneration: 1,
        phase: "final_unknown",
        containerId: "789",
        finalPublicationId: randomUUID(),
        preparationDeadline: new Date(Date.now() + 60_000),
      });
      await refused(f);
    });
    it("keeps a preparation-only action inside the current tenant and content resource", async () => {
      const f = await fixture();
      const other = await fixture();
      const before = await snapshot(f);
      await other.agent.get(`/api/content/${f.itemId}/meta-preparations`).expect(404);
      await other.agent.post(endpoint(f)).send(input(f)).expect(404);
      await f.agent.post(endpoint(f, other.stageId)).send(input(f)).expect(404);
      expect(await snapshot(f)).toEqual(before);
    });
    it("lets a granted editor recover but refuses an equally granted author", async () => {
      const f = await fixture();
      const editor = await person();
      const author = await person();
      const editorMember = randomUUID();
      const authorMember = randomUUID();
      await direct.db.insert(schema.member).values([
        { id: editorMember, organizationId: f.orgId, userId: editor.userId, role: "editor" },
        { id: authorMember, organizationId: f.orgId, userId: author.userId, role: "author" },
      ]);
      await f.agent
        .put(`/api/brands/${f.brandId}/access`)
        .send({ memberIds: [editorMember, authorMember] })
        .expect(200);
      for (const actor of [editor, author])
        await actor.agent
          .post("/api/auth/organization/set-active")
          .send({ organizationId: f.orgId })
          .expect(200);
      await author.agent.get(`/api/content/${f.itemId}/meta-preparations`).expect(200);
      const before = await snapshot(f);
      await author.agent.post(endpoint(f)).send(input(f)).expect(403);
      expect(await snapshot(f)).toEqual(before);
      await editor.agent.post(endpoint(f)).send(input(f)).expect(200);
    });
    it("rechecks a naturally expired admitted session after waiting for the preparation lock", async () => {
      const f = await fixture();
      const lock = await direct.pool.connect();
      await lock.query("begin");
      await lock.query("select id from meta_publication_stages where id = $1 for update", [
        f.stageId,
      ]);
      const before = await snapshot(f);
      const expiry = new Date(Date.now() + 1200);
      await direct.db
        .update(schema.session)
        .set({ expiresAt: expiry })
        .where(eq(schema.session.userId, f.userId));
      const pending = f.agent
        .post(endpoint(f))
        .send(input(f))
        .then((result) => result);
      try {
        await expect
          .poll(
            async () => {
              const result = await direct.pool.query(
                "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%meta_publication_stages%' and query like '%for update%' and pid <> pg_backend_pid()",
              );
              return Number(result.rows[0]?.n);
            },
            { timeout: 1100, interval: 20 },
          )
          .toBeGreaterThan(0);
        await direct.pool.query(
          "select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))) + 0.05)",
          [expiry],
        );
        await lock.query("commit");
        const result = await pending;
        expect(result.status).toBe(403);
        expect(result.body.code).toBe("meta_preparation_authority_changed");
        expect(await snapshot(f)).toEqual(before);
      } finally {
        await lock.query("rollback");
        lock.release();
        await pending;
      }
    });
    it("pages retained history honestly and rejects a cursor from another post", async () => {
      const f = await fixture();
      for (let attempt = 2; attempt <= 22; attempt++)
        await direct.db.insert(schema.metaPublicationStages).values({
          orgId: f.orgId,
          brandId: f.brandId,
          contentItemId: f.itemId,
          adaptationId: f.adaptationId,
          channelId: f.channelId,
          platform: "threads",
          attempt,
          inputHash: "b".repeat(64),
          frozenInput: { version: 1, platform: "threads", text: "Retained preparation" },
          target: "threads:123",
          credentialGeneration: 1,
          phase: "cancelled",
          preparationDeadline: new Date(Date.now() + 60_000),
        });
      // The entire history has one JavaScript millisecond but distinct PostgreSQL
      // microseconds. Equal actual instants also require the UUID tiebreak.
      await direct.pool.query(
        "with watermark as materialized (select date_trunc('milliseconds', clock_timestamp()) base) update meta_publication_stages set created_at = watermark.base + (floor((attempt-1)::numeric/2) * interval '1 microsecond'), preparation_deadline = watermark.base + interval '1 hour' from watermark where org_id = $1 and content_item_id = $2",
        [f.orgId, f.itemId],
      );
      const first = metaPreparationsPageSchema.parse(
        (await f.agent.get(`/api/content/${f.itemId}/meta-preparations`).expect(200)).body,
      );
      expect(first.stages).toHaveLength(20);
      expect(first.nextCursor).not.toBeNull();
      const second = metaPreparationsPageSchema.parse(
        (
          await f.agent
            .get(`/api/content/${f.itemId}/meta-preparations?cursor=${first.nextCursor}`)
            .expect(200)
        ).body,
      );
      expect(second.stages).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.stages, ...second.stages].map((stage) => stage.stageId)).size).toBe(
        22,
      );
      expect(
        new Set([...first.stages, ...second.stages].map((stage) => stage.createdAt)).size,
      ).toBe(1);
      const other = await fixture();
      await f.agent
        .get(`/api/content/${f.itemId}/meta-preparations?cursor=${other.stageId}`)
        .expect(404);
    });
  },
);
