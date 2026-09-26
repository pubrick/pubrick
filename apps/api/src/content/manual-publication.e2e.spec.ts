import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb } from "@pubrick/db";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("manual publication e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
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

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `vc${uniq}@example.com`, password: "password1234", name: "VC editor" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `VC ${uniq}`, slug: `vc-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string };
  }

  async function draft(agent: request.Agent) {
    const brand = await agent.post("/api/brands").send({ name: "Editorial" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({ brandId: brand.body.id, platform: "vc_ru", name: "VC.ru" })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({
        brandId: brand.body.id,
        title: "A reviewed article",
        body: "The reviewed body.",
        channelIds: [channel.body.id],
      })
      .expect(201);
    return { itemId: item.body.id as string, adaptationId: item.body.adaptations[0].id as string };
  }

  it("does not undo manual approval before an off-platform result is recorded", async () => {
    const { agent } = await orgAgent();
    const { itemId } = await draft(agent);
    await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

    const refused = await agent.post(`/api/content/${itemId}/retract-approval`).expect(409);
    expect(refused.body.code).toBe("approval_retraction_delivery_started");
    const after = await agent.get(`/api/content/${itemId}`).expect(200);
    expect(after.body.status).toBe("approved");
    expect(after.body.adaptations[0].status).toBe("manual_ready");
  });

  it("leaves automatic delivery queued when another channel may be live manually", async () => {
    const { agent } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Mixed delivery" }).expect(201);
    const vc = await agent
      .post("/api/channels")
      .send({ brandId: brand.body.id, platform: "vc_ru", name: "VC.ru" })
      .expect(201);
    const telegram = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Telegram",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({
        brandId: brand.body.id,
        body: "Both destinations",
        channelIds: [vc.body.id, telegram.body.id],
      })
      .expect(201);
    const itemId = item.body.id as string;
    const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    expect(
      approved.body.adaptations.map((adaptation: { status: string }) => adaptation.status).sort(),
    ).toEqual(["manual_ready", "queued"]);

    const refused = await agent.post(`/api/content/${itemId}/retract-approval`).expect(409);
    expect(refused.body.code).toBe("approval_retraction_delivery_started");
    const after = await agent.get(`/api/content/${itemId}`).expect(200);
    expect(after.body.status).toBe("approved");
    expect(
      after.body.adaptations.map((adaptation: { status: string }) => adaptation.status).sort(),
    ).toEqual(["manual_ready", "queued"]);
  });

  it("requires approval, never enqueues a VC send, and records only a human-confirmed URL", async () => {
    const { agent, orgId } = await orgAgent();
    const { itemId, adaptationId } = await draft(agent);
    const endpoint = `/api/content/${itemId}/adaptations/${adaptationId}/manual-publication`;

    await agent.post(endpoint).send({ url: "https://vc.ru/marketing/123-review" }).expect(409);
    await agent
      .post(`/api/content/${itemId}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })
      .expect(400);

    const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.adaptations[0]).toMatchObject({
      status: "manual_ready",
      deliveryOutcome: "manual_ready",
    });

    const { db, pool } = createDb(url as string);
    try {
      const jobs = await db.execute(sql`
        select count(*)::int as n from pgboss.job
        where name = 'publish' and data::jsonb->>'adaptationId' = ${adaptationId}
      `);
      expect((jobs.rows[0] as { n: number }).n).toBe(0);
      const before = await db.execute(sql`
        select count(*)::int as n from publications
        where adaptation_id = ${adaptationId} and org_id = ${orgId}
      `);
      expect((before.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await pool.end();
    }

    for (const invalid of [
      "http://vc.ru/marketing/123",
      "https://vc.ru.evil.test/123",
      "https://vc.ru:444/123",
      "https://vc.ru/",
    ]) {
      await agent.post(endpoint).send({ url: invalid }).expect(400);
    }
    const confirmed = await agent
      .post(endpoint)
      .send({ url: "https://vc.ru/marketing/123-review" })
      .expect(200);
    expect(confirmed.body.status).toBe("published");
    expect(confirmed.body.adaptations[0]).toMatchObject({
      status: "published",
      externalUrl: "https://vc.ru/marketing/123-review",
      assertedByName: "VC editor",
    });
    expect(confirmed.body.adaptations[0].assertedAt).toEqual(expect.any(String));
    await agent.post(endpoint).send({ url: "https://vc.ru/marketing/123-review" }).expect(409);
  });

  it.each([
    ["dzen", "https://dzen.ru/a/reviewed-post"],
    ["instagram", "https://www.instagram.com/p/reviewed-post/"],
    ["youtube", "https://www.youtube.com/watch?v=reviewed"],
    ["rutube", "https://rutube.ru/video/reviewed-post/"],
    ["tenchat", "https://tenchat.ru/media/reviewed-post"],
    ["t_j", "https://t-j.ru/reviewed-post/"],
  ])(
    "prepares %s without a send and records only its confirmed link",
    async (platform, publicUrl) => {
      const { agent, orgId } = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "Manual brand" }).expect(201);
      const channel = await agent
        .post("/api/channels")
        .send({ brandId: brand.body.id, platform, name: platform })
        .expect(201);
      if (platform === "dzen") {
        // A pre-manual Dzen row can still hold encrypted credentials after the
        // additive migration. It must be treated as manual, never sent.
        const legacy = createDb(url as string);
        try {
          await legacy.db.execute(
            sql`update channels set credentials_encrypted = 'legacy-ciphertext' where org_id = ${orgId} and id = ${channel.body.id}`,
          );
        } finally {
          await legacy.pool.end();
        }
        const check = await agent.post(`/api/channels/${channel.body.id}/test`).expect(200);
        expect(check.body).toMatchObject({ ok: false });
        expect(JSON.stringify(check.body)).not.toContain("legacy-ciphertext");
      }
      const item = await agent
        .post("/api/content")
        .send({
          brandId: brand.body.id,
          title: "Reviewed title",
          body: "Reviewed body",
          channelIds: [channel.body.id],
        })
        .expect(201);
      const adaptationId = item.body.adaptations[0].id as string;
      const endpoint = `/api/content/${item.body.id}/adaptations/${adaptationId}/manual-publication`;
      const approved = await agent
        .post(`/api/content/${item.body.id}/approve`)
        .send({})
        .expect(200);
      expect(approved.body.adaptations[0].status).toBe("manual_ready");
      await agent.post(endpoint).send({ url: "https://vc.ru/post/on-wrong-platform" }).expect(400);
      if (platform === "t_j") {
        for (const invalid of [
          "http://t-j.ru/reviewed-post/",
          "https://t-j.ru.evil.test/reviewed-post/",
          "https://www.t-j.ru/reviewed-post/",
          "https://t-j.ru/",
        ]) {
          await agent.post(endpoint).send({ url: invalid }).expect(400);
        }
      }

      const { db, pool } = createDb(url as string);
      try {
        const jobs = await db.execute(
          sql`select count(*)::int as n from pgboss.job where name = 'publish' and data::jsonb->>'adaptationId' = ${adaptationId}`,
        );
        expect((jobs.rows[0] as { n: number }).n).toBe(0);
      } finally {
        await pool.end();
      }
      const confirmed = await agent.post(endpoint).send({ url: publicUrl }).expect(200);
      expect(confirmed.body.status).toBe("published");
      expect(confirmed.body.adaptations[0]).toMatchObject({
        status: "published",
        externalUrl: publicUrl,
        assertedByName: "VC editor",
      });
      const receipt = createDb(url as string);
      try {
        const rows = await receipt.db.execute(
          sql`select external_url, asserted_at from publications where org_id = ${orgId} and adaptation_id = ${adaptationId}`,
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]).toMatchObject({ external_url: publicUrl });
        expect(rows.rows[0]?.asserted_at).toBeTruthy();
      } finally {
        await receipt.pool.end();
      }
      await agent.post(endpoint).send({ url: publicUrl }).expect(409);
    },
  );

  it("lets the reviewer withdraw preparation, and keeps another org out", async () => {
    const { agent } = await orgAgent();
    const outsider = await orgAgent();
    const { itemId, adaptationId } = await draft(agent);
    const endpoint = `/api/content/${itemId}/adaptations/${adaptationId}/manual-publication`;
    await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    await outsider.agent.post(endpoint).send({ url: "https://vc.ru/123" }).expect(404);
    const rejected = await agent.post(`/api/content/${itemId}/reject`).send({}).expect(200);
    expect(rejected.body.adaptations[0].status).toBe("pending");
    await agent.post(endpoint).send({ url: "https://vc.ru/123" }).expect(409);
  });

  it("keeps a mixed fan-out pending until its automatic channel also publishes", async () => {
    const { agent } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Mixed channels" }).expect(201);
    const vc = await agent
      .post("/api/channels")
      .send({ brandId: brand.body.id, platform: "vc_ru", name: "VC.ru" })
      .expect(201);
    const telegram = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Telegram",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({
        brandId: brand.body.id,
        title: "Two destinations",
        body: "Reviewed for both destinations.",
        channelIds: [vc.body.id, telegram.body.id],
      })
      .expect(201);
    const vcAdaptation = item.body.adaptations.find(
      (adaptation: { channelId: string }) => adaptation.channelId === vc.body.id,
    );
    const telegramAdaptation = item.body.adaptations.find(
      (adaptation: { channelId: string }) => adaptation.channelId === telegram.body.id,
    );

    const approved = await agent.post(`/api/content/${item.body.id}/approve`).send({}).expect(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.adaptations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: vcAdaptation.id, status: "manual_ready" }),
        expect.objectContaining({ id: telegramAdaptation.id, status: "queued" }),
      ]),
    );

    const { db, pool } = createDb(url as string);
    try {
      const jobs = await db.execute(sql`
        select data::jsonb->>'adaptationId' as adaptation_id from pgboss.job
        where name = 'publish' and data::jsonb->>'adaptationId' in (${vcAdaptation.id}, ${telegramAdaptation.id})
      `);
      expect(jobs.rows.map((row) => (row as { adaptation_id: string }).adaptation_id)).toEqual([
        telegramAdaptation.id,
      ]);
    } finally {
      await pool.end();
    }

    const endpoint = `/api/content/${item.body.id}/adaptations/${vcAdaptation.id}/manual-publication`;
    const confirmed = await agent
      .post(endpoint)
      .send({ url: "https://vc.ru/marketing/123-mixed" })
      .expect(200);
    expect(confirmed.body.status).toBe("approved");
    expect(confirmed.body.adaptations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: vcAdaptation.id, status: "published" }),
        expect.objectContaining({ id: telegramAdaptation.id, status: "queued" }),
      ]),
    );
    await agent.post(endpoint).send({ url: "https://vc.ru/marketing/123-mixed" }).expect(409);
  });
});
