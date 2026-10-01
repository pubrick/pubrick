import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createDb, hashEditorialSnapshot, readEditorialSnapshot, schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationsService } from "./notifications.service";
import type { TelegramInitialNotificationsRepository } from "./telegram-initial-notifications.repository";

const scripted = vi.hoisted(() => ({ initial: vi.fn(), legacy: vi.fn() }));
vi.mock("@pubrick/integrations", async (original) => ({
  ...(await original<typeof import("@pubrick/integrations")>()),
  createTelegramDecisionTransport: () => ({ sendInitialNotification: scripted.initial }),
  sendTelegramNotification: scripted.legacy,
}));
const url = process.env.TEST_DATABASE_URL;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
describe.skipIf(!url)("native durable initial Telegram draft notifications", () => {
  let connection: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let service: NotificationsService;
  let initial: TelegramInitialNotificationsRepository;
  let publishQueue: string;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 13).toString("base64");
    process.env.WEB_ORIGIN = "https://pubrick.example";
    connection = createDb(url as string);
    const repositoryModule = await import("./telegram-initial-notifications.repository");
    const serviceModule = await import("./notifications.service");
    initial = new repositoryModule.TelegramInitialNotificationsRepository();
    service = new serviceModule.NotificationsService(initial);
    boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", () => {});
    await boss.start();
    publishQueue = `telegram-initial-publish-${randomUUID()}`;
    await boss.createQueue(publishQueue);
  });
  beforeEach(() => {
    scripted.initial.mockReset().mockImplementation(async (_token, request) => ({
      status: "confirmed",
      value: { botId: request.botId, chatId: request.chatId, messageId: "890" },
    }));
    scripted.legacy.mockReset().mockResolvedValue("sent");
  });
  afterAll(async () => {
    await boss?.stop({ graceful: true });
    for (const orgId of orgIds)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    for (const userId of userIds)
      await connection.db.delete(schema.user).where(eq(schema.user.id, userId));
    await connection?.pool.end();
    await (await import("../db")).pool.end();
  });
  async function fixture(outboundOnly?: { botId: string; token: string; botIdentityId: string }) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Synthetic initial notification", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Synthetic Brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing brand fixture");
    const [channel] = await connection.db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "Synthetic channel",
        platform: "telegram",
        credentialsEncrypted: encryptJson(
          { botToken: "999:unused", chatId: "-10042" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing channel fixture");
    const [item] = await connection.db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId: brand.id,
        title: "Synthetic title",
        body: "Synthetic body",
        status: "draft",
        isSafeToDelete: true,
      })
      .returning({ id: schema.contentItems.id });
    if (!item) throw new Error("Missing item fixture");
    const [adaptation] = await connection.db
      .insert(schema.adaptations)
      .values({
        orgId,
        contentItemId: item.id,
        channelId: channel.id,
        status: "pending",
        body: "Synthetic adaptation",
      })
      .returning({ id: schema.adaptations.id });
    const [run] = await connection.db
      .insert(schema.pipelineRuns)
      .values({
        orgId,
        brandId: brand.id,
        contentItemId: item.id,
        status: "succeeded",
        input: { kind: "brief", text: "Synthetic", channelIds: [channel.id] },
      })
      .returning({ id: schema.pipelineRuns.id });
    if (!run || !adaptation) throw new Error("Missing scoped run/adaptation");
    const botId = outboundOnly?.botId ?? String(BigInt(`0x${randomBytes(6).toString("hex")}`) + 1n);
    const token = outboundOnly?.token ?? `${botId}:synthetic_token`;
    const [bot] = outboundOnly
      ? [{ id: outboundOnly.botIdentityId }]
      : await connection.db
          .insert(schema.telegramBotIdentities)
          .values({ botId, ownerOrgId: orgId, enabled: true })
          .returning({ id: schema.telegramBotIdentities.id });
    if (!bot) throw new Error("Missing bot fixture");
    await connection.db.insert(schema.notificationSettings).values({
      orgId,
      enabled: true,
      draftReady: true,
      credentialsEncrypted: encryptJson(
        { botToken: token, chatId: "-10042" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    if (!outboundOnly)
      await connection.db.insert(schema.telegramDecisionConfigs).values({
        orgId,
        botIdentityId: bot.id,
        state: "active",
        routeId: randomBytes(32).toString("base64url"),
        secretHash: randomBytes(32).toString("hex"),
        credentialsEncrypted: encryptJson(
          { botToken: token },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
        retryPayloadEncrypted: encryptJson(
          {
            botId,
            botUsername: "SyntheticBot",
            request: {
              url: "https://pubrick.example/api/telegram/synthetic",
              secret_token: "synthetic",
              allowed_updates: ["message", "callback_query"],
              drop_pending_updates: false,
              max_connections: 40,
            },
          },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      });
    const [event] = await connection.db
      .insert(schema.notificationEvents)
      .values({ orgId, event: "draft_ready", subjectId: run.id, targetId: item.id })
      .returning({ id: schema.notificationEvents.id });
    if (!event) throw new Error("Missing outbox fixture");
    return {
      orgId,
      brandId: brand.id,
      itemId: item.id,
      adaptationId: adaptation.id,
      botIdentityId: bot.id,
      botId,
      token,
      eventId: event.id,
      channelId: channel.id,
    };
  }
  async function capabilities(orgId: string) {
    return connection.db
      .select({
        id: schema.telegramInitialCapabilities.id,
        tokenHash: schema.telegramInitialCapabilities.tokenHash,
        snapshotHash: schema.telegramInitialCapabilities.snapshotHash,
        state: schema.telegramInitialCapabilities.state,
        sendState: schema.telegramInitialCapabilities.sendState,
        messageId: schema.telegramInitialCapabilities.messageId,
        expiresAt: schema.telegramInitialCapabilities.expiresAt,
        createdAt: schema.telegramInitialCapabilities.createdAt,
      })
      .from(schema.telegramInitialCapabilities)
      .where(eq(schema.telegramInitialCapabilities.orgId, orgId));
  }
  it("commits hash-only capability and attempted claim before one physical send", async () => {
    const f = await fixture();
    const snapshot = await readEditorialSnapshot(connection.db, f.orgId, f.itemId);
    if (!snapshot) throw new Error("Missing snapshot");
    scripted.initial.mockImplementationOnce(async (token, input) => {
      const [row] = await capabilities(f.orgId);
      expect(row).toMatchObject({
        state: "pending",
        sendState: "attempted",
        messageId: null,
        tokenHash: digest(input.rejectCallbackData.slice(3)),
        snapshotHash: hashEditorialSnapshot(snapshot),
      });
      expect(JSON.stringify(row)).not.toContain(input.rejectCallbackData.slice(3));
      expect(row && row.expiresAt.getTime() - row.createdAt.getTime()).toBe(30 * 60000);
      expect(token).toBe(f.token);
      expect(input).toMatchObject({
        botId: f.botId,
        chatId: "-10042",
        reviewUrl: `https://pubrick.example/en/content/${f.itemId}?intent=review`,
        rejectCallbackData: expect.stringMatching(/^ir:[A-Za-z0-9_-]{43}$/),
      });
      return { status: "confirmed", value: { botId: f.botId, chatId: "-10042", messageId: "890" } };
    });
    await service.scan(boss, publishQueue);
    await service.scan(boss, publishQueue);
    expect(scripted.initial).toHaveBeenCalledTimes(1);
    expect(scripted.legacy).not.toHaveBeenCalled();
    expect(await capabilities(f.orgId)).toMatchObject([
      { state: "pending", sendState: "sent", messageId: "890" },
    ]);
    const [item] = await connection.db
      .select({ status: schema.contentItems.status, opened: schema.contentItems.firstOpenedAt })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, f.itemId));
    expect(item).toEqual({ status: "draft", opened: null });
  });
  it("never falls back or retries an unknown durable send and records honest uncertainty", async () => {
    const f = await fixture();
    scripted.initial.mockResolvedValueOnce({ status: "unknown" });
    await service.scan(boss, publishQueue);
    await service.scan(boss, publishQueue);
    expect(scripted.initial).toHaveBeenCalledTimes(1);
    expect(scripted.legacy).not.toHaveBeenCalled();
    expect(await capabilities(f.orgId)).toMatchObject([{ sendState: "unknown", messageId: null }]);
    const [event] = await connection.db
      .select({
        status: schema.notificationEvents.status,
        reason: schema.notificationEvents.reason,
      })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.id, f.eventId));
    expect(event).toEqual({ status: "attempted", reason: "delivery_unconfirmed" });
  });
  it("revokes a rejected initial capability without a second URL send", async () => {
    const f = await fixture();
    scripted.initial.mockResolvedValueOnce({ status: "rejected" });
    await service.scan(boss, publishQueue);
    expect(await capabilities(f.orgId)).toMatchObject([
      { state: "revoked", sendState: "rejected" },
    ]);
    expect(scripted.legacy).not.toHaveBeenCalled();
  });
  it("uses legacy URLs for disabled interactive configuration and live SDK publication jobs", async () => {
    const disabled = await fixture();
    await connection.db
      .update(schema.telegramBotIdentities)
      .set({ enabled: false })
      .where(eq(schema.telegramBotIdentities.id, disabled.botIdentityId));
    const queued = await fixture();
    await boss.send(publishQueue, { orgId: queued.orgId, adaptationId: queued.adaptationId });
    const sdk = vi.spyOn(boss, "findJobs");
    await service.scan(boss, publishQueue);
    expect(scripted.initial).not.toHaveBeenCalled();
    expect(scripted.legacy).toHaveBeenCalledTimes(2);
    expect(await capabilities(disabled.orgId)).toEqual([]);
    expect(await capabilities(queued.orgId)).toEqual([]);
    expect(sdk).toHaveBeenCalledWith(
      publishQueue,
      expect.objectContaining({
        data: { orgId: queued.orgId, adaptationId: queued.adaptationId },
        db: expect.objectContaining({ executeSql: expect.any(Function) }),
      }),
    );
    const options = scripted.legacy.mock.calls[0]?.[2];
    expect(options.buttonRows[1][1]).toEqual({
      text: "Reject",
      url: expect.stringContaining("?intent=reject"),
    });
    sdk.mockRestore();
  });
  it("keeps a shared verified bot outbound-only in another organization with URL fallback", async () => {
    const owner = await fixture();
    const outbound = await fixture(owner);
    await service.scan(boss, publishQueue);
    expect(scripted.initial).toHaveBeenCalledTimes(1);
    expect(scripted.initial.mock.calls[0]?.[0]).toBe(owner.token);
    expect(scripted.initial.mock.calls[0]?.[1].reviewUrl).toContain(owner.itemId);
    expect(scripted.legacy).toHaveBeenCalledTimes(1);
    const [legacyCredentials, , options] = scripted.legacy.mock.calls[0] ?? [];
    expect(legacyCredentials).toEqual({ botToken: owner.token, chatId: "-10042" });
    expect(
      options.buttonRows
        .flat()
        .every(
          (button: { url?: string; callback_data?: string }) =>
            Boolean(button.url) && button.callback_data === undefined,
        ),
    ).toBe(true);
    expect(options.buttonRows[1][1]).toEqual({
      text: "Reject",
      url: expect.stringContaining(`${outbound.itemId}?intent=reject`),
    });
    expect(await capabilities(outbound.orgId)).toEqual([]);
    expect(await capabilities(owner.orgId)).toMatchObject([
      { state: "pending", sendState: "sent" },
    ]);
    const [registry] = await connection.db
      .select({
        owner: schema.telegramBotIdentities.ownerOrgId,
        enabled: schema.telegramBotIdentities.enabled,
        generation: schema.telegramBotIdentities.generation,
        quarantined: schema.telegramBotIdentities.quarantined,
      })
      .from(schema.telegramBotIdentities)
      .where(eq(schema.telegramBotIdentities.id, owner.botIdentityId));
    expect(registry).toEqual({
      owner: owner.orgId,
      enabled: true,
      generation: 1,
      quarantined: false,
    });
    const configs = await connection.db
      .select({
        orgId: schema.telegramDecisionConfigs.orgId,
        state: schema.telegramDecisionConfigs.state,
      })
      .from(schema.telegramDecisionConfigs)
      .where(eq(schema.telegramDecisionConfigs.botIdentityId, owner.botIdentityId));
    expect(configs).toEqual([{ orgId: owner.orgId, state: "active" }]);
    const events = await connection.db
      .select({ status: schema.notificationEvents.status })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.orgId, outbound.orgId));
    expect(events).toEqual([{ status: "sent" }]);
  });

  it("admits exactly one competing initial at 1999 combined live initial and private capabilities", async () => {
    const f = await fixture();
    const [secondItem] = await connection.db
      .insert(schema.contentItems)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        title: "Second quota draft",
        body: "Synthetic second body",
        status: "draft",
        isSafeToDelete: true,
      })
      .returning({ id: schema.contentItems.id });
    if (!secondItem) throw new Error("Missing second quota item");
    await connection.db.insert(schema.adaptations).values({
      orgId: f.orgId,
      contentItemId: secondItem.id,
      channelId: f.channelId,
      status: "pending",
      body: "Synthetic second adaptation",
    });
    const [secondRun] = await connection.db
      .insert(schema.pipelineRuns)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        contentItemId: secondItem.id,
        status: "succeeded",
        input: { kind: "brief", text: "Synthetic second", channelIds: [f.channelId] },
      })
      .returning({ id: schema.pipelineRuns.id });
    if (!secondRun) throw new Error("Missing second quota run");
    const [secondEvent] = await connection.db
      .insert(schema.notificationEvents)
      .values({
        orgId: f.orgId,
        event: "draft_ready",
        subjectId: secondRun.id,
        targetId: secondItem.id,
      })
      .returning({ id: schema.notificationEvents.id });
    if (!secondEvent) throw new Error("Missing second quota outbox");
    const snapshot = await readEditorialSnapshot(connection.db, f.orgId, f.itemId);
    if (!snapshot) throw new Error("Missing quota seed snapshot");
    const snapshotHash = hashEditorialSnapshot(snapshot);
    const now = new Date(),
      expiresAt = new Date(now.getTime() + 30 * 60000);
    const seeded = Array.from({ length: 1998 }, () => ({
      id: randomUUID(),
      orgId: f.orgId,
      botIdentityId: f.botIdentityId,
      generation: 1,
      contentItemId: f.itemId,
      brandId: f.brandId,
      snapshotHash,
      snapshotVersion: "client-review-v1",
      tokenHash: digest(randomUUID()),
      chatId: "-10042",
      createdAt: now,
      expiresAt,
    }));
    // Batch below PostgreSQL's bind-parameter limit; timestamps are inserted,
    // never rewritten around immutable source guards.
    for (let start = 0; start < seeded.length; start += 250)
      await connection.db
        .insert(schema.telegramInitialCapabilities)
        .values(seeded.slice(start, start + 250));
    const userId = randomUUID();
    userIds.push(userId);
    await connection.db
      .insert(schema.user)
      .values({ id: userId, name: "Synthetic quota actor", email: `${userId}@example.invalid` });
    const [binding] = await connection.db
      .insert(schema.telegramBindings)
      .values({
        orgId: f.orgId,
        userId,
        botIdentityId: f.botIdentityId,
        generation: 1,
        telegramUserId: "779",
        privateChatId: "779",
      })
      .returning({ id: schema.telegramBindings.id });
    if (!binding || !seeded[0]) throw new Error("Missing quota actor/initial parent");
    await connection.db.insert(schema.telegramActorConfirmations).values({
      orgId: f.orgId,
      userId,
      bindingId: binding.id,
      initialCapabilityId: seeded[0].id,
      initialExpiresAt: expiresAt,
      botIdentityId: f.botIdentityId,
      generation: 1,
      contentItemId: f.itemId,
      brandId: f.brandId,
      snapshotHash,
      snapshotVersion: "client-review-v1",
      tokenHash: digest(randomUUID()),
      chatId: "779",
      createdAt: now,
      expiresAt,
    });
    const live = async () =>
      (
        await connection.pool.query(
          `SELECT (SELECT count(*)::int FROM telegram_initial_capabilities WHERE org_id=$1 AND state='pending' AND expires_at>clock_timestamp()) AS initial, (SELECT count(*)::int FROM telegram_actor_confirmations WHERE org_id=$1 AND state='pending' AND expires_at>clock_timestamp()) AS private`,
          [f.orgId],
        )
      ).rows[0];
    expect(await live()).toEqual({ initial: 1998, private: 1 });
    let release!: () => void;
    const together = new Promise<void>((accept) => {
      release = accept;
    });
    const prepare = initial.prepare.bind(initial);
    const outcomes: Array<string | null> = [];
    let arrivals = 0;
    const spy = vi.spyOn(initial, "prepare").mockImplementation(async (...args) => {
      if (++arrivals === 2) release();
      await together;
      const result = await prepare(...args);
      outcomes.push(result?.capabilityId ?? null);
      return result;
    });
    try {
      // Each real scan claims a different committed outbox before the barrier;
      // both genuine prepare transactions then compete on the same registry.
      const scans = [service.scan(boss, publishQueue), service.scan(boss, publishQueue)];
      try {
        await vi.waitFor(() => expect(arrivals).toBe(2), { timeout: 3000, interval: 10 });
      } finally {
        release();
        await Promise.allSettled(scans);
      }
      await Promise.all(scans);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(new Set(spy.mock.calls.map((call) => call[1].id))).toEqual(
        new Set([f.eventId, secondEvent.id]),
      );
      expect(new Set(spy.mock.calls.map((call) => call[1].targetId))).toEqual(
        new Set([f.itemId, secondItem.id]),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(outcomes.filter((value) => value === null)).toHaveLength(1);
      expect(scripted.initial).toHaveBeenCalledTimes(1);
      expect(scripted.legacy).toHaveBeenCalledTimes(1);
      const options = scripted.legacy.mock.calls[0]?.[2];
      expect(options.buttonRows[1][1]).toEqual({
        text: "Reject",
        url: expect.stringContaining("?intent=reject"),
      });
      expect(
        options.buttonRows
          .flat()
          .every((button: { callback_data?: string }) => button.callback_data === undefined),
      ).toBe(true);
      expect(await live()).toEqual({ initial: 1999, private: 1 });
      const issued = await connection.db
        .select({
          id: schema.telegramInitialCapabilities.id,
          sendState: schema.telegramInitialCapabilities.sendState,
        })
        .from(schema.telegramInitialCapabilities)
        .where(
          and(
            eq(schema.telegramInitialCapabilities.orgId, f.orgId),
            eq(schema.telegramInitialCapabilities.sendState, "sent"),
          ),
        );
      expect(issued).toEqual([{ id: outcomes.find(Boolean), sendState: "sent" }]);
      const events = await connection.db
        .select({ status: schema.notificationEvents.status })
        .from(schema.notificationEvents)
        .where(eq(schema.notificationEvents.orgId, f.orgId));
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.status === "sent")).toBe(true);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("does not revive a capability revoked while the provider request is outstanding", async () => {
    const f = await fixture();
    scripted.initial.mockImplementationOnce(async () => {
      await connection.db
        .update(schema.telegramInitialCapabilities)
        .set({ state: "revoked", terminalAt: new Date() })
        .where(
          and(
            eq(schema.telegramInitialCapabilities.orgId, f.orgId),
            eq(schema.telegramInitialCapabilities.state, "pending"),
          ),
        );
      return { status: "confirmed", value: { botId: f.botId, chatId: "-10042", messageId: "890" } };
    });
    await service.scan(boss, publishQueue);
    expect(await capabilities(f.orgId)).toMatchObject([
      { state: "revoked", sendState: "attempted", messageId: null },
    ]);
    expect(scripted.legacy).not.toHaveBeenCalled();
  });
});
