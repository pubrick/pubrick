import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { extract } from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceExportRepository } from "./export.repository";
import type { WorkspaceExportService } from "./export.service";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("workspace data export against PostgreSQL", () => {
  let connection: ReturnType<typeof createDb>;
  let repo: WorkspaceExportRepository;
  let service: WorkspaceExportService;
  let app: INestApplication;
  let apiPool: { end(): Promise<void> };
  let authenticatedUser: string;
  let cookie: string;
  const owner = randomUUID();
  const author = randomUUID();
  const outsider = randomUUID();
  const orgId = randomUUID();
  const otherOrg = randomUUID();
  const brandId = randomUUID();
  const itemId = randomUUID();
  const original = `retained-content-${randomUUID()}`;
  const forbiddenContent = `other-tenant-${randomUUID()}`;
  const secret = `provider-secret-${randomUUID()}`;
  let ciphertext: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl as string;
    process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("base64");
    process.env.APP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    connection = createDb(databaseUrl as string);
    for (const id of [owner, author, outsider])
      await connection.db
        .insert(schema.user)
        .values({ id, name: "Export fixture", email: `${id}@example.test`, emailVerified: true });
    await connection.db.insert(schema.organization).values([
      { id: orgId, name: "Export fixture", slug: orgId },
      { id: otherOrg, name: "Other export fixture", slug: otherOrg },
    ]);
    await connection.db.insert(schema.member).values([
      { id: randomUUID(), organizationId: orgId, userId: owner, role: "owner" },
      { id: randomUUID(), organizationId: orgId, userId: author, role: "author" },
      { id: randomUUID(), organizationId: otherOrg, userId: outsider, role: "owner" },
    ]);
    const otherBrand = randomUUID();
    await connection.db.insert(schema.brands).values([
      { id: brandId, orgId, name: "Main fixture" },
      { id: otherBrand, orgId: otherOrg, name: "Other fixture" },
    ]);
    await connection.db.insert(schema.contentItems).values([
      { id: itemId, orgId, brandId, body: original },
      { orgId: otherOrg, brandId: otherBrand, body: forbiddenContent },
    ]);
    ciphertext = encryptJson({ apiKey: secret }, process.env.APP_ENCRYPTION_KEY);
    await connection.db
      .insert(schema.aiCredentials)
      .values({ orgId, provider: "google", credentialsEncrypted: ciphertext });
    await connection.db.insert(schema.channels).values({
      orgId,
      brandId,
      platform: "telegram",
      name: "Credential fixture",
      credentialsEncrypted: ciphertext,
    });
    await connection.db
      .insert(schema.searchCredentials)
      .values({ orgId, folderId: "fixture", credentialsEncrypted: ciphertext });
    const repositoryModule = await import("./export.repository");
    const serviceModule = await import("./export.service");
    repo = new repositoryModule.WorkspaceExportRepository();
    service = new serviceModule.WorkspaceExportService(repo);
    const { AppModule } = await import("../app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    const signedUp = await request(app.getHttpServer())
      .post("/api/auth/sign-up/email")
      .send({
        email: `${randomUUID()}@example.test`,
        password: "Disposable-export-fixture-2026",
        name: "Export administrator",
      })
      .expect(200);
    authenticatedUser = signedUp.body.user.id;
    const cookies = signedUp.headers["set-cookie"] as string[] | undefined;
    const token = cookies?.find((value) => value.startsWith("better-auth.session_token="));
    if (!token) throw new Error("Missing export fixture session cookie");
    cookie = token.split(";")[0] as string;
    await connection.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: authenticatedUser,
      role: "admin",
    });
    await request(app.getHttpServer())
      .post("/api/auth/organization/set-active")
      .set("Cookie", cookie)
      .send({ organizationId: orgId })
      .expect(200);
    apiPool = (await import("../db")).pool;
  });

  afterAll(async () => {
    await app?.close();
    for (const id of [orgId, otherOrg])
      await connection?.db.delete(schema.organization).where(eq(schema.organization.id, id));
    for (const id of [owner, author, outsider, authenticatedUser].filter(Boolean))
      await connection?.db.delete(schema.user).where(eq(schema.user.id, id));
    await connection?.pool.end();
    await repo?.onModuleDestroy();
    await apiPool?.end();
  });

  it("refuses ordinary authors and owners from another tenant before reading export data", async () => {
    const signal = new AbortController().signal;
    for (const userId of [author, outsider])
      await expect(repo.withSnapshot(orgId, userId, signal, async () => "leaked")).rejects.toThrow(
        "Only workspace owners",
      );
  });

  it("serves a native manager download and rejects anonymous and downgraded users", async () => {
    await request(app.getHttpServer()).get("/api/workspace-data/export").expect(401);
    const response = await request(app.getHttpServer())
      .get("/api/workspace-data/export")
      .set("Cookie", cookie)
      .expect(200);
    expect(response.headers["content-type"]).toContain("application/gzip");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    await connection.db
      .update(schema.member)
      .set({ role: "author" })
      .where(eq(schema.member.userId, authenticatedUser));
    try {
      await request(app.getHttpServer())
        .get("/api/workspace-data/export")
        .set("Cookie", cookie)
        .expect(403);
    } finally {
      await connection.db
        .update(schema.member)
        .set({ role: "admin" })
        .where(eq(schema.member.userId, authenticatedUser));
    }
  });

  it("uses bounded native connection acquisition when an export pool is saturated", async () => {
    const bounded = createDb(databaseUrl as string, { max: 1, connectionTimeoutMillis: 100 });
    const held = await bounded.pool.connect();
    try {
      await expect(bounded.pool.connect()).rejects.toThrow("timeout");
    } finally {
      held.release();
      await bounded.pool.end();
    }
  });

  it("exports only the current tenant and excludes plaintext and encrypted provider credentials", async () => {
    const chunks: Buffer[] = [];
    const target = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await service.stream(orgId, owner, new AbortController().signal, () => target);
    const unpacked = extract();
    unpacked.end(gunzipSync(Buffer.concat(chunks)));
    const files = new Map<string, string>();
    for await (const stream of unpacked) {
      const bytes: Buffer[] = [];
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Invalid archive byte fixture");
        bytes.push(Buffer.from(chunk));
      }
      files.set(stream.header.name, Buffer.concat(bytes).toString());
    }
    const contents = [...files.values()].join("\n");
    expect(contents).toContain(original);
    expect(contents).not.toContain(forbiddenContent);
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain(ciphertext);
    expect(JSON.parse(files.get("manifest.json") ?? "null")).toMatchObject({
      complete: true,
      rowCounts: { contentItems: 1, aiCredentials: 1, channels: 1 },
    });
  });

  it("retains one consistent snapshot across concurrent edits and newly inserted content", async () => {
    const lateContent = `later-content-${randomUUID()}`;
    const exported = await repo.withSnapshot(
      orgId,
      owner,
      new AbortController().signal,
      async (snapshot) => {
        await connection.db
          .update(schema.contentItems)
          .set({ body: "new-body" })
          .where(eq(schema.contentItems.id, itemId));
        const [late] = await connection.db
          .insert(schema.contentItems)
          .values({ orgId, brandId, body: lateContent })
          .returning({ id: schema.contentItems.id });
        try {
          const policy = (await import("./export-policy")).WORKSPACE_EXPORT_TABLES.find(
            (value) => value.key === "contentItems",
          );
          if (!policy) throw new Error("Missing fixture export policy");
          const rows = [];
          for await (const row of snapshot.rows(policy)) rows.push(row);
          return rows;
        } finally {
          if (late)
            await connection.db
              .delete(schema.contentItems)
              .where(eq(schema.contentItems.id, late.id));
          await connection.db
            .update(schema.contentItems)
            .set({ body: original })
            .where(eq(schema.contentItems.id, itemId));
        }
      },
    );
    expect(exported).toEqual([expect.objectContaining({ id: itemId, body: original })]);
  });

  it("serializes same-tenant exports across producer instances and releases the transaction lease", async () => {
    await repo.withSnapshot(orgId, owner, new AbortController().signal, async () => {
      await expect(
        repo.withSnapshot(orgId, owner, new AbortController().signal, async () => undefined),
      ).rejects.toThrow("already running");
    });
    await expect(
      repo.withSnapshot(orgId, owner, new AbortController().signal, async () => "released"),
    ).resolves.toBe("released");
  });
});
