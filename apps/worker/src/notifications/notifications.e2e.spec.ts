import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("notification outbox", () => {
  let server: http.Server;
  let direct: ReturnType<typeof createDb>;
  let workerPool: ReturnType<typeof createDb>["pool"];
  let service: InstanceType<typeof import("./notifications.service").NotificationsService>;
  let enqueue: typeof import("./notifications.outbox").enqueueNotification;
  let orgId: string;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let responseMode: "ok" | "reset" = "ok";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString()) });
        if (responseMode === "reset") {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.WEB_ORIGIN = "https://pubrick.example";
    direct = createDb(url as string);
    workerPool = (await import("../db")).pool;
    ({ enqueueNotification: enqueue } = await import("./notifications.outbox"));
    const { NotificationsService } = await import("./notifications.service");
    service = new NotificationsService();
    orgId = `notify-e2e-${Date.now()}`;
    await direct.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Notify", slug: orgId, createdAt: new Date() });
    await direct.db.insert(schema.notificationSettings).values({
      orgId,
      enabled: true,
      draftReady: true,
      deliveryProblem: true,
      credentialsEncrypted: encryptJson(
        { botToken: "123:secret", chatId: "-10042" },
        process.env.APP_ENCRYPTION_KEY,
      ),
    });
  });

  afterAll(async () => {
    await direct?.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await direct?.pool.end();
    await workerPool?.end();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("commits one event per subject, sends no plaintext credentials through the outbox, and does not send twice", async () => {
    const subjectId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await direct.db.transaction(async (tx) => {
      await enqueue(tx, orgId, "draft_ready", subjectId, targetId);
      await enqueue(tx, orgId, "draft_ready", subjectId, targetId);
    });
    const events = await direct.db
      .select()
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.orgId, orgId));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("123:secret");
    await service.scan();
    await service.scan();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/bot123:secret/sendMessage");
    expect(requests[0]?.body).toEqual({
      chat_id: "-10042",
      text: "A new draft is ready for review.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open post", url: `https://pubrick.example/en/content/${targetId}` }],
        ],
      },
    });
    const [delivered] = await direct.db
      .select({ status: schema.notificationEvents.status })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.orgId, orgId));
    expect(delivered?.status).toBe("sent");
  });

  it("does not enqueue when disabled and skips an event disabled before delivery", async () => {
    const first = crypto.randomUUID();
    await direct.db.transaction((tx) =>
      enqueue(tx, orgId, "delivery_unknown", first, crypto.randomUUID()),
    );
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: false })
      .where(eq(schema.notificationSettings.orgId, orgId));
    await direct.db.transaction((tx) =>
      enqueue(tx, orgId, "delivery_failed", crypto.randomUUID(), crypto.randomUUID()),
    );
    await service.scan();
    expect(requests).toHaveLength(1);
    const events = await direct.db
      .select({ status: schema.notificationEvents.status })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.orgId, orgId));
    expect(events.map((event) => event.status).sort()).toEqual(["sent", "skipped"]);
  });

  it("keeps an interrupted send unconfirmed and never sends it again", async () => {
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: true })
      .where(eq(schema.notificationSettings.orgId, orgId));
    responseMode = "reset";
    const subjectId = crypto.randomUUID();
    await direct.db.transaction((tx) =>
      enqueue(tx, orgId, "delivery_unknown", subjectId, crypto.randomUUID()),
    );
    await service.scan();
    await service.scan();
    expect(requests).toHaveLength(2);
    const [event] = await direct.db
      .select({ status: schema.notificationEvents.status })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.subjectId, subjectId));
    expect(event?.status).toBe("attempted");
  });

  it("records a new alert when a later publication attempt fails", async () => {
    responseMode = "ok";
    const subjectId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await direct.db.transaction(async (tx) => {
      await enqueue(tx, orgId, "delivery_failed", subjectId, targetId, 1);
      await enqueue(tx, orgId, "delivery_failed", subjectId, targetId, 1);
      await enqueue(tx, orgId, "delivery_failed", subjectId, targetId, 2);
    });
    const events = await direct.db
      .select({ attempt: schema.notificationEvents.attempt })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.subjectId, subjectId));
    expect(events.map((event) => event.attempt).sort()).toEqual([1, 2]);
  });
});
