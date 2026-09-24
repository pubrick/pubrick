import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { encryptJson, privateTelegramSourceCreateSchema } from "@pubrick/shared";
import { resolveJoinedPrivateChannel } from "@pubrick/telegram";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentAnalysisCaller } from "./comment-analysis.caller";

vi.mock("@pubrick/telegram", () => ({ resolveJoinedPrivateChannel: vi.fn() }));

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("watched sources e2e", () => {
  let app: INestApplication;
  const analysisRun = vi.fn();

  beforeEach(() => {
    vi.mocked(resolveJoinedPrivateChannel).mockReset();
    analysisRun.mockReset();
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "test-hash";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CommentAnalysisCaller)
      .useValue({ run: analysisRun })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

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

  it("analyzes an organization-scoped saved sample, records spend, and marks later samples stale", async () => {
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
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "not_collected" });
    await other.get(route).expect(404);
    await other.post(route).expect(404);
    await db
      .update(schema.newsItems)
      .set({
        commentsStatus: "available",
        commentsCheckedAt: new Date("2026-09-23T10:00:00Z"),
      })
      .where(eq(schema.newsItems.id, item.id));
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "no_comments" });
    await db.insert(schema.newsComments).values({
      orgId,
      brandId: brand.body.id,
      itemId: item.id,
      telegramMessageId: 10,
      body: "Please explain the pricing for smaller teams.",
      publishedAt: new Date("2026-09-23T09:00:00Z"),
    });
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "no_key" });
    expect((await agent.post(route).expect(201)).body).toEqual({ status: "no_key" });
    expect(analysisRun).not.toHaveBeenCalled();
    await agent
      .put("/api/ai-credentials")
      .send({
        provider: "google",
        apiKey: "test-key-never-used",
      })
      .expect(200);
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "not_analyzed" });
    analysisRun.mockImplementationOnce(
      async (args: { onUsage: (record: UsageRecord) => Promise<void> }) => {
        await args.onUsage({
          provider: "google",
          modelId: "gemini-test",
          attempt: 1,
          inputTokens: 20,
          outputTokens: 10,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.00001,
          costSource: "price_table",
          responseMs: 20,
          status: "ok",
          outcome: "completed",
        });
        return {
          ok: true,
          result: {
            summary: "Readers want clearer prices for small teams.",
            sentiment: { positive: 0, neutral: 1, negative: 0 },
            themes: [{ label: "Pricing", mentions: 1 }],
            feedback: ["Clarify the small-team pricing."],
          },
          usage: [],
        };
      },
    );
    const analyzed = (await agent.post(route).expect(201)).body;
    expect(analyzed).toMatchObject({
      status: "ready",
      sampleSize: 1,
      result: { themes: [{ label: "Pricing", mentions: 1 }] },
    });
    expect(JSON.stringify(analyzed)).not.toContain("test-key-never-used");
    expect(analysisRun).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({ provider: "google" }),
        comments: ["Please explain the pricing for smaller teams."],
      }),
    );
    const ledger = await db
      .select()
      .from(schema.usageLedger)
      .where(
        and(eq(schema.usageLedger.orgId, orgId), eq(schema.usageLedger.step, "comment_analysis")),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ keyOwnership: "byok", inputTokens: 20 });
    expect((await agent.post(route).expect(201)).body.status).toBe("ready");
    expect(analysisRun).toHaveBeenCalledTimes(1);
    await db
      .update(schema.newsItems)
      .set({ commentsCheckedAt: new Date("2026-09-23T11:00:00Z") })
      .where(eq(schema.newsItems.id, item.id));
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "stale" });
  });

  it("admits one concurrent analysis per sample and counts source and publication requests together", async () => {
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
    const route = `/api/sources/items/${item.id}/comment-analysis?brandId=${brand.body.id}`;
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    analysisRun.mockImplementationOnce(async () => {
      started();
      await gate;
      return {
        ok: true,
        result: {
          summary: "Pricing question.",
          sentiment: { positive: 0, neutral: 1, negative: 0 },
          themes: [{ label: "Price", mentions: 1 }],
          feedback: [],
        },
        usage: [],
      };
    });
    const first = agent.post(route).then((response) => response);
    await entered;
    expect((await agent.post(route).expect(201)).body).toEqual({ status: "in_progress" });
    expect(analysisRun).toHaveBeenCalledTimes(1);
    release();
    expect((await first).body.status).toBe("ready");

    await db
      .update(schema.newsItems)
      .set({ commentsCheckedAt: new Date("2026-09-23T11:00:00Z") })
      .where(eq(schema.newsItems.id, item.id));
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
    expect((await agent.post(route).expect(201)).body).toEqual({ status: "limit_reached" });
    expect(analysisRun).toHaveBeenCalledTimes(1);

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
});
