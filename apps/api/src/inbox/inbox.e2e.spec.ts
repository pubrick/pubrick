import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  encryptJson,
  inboxConversationPageDtoSchema,
  inboxDetailDtoSchema,
  inboxReplyDtoSchema,
  inboxReplyResolutionSchema,
  inboxReplySchema,
} from "@pubrick/shared";
import {
  DiscussionError,
  type DiscussionPage,
  type DiscussionReplyReceipt,
} from "@pubrick/telegram";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxTransport } from "./inbox.transport";

const url = process.env.TEST_DATABASE_URL;
const peerId = -1001234567890;
const at = new Date("2026-10-01T12:00:00Z");
const receipt = { messageId: 991, url: "https://t.me/discussion_test/991" };
const fixtureMessage = {
  messageId: 51,
  body: "x",
  bodyTruncated: false,
  publishedAt: at,
  editedAt: null,
};
function fixtureRow<T>(row: T | null | undefined): T {
  if (row == null) throw new Error("Expected populated fixture");
  return row;
}
const page: DiscussionPage = {
  peerId,
  rootId: 42,
  messages: [fixtureMessage],
  oldestId: 51,
  newestId: 51,
  hasMore: false,
};

describe.skipIf(!url)("supported Telegram inbox", () => {
  let app: INestApplication;
  let db: typeof import("../db").db;
  let owner: request.Agent;
  let orgId: string;
  let brandId: string;
  let channelId: string;
  let actorId: string;
  let accountId = 7;
  let collectPage = page;
  let creates = 0;
  let preflight: (() => Promise<void>) | null = null;
  let replyMode: "sent" | "unknown" | "accepted-write-failure" | "pending" = "sent";
  let completeCreate: ((receipt: DiscussionReplyReceipt) => void) | null = null;
  let createEntered: (() => void) | null = null;
  let collection: (() => Promise<DiscussionPage>) | null = null;
  let createSignal: AbortSignal | undefined;
  let applicationName: string;

  beforeAll(async () => {
    const scoped = new URL(url as string);
    applicationName = `inbox-${randomUUID()}`;
    scoped.searchParams.set("application_name", applicationName);
    process.env.DATABASE_URL = scoped.toString();
    process.env.TELEGRAM_API_ID = "123";
    process.env.TELEGRAM_API_HASH = "synthetic-telegram-app";
    const [{ AppModule }, database, { InboxTransport: Transport }] = await Promise.all([
      import("../app.module"),
      import("../db"),
      import("./inbox.transport"),
    ]);
    db = database.db;
    const transport = {
      account: async () => ({ id: accountId, label: `@fixture${accountId}` }),
      collect: async () => (collection ? collection() : collectPage),
      reply: async (_cipher: string, input: Parameters<InboxTransport["reply"]>[1]) => {
        if (preflight) await preflight();
        const create = async (signal?: AbortSignal): Promise<DiscussionReplyReceipt> => {
          creates++;
          createSignal = signal;
          if (replyMode === "pending") {
            createEntered?.();
            return new Promise((resolve) => {
              completeCreate = resolve;
            });
          }
          if (replyMode === "unknown") throw new DiscussionError("unavailable", true);
          return receipt;
        };
        if (replyMode === "accepted-write-failure") {
          creates++;
          throw new DiscussionError("unavailable", true, receipt);
        }
        return input.beforeSend({ id: accountId, label: `@fixture${accountId}` }, create);
      },
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Transport)
      .useValue(transport)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    const created = await organization();
    owner = created.agent;
    orgId = created.org;
    actorId = created.user;
    brandId = (await owner.post("/api/brands").send({ name: "Inbox fixture" }).expect(201)).body.id;
    channelId = (
      await owner
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Inbox channel",
          credentials: { botToken: "123:synthetic", chatId: "-1001234567890" },
        })
        .expect(201)
    ).body.id;
    await connect();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    creates = 0;
    preflight = null;
    replyMode = "sent";
    collectPage = page;
    collection = null;
    accountId = 7;
    completeCreate = null;
    createEntered = null;
    createSignal = undefined;
  });
  const base = () => `/api/brands/${brandId}/inbox`;
  async function organization() {
    const agent = request.agent(app.getHttpServer());
    const id = randomUUID();
    const signed = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${id}@example.com`, password: "Inbox-fixture-123!", name: "Inbox editor" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Inbox team", slug: `inbox-${id}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, org: org.body.id as string, user: signed.body.user.id as string };
  }
  async function connect() {
    const { env } = await import("../env");
    await db
      .insert(schema.telegramSourceAccounts)
      .values({
        orgId,
        sessionEncrypted: encryptJson(
          { session: `synthetic-${randomUUID()}` },
          env.APP_ENCRYPTION_KEY,
        ),
      })
      .onConflictDoUpdate({
        target: schema.telegramSourceAccounts.orgId,
        set: {
          sessionEncrypted: encryptJson(
            { session: `synthetic-${randomUUID()}` },
            env.APP_ENCRYPTION_KEY,
          ),
          connectedAt: new Date(),
        },
      });
  }
  async function fixture() {
    const item = await owner
      .post("/api/content")
      .send({
        brandId,
        title: "Saved publication",
        body: "Reviewed published text.",
        channelIds: [channelId],
      })
      .expect(201);
    const [publication] = await db
      .insert(schema.publications)
      .values({
        orgId,
        adaptationId: item.body.adaptations[0].id,
        channelId,
        status: "published",
        attempt: 1,
        externalId: "9",
        externalUrl: "https://t.me/pubrick_test/9",
      })
      .returning({ id: schema.publications.id });
    const conversation = await owner
      .post(`${base()}/collect`)
      .send({ publicationId: fixtureRow(publication).id })
      .expect(200);
    const path = `${base()}/${conversation.body.id}`;
    const detail = await owner.get(path).expect(200);
    return {
      publicationId: fixtureRow(publication).id,
      id: conversation.body.id as string,
      path,
      detail: inboxDetailDtoSchema.parse(detail.body),
    };
  }
  async function draft(f: Awaited<ReturnType<typeof fixture>>) {
    const preview = await owner.post(`${base()}/sender`).send({}).expect(200);
    return inboxReplySchema.parse({
      operationKey: randomUUID(),
      senderPreviewId: preview.body.id,
      messageId: fixtureRow(f.detail.messages.rows[0]).id,
      expectedMessageRevision: fixtureRow(f.detail.messages.rows[0]).revision,
      expectedMessageFingerprint: fixtureRow(f.detail.messages.rows[0]).reviewFingerprint,
      body: "Reviewed human answer.",
    });
  }
  async function stored(id: string) {
    return (
      await db
        .select({
          id: schema.inboxReplies.id,
          status: schema.inboxReplies.status,
          externalMessageId: schema.inboxReplies.externalMessageId,
          externalUrl: schema.inboxReplies.externalUrl,
        })
        .from(schema.inboxReplies)
        .where(eq(schema.inboxReplies.conversationId, id))
    ).at(-1);
  }

  it("keeps stable independent provider identities, short duplicate text, state and populated activity list", async () => {
    collectPage = { ...page, messages: [...page.messages, { ...fixtureMessage, messageId: 52 }] };
    const f = await fixture();
    expect((await owner.get(`${base()}/publications`).expect(200)).body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.publicationId, url: "https://t.me/pubrick_test/9" }),
      ]),
    );
    const ids = f.detail.messages.rows.map((m: { id: string }) => m.id);
    expect(f.detail.messages.rows.map((m: { body: string }) => m.body)).toEqual(["x", "x"]);
    expect(
      inboxConversationPageDtoSchema.parse(
        (await owner.get(`${base()}?filter=open`).expect(200)).body,
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.id,
          unread: true,
          lastActivityAt: expect.stringContaining("T"),
        }),
      ]),
    );
    await owner
      .post(`${f.path}/state`)
      .send({ action: "resolve", expectedActivityRevision: f.detail.conversation.activityRevision })
      .expect(200);
    expect(
      (await owner.get(`${base()}?filter=resolved`).expect(200)).body.rows.some(
        (r: { id: string }) => r.id === f.id,
      ),
    ).toBe(true);
    await owner.post(`${base()}/collect`).send({ publicationId: f.publicationId }).expect(200);
    expect(
      (await owner.get(f.path).expect(200)).body.messages.rows.map((m: { id: string }) => m.id),
    ).toEqual(ids);
    collectPage = {
      ...collectPage,
      messages: collectPage.messages.map((m) =>
        m.messageId === 52 ? { ...m, body: "edited", editedAt: new Date(at.getTime() + 1000) } : m,
      ),
    };
    await owner.post(`${base()}/collect`).send({ publicationId: f.publicationId }).expect(200);
    const updated = (await owner.get(f.path).expect(200)).body;
    expect(updated.conversation).toMatchObject({ unread: true, resolved: false });
    await owner
      .post(`${f.path}/state`)
      .send({ action: "read", expectedActivityRevision: f.detail.conversation.activityRevision })
      .expect(409);
    expect(
      await db
        .select({ id: schema.publicationCommentSamples.publicationId })
        .from(schema.publicationCommentSamples)
        .where(eq(schema.publicationCommentSamples.publicationId, f.publicationId)),
    ).toEqual([]);
  });
  it("pages normalized message IDs with a stable upper bound and rejects foreign cursors", async () => {
    collectPage = {
      ...page,
      messages: Array.from({ length: 25 }, (_, i) => ({
        ...fixtureMessage,
        messageId: 100 + i,
        body: `Message ${i}`,
      })),
      newestId: 124,
      oldestId: 100,
    };
    const f = await fixture();
    const first = f.detail.messages;
    expect(first.rows).toHaveLength(20);
    expect(fixtureRow(first.nextCursor)).toBeTruthy();
    const next = await owner
      .get(`${f.path}/messages?cursor=${encodeURIComponent(fixtureRow(first.nextCursor))}`)
      .expect(200);
    expect(next.body.rows).toHaveLength(5);
    expect(new Set([...first.rows, ...next.body.rows].map((m: { id: string }) => m.id)).size).toBe(
      25,
    );
    const forged = JSON.parse(Buffer.from(fixtureRow(first.nextCursor), "base64url").toString());
    forged.upper = 2_147_483_648;
    await owner
      .get(`${f.path}/messages?cursor=${Buffer.from(JSON.stringify(forged)).toString("base64url")}`)
      .expect(400);
    const other = await fixture();
    await owner
      .get(`${other.path}/messages?cursor=${encodeURIComponent(fixtureRow(first.nextCursor))}`)
      .expect(400);
    const org = await organization();
    await org.agent.get(f.path).expect(404);
    await org.agent
      .post(`${f.path}/replies`)
      .send(await draft(f))
      .expect(404);
    expect(creates).toBe(0);
  });
  it("pins activity paging before later collection and applies resolved filters before the limit", async () => {
    const f = await fixture();
    await db
      .insert(schema.inboxConversations)
      .values(
        Array.from({ length: 22 }, (_, i) => ({
          orgId,
          brandId,
          publicationId: randomUUID(),
          postUrl: "https://t.me/pubrick_test/9",
          title: `Discussion ${i}`,
          peerId,
          rootId: 200 + i,
          activityRevision: 1,
          resolvedRevision: i < 21 ? 1 : null,
        })),
      )
      .returning({ id: schema.inboxConversations.id })
      .then(async (rows) => {
        await db.insert(schema.inboxActivities).values(
          rows.map((row) => ({
            orgId,
            brandId,
            conversationId: row.id,
            activityAt: new Date(Date.now() + 1000),
          })),
        );
      });
    const all = await owner.get(`${base()}?filter=all`).expect(200);
    expect(all.body.rows).toHaveLength(20);
    expect(all.body.nextCursor).toBeTruthy();
    const forged = JSON.parse(Buffer.from(all.body.nextCursor, "base64url").toString());
    forged.window = "9999999999999999999";
    await owner
      .get(
        `${base()}?filter=all&cursor=${Buffer.from(JSON.stringify(forged)).toString("base64url")}`,
      )
      .expect(400);
    collectPage = {
      ...page,
      messages: [{ ...fixtureMessage, body: "New old-post reply", editedAt: new Date() }],
    };
    await owner.post(`${base()}/collect`).send({ publicationId: f.publicationId }).expect(200);
    const next = await owner
      .get(`${base()}?filter=all&cursor=${encodeURIComponent(all.body.nextCursor)}`)
      .expect(200);
    const ids = [...all.body.rows, ...next.body.rows].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(f.id);
    await owner
      .get(`${base()}?filter=open&cursor=${encodeURIComponent(all.body.nextCursor)}`)
      .expect(400);
    expect(
      (await owner.get(`${base()}?filter=resolved`).expect(200)).body.rows.every(
        (r: { resolved: boolean }) => r.resolved,
      ),
    ).toBe(true);
  });
  it("does not permit an API key to impersonate the human sender or read private inbox state", async () => {
    const f = await fixture();
    const input = await draft(f);
    const key = (
      await owner
        .post("/api/api-keys")
        .send({ name: "Inbox refusal fixture", scope: "content:create" })
        .expect(201)
    ).body.key;
    await request(app.getHttpServer())
      .get(f.path)
      .set("Authorization", `Bearer ${key}`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`${f.path}/replies`)
      .set("Authorization", `Bearer ${key}`)
      .send(input)
      .expect(401);
    expect(creates).toBe(0);
  });
  it("refuses a message from another conversation and a same-tenant foreign brand detail", async () => {
    const first = await fixture();
    const second = await fixture();
    const input = await draft(first);
    await owner.post(`${second.path}/replies`).send(input).expect(409);
    expect(creates).toBe(0);
    const otherBrand = (await owner.post("/api/brands").send({ name: "Foreign brand" }).expect(201))
      .body.id;
    await owner.get(`/api/brands/${otherBrand}/inbox/${first.id}`).expect(404);
  });
  it("records exact accepted receipt once, replays and refuses altered operation bodies", async () => {
    const f = await fixture();
    const input = await draft(f);
    const sent = await owner.post(`${f.path}/replies`).send(input).expect(200);
    expect(inboxReplyDtoSchema.parse(sent.body)).toMatchObject({
      status: "sent",
      externalMessageId: 991,
      externalUrl: receipt.url,
    });
    expect((await owner.post(`${f.path}/replies`).send(input).expect(200)).body.id).toBe(
      sent.body.id,
    );
    await owner
      .post(`${f.path}/replies`)
      .send({ ...input, body: "Different human text" })
      .expect(409);
    expect(creates).toBe(1);
    expect(await stored(f.id)).toMatchObject({ status: "sent", externalMessageId: 991 });
  });
  it("serializes simultaneous exact operation retries without a second provider create", async () => {
    const f = await fixture();
    const input = await draft(f);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    preflight = async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const original = owner
      .post(`${f.path}/replies`)
      .send(input)
      .expect(200)
      .then((result) => result);
    await ready;
    expect((await owner.post(`${f.path}/replies`).send(input).expect(200)).body.status).toBe(
      "sending",
    );
    release();
    expect((await original).body.status).toBe("sent");
    expect(creates).toBe(1);
  });
  it("refuses a simultaneous global operation reused across conversations without consuming the losing proof", async () => {
    const first = await fixture();
    const second = await fixture();
    const left = await draft(first);
    const right = { ...(await draft(second)), operationKey: left.operationKey };
    const holder = createDb(url as string);
    const connection = await holder.pool.connect();
    let attempts: Promise<request.Response>[] = [];
    try {
      await connection.query("begin");
      const pid = fixtureRow(
        (await connection.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0],
      ).pid;
      await connection.query(
        "select id from inbox_sender_previews where id=any($1::uuid[]) order by id for update",
        [[left.senderPreviewId, right.senderPreviewId]],
      );
      attempts = [
        owner
          .post(`${first.path}/replies`)
          .send(left)
          .then((result) => result),
        owner
          .post(`${second.path}/replies`)
          .send(right)
          .then((result) => result),
      ];
      // Both lookups must miss before either claim commits; observe from another connection, never the held transaction.
      await vi.waitFor(
        async () => {
          const waiting = await holder.pool.query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and $2::int=any(pg_blocking_pids(pid))",
            [applicationName, pid],
          );
          expect(fixtureRow(waiting.rows[0]).n).toBe(2);
        },
        { timeout: 5000, interval: 20 },
      );
      await connection.query("commit");
      const responses = await Promise.all(attempts);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const rejectedIndex = responses.findIndex((r) => r.status === 409);
      expect(fixtureRow(responses[rejectedIndex]).body.code).toBe("inbox_snapshot_changed");
      expect(creates).toBe(1);
      const losing =
        rejectedIndex === 0 ? { fixture: first, input: left } : { fixture: second, input: right };
      expect(await stored(losing.fixture.id)).toBeUndefined();
      const [proof] = await db
        .select({ consumedAt: schema.inboxSenderPreviews.consumedAt })
        .from(schema.inboxSenderPreviews)
        .where(eq(schema.inboxSenderPreviews.id, losing.input.senderPreviewId));
      expect(fixtureRow(proof).consumedAt).toBeNull();
    } finally {
      await connection.query("rollback");
      connection.release();
      await Promise.allSettled(attempts);
      await holder.pool.end();
    }
  });
  it("rejects an unseen body even if a raw writer did not advance its revision", async () => {
    const f = await fixture();
    const input = await draft(f);
    await db
      .update(schema.inboxMessages)
      .set({ body: "Unseen saved body" })
      .where(eq(schema.inboxMessages.id, input.messageId));
    const refused = await owner.post(`${f.path}/replies`).send(input).expect(409);
    expect(refused.body.code).toBe("inbox_message_changed");
    expect(creates).toBe(0);
  });
  it("refuses expired and consumed sender previews without another create", async () => {
    const f = await fixture();
    const input = await draft(f);
    await db
      .update(schema.inboxSenderPreviews)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.inboxSenderPreviews.id, input.senderPreviewId));
    await owner.post(`${f.path}/replies`).send(input).expect(409);
    expect(creates).toBe(0);
    const fresh = await draft(f);
    await owner.post(`${f.path}/replies`).send(fresh).expect(200);
    await owner
      .post(`${f.path}/replies`)
      .send({ ...fresh, operationKey: randomUUID() })
      .expect(409);
    expect(creates).toBe(1);
  });
  it("fences a stale collection response after a newer bounded read replaces its lease", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    collection = async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...page, messages: [{ ...fixtureMessage, body: "Stale response" }] };
    };
    const stale = owner
      .post(`${base()}/collect`)
      .send({ publicationId: f.publicationId })
      .expect(409)
      .then((result) => result);
    await ready;
    await owner.post(`${base()}/collect`).send({ publicationId: f.publicationId }).expect(409);
    await db
      .update(schema.inboxCollectionClaims)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.inboxCollectionClaims.publicationId, f.publicationId));
    collection = null;
    collectPage = { ...page, messages: [{ ...fixtureMessage, body: "New response" }] };
    await owner.post(`${base()}/collect`).send({ publicationId: f.publicationId }).expect(200);
    release();
    expect((await stale).body.code).toBe("inbox_snapshot_changed");
    expect((await owner.get(f.path).expect(200)).body.messages.rows[0].body).toBe("New response");
  });
  it("retains acceptance when the transport reports a post-create durable-write failure", async () => {
    const f = await fixture();
    const input = await draft(f);
    replyMode = "accepted-write-failure";
    const sent = await owner.post(`${f.path}/replies`).send(input).expect(200);
    expect(inboxReplyDtoSchema.parse(sent.body)).toMatchObject({
      status: "sent",
      externalMessageId: 991,
      externalUrl: receipt.url,
    });
    await owner.post(`${f.path}/replies`).send(input).expect(200);
    expect(creates).toBe(1);
  });
  it("refuses sender-generation ABA and saved-message edits immediately before create", async () => {
    const f = await fixture();
    const input = await draft(f);
    preflight = connect;
    const refused = await owner.post(`${f.path}/replies`).send(input).expect(200);
    expect(refused.body.status).toBe("failed");
    expect(creates).toBe(0);
    const f2 = await fixture();
    const input2 = await draft(f2);
    preflight = async () => {
      await db
        .update(schema.inboxMessages)
        .set({ body: "Unseen new message", revision: 1 })
        .where(eq(schema.inboxMessages.id, input2.messageId));
    };
    await owner.post(`${f2.path}/replies`).send(input2).expect(200);
    expect(creates).toBe(0);
  });
  it("rechecks a demoted role after network preflight and never creates", async () => {
    const f = await fixture();
    const input = await draft(f);
    preflight = async () => {
      await db
        .update(schema.member)
        .set({ role: "author" })
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorId)));
    };
    try {
      await owner.post(`${f.path}/replies`).send(input).expect(403);
      expect(creates).toBe(0);
    } finally {
      await db
        .update(schema.member)
        .set({ role: "owner" })
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorId)));
    }
  });
  it("rechecks an explicit editor brand grant after network preflight", async () => {
    const f = await fixture();
    const [member] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorId)));
    // The maintained role-change trigger deliberately removes old grants. Grant only after changing the role.
    await db
      .update(schema.member)
      .set({ role: "editor" })
      .where(eq(schema.member.id, fixtureRow(member).id));
    await db
      .insert(schema.brandAccess)
      .values({ orgId, brandId, memberId: fixtureRow(member).id })
      .onConflictDoNothing();
    try {
      const input = await draft(f);
      preflight = async () => {
        await db
          .delete(schema.brandAccess)
          .where(
            and(
              eq(schema.brandAccess.orgId, orgId),
              eq(schema.brandAccess.brandId, brandId),
              eq(schema.brandAccess.memberId, fixtureRow(member).id),
            ),
          );
      };
      await owner.post(`${f.path}/replies`).send(input).expect(403);
      expect(creates).toBe(0);
    } finally {
      await db
        .update(schema.member)
        .set({ role: "owner" })
        .where(eq(schema.member.id, fixtureRow(member).id));
      await db
        .delete(schema.brandAccess)
        .where(eq(schema.brandAccess.memberId, fixtureRow(member).id));
    }
  });
  it("rechecks session expiry after network preflight and records no create", async () => {
    const f = await fixture();
    const input = await draft(f);
    const sessions = await db
      .select({ id: schema.session.id, expiresAt: schema.session.expiresAt })
      .from(schema.session)
      .where(
        and(eq(schema.session.userId, actorId), eq(schema.session.activeOrganizationId, orgId)),
      );
    preflight = async () => {
      for (const session of sessions)
        await db
          .update(schema.session)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.session.id, session.id));
    };
    try {
      await owner.post(`${f.path}/replies`).send(input).expect(403);
      expect(creates).toBe(0);
    } finally {
      for (const session of sessions)
        await db
          .update(schema.session)
          .set({ expiresAt: session.expiresAt })
          .where(eq(schema.session.id, session.id));
    }
  });
  it.each(["session", "sender preview"] as const)(
    "aborts the locked create when the %s naturally expires",
    async (kind) => {
      const f = await fixture();
      const input = await draft(f);
      const sessions = await db
        .select({ id: schema.session.id, expiresAt: schema.session.expiresAt })
        .from(schema.session)
        .where(
          and(eq(schema.session.userId, actorId), eq(schema.session.activeOrganizationId, orgId)),
        );
      replyMode = "pending";
      preflight = async () => {
        if (kind === "session") {
          for (const session of sessions)
            await db
              .update(schema.session)
              .set({ expiresAt: sql`clock_timestamp() + interval '1 second'` })
              .where(eq(schema.session.id, session.id));
        } else
          await db
            .update(schema.inboxSenderPreviews)
            .set({ expiresAt: sql`clock_timestamp() + interval '1 second'` })
            .where(eq(schema.inboxSenderPreviews.id, input.senderPreviewId));
      };
      const started = Date.now();
      try {
        const pending = owner
          .post(`${f.path}/replies`)
          .send(input)
          .then((result) => result);
        await vi.waitFor(() => expect(creates).toBe(1), { timeout: 3000 });
        const response = await pending;
        expect(Date.now() - started).toBeLessThan(4000);
        // A naturally expired session also refuses the post-send read, while the durable exact claim remains unknown.
        expect(response.status).toBe(kind === "session" ? 403 : 200);
        expect(createSignal?.aborted).toBe(true);
        expect(await stored(f.id)).toMatchObject({ status: "unknown", externalMessageId: null });
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from inbox_conversations where id=${f.id}::uuid for update nowait`,
          );
        });
      } finally {
        for (const session of sessions)
          await db
            .update(schema.session)
            .set({ expiresAt: session.expiresAt })
            .where(eq(schema.session.id, session.id));
        // A real provider may still report acceptance after cancellation; preserve that exact late claim.
        completeCreate?.(receipt);
      }
      await vi.waitFor(
        async () =>
          expect(await stored(f.id)).toMatchObject({ status: "sent", externalMessageId: 991 }),
        { timeout: 5000 },
      );
      await owner.post(`${f.path}/replies`).send(input).expect(200);
      expect(creates).toBe(1);
    },
    10_000,
  );
  it("unknown blocks resend and requires original-account inspection plus exact unresolved receipt", async () => {
    const f = await fixture();
    const input = await draft(f);
    replyMode = "unknown";
    const unknown = (await owner.post(`${f.path}/replies`).send(input).expect(200)).body;
    expect(unknown.status).toBe("unknown");
    await owner
      .post(`${f.path}/replies`)
      .send({ ...input, operationKey: randomUUID() })
      .expect(409);
    expect(creates).toBe(1);
    const sender = (await owner.post(`${base()}/sender`).send({}).expect(200)).body;
    const resolution = inboxReplyResolutionSchema.parse({
      senderPreviewId: sender.id,
      expectedStatus: "unknown",
      outcome: "not_sent",
      inspectedProvider: true,
    });
    await owner.post(`${f.path}/replies/${unknown.id}/resolve`).send(resolution).expect(409);
    await db
      .update(schema.inboxReplies)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(schema.inboxReplies.id, unknown.id));
    await owner
      .post(`${f.path}/replies/${unknown.id}/resolve`)
      .send({ ...resolution, inspectedProvider: false })
      .expect(400);
    accountId = 8;
    const wrongSender = (await owner.post(`${base()}/sender`).send({}).expect(200)).body;
    await owner
      .post(`${f.path}/replies/${unknown.id}/resolve`)
      .send({ ...resolution, senderPreviewId: wrongSender.id })
      .expect(409);
    accountId = 7;
    await connect(); // Same sending identity, new session generation; explicit fresh inspection can recover.
    const reconnected = (await owner.post(`${base()}/sender`).send({}).expect(200)).body;
    const settled = await owner
      .post(`${f.path}/replies/${unknown.id}/resolve`)
      .send({ ...resolution, senderPreviewId: reconnected.id })
      .expect(200);
    expect(settled.body.status).toBe("confirmed_not_sent");
    await owner
      .post(`${f.path}/replies/${unknown.id}/resolve`)
      .send({ ...resolution, senderPreviewId: reconnected.id })
      .expect(409);
    await owner.post(`${f.path}/replies`).send(input).expect(200);
    expect(creates).toBe(1);
  });
  it("does not overwrite a later human settlement with late provider receipt completion", async () => {
    const f = await fixture();
    const input = await draft(f);
    replyMode = "unknown";
    const unknown = (await owner.post(`${f.path}/replies`).send(input).expect(200)).body;
    await db
      .update(schema.inboxReplies)
      .set({
        status: "confirmed_not_sent",
        finishedAt: new Date(),
        resolvedBy: actorId,
        resolvedAt: new Date(),
      })
      .where(eq(schema.inboxReplies.id, unknown.id));
    const { InboxRepository } = await import("./inbox.repository");
    const repo = app.get(InboxRepository);
    await (
      repo as unknown as {
        finish: (
          org: string,
          brand: string,
          id: string,
          claim: string,
          status: string,
          receipt: DiscussionReplyReceipt,
        ) => Promise<void>;
      }
    ).finish(orgId, brandId, f.id, unknown.id, "sent", receipt);
    expect(await stored(f.id)).toMatchObject({
      status: "confirmed_not_sent",
      externalMessageId: 991,
      externalUrl: receipt.url,
    });
    const enriched = (await owner.get(f.path).expect(200)).body.replies.find(
      (row: { id: string }) => row.id === unknown.id,
    );
    expect(enriched).toMatchObject({
      receiptContradiction: true,
      providerReceipts: [{ messageId: 991, url: receipt.url, receivedAt: expect.any(String) }],
    });
    expect(creates).toBe(1);
  });
  it("releases locked authority at the create deadline and retains late evidence on the original human verdict", async () => {
    const f = await fixture();
    const input = await draft(f);
    replyMode = "pending";
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    createEntered = entered;
    const original = owner
      .post(`${f.path}/replies`)
      .send(input)
      .expect(200)
      .then((result) => result);
    await ready;
    const unknown = (await original).body;
    expect(unknown.status).toBe("unknown");
    // NOWAIT is causal evidence that the never-settling SDK call no longer holds the conversation lock.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from inbox_conversations where id=${f.id}::uuid for update nowait`,
      );
    });
    await db
      .update(schema.inboxReplies)
      .set({
        status: "confirmed_not_sent",
        finishedAt: new Date(),
        resolvedBy: actorId,
        resolvedAt: new Date(),
      })
      .where(eq(schema.inboxReplies.id, unknown.id));
    completeCreate?.(receipt);
    await vi.waitFor(
      async () =>
        expect(await stored(f.id)).toMatchObject({
          status: "confirmed_not_sent",
          externalMessageId: 991,
        }),
      { timeout: 5000 },
    );
    const evidence = (await owner.get(f.path).expect(200)).body.replies.find(
      (row: { id: string }) => row.id === unknown.id,
    );
    expect(evidence.receiptContradiction).toBe(true);
    expect(evidence.providerReceipts).toHaveLength(1);
    await owner.post(`${f.path}/replies`).send(input).expect(200);
    expect(creates).toBe(1);
  }, 30_000);
  it("bounds receipt-recording lock contention and preserves the existing exact claim", async () => {
    const f = await fixture();
    const input = await draft(f);
    replyMode = "unknown";
    const unknown = (await owner.post(`${f.path}/replies`).send(input).expect(200)).body;
    const holder = createDb(url as string);
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = holder.db.transaction(async (tx) => {
      await tx.execute(sql`select id from inbox_conversations where id=${f.id}::uuid for update`);
      acquired();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    const { InboxRepository } = await import("./inbox.repository");
    const repo = app.get(InboxRepository);
    const start = Date.now();
    try {
      await expect(
        (
          repo as unknown as {
            finish: (
              org: string,
              brand: string,
              id: string,
              claim: string,
              status: string,
            ) => Promise<void>;
          }
        ).finish(orgId, brandId, f.id, unknown.id, "unknown"),
      ).rejects.toBeDefined();
      expect(Date.now() - start).toBeLessThan(10_000);
    } finally {
      release();
      await held;
      await holder.pool.end();
    }
    expect(await stored(f.id)).toMatchObject({ id: unknown.id, status: "unknown" });
  });
});
