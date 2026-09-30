import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("worker tenant deletion lock order", () => {
  let database: ReturnType<typeof createDb>;
  let workerPool: { end(): Promise<void> };
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    database = createDb(url as string);
    workerPool = (await import("./db")).pool;
  });
  afterAll(async () => {
    await workerPool?.end();
    await database?.pool.end();
  });

  it.each(["generation", "RSS", "suggestions", "Autopilot", "publication", "publication sweep"])(
    "does not deadlock tenant deletion against %s completion",
    async (kind) => {
      const orgId = randomUUID();
      await database.db
        .insert(schema.organization)
        .values({ id: orgId, name: "Deletion", slug: orgId });
      const [brand] = await database.db
        .insert(schema.brands)
        .values({ orgId, name: "Brand" })
        .returning();
      if (!brand) throw new Error("Missing brand");
      const [channel] = await database.db
        .insert(schema.channels)
        .values({ orgId, brandId: brand.id, name: "Manual", platform: "vc_ru" })
        .returning();
      if (!channel) throw new Error("Missing channel");
      const [run] = await database.db
        .insert(schema.pipelineRuns)
        .values({
          orgId,
          brandId: brand.id,
          status: "running",
          activeJobId: "test#1",
          input: { kind: "brief", text: "Draft", channelIds: [channel.id] },
        })
        .returning();
      const [source] = await database.db
        .insert(schema.newsSources)
        .values({ orgId, brandId: brand.id, name: "RSS", url: "https://example.test/feed" })
        .returning();
      const [request] = await database.db
        .insert(schema.topicSuggestionRequests)
        .values({ orgId, brandId: brand.id, status: "running" })
        .returning();
      const [item] = await database.db
        .insert(schema.contentItems)
        .values({ orgId, brandId: brand.id, body: "Draft" })
        .returning();
      if (!run || !source || !request || !item) throw new Error("Missing fixture");
      const [adaptation] = await database.db
        .insert(schema.adaptations)
        .values({
          orgId,
          contentItemId: item.id,
          channelId: channel.id,
          status: "publishing",
          updatedAt: new Date(0),
        })
        .returning();
      if (!adaptation) throw new Error("Missing adaptation");
      await database.db
        .insert(schema.autopilotConfigs)
        .values({ orgId, brandId: brand.id, channelIds: [channel.id], enabled: true });
      const { GenerateRepository } = await import("./generate/generate.repository");
      const { RssRepository } = await import("./rss/rss.repository");
      const { SuggestionsRepository } = await import("./suggestions/suggestions.repository");
      const { AutopilotService } = await import("./autopilot/autopilot.service");
      const { PublishRepository } = await import("./publish/publish.repository");
      const deleter = await database.pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await deleter.query("BEGIN");
        const {
          rows: [connection],
        } = await deleter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (!connection) throw new Error("Missing backend");
        await deleter.query("SELECT id FROM organization WHERE id = $1 FOR UPDATE", [orgId]);
        const mutation =
          kind === "generation"
            ? new GenerateRepository().finish(orgId, run.id, "test#1", brand.id, {
                body: "Draft",
                adaptations: [{ channelId: channel.id, body: "Draft" }],
              })
            : kind === "RSS"
              ? new RssRepository().save(orgId, source.id, source.url, [
                  {
                    title: "News",
                    summary: "News",
                    url: "https://example.test/news",
                    publishedAt: null,
                  },
                ])
              : kind === "suggestions"
                ? new SuggestionsRepository().complete(
                    orgId,
                    brand.id,
                    request.id,
                    [{ title: "Topic", description: "Details", newsItemId: null }],
                    [],
                  )
                : kind === "Autopilot"
                  ? new AutopilotService().trigger({} as PgBoss, orgId, brand.id, undefined, {
                      jobId: randomUUID(),
                      startedAt: new Date(),
                    })
                  : kind === "publication"
                    ? new PublishRepository().markFailed(
                        orgId,
                        adaptation.id,
                        "Not delivered",
                        "platform_rejected",
                        { status: "publishing", attemptCount: 0 },
                      )
                    : new PublishRepository().sweepAbandoned();
        pending = mutation.catch((error: unknown) => error);
        let waiting = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const { rows } = await database.pool.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting",
            [connection.pid],
          );
          if (rows[0]?.waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await deleter.query("DELETE FROM organization WHERE id = $1", [orgId]);
        await deleter.query("COMMIT");
        expect(await pending).not.toBeInstanceOf(Error);
      } finally {
        await deleter.query("ROLLBACK");
        deleter.release();
        await pending;
        await database.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      }
    },
    15_000,
  );
});
