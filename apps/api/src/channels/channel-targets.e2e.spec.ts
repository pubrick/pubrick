import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { wordpressPublisher } from "@pubrick/integrations";
import { decryptJson } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const encryptionKey =
  process.env.APP_ENCRYPTION_KEY ?? "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
const credentials = {
  siteUrl: "https://NEWS.EXAMPLE.COM:443/creators",
  username: "content-editor",
  applicationPassword: "synthetic-original-application-password",
};
const canonicalTarget = "https://news.example.com/creators/";

describe.skipIf(!url)("saved channel destination e2e", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= encryptionKey;
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    direct = createDb(url as string);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (direct) await direct.pool.end();
  });

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const unique = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `target-${unique}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Target tests", slug: `target-${unique}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return { agent, orgId: created.body.id as string };
  }

  it.each([
    { ...credentials, siteUrl: "https://127.0.0.1/blog" },
    { ...credentials, username: "" },
  ])(
    "returns a coded invalid destination refusal and stores no channel",
    async (invalidCredentials) => {
      const { agent } = await orgAgent();
      const brand = await agent
        .post("/api/brands")
        .send({ name: "Invalid destination" })
        .expect(201);
      const result = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "wordpress",
          name: "Journal",
          credentials: invalidCredentials,
        })
        .expect(400);
      expect(result.body.code).toBe("invalid_request");
      expect((await agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200)).body).toEqual(
        [],
      );
    },
  );

  async function connectedChannel() {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Creators" }).expect(201);
    const created = await agent
      .post("/api/channels")
      .send({ brandId: brand.body.id, platform: "wordpress", name: "Journal", credentials })
      .expect(201);
    return {
      agent,
      orgId,
      brandId: brand.body.id as string,
      channelId: created.body.id as string,
      created,
    };
  }

  async function scheduledChannel() {
    const connected = await connectedChannel();
    const item = await connected.agent
      .post("/api/content")
      .send({
        brandId: connected.brandId,
        title: "Reviewed article title",
        body: "Reviewed content for the connected journal.",
        channelIds: [connected.channelId],
      })
      .expect(201);
    await connected.agent
      .post(`/api/content/${item.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString() })
      .expect(200);
    return { ...connected, adaptationId: item.body.adaptations[0].id as string };
  }

  async function storedChannel(orgId: string, channelId: string) {
    const [row] = await direct.db
      .select({
        name: schema.channels.name,
        connectionTarget: schema.channels.connectionTarget,
        credentialsEncrypted: schema.channels.credentialsEncrypted,
        updatedAt: schema.channels.updatedAt,
      })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, channelId)));
    if (!row?.credentialsEncrypted) throw new Error("Fixture must have encrypted credentials");
    return row;
  }

  async function deliverySnapshot(orgId: string, adaptationId: string) {
    const [adaptation] = await direct.db
      .select({
        status: schema.adaptations.status,
        attemptCount: schema.adaptations.attemptCount,
        scheduledAt: schema.adaptations.scheduledAt,
      })
      .from(schema.adaptations)
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)));
    const jobs = await direct.db.execute(
      sql`select id, state, start_after as "startAfter", data from pgboss.job
          where name = 'publish' and data->>'orgId' = ${orgId}
            and data->>'adaptationId' = ${adaptationId} order by id`,
    );
    expect(adaptation?.status).toBe("scheduled");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({ state: "created" });
    return { adaptation, jobs: jobs.rows };
  }

  it("returns the saved canonical installation without exposing its credentials", async () => {
    const f = await connectedChannel();
    expect(f.created.body.connectionTarget).toBe(canonicalTarget);
    expect(f.created.body.credentialsEncrypted).toBeUndefined();
    expect(f.created.body.credentials).toBeUndefined();
    const list = await f.agent.get(`/api/channels?brandId=${f.brandId}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: f.channelId, connectionTarget: canonicalTarget });
    expect(JSON.stringify([f.created.body, list.body])).not.toContain(
      credentials.applicationPassword,
    );
    expect(JSON.stringify([f.created.body, list.body])).not.toContain("credentialsEncrypted");
    expect(JSON.stringify([f.created.body, list.body])).not.toContain("applicationPassword");
    const stored = await storedChannel(f.orgId, f.channelId);
    expect(stored.connectionTarget).toBe(canonicalTarget);
    expect(stored.credentialsEncrypted).not.toContain(credentials.applicationPassword);
  });

  it("refuses a canonical target that grows beyond the storage bound without creating a channel", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Long target" }).expect(201);
    const prefix = "https://news.example.com/";
    const siteUrl = prefix + "a".repeat(2048 - prefix.length);
    const submitted = { ...credentials, siteUrl };
    expect(siteUrl).toHaveLength(2048);
    expect(wordpressPublisher.credentialsSchema.safeParse(submitted).success).toBe(true);
    await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "wordpress",
        name: "Too long",
        credentials: submitted,
      })
      .expect(400);
    const rows = await direct.db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.brandId, brand.body.id)));
    expect(rows).toEqual([]);
  });

  it("rotates a password for the same canonical subdirectory without changing scheduled work", async () => {
    const f = await scheduledChannel();
    const before = await storedChannel(f.orgId, f.channelId);
    const delivery = await deliverySnapshot(f.orgId, f.adaptationId);
    const replacement = {
      ...credentials,
      siteUrl: canonicalTarget,
      applicationPassword: "synthetic-rotated-application-password",
    };
    const rotated = await f.agent
      .patch(`/api/channels/${f.channelId}`)
      .send({ credentials: replacement })
      .expect(200);
    expect(rotated.body.connectionTarget).toBe(canonicalTarget);
    expect(JSON.stringify(rotated.body)).not.toContain(replacement.applicationPassword);
    const after = await storedChannel(f.orgId, f.channelId);
    expect(after.connectionTarget).toBe(before.connectionTarget);
    expect(after.credentialsEncrypted).not.toBe(before.credentialsEncrypted);
    expect(decryptJson(after.credentialsEncrypted as string, encryptionKey)).toEqual(replacement);
    expect(await deliverySnapshot(f.orgId, f.adaptationId)).toEqual(delivery);
  });

  it.each([
    ["another host", "https://another.example.com/creators/"],
    ["another installation path", "https://news.example.com/other/"],
    ["another port", "https://news.example.com:8443/creators/"],
  ])(
    "refuses %s without rotating secrets, renaming the channel or changing its job",
    async (_kind, siteUrl) => {
      const f = await scheduledChannel();
      const before = await storedChannel(f.orgId, f.channelId);
      const delivery = await deliverySnapshot(f.orgId, f.adaptationId);
      const refused = await f.agent
        .patch(`/api/channels/${f.channelId}`)
        .send({
          name: "Renamed with unsafe retarget",
          credentials: { ...credentials, siteUrl, applicationPassword: "synthetic-new-password" },
        })
        .expect(409);
      expect(refused.body.code).toBe("channel_target_changed");
      expect(JSON.stringify(refused.body)).not.toContain("synthetic-new-password");
      expect(await storedChannel(f.orgId, f.channelId)).toEqual(before);
      expect(await deliverySnapshot(f.orgId, f.adaptationId)).toEqual(delivery);
    },
  );

  it("refuses a foreign tenant before exposing the saved target or rotating credentials", async () => {
    const f = await scheduledChannel();
    const before = await storedChannel(f.orgId, f.channelId);
    const delivery = await deliverySnapshot(f.orgId, f.adaptationId);
    const outsider = await orgAgent();
    const refused = await outsider.agent
      .patch(`/api/channels/${f.channelId}`)
      .send({ credentials: { ...credentials, applicationPassword: "synthetic-foreign-password" } })
      .expect(404);
    expect(JSON.stringify(refused.body)).not.toContain(canonicalTarget);
    expect(await storedChannel(f.orgId, f.channelId)).toEqual(before);
    expect(await deliverySnapshot(f.orgId, f.adaptationId)).toEqual(delivery);
  });
});
