import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  type ApprovedJpegIdentity,
  encryptJson,
  type FrozenMetaPublicationInput,
  type MetaApplicationCredentials,
  type MetaConnectionProvider,
  type MetaMediaAccess,
  sealMetaMediaAccess,
} from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

function required<T>(value: T | undefined): T {
  if (!value) throw new Error("Expected retained Meta media fixture row");
  return value;
}

describe.skipIf(!url)(
  "approved Meta image capabilities (real database and media endpoints)",
  () => {
    let app: INestApplication;
    let direct: ReturnType<typeof createDb>;
    let mediaDir: string;
    let png: Buffer;
    let key: string;
    let activeApplications: Record<MetaConnectionProvider, MetaApplicationCredentials | undefined>;
    let originalApplications: typeof activeApplications;
    const application = { clientId: "123457", clientSecret: "synthetic-media-application-secret" };

    beforeAll(async () => {
      mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-meta-media-"));
      vi.stubEnv("MEDIA_STORAGE_DIR", mediaDir);
      vi.stubEnv("DATABASE_URL", url as string);
      vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
      vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
      for (const prefix of ["THREADS", "INSTAGRAM", "FACEBOOK", "LINKEDIN"]) {
        vi.stubEnv(`${prefix}_CLIENT_ID`, "");
        vi.stubEnv(`${prefix}_CLIENT_SECRET`, "");
      }
      // No OAuth or provider fixture is called. Only a synthetic saved application's
      // public lineage is enabled after the real app has booted without operator keys.
      const [{ AppModule }, { metaApplications, env }] = await Promise.all([
        import("../app.module"),
        import("../env"),
      ]);
      key = env.APP_ENCRYPTION_KEY;
      activeApplications = metaApplications;
      originalApplications = { ...metaApplications };
      activeApplications.instagram_native = application;
      const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication({ bodyParser: false });
      app.setGlobalPrefix("api");
      await app.init();
      await app.listen(0);
      direct = createDb(url as string);
      png = await sharp({
        create: { width: 640, height: 480, channels: 3, background: "#cc6600" },
      })
        .png()
        .toBuffer();
    });

    afterAll(async () => {
      if (activeApplications && originalApplications)
        Object.assign(activeApplications, originalApplications);
      if (app) await app.close();
      if (direct) await direct.pool.end();
      if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    async function fixture() {
      const agent = request.agent(app.getHttpServer());
      const unique = randomUUID();
      await agent
        .post("/api/auth/sign-up/email")
        .send({
          email: `meta-media-${unique}@example.com`,
          password: "Media-fixture-123!",
          name: "Editor",
        })
        .expect(200);
      const organization = await agent
        .post("/api/auth/organization/create")
        .send({ name: "Approved images", slug: `meta-media-${unique}` })
        .expect(200);
      const orgId = organization.body.id as string;
      await agent
        .post("/api/auth/organization/set-active")
        .send({ organizationId: orgId })
        .expect(200);
      const brand = await agent.post("/api/brands").send({ name: "Studio" }).expect(201);
      const brandId = brand.body.id as string;
      const upload = await agent
        .post(`/api/media?brandId=${brandId}`)
        .attach("file", png, { filename: "reviewed-cover.png", contentType: "image/png" })
        .expect(201);
      expect(upload.body).toMatchObject({ mimeType: "image/jpeg", width: 640, height: 480 });
      const mediaId = upload.body.id as string;
      const filePath = path.join(mediaDir, `${mediaId}.jpg`);
      const bytes = await readFile(filePath);
      const image: ApprovedJpegIdentity = {
        mediaId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: "image/jpeg",
        width: 640,
        height: 480,
        byteSize: bytes.length,
      };
      const clock = required(
        (await direct.db.execute<{ now: string }>(sql`select clock_timestamp() as now`)).rows[0],
      );
      const now = new Date(clock.now);
      // This is synthetic already-authorized provider state. Real authentication,
      // upload normalization, capability encryption and the anonymous route remain intact.
      const channelValues = {
        orgId,
        brandId,
        platform: "instagram_native" as const,
        name: "Studio native",
        credentialsEncrypted: encryptJson(
          { accessToken: "synthetic-media-token", accountId: "654321" },
          key,
        ),
        connectionTarget: "instagram:654321",
        connectionGeneration: 1,
        connectionApplicationId: application.clientId,
        connectionExpiresAt: new Date(now.getTime() + 3_600_000),
      };
      const channel = required(
        (
          await direct.db
            .insert(schema.channels)
            .values(channelValues)
            .returning({ id: schema.channels.id })
        )[0],
      );
      const itemValues = {
        orgId,
        brandId,
        title: "Reviewed image",
        body: "Reviewed caption.",
        coverMediaId: mediaId,
        status: "approved" as const,
      };
      const item = required(
        (
          await direct.db
            .insert(schema.contentItems)
            .values(itemValues)
            .returning({ id: schema.contentItems.id })
        )[0],
      );
      const adaptation = required(
        (
          await direct.db
            .insert(schema.adaptations)
            .values({
              orgId,
              contentItemId: item.id,
              channelId: channel.id,
              status: "publishing",
              attemptCount: 1,
            })
            .returning({ id: schema.adaptations.id })
        )[0],
      );
      const frozenInput: FrozenMetaPublicationInput = {
        version: 1,
        platform: "instagram_native",
        text: itemValues.body,
        image,
      };
      const inputHash = createHash("sha256").update(JSON.stringify(frozenInput)).digest("hex");
      const stage = required(
        (
          await direct.db
            .insert(schema.metaPublicationStages)
            .values({
              orgId,
              brandId,
              adaptationId: adaptation.id,
              contentItemId: item.id,
              channelId: channel.id,
              platform: "instagram_native",
              attempt: 1,
              inputHash,
              frozenInput,
              target: channelValues.connectionTarget,
              credentialGeneration: 1,
              phase: "preparation_intent",
              createdAt: now,
              preparationDeadline: new Date(now.getTime() + 180_000),
            })
            .returning({ id: schema.metaPublicationStages.id })
        )[0],
      );
      const claim: MetaMediaAccess = {
        purpose: "meta_preparation",
        stageId: stage.id,
        identity: {
          orgId,
          brandId,
          adaptationId: adaptation.id,
          channelId: channel.id,
          attempt: 1,
          inputHash,
          target: channelValues.connectionTarget,
          credentialGeneration: 1,
        },
        image,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      };
      return {
        orgId,
        brandId,
        channel,
        channelValues,
        item,
        itemValues,
        adaptation,
        stage,
        claim,
        bytes,
        filePath,
      };
    }

    type Fixture = Awaited<ReturnType<typeof fixture>>;
    function endpoint(f: Fixture, claim = f.claim, orgId = f.orgId) {
      return `/api/media/meta/${encodeURIComponent(orgId)}/${sealMetaMediaAccess(claim, key)}`;
    }
    async function available(f: Fixture) {
      // An actual successful request precedes every mutation so an unrelated fixture
      // refusal cannot stand in for the identity guard under review.
      const response = await request(app.getHttpServer()).get(endpoint(f)).expect(200);
      expect(response.body).toEqual(f.bytes);
      return response;
    }
    async function unavailable(url: string) {
      const response = await request(app.getHttpServer()).get(url).expect(404);
      expect(response.body.message).toBe("Approved image is unavailable");
      return response;
    }

    it("serves only the exact normalized reviewed bytes anonymously with non-cacheable image headers", async () => {
      const response = await available(await fixture());
      expect(response.headers["content-type"]).toMatch(/^image\/jpeg/);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-disposition"]).toBe("inline");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    });

    it.each(["content item", "channel"] as const)(
      "refuses an adaptation whose live %s differs from the retained stage",
      async (parent) => {
        const f = await fixture();
        await available(f);
        // No current API permits this reassignment. Plant an inconsistent live parent
        // beneath the endpoint to pin its own defence, with all other facts unchanged.
        if (parent === "content item") {
          const sibling = required(
            (
              await direct.db
                .insert(schema.contentItems)
                .values(f.itemValues)
                .returning({ id: schema.contentItems.id })
            )[0],
          );
          await direct.db
            .update(schema.adaptations)
            .set({ contentItemId: sibling.id })
            .where(eq(schema.adaptations.id, f.adaptation.id));
        } else {
          const sibling = required(
            (
              await direct.db
                .insert(schema.channels)
                .values(f.channelValues)
                .returning({ id: schema.channels.id })
            )[0],
          );
          await direct.db
            .update(schema.adaptations)
            .set({ channelId: sibling.id })
            .where(eq(schema.adaptations.id, f.adaptation.id));
        }
        await unavailable(endpoint(f));
      },
    );

    it("refuses a valid capability under another real tenant", async () => {
      const f = await fixture();
      await available(f);
      const foreign = await fixture();
      await unavailable(endpoint(f, f.claim, foreign.orgId));
      await available(f);
    });

    it.each(["expired", "future"] as const)(
      "refuses a correctly encrypted %s capability",
      async (time) => {
        const f = await fixture();
        await available(f);
        const now = Date.now();
        const claim = {
          ...f.claim,
          issuedAt: new Date(now + (time === "expired" ? -60_000 : 60_000)).toISOString(),
          expiresAt: new Date(now + (time === "expired" ? -1000 : 120_000)).toISOString(),
        };
        await unavailable(endpoint(f, claim));
        await available(f);
      },
    );

    it("refuses a capability whose authenticated claim differs from the stage hash", async () => {
      const f = await fixture();
      await available(f);
      await unavailable(
        endpoint(f, { ...f.claim, identity: { ...f.claim.identity, inputHash: "0".repeat(64) } }),
      );
      await available(f);
    });

    it("refuses changed file bytes of the same stored length", async () => {
      const f = await fixture();
      await available(f);
      const changed = Buffer.from(f.bytes);
      changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
      await writeFile(f.filePath, changed);
      await unavailable(endpoint(f));
    });

    it.each(["cancelled", "deadline", "generation", "expiry", "text", "attempt"] as const)(
      "refuses a capability after its current %s changes",
      async (change) => {
        const f = await fixture();
        await available(f);
        if (change === "cancelled")
          await direct.db
            .update(schema.metaPublicationStages)
            .set({ phase: "cancelled" })
            .where(eq(schema.metaPublicationStages.id, f.stage.id));
        if (change === "deadline")
          await direct.db
            .update(schema.metaPublicationStages)
            .set({
              createdAt: new Date(Date.now() - 120_000),
              preparationDeadline: new Date(Date.now() - 60_000),
            })
            .where(eq(schema.metaPublicationStages.id, f.stage.id));
        if (change === "generation")
          await direct.db
            .update(schema.channels)
            .set({ connectionGeneration: 2 })
            .where(eq(schema.channels.id, f.channel.id));
        if (change === "expiry")
          await direct.db
            .update(schema.channels)
            .set({ connectionExpiresAt: new Date(Date.now() - 1000) })
            .where(eq(schema.channels.id, f.channel.id));
        if (change === "text")
          await direct.db
            .update(schema.adaptations)
            .set({ body: "A different saved caption." })
            .where(eq(schema.adaptations.id, f.adaptation.id));
        if (change === "attempt")
          await direct.db
            .update(schema.adaptations)
            .set({ attemptCount: 2 })
            .where(eq(schema.adaptations.id, f.adaptation.id));
        await unavailable(endpoint(f));
      },
    );
  },
);
