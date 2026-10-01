import { createHash, randomBytes, randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TelegramActorCandidate } from "./telegram-bound-actor";

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("Telegram bound editorial actor on native PostgreSQL", () => {
  let db: typeof import("../db")["db"];
  let pool: typeof import("../db")["pool"];
  let authorize: typeof import("./telegram-bound-actor")["authorizeTelegramBoundActor"];
  const orgs: string[] = [];
  const users: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    process.env.BETTER_AUTH_SECRET ??= "synthetic-bound-actor-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64");
    ({ db, pool } = await import("../db"));
    authorize = (await import("./telegram-bound-actor")).authorizeTelegramBoundActor;
  });
  afterAll(async () => {
    for (const id of orgs)
      await db.delete(schema.organization).where(eq(schema.organization.id, id));
    for (const id of users) await db.delete(schema.user).where(eq(schema.user.id, id));
    await pool?.end();
  });
  async function fixture(role = "editor", grant = true) {
    const orgId = `bound-org-${randomUUID()}`;
    const userId = `opaque-bound-user-${randomUUID()}`;
    orgs.push(orgId);
    users.push(userId);
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Synthetic", slug: orgId, createdAt: new Date() });
    await db.insert(schema.user).values({
      id: userId,
      name: "Synthetic",
      email: `${userId}@example.invalid`,
      emailVerified: true,
    });
    const memberId = randomUUID();
    await db.insert(schema.member).values({ id: memberId, userId, organizationId: orgId, role });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Synthetic" })
      .returning({ id: schema.brands.id });
    const [bot] = await db
      .insert(schema.telegramBotIdentities)
      .values({
        botId: String(BigInt(`0x${randomBytes(6).toString("hex")}`) + 1n),
        ownerOrgId: orgId,
        enabled: true,
      })
      .returning({ id: schema.telegramBotIdentities.id });
    if (!brand || !bot) throw new Error("Missing actor fixture");
    if (grant) await db.insert(schema.brandAccess).values({ orgId, brandId: brand.id, memberId });
    await db.insert(schema.telegramDecisionConfigs).values({
      orgId,
      botIdentityId: bot.id,
      state: "active",
      routeId: randomBytes(32).toString("base64url"),
      secretHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      credentialsEncrypted: "synthetic-unused",
      retryPayloadEncrypted: "synthetic-unused",
    });
    const [binding] = await db
      .insert(schema.telegramBindings)
      .values({
        orgId,
        userId,
        botIdentityId: bot.id,
        generation: 1,
        telegramUserId: "42",
        privateChatId: "42",
      })
      .returning({ id: schema.telegramBindings.id });
    if (!binding) throw new Error("Missing binding fixture");
    const candidate: TelegramActorCandidate = {
      orgId,
      userId,
      brandId: brand.id,
      bindingId: binding.id,
      botIdentityId: bot.id,
      generation: 1,
      telegramUserId: "42",
    };
    return { candidate, memberId };
  }
  const check = (candidate: TelegramActorCandidate) =>
    db.transaction((tx) => authorize(tx, candidate));
  it("uses current unioned editorial roles and brand grants without a session", async () => {
    for (const [role, grant, allowed] of [
      ["owner", false, true],
      ["admin", false, true],
      ["member", true, true],
      ["editor", true, true],
      ["author", true, false],
      ["author,member", true, true],
      ["editor", false, false],
      ["unknown", true, false],
    ] as const) {
      const f = await fixture(role, grant);
      expect(Boolean(await check(f.candidate)), `${role}/${grant}`).toBe(allowed);
    }
  });
  it("refuses stale actor and generation provenance and removed brand grants", async () => {
    const f = await fixture();
    expect(await check({ ...f.candidate, telegramUserId: "43" })).toBeNull();
    expect(await check({ ...f.candidate, generation: 2 })).toBeNull();
    expect(await check({ ...f.candidate, userId: "missing-user" })).toBeNull();
    await db
      .delete(schema.brandAccess)
      .where(
        and(
          eq(schema.brandAccess.orgId, f.candidate.orgId),
          eq(schema.brandAccess.memberId, f.memberId),
        ),
      );
    expect(await check(f.candidate)).toBeNull();
  });
  async function overlappingRevocation(kind: "role" | "binding") {
    const f = await fixture();
    let entered!: (pid: number) => void;
    let release!: () => void;
    const ready = new Promise<number>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decision = db.transaction(async (tx) => {
      const actor = await authorize(tx, f.candidate);
      expect(actor).toMatchObject({ userId: f.candidate.userId, privateChatId: "42" });
      const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      entered(Number(result.rows[0]?.pid));
      await held;
      return actor;
    });
    const ownerPid = await ready;
    const writer = await pool.connect();
    let revocation: Promise<unknown> | undefined;
    try {
      const { rows } = await writer.query("SELECT pg_backend_pid() AS pid");
      const writerPid = Number(rows[0].pid);
      revocation =
        kind === "role"
          ? writer.query("UPDATE member SET role = 'author' WHERE id = $1", [f.memberId])
          : writer.query(
              "UPDATE telegram_bindings SET state = 'revoked', revoked_at = clock_timestamp() WHERE id = $1",
              [f.candidate.bindingId],
            );
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await db.execute(
          sql`SELECT ${ownerPid} = ANY(pg_blocking_pids(${writerPid}::int)) AS blocked`,
        );
        if (result.rows[0]?.blocked === true) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked, "revocation must wait on the authorized transaction").toBe(true);
    } finally {
      release();
      await decision;
      await revocation;
      writer.release();
    }
    expect(await check(f.candidate)).toBeNull();
  }
  it("holds member role authority through commit and observes the next revocation", () =>
    overlappingRevocation("role"));
  it("holds the binding through commit and observes the next unlink", () =>
    overlappingRevocation("binding"));
});
