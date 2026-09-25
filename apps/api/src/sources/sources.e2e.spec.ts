import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { encryptJson, privateTelegramSourceCreateSchema } from "@pubrick/shared";
import { resolveJoinedPrivateChannel } from "@pubrick/telegram";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pubrick/telegram", () => ({ resolveJoinedPrivateChannel: vi.fn() }));

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("watched sources e2e", () => {
  let app: INestApplication;

  beforeEach(() => {
    vi.mocked(resolveJoinedPrivateChannel).mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "test-hash";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  function mockCountTokens() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const endpoint = String(input);
      if (!endpoint.endsWith(":countTokens"))
        throw new Error(`Unexpected external request: ${endpoint}`);
      expect(init?.method).toBe("POST");
      expect(
        JSON.parse(String(init?.body)).generateContentRequest.generationConfig.maxOutputTokens,
      ).toBe(1024);
      return new Response(JSON.stringify({ totalTokens: 200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  async function orgAgent(): Promise<{ agent: request.Agent; orgId: string }> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `rss${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `rss-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id };
  }

  it("keeps automatic collection off by default and scopes opt-in to an authorized brand", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Collection" }).expect(201);
    const route = `/api/sources/comment-collection?brandId=${brand.body.id}`;
    expect((await agent.get(route).expect(200)).body).toEqual({ enabled: false, updatedAt: null });
    await agent.put(route).send({ enabled: true, unexpected: true }).expect(400);
    expect((await agent.put(route).send({ enabled: true }).expect(200)).body.enabled).toBe(true);
    const db = (await import("../db")).db;
    const [first] = await db
      .select({ revision: schema.newsCommentCollectionConfigs.revision })
      .from(schema.newsCommentCollectionConfigs)
      .where(eq(schema.newsCommentCollectionConfigs.brandId, brand.body.id));
    expect(first?.revision).toBe(1);
    const scannedAt = new Date("2026-09-25T01:00:00.000Z");
    await db
      .update(schema.newsCommentCollectionConfigs)
      .set({ lastScannedAt: scannedAt })
      .where(eq(schema.newsCommentCollectionConfigs.brandId, brand.body.id));
    await agent.put(route).send({ enabled: false }).expect(200);
    await agent.put(route).send({ enabled: true }).expect(200);
    const [last] = await db
      .select({
        revision: schema.newsCommentCollectionConfigs.revision,
        lastScannedAt: schema.newsCommentCollectionConfigs.lastScannedAt,
      })
      .from(schema.newsCommentCollectionConfigs)
      .where(eq(schema.newsCommentCollectionConfigs.brandId, brand.body.id));
    expect(last?.revision).toBe(3);
    expect(last?.lastScannedAt).toEqual(scannedAt);
    const other = await orgAgent();
    await other.agent.get(route).expect(404);
    await other.agent.put(route).send({ enabled: true }).expect(404);
    const unconfigured = await agent
      .post("/api/brands")
      .send({ name: "Another collection" })
      .expect(201);
    await expect(
      db
        .insert(schema.newsCommentCollectionConfigs)
        .values({ orgId: other.orgId, brandId: unconfigured.body.id, enabled: true }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    const [membership] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.organizationId, orgId));
    if (!membership) throw new Error("member fixture");
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.organizationId, orgId));
    await agent.get(route).expect(404);
    await db
      .insert(schema.brandAccess)
      .values({ orgId, brandId: brand.body.id, memberId: membership.id });
    expect((await agent.get(route).expect(200)).body.enabled).toBe(true);
    expect((await agent.put(route).send({ enabled: false }).expect(200)).body.enabled).toBe(false);
  });

  it("adds only joined private broadcasts, rate limits atomically, and returns no invite or peer", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Private news" }).expect(201);
    const invite = "https://t.me/+SecretInvite123";
    const body = { brandId: brand.body.id, name: "Joined channel", invite };
    expect(privateTelegramSourceCreateSchema.parse(body)).toEqual(body);
    const route = "/api/sources/telegram-private";
    const key = process.env.APP_ENCRYPTION_KEY as string;
    await agent.post(route).send(body).expect(409); // no connected account
    expect(resolveJoinedPrivateChannel).not.toHaveBeenCalled();
    await (await import("../db")).db.insert(schema.telegramSourceAccounts).values({
      orgId,
      sessionEncrypted: encryptJson({ session: "joined-session" }, key),
    });
    vi.mocked(resolveJoinedPrivateChannel).mockResolvedValue({
      peer: { channelId: 987654321, accessHash: "123456789" },
      title: "A broadcast",
    });
    const [first, second] = await Promise.all([
      agent.post(route).send(body),
      agent.post(route).send(body),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(resolveJoinedPrivateChannel).toHaveBeenCalledTimes(1);
    const created = first.status === 201 ? first : second;
    expect(created.body).toMatchObject({
      kind: "telegram_private",
      url: "https://t.me/c/987654321",
    });
    expect(JSON.stringify(created.body)).not.toContain(invite);
    expect(JSON.stringify(created.body)).not.toContain("123456789");
    const other = first.status === 409 ? first : second;
    expect(other.body.code).toBe("private_source_cooldown");
    expect(JSON.stringify(other.body)).not.toContain(invite);
    const [stored] = await (await import("../db")).db
      .select({ privatePeerEncrypted: schema.newsSources.privatePeerEncrypted })
      .from(schema.newsSources)
      .where(
        and(eq(schema.newsSources.orgId, orgId), eq(schema.newsSources.brandId, brand.body.id)),
      );
    expect(stored?.privatePeerEncrypted).not.toContain("123456789");
  });

  it("refuses members and never calls Telegram with invalid invites", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Guard" }).expect(201);
    const db = (await import("../db")).db;
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.organizationId, orgId));
    const body = {
      brandId: brand.body.id,
      name: "Secret",
      invite: "https://t.me/+SecretInvite123",
    };
    const refused = await agent.post("/api/sources/telegram-private").send(body).expect(403);
    expect(refused.body.code).toBe("private_source_owner_required");
    expect(JSON.stringify(refused.body)).not.toContain(body.invite);
    expect(resolveJoinedPrivateChannel).not.toHaveBeenCalled();
  });

  it("never reflects an invite or provider error in an access refusal", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Refusal" }).expect(201);
    const db = (await import("../db")).db;
    await db.insert(schema.telegramSourceAccounts).values({
      orgId,
      sessionEncrypted: encryptJson(
        { session: "joined-session" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    const route = "/api/sources/telegram-private";
    await agent
      .post(route)
      .send({ brandId: brand.body.id, name: "Bad", invite: "https://evil.example/invite" })
      .expect(400);
    expect(resolveJoinedPrivateChannel).not.toHaveBeenCalled();
    const invite = "https://t.me/+SensitiveInvite567";
    vi.mocked(resolveJoinedPrivateChannel).mockRejectedValueOnce(
      new Error(`provider echoed ${invite}`),
    );
    const refused = await agent
      .post(route)
      .send({ brandId: brand.body.id, name: "Denied", invite })
      .expect(409);
    expect(refused.body.code).toBe("private_source_access_denied");
    expect(JSON.stringify(refused.body)).not.toContain(invite);
    expect(JSON.stringify(refused.body)).not.toContain("provider echoed");
  });

  it("drops a resolved peer when the organization session is replaced mid-check", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Race" }).expect(201);
    const db = (await import("../db")).db;
    const key = process.env.APP_ENCRYPTION_KEY as string;
    await db.insert(schema.telegramSourceAccounts).values({
      orgId,
      sessionEncrypted: encryptJson({ session: "old-session" }, key),
    });
    let release:
      | ((value: { peer: { channelId: number; accessHash: string }; title: string }) => void)
      | undefined;
    vi.mocked(resolveJoinedPrivateChannel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = agent.post("/api/sources/telegram-private").send({
      brandId: brand.body.id,
      name: "Race channel",
      invite: "https://t.me/+RaceInvite123",
    });
    const response = pending.then((result) => result);
    await vi.waitFor(() => expect(release).toBeDefined());
    await db
      .update(schema.telegramSourceAccounts)
      .set({ sessionEncrypted: encryptJson({ session: "new-session" }, key) })
      .where(eq(schema.telegramSourceAccounts.orgId, orgId));
    release?.({ peer: { channelId: 1234567, accessHash: "98765" }, title: "Old account channel" });
    const refused = await response;
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("private_source_session_changed");
    const rows = await db
      .select({ id: schema.newsSources.id })
      .from(schema.newsSources)
      .where(eq(schema.newsSources.orgId, orgId));
    expect(rows).toEqual([]);
  });

  it("drops a resolved peer when the actor loses admin access mid-check", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Role race" }).expect(201);
    const db = (await import("../db")).db;
    await db.insert(schema.telegramSourceAccounts).values({
      orgId,
      sessionEncrypted: encryptJson(
        { session: "joined-session" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    let release:
      | ((value: { peer: { channelId: number; accessHash: string }; title: string }) => void)
      | undefined;
    vi.mocked(resolveJoinedPrivateChannel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = agent
      .post("/api/sources/telegram-private")
      .send({
        brandId: brand.body.id,
        name: "Role race channel",
        invite: "https://t.me/+RoleRaceInvite123",
      })
      .then((result) => result);
    await vi.waitFor(() => expect(release).toBeDefined());
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.organizationId, orgId));
    release?.({
      peer: { channelId: 4321876, accessHash: "2222" },
      title: "Former account channel",
    });
    const refused = await pending;
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("private_source_owner_required");
    const rows = await db
      .select({ id: schema.newsSources.id })
      .from(schema.newsSources)
      .where(eq(schema.newsSources.orgId, orgId));
    expect(rows).toEqual([]);
  });

  it("scopes feed CRUD and news reads by both organization and brand", async () => {
    const { agent: owner, orgId: ownerOrgId } = await orgAgent();
    const { agent: other } = await orgAgent();
    const a = await owner.post("/api/brands").send({ name: "Brand A" }).expect(201);
    const b = await owner.post("/api/brands").send({ name: "Brand B" }).expect(201);
    const source = await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Journal",
        url: "https://example.com/feed.xml",
      })
      .expect(201);
    expect(source.body).toMatchObject({ brandId: a.body.id, name: "Journal", isActive: true });
    expect(source.body.kind).toBe("rss");

    const telegram = await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Public channel",
        kind: "telegram",
        url: "https://t.me/example_channel",
      })
      .expect(201);
    expect(telegram.body).toMatchObject({ kind: "telegram", url: "https://t.me/example_channel" });
    await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Duplicate",
        kind: "telegram",
        url: "https://t.me/EXAMPLE_CHANNEL/",
      })
      .expect(409);
    await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Invalid",
        kind: "telegram",
        url: "https://evil.example.com/channel",
      })
      .expect(400);
    await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Invite",
        kind: "telegram_private",
        url: "https://t.me/+SensitiveInvite",
      })
      .expect(400);
    expect((await owner.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: false,
    });
    expect((await other.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: false,
    });
    const { db } = await import("../db");
    const [privateSource] = await db
      .insert(schema.newsSources)
      .values({
        orgId: ownerOrgId,
        brandId: a.body.id,
        name: "Joined private channel",
        kind: "telegram_private",
        url: "https://t.me/c/123456",
        privatePeerEncrypted: "encrypted-access-hash",
      })
      .returning({ id: schema.newsSources.id });
    if (!privateSource) throw new Error("Private source fixture was not inserted");
    const privateList = await owner.get(`/api/sources?brandId=${a.body.id}`).expect(200);
    expect(privateList.body).toContainEqual(
      expect.objectContaining({
        id: privateSource.id,
        kind: "telegram_private",
        url: "https://t.me/c/123456",
      }),
    );
    expect(JSON.stringify(privateList.body)).not.toContain("encrypted-access-hash");
    await owner
      .patch(`/api/sources/${privateSource.id}?brandId=${a.body.id}`)
      .send({ url: "https://t.me/other_channel" })
      .expect(400);
    await other.get(`/api/sources?brandId=${a.body.id}`).expect(404);
    await db
      .insert(schema.telegramSourceAccounts)
      .values({ orgId: ownerOrgId, sessionEncrypted: "never-expose-this-session" });
    expect((await owner.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: true,
    });
    const member = request.agent(app.getHttpServer());
    const memberEmail = `connection-${randomUUID()}@example.com`;
    await member
      .post("/api/auth/sign-up/email")
      .send({ email: memberEmail, password: "password1234", name: "Member" })
      .expect(200);
    const memberSession = await member.get("/api/auth/get-session").expect(200);
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: ownerOrgId,
      userId: memberSession.body.user.id,
      role: "member",
    });
    await member
      .post("/api/auth/organization/set-active")
      .send({ organizationId: ownerOrgId })
      .expect(200);
    expect((await member.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: true,
    });
    expect((await other.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: false,
    });
    await owner
      .patch(`/api/sources/${source.body.id}?brandId=${a.body.id}`)
      .send({ url: "https://example.com/updated.xml" })
      .expect(200);
    await owner
      .patch(`/api/sources/${telegram.body.id}?brandId=${a.body.id}`)
      .send({ url: "https://example.com/feed.xml" })
      .expect(400);

    const list = await owner.get(`/api/sources?brandId=${a.body.id}`).expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toContain(source.body.id);
    expect((await owner.get(`/api/sources?brandId=${b.body.id}`).expect(200)).body).toEqual([]);
    expect((await owner.get(`/api/sources/items?brandId=${a.body.id}`).expect(200)).body).toEqual(
      [],
    );
    const [telegramItem] = await db
      .insert(schema.newsItems)
      .values({
        orgId: ownerOrgId,
        brandId: a.body.id,
        sourceId: telegram.body.id,
        title: "Public story",
        summary: "A public Telegram story",
        url: "https://t.me/example_channel/42",
      })
      .returning({ id: schema.newsItems.id });
    if (!telegramItem) throw new Error("Telegram story fixture was not inserted");
    expect(
      (
        await owner
          .get(`/api/sources/items/${telegramItem.id}/comments?brandId=${a.body.id}`)
          .expect(200)
      ).body,
    ).toEqual([]);
    await other
      .get(`/api/sources/items/${telegramItem.id}/comments?brandId=${a.body.id}`)
      .expect(404);
    await owner
      .get(`/api/sources/items/${telegramItem.id}/comments?brandId=${b.body.id}`)
      .expect(404);
    expect(
      (
        await owner
          .post(`/api/sources/items/${telegramItem.id}/comments/refresh?brandId=${a.body.id}`)
          .expect(201)
      ).body,
    ).toEqual({ queued: true });
    const [queuedItem] = (await owner.get(`/api/sources/items?brandId=${a.body.id}`).expect(200))
      .body;
    expect(queuedItem).toMatchObject({
      id: telegramItem.id,
      commentsStatus: "pending",
      commentsCheckedAt: null,
      commentsErrorCode: null,
    });
    expect(
      (
        await owner
          .post(`/api/sources/items/${telegramItem.id}/comments/refresh?brandId=${a.body.id}`)
          .expect(201)
      ).body,
    ).toEqual({ queued: false });
    await owner
      .post(`/api/sources/items/${telegramItem.id}/comments/refresh?brandId=${b.body.id}`)
      .expect(404);
    await owner
      .patch(`/api/sources/${telegram.body.id}?brandId=${a.body.id}`)
      .send({ isActive: false })
      .expect(200);
    await owner
      .post(`/api/sources/items/${telegramItem.id}/comments/refresh?brandId=${a.body.id}`)
      .expect(409);
    await owner
      .patch(`/api/sources/${telegram.body.id}?brandId=${a.body.id}`)
      .send({ isActive: true })
      .expect(200);
    await other.get(`/api/sources?brandId=${a.body.id}`).expect(404);
    await other.get(`/api/sources/items?brandId=${a.body.id}`).expect(404);
    await other
      .patch(`/api/sources/${source.body.id}?brandId=${a.body.id}`)
      .send({ isActive: false })
      .expect(404);
    await owner
      .patch(`/api/sources/${source.body.id}?brandId=${b.body.id}`)
      .send({ isActive: false })
      .expect(404);
    await owner.delete(`/api/sources/${source.body.id}?brandId=${b.body.id}`).expect(404);
    await other.delete(`/api/sources/${source.body.id}?brandId=${a.body.id}`).expect(404);

    const refresh = await owner
      .post(`/api/sources/${source.body.id}/refresh?brandId=${a.body.id}`)
      .expect(201);
    expect(refresh.body).toEqual({ queued: false });
    await owner
      .patch(`/api/sources/${source.body.id}?brandId=${a.body.id}`)
      .send({ isActive: false })
      .expect(200);
    await owner.post(`/api/sources/${source.body.id}/refresh?brandId=${a.body.id}`).expect(409);
    await owner.delete(`/api/sources/${source.body.id}?brandId=${a.body.id}`).expect(200);
    await owner.delete(`/api/sources/${telegram.body.id}?brandId=${a.body.id}`).expect(200);
    await owner.delete(`/api/sources/${privateSource.id}?brandId=${a.body.id}`).expect(200);
    expect((await owner.get(`/api/sources?brandId=${a.body.id}`).expect(200)).body).toEqual([]);
  });

  it("filters and orders scores without replacing the editor signal or crossing brands", async () => {
    const { agent: owner } = await orgAgent();
    const { agent: other } = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Cafe" }).expect(201);
    const source = await owner
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "Journal", url: "https://example.com/relevance.xml" })
      .expect(201);
    const { schema } = await import("@pubrick/db");
    const { db } = await import("../db");
    const { eq } = await import("drizzle-orm");
    const orgRows = await db
      .select({ orgId: schema.brands.orgId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brand.body.id));
    const orgId = orgRows[0]?.orgId as string;
    const [high, low, pending, capped] = await db
      .insert(schema.newsItems)
      .values([
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "High",
          url: "https://example.com/high",
          relevanceStatus: "scored",
          relevanceScore: 0.9,
          relevanceFeedbackDelta: -0.2,
          relevanceReason: "Highly relevant",
          relevanceUrgency: "timely",
          relevanceScoredAt: new Date(),
          editorSignal: "irrelevant",
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Low",
          url: "https://example.com/low",
          relevanceStatus: "scored",
          relevanceScore: 0.65,
          relevanceFeedbackDelta: 0.2,
          relevanceReason: "Weak fit",
          relevanceUrgency: "evergreen",
          relevanceScoredAt: new Date(),
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Pending",
          url: "https://example.com/pending",
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Capped",
          url: "https://example.com/capped",
          relevanceStatus: "scored",
          relevanceScore: 0.95,
          relevanceFeedbackDelta: 0.2,
          relevanceReason: "Strong fit",
          relevanceUrgency: "timely",
          relevanceScoredAt: new Date(),
        },
      ])
      .returning({ id: schema.newsItems.id });
    if (!high || !low || !pending || !capped) throw new Error("Article seed failed");
    const ranked = await owner
      .get(`/api/sources/items?brandId=${brand.body.id}&sort=relevance&status=scored`)
      .expect(200);
    expect(ranked.body.map((row: { id: string }) => row.id)).toEqual([capped.id, low.id, high.id]);
    expect(ranked.body[0]).toMatchObject({ relevanceScore: 0.95, rankScore: 1 });
    expect(ranked.body[1]).toMatchObject({
      relevanceScore: 0.65,
      rankScore: 0.85,
      feedbackDelta: 0.2,
    });
    expect(ranked.body[2]).toMatchObject({
      relevanceScore: 0.9,
      rankScore: 0.7,
      feedbackDelta: -0.2,
      editorSignal: "irrelevant",
    });
    const unscored = await owner
      .get(`/api/sources/items?brandId=${brand.body.id}&status=unscored`)
      .expect(200);
    expect(unscored.body.map((row: { id: string }) => row.id)).toEqual([pending.id]);
    await other.get(`/api/sources/items?brandId=${brand.body.id}&sort=relevance`).expect(404);
    await other.post(`/api/sources/items/${pending.id}/score?brandId=${brand.body.id}`).expect(404);
    await owner.post(`/api/sources/items/${high.id}/score?brandId=${brand.body.id}`).expect(409);
    await owner.post(`/api/sources/items/${pending.id}/score?brandId=${brand.body.id}`).expect(201);
  });

  it("dismisses stories without deleting URL identity and restores prior feedback", async () => {
    const { agent: owner, orgId } = await orgAgent();
    const { agent: other } = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Editorial news" }).expect(201);
    const source = await owner
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "Journal", url: "https://example.com/dismiss.xml" })
      .expect(201);
    const db = (await import("../db")).db;
    const [standalone, linked, racing] = await db
      .insert(schema.newsItems)
      .values(
        ["standalone", "linked", "racing"].map((name) => ({
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: name,
          url: `https://example.com/${name}`,
          editorSignal: name === "standalone" ? ("relevant" as const) : null,
        })),
      )
      .returning({ id: schema.newsItems.id });
    if (!standalone || !linked || !racing) throw new Error("News seed failed");
    const list = `/api/sources/items?brandId=${brand.body.id}`;
    const dismiss = (itemId: string) =>
      `/api/sources/items/${itemId}/dismiss?brandId=${brand.body.id}`;
    const restore = (itemId: string) =>
      `/api/sources/items/${itemId}/restore?brandId=${brand.body.id}`;
    const before = await db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId));
    await other.post(dismiss(standalone.id)).expect(404);
    await other.post(restore(standalone.id)).expect(404);
    await owner.post(dismiss(standalone.id)).expect(201);
    await owner.post(dismiss(standalone.id)).expect(201);
    await owner
      .post(`/api/sources/items/${standalone.id}/score?brandId=${brand.body.id}`)
      .expect(404);
    expect(
      (await owner.get(list).expect(200)).body.map((item: { id: string }) => item.id),
    ).not.toContain(standalone.id);
    const hidden = await owner.get(`${list}&view=dismissed`).expect(200);
    expect(hidden.body).toMatchObject([
      { id: standalone.id, editorSignal: "irrelevant", dismissedAt: expect.any(String) },
    ]);
    expect(
      (
        await db
          .select({ id: schema.newsItems.id, url: schema.newsItems.url })
          .from(schema.newsItems)
          .where(eq(schema.newsItems.id, standalone.id))
      )[0],
    ).toEqual({ id: standalone.id, url: "https://example.com/standalone" });
    await owner.post(restore(standalone.id)).expect(201);
    await owner.post(restore(standalone.id)).expect(201);
    expect(
      (await owner.get(list).expect(200)).body.find(
        (item: { id: string }) => item.id === standalone.id,
      ),
    ).toMatchObject({ editorSignal: "relevant", dismissedAt: null });

    await owner.post(`/api/topics/from-news/${linked.id}?brandId=${brand.body.id}`).expect(201);
    await owner.post(dismiss(linked.id)).expect(201);
    expect(
      (await owner.get(`${list}&view=dismissed`).expect(200)).body.find(
        (item: { id: string }) => item.id === linked.id,
      ),
    ).toMatchObject({ editorSignal: "relevant" });
    await owner.post(restore(linked.id)).expect(201);

    const [conversion, dismissal] = await Promise.all([
      owner.post(`/api/topics/from-news/${racing.id}?brandId=${brand.body.id}`),
      owner.post(dismiss(racing.id)),
    ]);
    expect(dismissal.status).toBe(201);
    expect([201, 409]).toContain(conversion.status);
    if (conversion.status === 409) {
      expect(conversion.body.code).toBe("news_item_dismissed");
      await owner.post(restore(racing.id)).expect(201);
      await owner.post(`/api/topics/from-news/${racing.id}?brandId=${brand.body.id}`).expect(201);
      await owner.post(dismiss(racing.id)).expect(201);
    }
    const [raceResult] = await db
      .select({
        editorSignal: schema.newsItems.editorSignal,
        dismissedAt: schema.newsItems.dismissedAt,
      })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.id, racing.id));
    expect(raceResult).toMatchObject({ editorSignal: "relevant", dismissedAt: expect.any(Date) });
    expect(
      await db
        .select({ id: schema.usageLedger.id })
        .from(schema.usageLedger)
        .where(eq(schema.usageLedger.orgId, orgId)),
    ).toEqual(before);
    expect(
      await db
        .select({ id: schema.paidReplyAnalysisAttempts.id })
        .from(schema.paidReplyAnalysisAttempts)
        .where(eq(schema.paidReplyAnalysisAttempts.orgId, orgId)),
    ).toHaveLength(0);
  });

  it("searches literal title and summary text before the news limit within a source and brand", async () => {
    const { agent: owner, orgId } = await orgAgent();
    const { agent: other } = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Search" }).expect(201);
    const otherBrand = await owner.post("/api/brands").send({ name: "Other" }).expect(201);
    const first = await owner
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "First", url: "https://example.com/first.xml" })
      .expect(201);
    const second = await owner
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "Second", url: "https://example.com/second.xml" })
      .expect(201);
    const foreignSource = await owner
      .post("/api/sources")
      .send({
        brandId: otherBrand.body.id,
        name: "Foreign",
        url: "https://example.com/foreign.xml",
      })
      .expect(201);
    const { db } = await import("../db");
    await db.insert(schema.newsItems).values(
      Array.from({ length: 101 }, (_, index) => ({
        orgId,
        brandId: brand.body.id,
        sourceId: second.body.id,
        title: `Recent ${index}`,
        url: `https://example.com/recent-${index}`,
        publishedAt: new Date("2026-09-24T00:00:00Z"),
      })),
    );
    const [match] = await db
      .insert(schema.newsItems)
      .values({
        orgId,
        brandId: brand.body.id,
        sourceId: first.body.id,
        title: "СВОДКА 100%_",
        summary: "Важная история",
        url: "https://example.com/match",
        publishedAt: new Date("2026-09-01T00:00:00Z"),
      })
      .returning({ id: schema.newsItems.id });
    await db.insert(schema.newsItems).values({
      orgId,
      brandId: otherBrand.body.id,
      sourceId: foreignSource.body.id,
      title: "СВОДКА 100%_",
      url: "https://example.com/other-brand",
    });
    if (!match) throw new Error("Search fixture failed");
    const endpoint = `/api/sources/items?brandId=${brand.body.id}&sourceId=${first.body.id}`;
    const byTitle = await owner
      .get(`${endpoint}&search=${encodeURIComponent("сводка 100%_")}`)
      .expect(200);
    expect(byTitle.body.map((item: { id: string }) => item.id)).toEqual([match.id]);
    const bySummary = await owner
      .get(`${endpoint}&search=${encodeURIComponent("ИСТОРИЯ")}`)
      .expect(200);
    expect(bySummary.body.map((item: { id: string }) => item.id)).toEqual([match.id]);
    expect(
      (await owner.get(`${endpoint}&search=${encodeURIComponent("100%X")}`).expect(200)).body,
    ).toEqual([]);
    expect(
      (await owner.get(`${endpoint}&search=${encodeURIComponent("100X_")}`).expect(200)).body,
    ).toEqual([]);
    expect(
      (
        await owner
          .get(
            `/api/sources/items?brandId=${brand.body.id}&sourceId=${second.body.id}&search=${encodeURIComponent("сводка")}`,
          )
          .expect(200)
      ).body,
    ).toEqual([]);
    expect(
      (
        await owner
          .get(`/api/sources/items?brandId=${brand.body.id}&sourceId=${foreignSource.body.id}`)
          .expect(200)
      ).body,
    ).toEqual([]);
    await other.get(`${endpoint}&search=${encodeURIComponent("сводка")}`).expect(404);
    await owner.get(`${endpoint}&search=${"x".repeat(201)}`).expect(400);
  });

  it("applies the original AI score threshold before the news limit and preserves unfiltered stories", async () => {
    const { agent: owner, orgId } = await orgAgent();
    const { agent: outsider } = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Threshold" }).expect(201);
    const otherBrand = await owner.post("/api/brands").send({ name: "Other" }).expect(201);
    const source = await owner
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "Main", url: "https://example.com/main.xml" })
      .expect(201);
    const otherSource = await owner
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "Another", url: "https://example.com/another.xml" })
      .expect(201);
    const foreignSource = await owner
      .post("/api/sources")
      .send({
        brandId: otherBrand.body.id,
        name: "Foreign",
        url: "https://example.com/foreign.xml",
      })
      .expect(201);
    const { db } = await import("../db");
    const scored = {
      relevanceStatus: "scored" as const,
      relevanceReason: "Local test verdict",
      relevanceUrgency: "timely" as const,
      relevanceScoredAt: new Date("2026-09-24T00:00:00Z"),
    };
    await db.insert(schema.newsItems).values(
      Array.from({ length: 101 }, (_, index) => ({
        orgId,
        brandId: brand.body.id,
        sourceId: source.body.id,
        title: `Match recent ${index}`,
        url: `https://example.com/low-${index}`,
        publishedAt: new Date("2026-09-24T00:00:00Z"),
        ...scored,
        relevanceScore: 0.2,
      })),
    );
    const [high, boosted, zero, pending, failed] = await db
      .insert(schema.newsItems)
      .values([
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Match high",
          url: "https://example.com/high",
          publishedAt: new Date("2026-09-01T00:00:00Z"),
          ...scored,
          relevanceScore: 0.8,
          relevanceFeedbackDelta: -0.2,
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Match boosted",
          url: "https://example.com/boosted",
          ...scored,
          relevanceScore: 0.7,
          relevanceFeedbackDelta: 0.2,
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Zero score",
          url: "https://example.com/zero",
          ...scored,
          relevanceScore: 0,
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Pending score",
          url: "https://example.com/pending-score",
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Failed score",
          url: "https://example.com/failed-score",
          relevanceStatus: "failed",
          relevanceErrorCode: "model_failed",
        },
      ])
      .returning({ id: schema.newsItems.id });
    if (!high || !boosted || !zero || !pending || !failed)
      throw new Error("Threshold fixture failed");
    await db.insert(schema.newsItems).values([
      {
        orgId,
        brandId: brand.body.id,
        sourceId: otherSource.body.id,
        title: "Match other source",
        url: "https://example.com/other-source",
        ...scored,
        relevanceScore: 0.99,
      },
      {
        orgId,
        brandId: otherBrand.body.id,
        sourceId: foreignSource.body.id,
        title: "Match other brand",
        url: "https://example.com/other-brand",
        ...scored,
        relevanceScore: 0.99,
      },
    ]);
    const endpoint = `/api/sources/items?brandId=${brand.body.id}&sourceId=${source.body.id}`;
    const filtered = await owner
      .get(`${endpoint}&search=Match&sort=recent&minScorePercent=75`)
      .expect(200);
    expect(filtered.body.map((item: { id: string }) => item.id)).toEqual([high.id]);
    expect(filtered.body[0]).toMatchObject({ relevanceScore: 0.8, rankScore: 0.6 });
    expect(
      (await owner.get(`${endpoint}&search=Zero&minScorePercent=0`).expect(200)).body.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([zero.id]);
    expect(
      (await owner.get(`${endpoint}&search=Pending`).expect(200)).body.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([pending.id]);
    expect(
      (await owner.get(`${endpoint}&search=Failed`).expect(200)).body.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([failed.id]);
    expect(
      (await owner.get(`${endpoint}&search=Pending&minScorePercent=0`).expect(200)).body,
    ).toEqual([]);
    expect(
      (await owner.get(`${endpoint}&status=unscored&minScorePercent=0`).expect(200)).body,
    ).toEqual([]);
    await outsider.get(`${endpoint}&minScorePercent=75`).expect(404);
    for (const invalid of ["-1", "101", "0.5", "abc", " "]) {
      await owner.get(`${endpoint}&minScorePercent=${encodeURIComponent(invalid)}`).expect(400);
    }
  });

  it("reranks scored news in bounded pages from local feedback without model usage", async () => {
    const { agent: owner, orgId } = await orgAgent();
    const { agent: other } = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Rerank" }).expect(201);
    const otherBrand = await owner.post("/api/brands").send({ name: "Other brand" }).expect(201);
    const source = await owner
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "Rerank feed", url: "https://example.com/rerank.xml" })
      .expect(201);
    const { db } = await import("../db");
    const now = Date.now();
    const score = {
      relevanceStatus: "scored" as const,
      relevanceScore: 0.7,
      relevanceReason: "Original model verdict",
      relevanceUrgency: "timely" as const,
      relevanceScoredAt: new Date(now - 60_000),
      relevanceAttempts: 2,
    };
    const rows = await db
      .insert(schema.newsItems)
      .values([
        {
          ...score,
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Battery recycling rules for European manufacturers",
          summary: "Factories collect batteries under new recycling rules.",
          url: "https://example.com/rerank-signal",
          editorSignal: "relevant" as const,
          relevanceFeedbackDelta: 0.2,
          createdAt: new Date(now - 1_000),
        },
        {
          ...score,
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "European manufacturers face battery recycling rules",
          summary: "Factories collect batteries under new recycling rules.",
          url: "https://example.com/rerank-nearby",
          createdAt: new Date(now - 2_000),
        },
        ...Array.from({ length: 51 }, (_, index) => ({
          ...score,
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: `Coffee price report ${index}`,
          summary: "A separate story about cafe equipment.",
          url: `https://example.com/rerank-unrelated-${index}`,
          createdAt: new Date(now - 3_000 - index * 1_000),
        })),
      ])
      .returning({ id: schema.newsItems.id, title: schema.newsItems.title });
    const signal = rows[0];
    const nearby = rows[1];
    if (!signal || !nearby) throw new Error("Rerank seed failed");
    const [old, pending] = await db
      .insert(schema.newsItems)
      .values([
        {
          ...score,
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Old scored article",
          url: "https://example.com/rerank-old",
          relevanceFeedbackDelta: -0.2,
          createdAt: new Date(now - 31 * 24 * 60 * 60_000),
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Pending article",
          url: "https://example.com/rerank-pending",
          relevanceFeedbackDelta: 0.2,
        },
      ])
      .returning({ id: schema.newsItems.id });
    if (!old || !pending) throw new Error("Rerank exclusion seed failed");
    const route = `/api/sources/items/rerank?brandId=${brand.body.id}`;
    await owner.post(route).send({ days: 31 }).expect(400);
    await owner.post(route).send({ days: 30, extra: true }).expect(400);
    await owner
      .post(route)
      .send({ cursor: { createdAt: "invalid", id: signal.id } })
      .expect(400);
    await other.post(route).send({}).expect(404);
    await owner
      .post(`/api/sources/items/rerank?brandId=${otherBrand.body.id}`)
      .send({})
      .expect(201);

    const usageBefore = await db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId));
    const first = await owner.post(route).send({ days: 30 }).expect(201);
    expect(first.body).toMatchObject({ processed: 50, changed: 2 });
    expect(first.body.nextCursor).toEqual({
      createdAt: expect.any(String),
      id: expect.any(String),
    });
    const second = await owner
      .post(route)
      .send({ days: 30, cursor: first.body.nextCursor })
      .expect(201);
    expect(second.body).toEqual({ processed: 3, changed: 0, nextCursor: null });
    const repeat = await owner.post(route).send({ days: 30 }).expect(201);
    expect(repeat.body).toMatchObject({ processed: 50, changed: 0 });

    const saved = await db
      .select({
        id: schema.newsItems.id,
        feedbackDelta: schema.newsItems.relevanceFeedbackDelta,
        relevanceScore: schema.newsItems.relevanceScore,
        relevanceReason: schema.newsItems.relevanceReason,
        relevanceAttempts: schema.newsItems.relevanceAttempts,
        editorSignal: schema.newsItems.editorSignal,
      })
      .from(schema.newsItems)
      .where(and(eq(schema.newsItems.orgId, orgId), eq(schema.newsItems.brandId, brand.body.id)));
    expect(saved.find((item) => item.id === signal.id)).toMatchObject({
      feedbackDelta: 0,
      editorSignal: "relevant",
    });
    expect(saved.find((item) => item.id === nearby.id)).toMatchObject({
      feedbackDelta: expect.any(Number),
      relevanceScore: 0.7,
      relevanceReason: "Original model verdict",
      relevanceAttempts: 2,
    });
    expect(saved.find((item) => item.id === nearby.id)?.feedbackDelta).toBeGreaterThan(0);
    expect(
      saved.filter((item) => rows.some((row) => row.id === item.id) && item.feedbackDelta !== 0),
    ).toHaveLength(1);
    expect(saved.find((item) => item.id === old.id)?.feedbackDelta).toBe(-0.2);
    expect(saved.find((item) => item.id === pending.id)?.feedbackDelta).toBe(0.2);
    const usageAfter = await db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId));
    expect(usageAfter).toEqual(usageBefore);
    expect(
      await db
        .select({ id: schema.paidReplyAnalysisAttempts.id })
        .from(schema.paidReplyAnalysisAttempts)
        .where(eq(schema.paidReplyAnalysisAttempts.orgId, orgId)),
    ).toHaveLength(0);
  });

  it("queues one owned frozen sample and shows an earlier aggregate after a new sample", async () => {
    const { agent, orgId } = await orgAgent();
    const { agent: other } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Discussion brand" }).expect(201);
    const source = await agent
      .post("/api/sources")
      .send({
        brandId: brand.body.id,
        name: "Public channel",
        kind: "telegram",
        url: "https://t.me/discussion_fixture",
      })
      .expect(201);
    const { db } = await import("../db");
    const checkedAt = new Date("2026-09-23T10:00:00Z");
    const sampleVersion = randomUUID();
    const [item] = await db
      .insert(schema.newsItems)
      .values({
        orgId,
        brandId: brand.body.id,
        sourceId: source.body.id,
        title: "A public post",
        url: "https://t.me/discussion_fixture/7",
      })
      .returning({ id: schema.newsItems.id });
    if (!item) throw new Error("story fixture missing");
    const route = `/api/sources/items/${item.id}/comment-analysis?brandId=${brand.body.id}`;
    expect((await agent.get(route).expect(200)).body).toMatchObject({
      status: "not_collected",
      current: { sampleVersion: null },
    });
    await other.get(route).expect(404);
    await other.post(route).expect(404);
    await db
      .update(schema.newsItems)
      .set({
        commentsStatus: "available",
        commentsCheckedAt: checkedAt,
        commentsSampleVersion: sampleVersion,
      })
      .where(eq(schema.newsItems.id, item.id));
    expect((await agent.get(route).expect(200)).body).toMatchObject({ status: "no_comments" });
    await db.insert(schema.newsComments).values({
      orgId,
      brandId: brand.body.id,
      itemId: item.id,
      telegramMessageId: 10,
      body: "Please explain the pricing for smaller teams.",
      publishedAt: checkedAt,
    });
    expect((await agent.get(route).expect(200)).body).toMatchObject({ status: "no_key" });
    expect((await agent.post(route).expect(201)).body).toMatchObject({ status: "no_key" });
    expect(
      await db
        .select()
        .from(schema.paidReplyAnalysisAttempts)
        .where(eq(schema.paidReplyAnalysisAttempts.orgId, orgId)),
    ).toHaveLength(0);
    await agent
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "test-key-never-used" })
      .expect(200);
    expect((await agent.get(route).expect(200)).body).toMatchObject({ status: "not_analyzed" });
    const countTokens = mockCountTokens();
    const queued = (await agent.post(route).expect(201)).body;
    expect(queued).toMatchObject({
      status: "in_progress",
      current: { sampleVersion, collectionStatus: "available" },
    });
    expect(JSON.stringify(queued)).not.toContain("test-key-never-used");
    expect((await agent.post(route).expect(201)).body).toMatchObject({ status: "in_progress" });
    expect(countTokens).toHaveBeenCalledTimes(1);
    const attempts = await db
      .select()
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, orgId),
          eq(schema.paidReplyAnalysisAttempts.targetId, item.id),
        ),
      );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: "queued",
      origin: "manual",
      sampleVersion,
      sampleSize: 1,
    });
    expect(attempts[0]?.promptEncrypted).toBeTruthy();
    expect(
      await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.orgId, orgId)),
    ).toHaveLength(0);
    const result = {
      summary: "Readers want clearer prices for small teams.",
      sentiment: { positive: 0, neutral: 1, negative: 0 },
      themes: [{ label: "Pricing", mentions: 1 }],
      feedback: ["Clarify the small-team pricing."],
    };
    await db.insert(schema.newsCommentAnalyses).values({
      orgId,
      brandId: brand.body.id,
      itemId: item.id,
      sampleVersion,
      sampleCheckedAt: checkedAt,
      sampleSize: 1,
      result,
    });
    expect((await agent.get(route).expect(200)).body).toMatchObject({
      status: "ready",
      result,
      sampleSize: 1,
    });
    const newVersion = randomUUID();
    await db
      .update(schema.newsItems)
      .set({
        commentsSampleVersion: newVersion,
        commentsCheckedAt: new Date("2026-09-23T11:00:00Z"),
      })
      .where(eq(schema.newsItems.id, item.id));
    expect((await agent.get(route).expect(200)).body).toMatchObject({
      status: "stale",
      current: { sampleVersion: newVersion },
      earlierAnalysis: { sampleVersion, result, sampleSize: 1 },
    });
  });

  it("keeps one attempt for concurrent manual requests and shares the rolling allowance", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Metered brand" }).expect(201);
    const source = await agent
      .post("/api/sources")
      .send({
        brandId: brand.body.id,
        name: "Channel",
        kind: "telegram",
        url: "https://t.me/metered",
      })
      .expect(201);
    const { db } = await import("../db");
    const checkedAt = new Date("2026-09-23T10:00:00Z");
    const sampleVersion = randomUUID();
    const [item] = await db
      .insert(schema.newsItems)
      .values({
        orgId,
        brandId: brand.body.id,
        sourceId: source.body.id,
        title: "Post",
        url: "https://t.me/metered/7",
        commentsStatus: "available",
        commentsCheckedAt: checkedAt,
        commentsSampleVersion: sampleVersion,
      })
      .returning({ id: schema.newsItems.id });
    if (!item) throw new Error("story fixture missing");
    await db.insert(schema.newsComments).values({
      orgId,
      brandId: brand.body.id,
      itemId: item.id,
      telegramMessageId: 10,
      body: "What is the price?",
      publishedAt: checkedAt,
    });
    await agent
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "test-key-never-used" })
      .expect(200);
    const countTokens = mockCountTokens();
    const route = `/api/sources/items/${item.id}/comment-analysis?brandId=${brand.body.id}`;
    const [first, second] = await Promise.all([agent.post(route), agent.post(route)]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.status).toBe("in_progress");
    expect(second.body.status).toBe("in_progress");
    expect(countTokens.mock.calls.every(([input]) => String(input).endsWith(":countTokens"))).toBe(
      true,
    );
    const attempts = await db
      .select()
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, orgId),
          eq(schema.paidReplyAnalysisAttempts.targetId, item.id),
        ),
      );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ sampleVersion, status: "queued" });
    expect(
      await db
        .select()
        .from(schema.analysisAdmissions)
        .where(eq(schema.analysisAdmissions.orgId, orgId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.orgId, orgId)),
    ).toHaveLength(0);

    const { admitAnalysis, recordAnalysisUsage } = await import("../analysis-admission");
    const extra = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        admitAnalysis({
          orgId,
          targetKind: index % 2 === 0 ? "publication_comment" : "source_comment",
          targetId: randomUUID(),
          sampleCheckedAt: checkedAt,
        }),
      ),
    );
    expect(extra.every((admission) => admission.status === "admitted")).toBe(true);
    await db
      .update(schema.newsItems)
      .set({
        commentsSampleVersion: randomUUID(),
        commentsCheckedAt: new Date("2026-09-23T11:00:00Z"),
      })
      .where(eq(schema.newsItems.id, item.id));
    expect((await agent.post(route).expect(201)).body).toMatchObject({
      status: "blocked",
      reason: "hourly_limit",
    });
    expect(
      await db
        .select()
        .from(schema.paidReplyAnalysisAttempts)
        .where(
          and(
            eq(schema.paidReplyAnalysisAttempts.orgId, orgId),
            eq(schema.paidReplyAnalysisAttempts.targetId, item.id),
          ),
        ),
    ).toHaveLength(1);

    const lossMarker = extra[0];
    if (lossMarker?.status !== "admitted") throw new Error("expected admission fixture");
    await expect(
      recordAnalysisUsage({
        admissionId: lossMarker.id,
        orgId,
        targetKind: "publication_comment",
        record: {
          provider: "invalid-provider" as UsageRecord["provider"],
          modelId: "gemini-test",
          attempt: 1,
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.00001,
          costSource: "price_table",
          responseMs: 20,
          status: "ok",
          outcome: "completed",
        },
      }),
    ).rejects.toThrow();
    const [marked] = await db
      .select({ unrecordedCalls: schema.analysisAdmissions.unrecordedCalls })
      .from(schema.analysisAdmissions)
      .where(eq(schema.analysisAdmissions.id, lossMarker.id));
    expect(marked?.unrecordedCalls).toBe(1);
  });

  it("keeps pre-admission ledger calls inside the rolling allowance during upgrade", async () => {
    const { orgId } = await orgAgent();
    const { db } = await import("../db");
    const { admitAnalysis } = await import("../analysis-admission");
    await db.insert(schema.usageLedger).values(
      Array.from({ length: 9 }, () => ({
        orgId,
        step: "comment_analysis",
        provider: "google" as const,
        modelId: "gemini-test",
        costSource: "unknown" as const,
        status: "ok" as const,
      })),
    );
    expect(
      (
        await admitAnalysis({
          orgId,
          targetKind: "source_comment",
          targetId: randomUUID(),
          sampleCheckedAt: new Date(),
        })
      ).status,
    ).toBe("admitted");
    expect(
      (
        await admitAnalysis({
          orgId,
          targetKind: "publication_comment",
          targetId: randomUUID(),
          sampleCheckedAt: new Date(),
        })
      ).status,
    ).toBe("limit_reached");
  });

  it("does not admit a source sample replaced while countTokens is in flight", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Moving discussion" }).expect(201);
    const source = await agent
      .post("/api/sources")
      .send({
        brandId: brand.body.id,
        name: "Channel",
        kind: "telegram",
        url: "https://t.me/moving_discussion",
      })
      .expect(201);
    const { db } = await import("../db");
    const checkedAt = new Date("2026-09-23T10:00:00Z");
    const [item] = await db
      .insert(schema.newsItems)
      .values({
        orgId,
        brandId: brand.body.id,
        sourceId: source.body.id,
        title: "Original post",
        url: "https://t.me/moving_discussion/7",
        commentsStatus: "available",
        commentsCheckedAt: checkedAt,
        commentsSampleVersion: randomUUID(),
      })
      .returning({ id: schema.newsItems.id });
    if (!item) throw new Error("story fixture missing");
    await db.insert(schema.newsComments).values({
      orgId,
      brandId: brand.body.id,
      itemId: item.id,
      telegramMessageId: 10,
      body: "Old question",
      publishedAt: checkedAt,
    });
    await agent
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "test-key-never-used" })
      .expect(200);
    let entered!: () => void;
    let release!: () => void;
    const countStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (!String(input).endsWith(":countTokens")) throw new Error("Unexpected generation request");
      entered();
      await gate;
      return new Response(JSON.stringify({ totalTokens: 200 }), { status: 200 });
    });
    const route = `/api/sources/items/${item.id}/comment-analysis?brandId=${brand.body.id}`;
    const pending = agent.post(route).then((response) => response);
    await countStarted;
    await db
      .update(schema.newsItems)
      .set({
        commentsSampleVersion: randomUUID(),
        commentsCheckedAt: new Date("2026-09-23T11:00:00Z"),
      })
      .where(eq(schema.newsItems.id, item.id));
    release();
    expect((await pending).body).toMatchObject({ status: "stale" });
    expect(
      await db
        .select()
        .from(schema.paidReplyAnalysisAttempts)
        .where(eq(schema.paidReplyAnalysisAttempts.orgId, orgId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.analysisAdmissions)
        .where(eq(schema.analysisAdmissions.orgId, orgId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.orgId, orgId)),
    ).toHaveLength(0);
  });
});
