import { randomBytes, randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TelegramRetentionRepository } from "./telegram-retention.repository";

const url = process.env.TEST_DATABASE_URL;
const hash = () => randomBytes(32).toString("hex");
describe.skipIf(!url)("native bounded Telegram retention", () => {
  let connection: ReturnType<typeof createDb>;
  let repository: TelegramRetentionRepository;
  const orgIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    connection = createDb(url as string, { max: 6 });
    const module = await import("./telegram-retention.repository");
    repository = new module.TelegramRetentionRepository();
  });
  afterAll(async () => {
    for (const orgId of orgIds)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await connection?.pool.end();
    await (await import("../db")).pool.end();
  });
  async function fixture(orgId: string = randomUUID()) {
    const userId = `synthetic-retention-${randomUUID()}`;
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Synthetic retention", slug: orgId });
    await connection.db
      .insert(schema.user)
      .values({ id: userId, name: "Synthetic Human", email: `${userId}@example.invalid` });
    const [bot] = await connection.db
      .insert(schema.telegramBotIdentities)
      .values({
        botId: String(BigInt(`0x${randomBytes(6).toString("hex")}`) + 1n),
        ownerOrgId: orgId,
      })
      .returning({ id: schema.telegramBotIdentities.id });
    if (!bot) throw new Error("Missing synthetic bot");
    const [binding] = await connection.db
      .insert(schema.telegramBindings)
      .values({
        orgId,
        userId,
        botIdentityId: bot.id,
        generation: 1,
        telegramUserId: "88001",
        privateChatId: "88001",
        state: "revoked",
        revokedAt: new Date(Date.now() - 30 * 86400000),
        createdAt: new Date(Date.now() - 31 * 86400000),
      })
      .returning({ id: schema.telegramBindings.id });
    if (!binding) throw new Error("Missing synthetic binding");
    return { orgId, userId, botId: bot.id, bindingId: binding.id };
  }
  async function challenge(
    f: Awaited<ReturnType<typeof fixture>>,
    days = 2,
    id: string = randomUUID(),
  ) {
    await connection.pool.query(
      `INSERT INTO telegram_binding_challenges
      (id,org_id,user_id,bot_identity_id,generation,code_hash,state,candidate_telegram_user_id,candidate_chat_id,candidate_display_name,created_at,claimed_at,expires_at)
      VALUES ($1,$2,$3,$4,1,$5,'awaiting_web_confirmation','88002','88002','Synthetic aged human',statement_timestamp()-$6*interval '1 day'-interval '2 minutes',statement_timestamp()-$6*interval '1 day'-interval '1 minute',statement_timestamp()-$6*interval '1 day'+interval '3 minutes')`,
      [id, f.orgId, f.userId, f.botId, hash(), days],
    );
    return id;
  }
  it("erases aged personal/token/replay rows and preserves fresh rows, revoked bindings and opaque audit", async () => {
    const f = await fixture();
    const oldChallenge = await challenge(f);
    const freshChallenge = await challenge(f, 0);
    const initial = randomUUID();
    const confirmation = randomUUID();
    const item = randomUUID();
    const brand = randomUUID();
    const snapshot = hash();
    await connection.pool.query(
      `INSERT INTO telegram_initial_capabilities
      (id,org_id,bot_identity_id,generation,content_item_id,brand_id,snapshot_hash,snapshot_version,token_hash,chat_id,message_id,state,send_state,send_attempted_at,terminal_at,created_at,expires_at)
      VALUES ($1,$2,$3,1,$4,$5,$6,'client-review-v1',$7,'88001','9','consumed','sent',statement_timestamp()-interval '8 days'+interval '1 minute',statement_timestamp()-interval '8 days'+interval '2 minutes',statement_timestamp()-interval '8 days',statement_timestamp()-interval '8 days'+interval '30 minutes')`,
      [initial, f.orgId, f.botId, item, brand, snapshot, hash()],
    );
    await connection.pool.query(
      `INSERT INTO telegram_actor_confirmations
      (id,org_id,user_id,binding_id,initial_capability_id,initial_expires_at,bot_identity_id,generation,content_item_id,brand_id,snapshot_hash,snapshot_version,token_hash,chat_id,message_id,state,send_state,send_attempted_at,terminal_at,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,initial.expires_at,$6,1,$7,$8,$9,'client-review-v1',$10,'88001','10','consumed','sent',initial.created_at+interval '1 minute',initial.created_at+interval '2 minutes',initial.created_at,initial.expires_at FROM telegram_initial_capabilities initial WHERE initial.id=$5`,
      [
        confirmation,
        f.orgId,
        f.userId,
        f.bindingId,
        initial,
        f.botId,
        item,
        brand,
        snapshot,
        hash(),
      ],
    );
    const audit = randomUUID();
    await connection.db.insert(schema.telegramDecisionAudit).values({
      id: audit,
      orgId: f.orgId,
      contentItemId: item,
      brandId: brand,
      actorUserId: f.userId,
      bindingId: f.bindingId,
      botIdentityId: f.botId,
      generation: 1,
      capabilityId: confirmation,
      updateId: "900",
      action: "reject",
      outcome: "rejected",
      snapshotHash: snapshot,
      snapshotVersion: "client-review-v1",
    });
    await connection.pool.query(
      `INSERT INTO telegram_update_receipts (org_id,bot_identity_id,update_id,generation,request_fingerprint,operation,outcome,actor_user_id,capability_id,decision_id,accepted_at)
      VALUES ($1,$2,'900',1,$3,'confirm_reject','accepted',$4,$5,$6,statement_timestamp()-interval '8 days'+interval '2 minutes')`,
      [f.orgId, f.botId, hash(), f.userId, confirmation, audit],
    );
    await connection.pool.query(
      `INSERT INTO telegram_update_receipts (org_id,bot_identity_id,update_id,generation,request_fingerprint,operation,outcome)
      VALUES ($1,$2,'901',1,$3,'binding_start','refused')`,
      [f.orgId, f.botId, hash()],
    );
    expect(await repository.sweepOrg(f.orgId)).toBe(4);
    expect(
      await connection.db
        .select({ id: schema.telegramBindingChallenges.id })
        .from(schema.telegramBindingChallenges)
        .where(eq(schema.telegramBindingChallenges.orgId, f.orgId)),
    ).toEqual([{ id: freshChallenge }]);
    expect(
      await connection.db
        .select({ id: schema.telegramInitialCapabilities.id })
        .from(schema.telegramInitialCapabilities)
        .where(eq(schema.telegramInitialCapabilities.id, initial)),
    ).toEqual([]);
    expect(
      await connection.db
        .select({ id: schema.telegramActorConfirmations.id })
        .from(schema.telegramActorConfirmations)
        .where(eq(schema.telegramActorConfirmations.id, confirmation)),
    ).toEqual([]);
    expect(
      await connection.db
        .select({ id: schema.telegramBindings.id })
        .from(schema.telegramBindings)
        .where(eq(schema.telegramBindings.id, f.bindingId)),
    ).toEqual([{ id: f.bindingId }]);
    expect(
      await connection.db
        .select({ id: schema.telegramDecisionAudit.id })
        .from(schema.telegramDecisionAudit)
        .where(eq(schema.telegramDecisionAudit.id, audit)),
    ).toEqual([{ id: audit }]);
    expect(
      await connection.db
        .select({ updateId: schema.telegramUpdateReceipts.updateId })
        .from(schema.telegramUpdateReceipts)
        .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId)),
    ).toEqual([{ updateId: "901" }]);
    expect(
      await connection.db
        .select({ id: schema.telegramBindingChallenges.id })
        .from(schema.telegramBindingChallenges)
        .where(eq(schema.telegramBindingChallenges.id, oldChallenge)),
    ).toEqual([]);
  });
  it("removes the oldest high-UUID personal row before a newer low-UUID backlog", async () => {
    const f = await fixture();
    const oldest = `ffffffff-${randomUUID().slice(9)}`;
    await challenge(f, 3, oldest);
    for (let index = 0; index < 100; index++)
      await challenge(f, 2, `00000000-${randomUUID().slice(9)}`);
    expect(await repository.sweepOrg(f.orgId)).toBe(100);
    const remaining = await connection.db
      .select({ id: schema.telegramBindingChallenges.id })
      .from(schema.telegramBindingChallenges)
      .where(eq(schema.telegramBindingChallenges.orgId, f.orgId));
    expect(remaining).toHaveLength(1);
    expect(remaining.some((row) => row.id === oldest)).toBe(false);
    expect(remaining[0]?.id.startsWith("00000000-")).toBe(true);
  });
  it("caps each tier at 100 and concurrent replicas neither double-delete nor leak locks", async () => {
    const f = await fixture();
    for (let index = 0; index < 101; index++) await challenge(f);
    const results = await Promise.all([repository.sweepOrg(f.orgId), repository.sweepOrg(f.orgId)]);
    expect(results.every((count) => count <= 100)).toBe(true);
    const left = await connection.db
      .select({ id: schema.telegramBindingChallenges.id })
      .from(schema.telegramBindingChallenges)
      .where(eq(schema.telegramBindingChallenges.orgId, f.orgId));
    expect(results.reduce((sum, count) => sum + count, 0) + left.length).toBe(101);
    expect(await repository.sweepOrg(f.orgId)).toBe(left.length);
  });
  it("skips a deleting organization parent and never waits on a child before that barrier", async () => {
    const f = await fixture();
    await challenge(f);
    const client = await connection.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM organization WHERE id=$1 FOR UPDATE", [f.orgId]);
      expect(await repository.sweepOrg(f.orgId)).toBe(0);
      await client.query("DELETE FROM organization WHERE id=$1", [f.orgId]);
      await client.query("COMMIT");
      expect(await repository.sweepOrg(f.orgId)).toBe(0);
      const [registry] = await connection.db
        .select({
          owner: schema.telegramBotIdentities.ownerOrgId,
          quarantined: schema.telegramBotIdentities.quarantined,
        })
        .from(schema.telegramBotIdentities)
        .where(eq(schema.telegramBotIdentities.id, f.botId));
      expect(registry).toEqual({ owner: null, quarantined: true });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("overlaps a user cascade without acquiring the user after ephemeral rows", async () => {
    const f = await fixture();
    await challenge(f);
    const client = await connection.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('DELETE FROM "user" WHERE id=$1', [f.userId]);
      // Uncommitted cascade locks the challenge; the janitor skips that child,
      // commits its parent/registry locks, and never requests the locked user.
      expect(await repository.sweepOrg(f.orgId)).toBe(0);
      await client.query("COMMIT");
      expect(await repository.sweepOrg(f.orgId)).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("rolls back the entire batch when a concurrent registry writer holds its parent", async () => {
    const f = await fixture();
    const id = await challenge(f);
    const client = await connection.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM telegram_bot_identities WHERE id=$1 FOR UPDATE", [
        f.botId,
      ]);
      await expect(repository.sweepOrg(f.orgId)).rejects.toThrow();
      const stillPresent = await connection.db
        .select({ id: schema.telegramBindingChallenges.id })
        .from(schema.telegramBindingChallenges)
        .where(eq(schema.telegramBindingChallenges.id, id));
      expect(stillPresent).toEqual([{ id }]);
      await client.query("COMMIT");
      expect(await repository.sweepOrg(f.orgId)).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("runs a real database batch from the background lifecycle and drains it before shutdown", async () => {
    const f = await fixture();
    const id = await challenge(f);
    expect(await repository.candidates()).toContain(f.orgId);
    const { TelegramRetentionLifecycle } = await import("./telegram-retention.lifecycle");
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const original = repository.sweepOrg.bind(repository);
    const spy = vi.spyOn(repository, "sweepOrg").mockImplementation(async (orgId) => {
      if (orgId === f.orgId) admitted();
      return original(orgId);
    });
    const lifecycle = new TelegramRetentionLifecycle(repository);
    try {
      lifecycle.onModuleInit();
      await started;
      await lifecycle.onModuleDestroy();
      const old = await connection.db
        .select({ id: schema.telegramBindingChallenges.id })
        .from(schema.telegramBindingChallenges)
        .where(eq(schema.telegramBindingChallenges.id, id));
      expect(old).toEqual([]);
    } finally {
      await lifecycle.onModuleDestroy();
      spy.mockRestore();
    }
  });
  it("preserves unresolved quarantined registry evidence throughout retention", async () => {
    const f = await fixture();
    await challenge(f);
    const attempt = randomUUID();
    const fingerprint = hash();
    await connection.pool.query(
      `UPDATE telegram_bot_identities SET remote_state='attempted',remote_mutation='install',remote_generation=1,request_fingerprint=$2,attempt_id=$3,unresolved_attempts=1,attempted_at=statement_timestamp() WHERE id=$1`,
      [f.botId, fingerprint, attempt],
    );
    await connection.pool.query(
      `INSERT INTO telegram_remote_attempts (id,bot_identity_id,generation,mutation,request_fingerprint) VALUES ($1,$2,1,'install',$3)`,
      [attempt, f.botId, fingerprint],
    );
    await connection.pool.query(
      `UPDATE telegram_remote_attempts SET outcome='unknown' WHERE id=$1`,
      [attempt],
    );
    await connection.pool.query(
      `UPDATE telegram_bot_identities SET remote_state='unknown',quarantined=true WHERE id=$1`,
      [f.botId],
    );
    expect(await repository.sweepOrg(f.orgId)).toBe(1);
    const [registry] = await connection.db
      .select({
        owner: schema.telegramBotIdentities.ownerOrgId,
        quarantined: schema.telegramBotIdentities.quarantined,
        state: schema.telegramBotIdentities.remoteState,
        unresolved: schema.telegramBotIdentities.unresolvedAttempts,
        fingerprint: schema.telegramBotIdentities.requestFingerprint,
      })
      .from(schema.telegramBotIdentities)
      .where(eq(schema.telegramBotIdentities.id, f.botId));
    expect(registry).toEqual({
      owner: f.orgId,
      quarantined: true,
      state: "unknown",
      unresolved: 1,
      fingerprint,
    });
    const [evidence] = await connection.db
      .select({ outcome: schema.telegramRemoteAttempts.outcome })
      .from(schema.telegramRemoteAttempts)
      .where(eq(schema.telegramRemoteAttempts.id, attempt));
    expect(evidence?.outcome).toBe("unknown");
  });
  it("admits an overdue organization beyond twenty locked parents and a large earlier backlog", async () => {
    const fixtures = [];
    for (let index = 0; index < 21; index++) {
      const f = await fixture();
      await challenge(f);
      fixtures.push(f);
    }
    fixtures.sort((left, right) => left.orgId.localeCompare(right.orgId));
    const available = fixtures[20];
    const oldest = fixtures[0];
    if (!available || !oldest) throw new Error("Missing bounded retention fixtures");
    // More than the former per-branch 2,000-row bound must not hide org 21.
    await connection.pool.query(
      `INSERT INTO telegram_binding_challenges
      (org_id,user_id,bot_identity_id,generation,code_hash,created_at,expires_at)
      SELECT $1,$2,$3,1,encode(sha256(($4 || series::text)::bytea),'hex'),
      statement_timestamp()-interval '3 days',statement_timestamp()-interval '3 days'+interval '5 minutes'
      FROM generate_series(1,2001) series`,
      [oldest.orgId, oldest.userId, oldest.botId, randomUUID()],
    );
    const lockedIds = fixtures.slice(0, 20).map((f) => f.orgId);
    const client = await connection.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM organization WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
        [lockedIds],
      );
      const selected = await repository.candidates();
      expect(selected.length).toBeLessThanOrEqual(20);
      expect(selected).toContain(available.orgId);
      expect(selected.filter((id) => lockedIds.includes(id))).toEqual([]);
      expect(await repository.sweepOrg(available.orgId)).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("advances the bounded organization cursor despite unchanged failing backlog", async () => {
    const fixtures = [];
    for (let index = 0; index < 21; index++) {
      const f = await fixture(
        `000-retention-cursor-${index.toString().padStart(2, "0")}-${randomUUID()}`,
      );
      await challenge(f);
      fixtures.push(f);
    }
    const { TelegramRetentionRepository } = await import("./telegram-retention.repository");
    const independent = new TelegramRetentionRepository();
    const first = await independent.candidates();
    expect(first).toHaveLength(20);
    const omitted = fixtures.filter((f) => !first.includes(f.orgId));
    expect(omitted.length).toBeGreaterThan(0);
    // No successful sweep: the first twenty tenants remain overdue, as with a
    // persistent registry writer failure. Selection must still advance next tick.
    const second = await independent.candidates();
    expect(second).toHaveLength(20);
    for (const f of omitted) expect(second).toContain(f.orgId);
    const [remaining] = await connection.pool
      .query(
        "SELECT count(*)::int AS count FROM telegram_binding_challenges WHERE org_id=ANY($1::text[])",
        [fixtures.map((f) => f.orgId)],
      )
      .then((result) => result.rows);
    expect(remaining?.count).toBe(21);
  });
});
