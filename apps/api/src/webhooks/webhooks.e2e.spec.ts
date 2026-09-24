import assert from "node:assert/strict";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, runMigrations, schema } from "@pubrick/db";
import { decryptJson } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("outgoing webhook management", () => {
  let app: INestApplication;
  let connection: ReturnType<typeof createDb>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    await runMigrations(url as string);
    connection = createDb(url as string);
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await connection?.pool.end();
  });

  async function owner() {
    const agent = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `webhook${suffix}@example.com`, password: "password1234", name: "Owner" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Webhooks ${suffix}`, slug: `webhooks-${suffix}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string };
  }

  it("keeps URL and secret encrypted, shows the secret once, scopes history, and resolves revocation", async () => {
    const { agent, orgId } = await owner();
    await agent
      .post("/api/webhooks")
      .send({ name: "Unsafe", url: "http://127.0.0.1/callback" })
      .expect(400);
    const created = await agent
      .post("/api/webhooks")
      .send({
        name: "Automation",
        url: "https://hooks.example.com/private-capability",
        onSucceeded: true,
        onFailed: true,
        onUnknown: true,
      })
      .expect(201);
    expect(created.headers["cache-control"]).toContain("no-store");
    expect(created.body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const subscriptionId = created.body.id as string;
    const listed = await agent.get("/api/webhooks").expect(200);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
    expect(JSON.stringify(listed.body)).not.toContain("private-capability");
    const [stored] = await connection.db
      .select({
        endpointEncrypted: schema.webhookSubscriptions.endpointEncrypted,
        secretEncrypted: schema.webhookSubscriptions.secretEncrypted,
      })
      .from(schema.webhookSubscriptions)
      .where(
        and(
          eq(schema.webhookSubscriptions.orgId, orgId),
          eq(schema.webhookSubscriptions.id, subscriptionId),
        ),
      );
    assert(stored);
    assert(process.env.APP_ENCRYPTION_KEY);
    expect(JSON.stringify(stored)).not.toContain("private-capability");
    expect(JSON.stringify(stored)).not.toContain(created.body.secret);
    expect(
      decryptJson<{ url: string }>(stored.endpointEncrypted, process.env.APP_ENCRYPTION_KEY).url,
    ).toBe("https://hooks.example.com/private-capability");

    const [first] = await connection.db
      .insert(schema.publications)
      .values({ orgId, status: "failed" })
      .returning({ id: schema.publications.id });
    const [second] = await connection.db
      .insert(schema.publications)
      .values({ orgId, status: "unknown" })
      .returning({ id: schema.publications.id });
    if (!first || !second) throw new Error("Publication fixture missing");
    await connection.db
      .update(schema.webhookDeliveries)
      .set({ status: "attempting", attempts: 1 })
      .where(eq(schema.webhookDeliveries.publicationId, second.id));
    const foreign = await owner();
    await foreign.agent
      .post("/api/webhooks")
      .send({ name: "Foreign", url: "https://hooks.example.com/foreign" })
      .expect(201);
    const [foreignPublication] = await connection.db
      .insert(schema.publications)
      .values({ orgId: foreign.orgId, status: "failed" })
      .returning({ id: schema.publications.id });
    if (!foreignPublication) throw new Error("Foreign publication fixture missing");
    const history = await agent.get("/api/webhooks/deliveries").expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body.map((row: { publicationId: string }) => row.publicationId)).not.toContain(
      foreignPublication.id,
    );
    const foreignHistory = await foreign.agent.get("/api/webhooks/deliveries").expect(200);
    expect(foreignHistory.body.map((row: { publicationId: string }) => row.publicationId)).toEqual([
      foreignPublication.id,
    ]);
    expect(JSON.stringify(history.body)).not.toContain("private-capability");
    expect(JSON.stringify(history.body)).not.toContain(created.body.secret);

    await agent.delete(`/api/webhooks/${subscriptionId}`).expect(204);
    const after = await agent.get("/api/webhooks/deliveries").expect(200);
    expect(
      after.body.find((row: { publicationId: string }) => row.publicationId === first.id).status,
    ).toBe("failed");
    expect(
      after.body.find((row: { publicationId: string }) => row.publicationId === second.id).status,
    ).toBe("unknown");
    expect((await agent.get("/api/webhooks").expect(200)).body).toHaveLength(0);
  });

  it("enforces the ten-active-subscription cap under concurrent creates", async () => {
    const { agent } = await owner();
    const body = (index: number) => ({
      name: `Endpoint ${index}`,
      url: `https://hooks.example.com/path-${index}`,
      onSucceeded: true,
      onFailed: true,
      onUnknown: true,
    });
    for (let index = 0; index < 9; index++) {
      await agent.post("/api/webhooks").send(body(index)).expect(201);
    }
    const attempts = await Promise.all([
      agent.post("/api/webhooks").send(body(9)),
      agent.post("/api/webhooks").send(body(10)),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 400]);
    expect((await agent.get("/api/webhooks").expect(200)).body).toHaveLength(10);
  });
});
