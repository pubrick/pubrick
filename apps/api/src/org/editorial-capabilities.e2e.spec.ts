import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SourceExtractionService } from "../source-extraction/source-extraction.service";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("editorial capabilities over HTTP", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    vi.spyOn(app.get(SourceExtractionService), "extract").mockResolvedValue({
      title: "A source title",
      material: "A source reviewed by the author.",
      truncated: false,
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function person(name: string) {
    const agent = request.agent(app.getHttpServer());
    const signed = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${name}-${randomUUID()}@example.com`, password: "password1234", name })
      .expect(200);
    return { agent, userId: signed.body.user.id as string };
  }

  async function join(
    orgId: string,
    actor: Awaited<ReturnType<typeof person>>,
    role: "author" | "editor" | "member",
  ) {
    const memberId = randomUUID();
    await db.insert(schema.member).values({
      id: memberId,
      organizationId: orgId,
      userId: actor.userId,
      role,
    });
    await actor.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return memberId;
  }

  it("enforces granted-brand author/editor actions, default denials, and fresh role reads", async () => {
    const owner = await person("owner");
    const org = await owner.agent
      .post("/api/auth/organization/create")
      .send({ name: "Editorial", slug: `editorial-${randomUUID()}` })
      .expect(200);
    const orgId = org.body.id as string;
    await owner.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const grantedBrand = (
      await owner.agent.post("/api/brands").send({ name: "Granted" }).expect(201)
    ).body.id as string;
    const hiddenBrand = (await owner.agent.post("/api/brands").send({ name: "Hidden" }).expect(201))
      .body.id as string;
    const channelId = (
      await owner.agent
        .post("/api/channels")
        .send({ brandId: grantedBrand, platform: "vc_ru", name: "Manual" })
        .expect(201)
    ).body.id as string;
    const hiddenItem = (
      await db
        .insert(schema.contentItems)
        .values({ orgId, brandId: hiddenBrand, body: "Hidden draft" })
        .returning({ id: schema.contentItems.id })
    )[0]?.id;
    if (!hiddenItem) throw new Error("Hidden content fixture missing");

    const author = await person("author");
    const editor = await person("editor");
    const legacyMember = await person("member");
    const authorMemberId = await join(orgId, author, "author");
    const editorMemberId = await join(orgId, editor, "editor");
    const legacyMemberId = await join(orgId, legacyMember, "member");

    // The manager grant API accepts dedicated editorial roles as well as the
    // legacy member. No session restart is needed after a grant change.
    await owner.agent
      .put(`/api/brands/${grantedBrand}/access`)
      .send({ memberIds: [authorMemberId, editorMemberId, legacyMemberId] })
      .expect(200);
    await author.agent.get(`/api/brands/${grantedBrand}`).expect(200);
    await author.agent.get(`/api/brands/${hiddenBrand}`).expect(404);
    expect((await author.agent.get("/api/channels").expect(200)).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: channelId })]),
    );
    await author.agent.patch(`/api/content/${hiddenItem}`).send({ body: "No" }).expect(404);
    await author.agent.patch(`/api/brands/${hiddenBrand}`).send({ name: "No" }).expect(404);
    await author.agent
      .post("/api/content")
      .send({ brandId: hiddenBrand, body: "No", channelIds: [channelId] })
      .expect(404);

    const draft = await author.agent
      .post("/api/content")
      .send({ brandId: grantedBrand, body: "A human draft.", channelIds: [channelId] })
      .expect(201);
    const itemId = draft.body.id as string;
    const adaptationId = draft.body.adaptations[0].id as string;
    await author.agent
      .patch(`/api/content/${itemId}`)
      .send({ body: "Edited by author." })
      .expect(200);
    await author.agent
      .post("/api/topics")
      .send({ brandId: grantedBrand, title: "An idea" })
      .expect(201);
    await editor.agent
      .post("/api/topics")
      .send({ brandId: grantedBrand, title: "Editor's idea" })
      .expect(201);

    // URL preview is read-like but POST: editorial roles must supply a granted
    // brand, while existing owner/member callers may still send only {url}.
    await author.agent.post("/api/source-extraction").send({ url: "not-a-url" }).expect(400);
    await author.agent
      .post("/api/source-extraction")
      .send({ brandId: hiddenBrand, url: "not-a-url" })
      .expect(404);
    await author.agent
      .post("/api/source-extraction")
      .send({ brandId: grantedBrand, url: "not-a-url" })
      .expect(400);
    await legacyMember.agent.post("/api/source-extraction").send({ url: "not-a-url" }).expect(400);
    const sourceUrl = "https://example.com/article";
    const preview = await author.agent
      .post("/api/source-extraction")
      .send({ brandId: grantedBrand, url: sourceUrl })
      .expect(200);
    expect(preview.body.material).toBe("A source reviewed by the author.");
    const run = await author.agent
      .post("/api/runs")
      .send({
        brandId: grantedBrand,
        material: preview.body.material,
        sourceUrl,
        channelIds: [channelId],
      })
      .expect(201);
    expect(run.body.input.material).toBe(preview.body.material);
    expect(run.body.input.sourceUrl).toBe(sourceUrl);

    // A malformed body reaches validation only when the capability permits it.
    const badSchedule = { scheduledAt: "not-a-date" };
    await author.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(403);
    await editor.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(400);
    await author.agent
      .post(`/api/content/${itemId}/adaptations/${adaptationId}/reschedule`)
      .send({})
      .expect(403);
    await editor.agent
      .post(`/api/content/${itemId}/adaptations/${adaptationId}/reschedule`)
      .send({})
      .expect(400);
    await author.agent.post(`/api/content/${itemId}/reject`).expect(403);
    await author.agent.post(`/api/content/${itemId}/retract-approval`).expect(403);
    await author.agent.post(`/api/content/${itemId}/refine`).send({}).expect(400);
    await author.agent.post(`/api/content/${itemId}/claim-review`).send({}).expect(403);
    await editor.agent.post(`/api/content/${itemId}/claim-review`).send({}).expect(400);
    await author.agent
      .post(`/api/content/${itemId}/adaptations/${adaptationId}/manual-publication`)
      .send({})
      .expect(403);
    await author.agent.post("/api/calendar/slots").send({ brandId: grantedBrand }).expect(403);
    await editor.agent.post("/api/calendar/slots").send({ brandId: grantedBrand }).expect(400);

    for (const actor of [author, editor]) {
      await actor.agent.patch(`/api/brands/${grantedBrand}`).send({ name: "No" }).expect(403);
      await actor.agent
        .post("/api/channels")
        .send({ brandId: grantedBrand, platform: "vc_ru", name: "No" })
        .expect(403);
      await actor.agent
        .put(`/api/brands/${grantedBrand}/access`)
        .send({ memberIds: [] })
        .expect(403);
      await actor.agent.put(`/api/brands/${grantedBrand}/autopilot`).send({}).expect(403);
      await actor.agent.put("/api/ai-credentials").send({}).expect(403);
      await actor.agent.get("/api/ai-credentials").expect(403);
      await actor.agent.post("/api/api-keys").send({}).expect(403);
      await actor.agent.get("/api/api-keys").expect(403);
      await actor.agent.post("/api/webhooks").send({}).expect(403);
      await actor.agent.get("/api/webhooks").expect(403);
      await actor.agent.post(`/api/content/${itemId}/client-review-link`).send({}).expect(403);
    }

    const approved = await editor.agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    expect(approved.body.status).toBe("approved");
    const delivered = await editor.agent
      .post(`/api/content/${itemId}/adaptations/${adaptationId}/manual-publication`)
      .send({ url: "https://vc.ru/marketing/123-editorial" })
      .expect(200);
    expect(delivered.body.status).toBe("published");

    // The legacy member and managers retain their pre-existing rights. Each
    // request reads the current DB role; a stale cookie never retains editor.
    await legacyMember.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(400);
    await owner.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(400);
    await db
      .update(schema.member)
      .set({ role: "editor" })
      .where(eq(schema.member.id, authorMemberId));
    // The existing DB trigger revokes every brand grant when a role changes.
    // Role elevation cannot carry a stale grant into its new powers.
    await author.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(404);
    await owner.agent
      .put(`/api/brands/${grantedBrand}/access`)
      .send({ memberIds: [authorMemberId, editorMemberId, legacyMemberId] })
      .expect(200);
    await author.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(400);
    await db
      .update(schema.member)
      .set({ role: "author" })
      .where(eq(schema.member.id, authorMemberId));
    await author.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(404);
    await owner.agent
      .put(`/api/brands/${grantedBrand}/access`)
      .send({ memberIds: [authorMemberId, editorMemberId, legacyMemberId] })
      .expect(200);
    await author.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(403);
    await db
      .update(schema.member)
      .set({ role: "admin" })
      .where(eq(schema.member.id, authorMemberId));
    await author.agent.post(`/api/content/${itemId}/approve`).send(badSchedule).expect(400);
    await db
      .update(schema.member)
      .set({ role: "author" })
      .where(eq(schema.member.id, authorMemberId));
    await owner.agent
      .put(`/api/brands/${grantedBrand}/access`)
      .send({ memberIds: [editorMemberId, legacyMemberId] })
      .expect(200);
    await author.agent.get(`/api/content/${itemId}`).expect(404);
    await author.agent.patch(`/api/content/${itemId}`).send({ body: "No" }).expect(404);
  });
});
