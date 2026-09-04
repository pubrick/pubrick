import { createCipheriv, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  decryptJson,
  encryptJson,
  isUnreadableCiphertext,
  UNREADABLE_CREDENTIALS_MESSAGE,
} from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { db as ApiDb } from "../db";
import type { env as ApiEnv } from "../env";
import type { ChannelsRepository as ChannelsRepositoryCtor } from "./channels.repository";

const url = process.env.TEST_DATABASE_URL;

/**
 * ONE EVENT, ONE ANSWER — driven, not asserted about a shared helper.
 *
 * A stored credential that no configured key can open used to produce four
 * different outcomes in four places: a clean verdict from the AI credential
 * Test, an HTTP 500 with a crypto stack trace from the channel connection test,
 * node's own "Unsupported state or unable to authenticate data" written onto an
 * adaptation where a screen prints it, and a sentence written for a human. This
 * file drives the two API surfaces with real ciphertext written under a key the
 * instance does not have, and asserts each one now names the event in the closed
 * set its own reader already understands. (The worker's two paths are driven the
 * same way in `apps/worker/src/publish/publish.e2e.spec.ts` and
 * `generate.service.spec.ts`.)
 *
 * It also drives the other half: this app boots on a ROTATED RING — the usual
 * test key in front, a second key behind it — so a row written under the demoted
 * key, and a row written before the versioned envelope existed at all, are both
 * still readable, and both get moved onto the active key as they are read.
 */

/** Active key: the value every other spec in this suite uses, so nothing else notices. */
const ACTIVE_KEY = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
/** The key this instance has rotated AWAY from — still in the ring, still readable. */
const DEMOTED_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
/** A key this instance has never had. Blobs under it are the one event. */
const FOREIGN_KEY = Buffer.from(new Uint8Array(32).fill(11)).toString("base64");
const RING = `${ACTIVE_KEY},${DEMOTED_KEY}`;

const CREDENTIALS = { botToken: "123:abc", chatId: "-1001234567890" };

/**
 * The format this product wrote before the envelope existed: `base64(iv || tag
 * || ciphertext)`, no version, no key id. Written out by hand rather than
 * imported, because the whole question is whether TODAY'S reader opens
 * YESTERDAY'S bytes — a helper shared with the reader could drift with it and
 * the test would still pass. (`crypto.test.ts` pins a frozen literal for the
 * same reason; this one needs arbitrary contents.)
 */
function legacyBlob(value: unknown, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

describe.skipIf(!url)("credential decryption e2e", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;
  let channels: InstanceType<typeof ChannelsRepositoryCtor>;
  let telegram: Server;
  let previousKey: string | undefined;
  /**
   * The api's OWN `env` and `db` bindings — the module instances the repository
   * closes over, fetched after `process.env.APP_ENCRYPTION_KEY` is set so they
   * are the ones booted on the ring. A static import at the top of this file
   * would evaluate `../env` before `beforeAll` runs and give the whole file a
   * different key than the app it is driving.
   */
  let apiEnv: typeof ApiEnv;
  let apiDb: typeof ApiDb;

  beforeAll(async () => {
    telegram = createServer((req, res) => {
      const method = (req.url ?? "").split("/").pop();
      const bodies: Record<string, unknown> = {
        getMe: { ok: true, result: { id: 42, username: "my_bot" } },
        getChat: { ok: true, result: { id: -1001234567890, type: "channel", title: "My Channel" } },
        getChatMember: { ok: true, result: { status: "administrator", can_post_messages: true } },
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(bodies[method ?? ""] ?? { ok: false, error_code: 400 }));
    });
    await new Promise<void>((resolve) => telegram.listen(0, resolve));
    process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${(telegram.address() as { port: number }).port}`;

    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    // Unconditional, unlike the `??=` every sibling spec uses: a ring is exactly
    // what this file is here to exercise. Its ACTIVE key is the one they all
    // use, so a file that runs later in the same fork and inherits this value
    // still writes and reads precisely what it did before; the previous value is
    // restored below regardless.
    previousKey = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = RING;

    // Migrations run once for the whole suite in vitest.global-setup.ts.
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    const { ChannelsRepository } = (await import("./channels.repository")) as {
      ChannelsRepository: typeof ChannelsRepositoryCtor;
    };
    channels = app.get(ChannelsRepository);
    ({ env: apiEnv } = await import("../env"));
    ({ db: apiDb } = await import("../db"));
    direct = createDb(url as string);
  });

  afterAll(async () => {
    await app.close();
    await direct.pool.end();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  });

  async function orgAgent(): Promise<{ agent: request.Agent; orgId: string }> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `u${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return { agent, orgId: created.body.id as string };
  }

  /** A brand and a channel whose stored blob is exactly `blob`. */
  async function channelHolding(
    agent: request.Agent,
    blob: string,
  ): Promise<{ id: string; updatedAt: Date }> {
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const created = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: CREDENTIALS,
      })
      .expect(201);
    const id = created.body.id as string;
    const rows = await direct.db
      .update(schema.channels)
      .set({ credentialsEncrypted: blob })
      .where(eq(schema.channels.id, id))
      .returning({ updatedAt: schema.channels.updatedAt });
    return { id, updatedAt: rows[0]?.updatedAt as Date };
  }

  async function storedBlob(id: string): Promise<string> {
    const rows = await direct.db
      .select({
        credentialsEncrypted: schema.channels.credentialsEncrypted,
        updatedAt: schema.channels.updatedAt,
      })
      .from(schema.channels)
      .where(eq(schema.channels.id, id));
    return rows[0]?.credentialsEncrypted as string;
  }

  describe("a blob no configured key can open", () => {
    it("is a coded 409 from the channel connection test, not a 500 with a crypto stack", async () => {
      const { agent } = await orgAgent();
      const channel = await channelHolding(agent, encryptJson(CREDENTIALS, FOREIGN_KEY));

      const result = await agent.post(`/api/channels/${channel.id}/test`).send({}).expect(409);

      expect(result.body).toEqual({
        statusCode: 409,
        error: "Conflict",
        message: UNREADABLE_CREDENTIALS_MESSAGE,
        code: "unreadable_credentials",
      });
      // The sentence a screen used to print, and the key it was protecting.
      expect(JSON.stringify(result.body)).not.toMatch(/unable to authenticate data/i);
      expect(JSON.stringify(result.body)).not.toContain("123:abc");
    });

    it("is the AI credential path's own named verdict for the very same ciphertext", async () => {
      // The model this change was written against: the same event, driven
      // through the other credential store, still answers with a member of a
      // closed set that the web renders in four languages. Both are reached
      // before anything is asked of a provider or a platform.
      const { agent, orgId } = await orgAgent();
      await agent
        .put("/api/ai-credentials")
        .send({ provider: "google", apiKey: "some-api-key" })
        .expect(200);
      await direct.db
        .update(schema.aiCredentials)
        .set({ credentialsEncrypted: encryptJson({ apiKey: "k" }, FOREIGN_KEY) })
        .where(eq(schema.aiCredentials.orgId, orgId));

      const result = await agent.post("/api/ai-credentials/google/test").expect(200);
      expect(result.body).toEqual({ ok: false, reason: "unreadable_key" });
    });

    it("leaves the row exactly as it was — an unreadable blob is never rewritten", async () => {
      const { agent } = await orgAgent();
      const blob = encryptJson(CREDENTIALS, FOREIGN_KEY);
      const channel = await channelHolding(agent, blob);

      await agent.post(`/api/channels/${channel.id}/test`).send({}).expect(409);

      expect(await storedBlob(channel.id)).toBe(blob);
    });
  });

  describe("a rotated key ring", () => {
    it("reads a channel written under the key the instance rotated away from", async () => {
      const { agent } = await orgAgent();
      const channel = await channelHolding(agent, encryptJson(CREDENTIALS, DEMOTED_KEY));

      const result = await agent.post(`/api/channels/${channel.id}/test`).send({}).expect(200);
      expect(result.body).toEqual({ ok: true, account: "@my_bot", target: "My Channel" });
    });

    it("reads a channel written before the versioned envelope existed", async () => {
      // Every install that has ever run Pubrick has rows in this shape. A scheme
      // that needed them rewritten before it worked would break the product on
      // deploy.
      const { agent } = await orgAgent();
      const blob = legacyBlob(CREDENTIALS, ACTIVE_KEY);
      expect(blob).not.toContain(".");
      const channel = await channelHolding(agent, blob);

      const result = await agent.post(`/api/channels/${channel.id}/test`).send({}).expect(200);
      expect(result.body.ok).toBe(true);
    });

    it("moves a legacy row onto the active key as it reads it, without claiming the token was rotated", async () => {
      const { agent } = await orgAgent();
      const before = legacyBlob(CREDENTIALS, ACTIVE_KEY);
      const channel = await channelHolding(agent, before);

      await agent.post(`/api/channels/${channel.id}/test`).send({}).expect(200);

      const after = await storedBlob(channel.id);
      expect(after).not.toBe(before);
      expect(after.startsWith("p1.")).toBe(true);
      expect(decryptJson(after, ACTIVE_KEY)).toEqual(CREDENTIALS);
      // `updated_at` is the answer to "when was this channel's token last
      // rotated?" (PUBLIC_COLUMNS). Re-encrypting the SAME token is not that.
      const rows = await direct.db
        .select({ updatedAt: schema.channels.updatedAt })
        .from(schema.channels)
        .where(eq(schema.channels.id, channel.id));
      expect(rows[0]?.updatedAt).toEqual(channel.updatedAt);
    });

    it("moves a demoted-key row onto the active key, so the old key can eventually be dropped", async () => {
      const { agent } = await orgAgent();
      const channel = await channelHolding(agent, encryptJson(CREDENTIALS, DEMOTED_KEY));

      await agent.post(`/api/channels/${channel.id}/test`).send({}).expect(200);

      const after = await storedBlob(channel.id);
      // Readable by the ACTIVE key alone — which is what makes dropping the
      // demoted one safe once every row has moved.
      expect(decryptJson(after, ACTIVE_KEY)).toEqual(CREDENTIALS);
    });

    it("does not rewrite a row that is already on the active key", async () => {
      const { agent } = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
      const created = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Main",
          credentials: CREDENTIALS,
        })
        .expect(201);
      const before = await storedBlob(created.body.id);

      await agent.post(`/api/channels/${created.body.id}/test`).send({}).expect(200);

      // Byte-identical: the rewrap answers "nothing to do" from the envelope's
      // key id, without decrypting and without a write.
      expect(await storedBlob(created.body.id)).toBe(before);
    });

    it("never writes a rewrap over credentials installed since the blob was read", async () => {
      // The race this guards cannot be scheduled from outside — it lives between
      // the SELECT in `getDecryptedCredentials` and the UPDATE in
      // `rewrapIfStale` — so the stale value is handed in directly instead. If
      // the write did not match on the blob it actually decrypted, a rewrap of
      // the OLD ciphertext would silently restore a token the user had just
      // replaced.
      const { agent, orgId } = await orgAgent();
      const stale = encryptJson(CREDENTIALS, DEMOTED_KEY);
      const channel = await channelHolding(agent, stale);
      await agent
        .patch(`/api/channels/${channel.id}`)
        .send({ credentials: { botToken: "999:new", chatId: "-100999" } })
        .expect(200);
      const installed = await storedBlob(channel.id);

      await (
        channels as unknown as {
          rewrapIfStale(orgId: string, id: string, stored: string): Promise<void>;
        }
      ).rewrapIfStale(orgId, channel.id, stale);

      expect(await storedBlob(channel.id)).toBe(installed);
      expect(decryptJson(await storedBlob(channel.id), ACTIVE_KEY)).toEqual({
        botToken: "999:new",
        chatId: "-100999",
      });
    });

    it("writes new credentials under the ACTIVE key, never a trailing one", async () => {
      const { agent } = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
      const created = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Main",
          credentials: CREDENTIALS,
        })
        .expect(201);

      expect(decryptJson(await storedBlob(created.body.id), ACTIVE_KEY)).toEqual(CREDENTIALS);
    });
  });

  /**
   * The two things `getDecryptedCredentials` and `rewrapIfStale` promise in
   * prose and, until now, in prose only. Both mutations — deleting
   * `if (!isUnreadableCiphertext(error)) throw error`, and letting a failed
   * rewrap out instead of logging it — survived the whole suite.
   */
  describe("what a decrypt failure is NOT allowed to swallow or invent", () => {
    it("answers a BROKEN INSTANCE with a 500, never with a verdict about this org's row", async () => {
      // The mirror image of the defect this method replaced: a catch-all here
      // would take an operator's mistake about the whole install — or a genuine
      // bug in this method — and tell the org their stored credentials cannot be
      // read. A key that is not 32 bytes is a plain `Error` from `keyFromBase64`
      // precisely so it can be told apart, and this is the only place that
      // distinction is ever made.
      const { agent, orgId } = await orgAgent();
      const channel = await channelHolding(agent, encryptJson(CREDENTIALS, ACTIVE_KEY));
      const ring = apiEnv.APP_ENCRYPTION_KEY;

      let thrown: unknown;
      apiEnv.APP_ENCRYPTION_KEY = "dG9vLXNob3J0";
      try {
        try {
          await channels.getDecryptedCredentials(orgId, channel.id);
        } catch (error) {
          thrown = error;
        }
      } finally {
        apiEnv.APP_ENCRYPTION_KEY = ring;
      }

      // Rethrown untouched: the instance's sentence, not the row's, and not an
      // HTTP refusal of any kind.
      expect((thrown as Error | undefined)?.message).toMatch(/32 bytes/);
      expect(isUnreadableCiphertext(thrown)).toBe(false);
      expect((thrown as { getStatus?: () => number } | undefined)?.getStatus).toBeUndefined();
      expect(JSON.stringify(thrown ?? null)).not.toContain(UNREADABLE_CREDENTIALS_MESSAGE);

      // Control, same channel, ring restored: nothing about this row was ever wrong.
      await agent.post(`/api/channels/${channel.id}/test`).send({}).expect(200);
    });

    it("keeps the connection test green when the opportunistic rewrap cannot be written", async () => {
      // Best effort BY CONSTRUCTION. A rewrap that fails leaves a readable row on
      // an older key — exactly the state it was already in — so letting the
      // failure out would turn a working channel into a broken one for a reason
      // the operator cannot act on and did not ask about.
      const { agent, orgId } = await orgAgent();
      const stale = encryptJson(CREDENTIALS, DEMOTED_KEY);
      const channel = await channelHolding(agent, stale);
      const verdict = { ok: true, account: "@my_bot", target: "My Channel" };

      const update = vi.spyOn(apiDb, "update").mockImplementation(() => {
        throw new Error("could not write the rewrap");
      });
      try {
        expect(await channels.verify(orgId, channel.id)).toEqual(verdict);
        // The rewrap really was attempted — otherwise this test would pass on a
        // row that never needed one, which is the whole trap it exists to avoid.
        expect(update).toHaveBeenCalled();
      } finally {
        update.mockRestore();
      }

      // Untouched, and still on the key it was already readable under.
      expect(await storedBlob(channel.id)).toBe(stale);
      // And the next read moves it, now that writing works again: the failure
      // cost the rotation one attempt, not the channel.
      expect(await channels.verify(orgId, channel.id)).toEqual(verdict);
      expect(decryptJson(await storedBlob(channel.id), ACTIVE_KEY)).toEqual(CREDENTIALS);
    });
  });

  describe("the refusals that had no code", () => {
    it("names the channel 404 rather than leaving one English sentence untranslated", async () => {
      const { agent } = await orgAgent();
      const stranger = await orgAgent();
      const channel = await channelHolding(agent, encryptJson(CREDENTIALS, ACTIVE_KEY));

      for (const result of [
        await stranger.agent.post(`/api/channels/${channel.id}/test`).send({}).expect(404),
        await stranger.agent.patch(`/api/channels/${channel.id}`).send({ name: "x" }).expect(404),
        await stranger.agent.delete(`/api/channels/${channel.id}`).expect(404),
      ]) {
        expect(result.body.code).toBe("channel_not_found");
        expect(result.body.statusCode).toBe(404);
      }
    });

    it("names the brand 404 that a channel create refuses on", async () => {
      const { agent } = await orgAgent();
      const stranger = await orgAgent();
      const brand = await stranger.agent.post("/api/brands").send({ name: "B" }).expect(201);

      const result = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Main",
          credentials: CREDENTIALS,
        })
        .expect(404);
      expect(result.body.code).toBe("brand_not_found");
      // Refused before anything was written: no ciphertext left behind.
      const rows = await direct.db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(and(eq(schema.channels.brandId, brand.body.id), eq(schema.channels.name, "Main")));
      expect(rows).toHaveLength(0);
    });
  });
});
