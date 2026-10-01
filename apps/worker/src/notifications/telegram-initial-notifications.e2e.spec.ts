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
    await connection?.pool.end();
    await (await import("../db")).pool.end();
  });
  async function fixture() {
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
    const botId = String(BigInt(`0x${randomBytes(6).toString("hex")}`) + 1n);
    const token = `${botId}:synthetic_token`;
    const [bot] = await connection.db
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
