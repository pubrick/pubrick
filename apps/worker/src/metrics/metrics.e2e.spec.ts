import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { schema } from "@pubrick/db";
import { encryptJson, VK_METRICS_QUEUE, type VkMetricsJob } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("automatic VK publication metrics", () => {
  let server: Server;
  let service: import("./metrics.service").MetricsService;
  let db: typeof import("../db")["db"];
  let pool: typeof import("../db")["pool"];
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  let brandId: string;
  let channelId: string;
  let publicationId: string;
  let calls = 0;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (req.url !== "/method/wall.getById") return void res.writeHead(404).end();
      calls++;
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const post = new URLSearchParams(Buffer.concat(chunks).toString()).get("posts");
      res.setHeader("content-type", "application/json");
      if (post === "-123_3")
        return void res.end(JSON.stringify({ error: { error_code: 5, error_msg: "Denied" } }));
      res.end(
        JSON.stringify({
          response: {
            items:
              post === "-123_2"
                ? [{ owner_id: -123, id: 2 }]
                : [{ owner_id: -123, id: 1, views: { count: 0 }, likes: { count: 4 } }],
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fake VK address");
    process.env.DATABASE_URL = url;
    process.env.VK_API_BASE_URL = `http://127.0.0.1:${address.port}/method`;
    process.env.APP_ENCRYPTION_KEY = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = await import("../db"));
    const { MetricsService } = await import("./metrics.service");
    service = new MetricsService();
    await db.insert(schema.organization).values([
      { id: orgId, name: "Metrics", slug: `metrics-${orgId}` },
      { id: otherOrgId, name: "Other", slug: `metrics-${otherOrgId}` },
    ]);
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Newsroom" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing brand");
    brandId = brand.id;
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "vk",
        name: "VK",
        credentialsEncrypted: encryptJson(
          { accessToken: "fake", groupId: "123" },
          process.env.APP_ENCRYPTION_KEY,
        ),
      })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing channel");
    channelId = channel.id;
    publicationId = await addPublication("1");
  });

  afterAll(async () => {
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
    if (pool) await pool.end();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function addPublication(externalId: string): Promise<string> {
    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Post", status: "published" })
      .returning({ id: schema.contentItems.id });
    if (!item) throw new Error("Missing item");
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({ orgId, contentItemId: item.id, channelId, status: "published" })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("Missing adaptation");
    const [publication] = await db
      .insert(schema.publications)
      .values({ orgId, adaptationId: adaptation.id, channelId, status: "published", externalId })
      .returning({ id: schema.publications.id });
    if (!publication) throw new Error("Missing publication");
    return publication.id;
  }

  function job(id = publicationId): VkMetricsJob {
    return { orgId, brandId, channelId, publicationId: id };
  }

  it("stays off by default and rejects a forged tenant or brand before calling VK", async () => {
    const sent: VkMetricsJob[] = [];
    const boss = {
      send: async (queue: string, payload: VkMetricsJob) => {
        expect(queue).toBe(VK_METRICS_QUEUE);
        sent.push(payload);
      },
    } as unknown as Parameters<typeof service.scan>[0];
    expect(await service.scan(boss)).toBe(0);
    await service.handle(job());
    expect(calls).toBe(0);
    await db
      .update(schema.channels)
      .set({ metricsAutoRefresh: true })
      .where(eq(schema.channels.id, channelId));
    expect(await service.scan(boss)).toBe(1);
    expect(sent).toEqual([job()]);
    await service.handle({ ...job(), orgId: otherOrgId });
    await service.handle({ ...job(), brandId: randomUUID() });
    expect(calls).toBe(0);
  });

  it("claims once under concurrency and preserves unknown counters and measured zero", async () => {
    await Promise.all([service.handle(job()), service.handle(job())]);
    expect(calls).toBe(1);
    const [metric] = await db
      .select({
        status: schema.publicationMetrics.status,
        views: schema.publicationMetrics.views,
        likes: schema.publicationMetrics.likes,
        comments: schema.publicationMetrics.comments,
      })
      .from(schema.publicationMetrics)
      .where(
        and(
          eq(schema.publicationMetrics.orgId, orgId),
          eq(schema.publicationMetrics.publicationId, publicationId),
        ),
      );
    expect(metric).toEqual({ status: "available", views: 0, likes: 4, comments: null });
    await service.handle(job());
    expect(calls).toBe(1);
    await db
      .update(schema.channels)
      .set({ metricsAutoRefresh: false })
      .where(eq(schema.channels.id, channelId));
    expect(
      await service.scan({
        send: async () => {
          throw new Error("disabled channel queued");
        },
      } as unknown as Parameters<typeof service.scan>[0]),
    ).toBe(0);
    await service.handle(job());
    expect(calls).toBe(1);
  });

  it("records unavailable and provider errors with null counters", async () => {
    await db
      .update(schema.channels)
      .set({ metricsAutoRefresh: true })
      .where(eq(schema.channels.id, channelId));
    const missingId = await addPublication("2");
    const errorId = await addPublication("3");
    await service.handle(job(missingId));
    await service.handle(job(errorId));
    const rows = await db
      .select({
        id: schema.publicationMetrics.publicationId,
        status: schema.publicationMetrics.status,
        views: schema.publicationMetrics.views,
      })
      .from(schema.publicationMetrics)
      .where(eq(schema.publicationMetrics.orgId, orgId));
    expect(rows.find((row) => row.id === missingId)).toMatchObject({
      status: "unavailable",
      views: null,
    });
    expect(rows.find((row) => row.id === errorId)).toMatchObject({ status: "error", views: null });
  });
});
