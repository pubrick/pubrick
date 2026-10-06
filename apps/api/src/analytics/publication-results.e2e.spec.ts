import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { encodeContentCursor, publicationResultsPageSchema } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const period = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
describe.skipIf(!url)("publication result cohorts", () => {
  let app: INestApplication;
  let db: typeof import("../db")["db"];
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = (await import("../db")).db;
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app?.close();
  });
  async function fixture() {
    const agent = request.agent(app.getHttpServer());
    const id = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `results-${id}@example.com`, password: "password1234", name: "Results" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: id, slug: id })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Results" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "vk",
        name: '=HYPERLINK("https://unsafe.example")',
        credentials: { accessToken: "synthetic-results-token", groupId: "123" },
      })
      .expect(201);
    return {
      agent,
      orgId: org.body.id as string,
      brandId: brand.body.id as string,
      channelId: channel.body.id as string,
    };
  }
  async function receipt(
    owner: Awaited<ReturnType<typeof fixture>>,
    at: string,
    status: "published" | "unknown" = "published",
  ) {
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        title: "=SUM(1,2)",
        body: "Actual saved text",
      })
      .returning({ id: schema.contentItems.id });
    if (!item) throw new Error("Missing item fixture");
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId: owner.orgId,
        contentItemId: item.id,
        channelId: owner.channelId,
        body: "Reviewed text",
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("Missing adaptation fixture");
    const [publication] = await db
      .insert(schema.publications)
      .values({
        orgId: owner.orgId,
        adaptationId: adaptation.id,
        channelId: owner.channelId,
        status,
        externalId: "-123_9",
        externalUrl: "https://vk.com/wall-123_9",
        createdAt: new Date(at),
      })
      .returning({ id: schema.publications.id });
    if (!publication) throw new Error("Missing publication fixture");
    return publication.id;
  }
  function endpoint(owner: Awaited<ReturnType<typeof fixture>>) {
    return `/api/analytics/brands/${owner.brandId}/results`;
  }

  it("counts the whole cohort before paging, preserves null/zero and exposes equal-length prior cohort", async () => {
    const owner = await fixture();
    const ids = [];
    for (let index = 0; index < 5; index++)
      ids.push(await receipt(owner, "2026-09-15T12:00:00.123Z"));
    await receipt(owner, period.to);
    await receipt(owner, "2026-08-15T00:00:00.000Z");
    await receipt(owner, "2026-09-10T00:00:00.000Z", "unknown");
    const [zero, measured, errored] = ids;
    if (!zero || !measured || !errored) throw new Error("Missing metric fixtures");
    await db.insert(schema.publicationMetrics).values([
      {
        orgId: owner.orgId,
        publicationId: zero,
        status: "available",
        views: 0,
        likes: 2,
        checkedAt: new Date("2026-09-20T00:00:00Z"),
      },
      { orgId: owner.orgId, publicationId: measured, status: "available", views: 7, likes: null },
      { orgId: owner.orgId, publicationId: errored, status: "error", views: 900 },
    ]);
    const response = await owner.agent
      .get(endpoint(owner))
      .query({ ...period, limit: 2 })
      .expect(200);
    const first = publicationResultsPageSchema.parse(response.body);
    expect(first.summary).toMatchObject({
      publishedCount: 5,
      measuredCount: 2,
      totals: { views: 7, likes: 2, comments: null, shares: null },
      observedCounts: { views: 2, likes: 1, comments: 0, shares: 0 },
    });
    expect(first.previous).toMatchObject({
      from: "2026-08-02T00:00:00.000Z",
      to: period.from,
      summary: { publishedCount: 1 },
    });
    expect(first.channels[0]).toMatchObject({
      id: owner.channelId,
      canCollectMetrics: true,
      summary: first.summary,
    });
    const seen = [...first.rows.map((row) => row.id)];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = publicationResultsPageSchema.parse(
        (
          await owner.agent
            .get(endpoint(owner))
            .query({ ...period, limit: 2, cursor })
            .expect(200)
        ).body,
      );
      expect(next.summary).toEqual(first.summary);
      seen.push(...next.rows.map((row) => row.id));
      cursor = next.nextCursor;
    }
    expect(seen).toEqual([...ids].sort().reverse());
    expect(new Set(seen).size).toBe(5);
  });

  it("pins microsecond cursor position independently from displayed millisecond dates", async () => {
    const owner = await fixture();
    const low = await receipt(owner, "2026-09-15T12:00:00.123Z");
    const high = await receipt(owner, "2026-09-15T12:00:00.123Z");
    await db.execute(
      sql`update publications set created_at = '2026-09-15T12:00:00.123456Z'::timestamptz where id = ${high}::uuid`,
    );
    const first = publicationResultsPageSchema.parse(
      (
        await owner.agent
          .get(endpoint(owner))
          .query({ ...period, limit: 1 })
          .expect(200)
      ).body,
    );
    expect(first.rows[0]?.id).toBe(high);
    const second = publicationResultsPageSchema.parse(
      (
        await owner.agent
          .get(endpoint(owner))
          .query({ ...period, limit: 1, cursor: first.nextCursor })
          .expect(200)
      ).body,
    );
    expect(second.rows.map((row) => row.id)).toEqual([low]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses malformed or changed-filter cursors and isolates tenant, brand and channel", async () => {
    const owner = await fixture();
    const other = await fixture();
    await receipt(owner, "2026-09-15T12:00:00Z");
    await receipt(owner, "2026-09-14T12:00:00Z");
    await receipt(other, "2026-09-15T12:00:00Z");
    const first = (
      await owner.agent
        .get(endpoint(owner))
        .query({ ...period, limit: 1 })
        .expect(200)
    ).body;
    const malformedPosition = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()) as {
      position: string;
    };
    const malformedDateCursors = ["2026-02-30T00:00:00.000000Z", "0000-01-01T00:00:00.000000Z"].map(
      (createdAt) => {
        malformedPosition.position = encodeContentCursor({ createdAt, id: randomUUID() });
        return { cursor: Buffer.from(JSON.stringify(malformedPosition)).toString("base64url") };
      },
    );
    for (const change of [
      { cursor: "garbage" },
      ...malformedDateCursors,
      { cursor: first.nextCursor, channelId: owner.channelId },
      { cursor: first.nextCursor, from: "2026-09-02T00:00:00.000Z" },
    ]) {
      expect(
        (
          await owner.agent
            .get(endpoint(owner))
            .query({ ...period, ...change })
            .expect(400)
        ).body.code,
      ).toBe("invalid_request");
    }
    await other.agent.get(endpoint(owner)).query(period).expect(404);
    await owner.agent
      .get(endpoint(owner))
      .query({ ...period, channelId: other.channelId })
      .expect(404);
    const sibling = await owner.agent.post("/api/brands").send({ name: "Sibling" }).expect(201);
    await owner.agent
      .get(`/api/analytics/brands/${sibling.body.id}/results`)
      .query({ ...period, channelId: owner.channelId })
      .expect(404);
    const filtered = publicationResultsPageSchema.parse(
      (
        await owner.agent
          .get(endpoint(owner))
          .query({ ...period, channelId: owner.channelId })
          .expect(200)
      ).body,
    );
    expect(filtered.summary.publishedCount).toBe(2);
  });

  it("keeps attributable deleted-channel receipts and available observations without dead content links", async () => {
    const owner = await fixture();
    const id = await receipt(owner, "2026-09-15T00:00:00Z");
    await db
      .insert(schema.publicationMetrics)
      .values({ orgId: owner.orgId, publicationId: id, status: "available", views: 12 });
    await db.delete(schema.channels).where(eq(schema.channels.id, owner.channelId));
    const data = publicationResultsPageSchema.parse(
      (await owner.agent.get(endpoint(owner)).query(period).expect(200)).body,
    );
    expect(data.summary).toMatchObject({
      publishedCount: 1,
      measuredCount: 1,
      totals: { views: 12 },
    });
    expect(data.rows[0]).toMatchObject({
      id,
      channelId: null,
      contentItemId: null,
      archived: true,
      platform: "vk",
      canRefresh: false,
    });
    expect(data.channels[0]).toMatchObject({ id: null, archived: true, canCollectMetrics: false });
    await owner.agent
      .get(endpoint(owner))
      .query({ ...period, channelId: owner.channelId })
      .expect(404);
  });

  it("exports the complete cohort with maintained CSV quoting, formula protection and explicit unknowns", async () => {
    const owner = await fixture();
    const id = await receipt(owner, "2026-09-15T00:00:00Z");
    await db
      .insert(schema.publicationMetrics)
      .values({ orgId: owner.orgId, publicationId: id, status: "available", views: 0 });
    await receipt(owner, "2026-09-14T00:00:00Z");
    const response = await owner.agent
      .get(`${endpoint(owner)}.csv`)
      .query({ ...period, limit: 1 })
      .expect(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("pubrick-publication-results.csv");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.text).toContain(id);
    expect(response.text).toContain("'=SUM(1,2)");
    expect(response.text).toContain("'=HYPERLINK");
    expect(response.text).toContain("not_collected");
    expect(response.text).toContain("not_collected,,false,,,,");
    expect(response.text.split("\n").filter(Boolean)).toHaveLength(3);
    expect(response.text).not.toContain("credentials");
    await owner.agent
      .get(`${endpoint(owner)}.csv`)
      .query({ ...period, cursor: "page" })
      .expect(400);
  });

  it("uses inclusive from and exclusive to in both adjacent publication cohorts", async () => {
    const owner = await fixture();
    const lower = await receipt(owner, period.from);
    await receipt(owner, period.to);
    await receipt(owner, "2026-08-02T00:00:00.000Z");
    await receipt(owner, "2026-08-01T23:59:59.999Z");
    const data = publicationResultsPageSchema.parse(
      (await owner.agent.get(endpoint(owner)).query(period).expect(200)).body,
    );
    expect(data.rows.map((row) => row.id)).toEqual([lower]);
    expect(data.summary.publishedCount).toBe(1);
    expect(data.previous.summary.publishedCount).toBe(1);
    expect(data.summary.totals).toEqual({ views: null, likes: null, comments: null, shares: null });
    expect(data.summary.observedCounts).toEqual({ views: 0, likes: 0, comments: 0, shares: 0 });
  });

  it("refuses an oversized whole-cohort CSV and still permits a bounded narrow period", async () => {
    const owner = await fixture();
    await db.execute(sql`insert into publications (org_id, brand_id, channel_name, channel_platform, status, created_at)
      select ${owner.orgId}, ${owner.brandId}::uuid, 'Archived', 'vk', 'published', '2026-09-15T00:00:00Z'::timestamptz
      from generate_series(1, 10001)`);
    const response = await owner.agent
      .get(`${endpoint(owner)}.csv`)
      .query(period)
      .expect(400);
    expect(response.body.code).toBe("invalid_request");
    expect(response.headers["content-disposition"]).toBeUndefined();
    const page = publicationResultsPageSchema.parse(
      (
        await owner.agent
          .get(endpoint(owner))
          .query({ ...period, limit: 1 })
          .expect(200)
      ).body,
    );
    expect(page.summary.publishedCount).toBe(10001);
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const empty = await owner.agent
      .get(`${endpoint(owner)}.csv`)
      .query({ ...period, to: "2026-09-14T00:00:00.000Z" })
      .expect(200);
    expect(empty.text.split("\n").filter(Boolean)).toHaveLength(1);
  });
});
