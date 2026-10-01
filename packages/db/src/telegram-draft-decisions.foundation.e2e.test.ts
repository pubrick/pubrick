import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

const baseUrl = process.env.TEST_DATABASE_URL;
const hash = "a".repeat(64);
const code = "x".repeat(43);

describe.skipIf(!baseUrl)("Telegram draft decision foundation on native PostgreSQL", () => {
  let pool: pg.Pool;
  let database: string | undefined;
  beforeAll(async () => {
    if (!baseUrl) throw new Error("Missing disposable database URL");
    const parsed = new URL(baseUrl);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      !/^\/pubrick_.*_test$/.test(parsed.pathname)
    )
      throw new Error("Telegram foundation requires loopback disposable pubrick_*_test database");
    const name = `pubrick_telegram_foundation_${randomUUID().replaceAll("-", "")}_test`;
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      database = name;
    } finally {
      await admin.end();
    }
    parsed.pathname = `/${name}`;
    await runMigrations(parsed.toString());
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 4 });
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (!database) return;
    if (!/^pubrick_telegram_foundation_[a-f0-9]{32}_test$/.test(database))
      throw new Error("Unowned database");
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  async function insert(table: string, row: Record<string, unknown>) {
    const result = await pool.query(
      `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map((_, i) => `$${i + 1}`)
        .join(",")}) RETURNING *`,
      Object.values(row),
    );
    return result.rows[0] as Record<string, string>;
  }
  async function fixture() {
    const orgId = `telegram-org-${randomUUID()}`;
    const userId = `opaque-user_${randomUUID()}`;
    await insert("organization", { id: orgId, name: "Synthetic", slug: orgId });
    await insert('"user"', { id: userId, name: "Synthetic", email: `${userId}@example.invalid` });
    const bot = await insert("telegram_bot_identities", {
      bot_id: String(BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 15)}`) + 1n),
      owner_org_id: orgId,
    });
    const config = await insert("telegram_decision_configs", {
      org_id: orgId,
      bot_identity_id: bot.id,
      route_id: randomUUID().replaceAll("-", "") + "x".repeat(11),
      secret_hash: hash,
      credentials_encrypted: "synthetic-encrypted-token",
      retry_payload_encrypted: "synthetic-encrypted-frozen-request",
    });
    const base = { org_id: orgId, user_id: userId, bot_identity_id: bot.id, generation: 1 };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 300_000);
    const challenge = await insert("telegram_binding_challenges", {
      ...base,
      code_hash: randomUUID().replaceAll("-", "") + "a".repeat(32),
      created_at: now,
      expires_at: expiresAt,
    });
    const binding = await insert("telegram_bindings", {
      ...base,
      telegram_user_id: "18446744073709551615",
      private_chat_id: "18446744073709551615",
    });
    const capabilityBase = {
      org_id: orgId,
      bot_identity_id: bot.id,
      generation: 1,
      content_item_id: randomUUID(),
      brand_id: randomUUID(),
      snapshot_hash: hash,
      snapshot_version: "client-review-v1",
      created_at: now,
      expires_at: expiresAt,
    };
    const initial = await insert("telegram_initial_capabilities", {
      ...capabilityBase,
      token_hash: randomUUID().replaceAll("-", "") + "a".repeat(32),
      chat_id: "-1001234567890",
    });
    const confirmation = await insert("telegram_actor_confirmations", {
      ...capabilityBase,
      user_id: userId,
      binding_id: binding.id,
      initial_capability_id: initial.id,
      initial_expires_at: expiresAt,
      token_hash: randomUUID().replaceAll("-", "") + "b".repeat(32),
      chat_id: "18446744073709551615",
    });
    const audit = await insert("telegram_decision_audit", {
      org_id: orgId,
      content_item_id: initial.content_item_id,
      brand_id: initial.brand_id,
      actor_user_id: userId,
      binding_id: binding.id,
      bot_identity_id: bot.id,
      generation: 1,
      capability_id: confirmation.id,
      update_id: "42",
      action: "reject",
      outcome: "rejected",
      snapshot_hash: hash,
      snapshot_version: "client-review-v1",
    });
    const replay = await insert("telegram_update_receipts", {
      org_id: orgId,
      bot_identity_id: bot.id,
      update_id: "42",
      generation: 1,
      request_fingerprint: hash,
      operation: "confirm_reject",
      outcome: "accepted",
      actor_user_id: userId,
      capability_id: confirmation.id,
      decision_id: audit.id,
    });
    return {
      orgId,
      userId,
      bot,
      config,
      challenge,
      binding,
      initial,
      confirmation,
      audit,
      replay,
      now,
      expiresAt,
    };
  }
  it("rejects cross-org live references, lossy IDs, incomplete candidates and invalid confirmation secrets", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await expect(
      insert("telegram_bindings", {
        org_id: foreign.orgId,
        user_id: foreign.userId,
        bot_identity_id: f.bot.id,
        generation: 1,
        telegram_user_id: "999",
        private_chat_id: "999",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert("telegram_decision_configs", {
        org_id: `absent-${randomUUID()}`,
        bot_identity_id: f.bot.id,
        route_id: code,
        secret_hash: hash,
        credentials_encrypted: "x",
        retry_payload_encrypted: "x",
      }),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        "UPDATE telegram_binding_challenges SET state = 'awaiting_web_confirmation', candidate_telegram_user_id = '123', candidate_display_name = 'Synthetic', claimed_at = now() WHERE id = $1",
        [f.challenge.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE telegram_actor_confirmations SET token_hash = 'raw-token' WHERE id = $1", [
        f.confirmation.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE telegram_bindings SET telegram_user_id = '01', private_chat_id = '01' WHERE id = $1",
        [f.binding.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("refuses inbound owner transfer or release even after tenant config removal", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await pool.query("UPDATE telegram_bot_identities SET enabled = true WHERE id = $1", [f.bot.id]);
    await pool.query("DELETE FROM telegram_decision_configs WHERE org_id = $1", [f.orgId]);
    await expect(
      pool.query("UPDATE telegram_bot_identities SET owner_org_id = $2 WHERE id = $1", [
        f.bot.id,
        foreign.orgId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE telegram_bot_identities SET enabled = false WHERE id = $1", [
      f.bot.id,
    ]);
    await expect(
      pool.query("UPDATE telegram_bot_identities SET owner_org_id = NULL WHERE id = $1", [
        f.bot.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await pool.query("SELECT owner_org_id FROM telegram_bot_identities WHERE id = $1", [
          f.bot.id,
        ])
      ).rows[0].owner_org_id,
    ).toBe(f.orgId);
  });
  it("preserves minimal immutable audit through direct user deletion and erases all actor rows", async () => {
    const f = await fixture();
    await expect(
      pool.query("UPDATE telegram_decision_audit SET actor_user_id = 'different' WHERE id = $1", [
        f.audit.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM telegram_decision_audit WHERE id = $1", [f.audit.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query('DELETE FROM "user" WHERE id = $1', [f.userId]);
    for (const table of [
      "telegram_bindings",
      "telegram_binding_challenges",
      "telegram_actor_confirmations",
    ])
      expect(
        (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [f.orgId]))
          .rows[0].n,
      ).toBe(0);
    expect(
      (
        await pool.query("SELECT actor_user_id FROM telegram_decision_audit WHERE id = $1", [
          f.audit.id,
        ])
      ).rows[0].actor_user_id,
    ).toBe(f.userId);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM telegram_initial_capabilities WHERE org_id = $1",
          [f.orgId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("keeps replay unique per bot/update and forbids receipt rewrites", async () => {
    const f = await fixture();
    await expect(
      insert("telegram_update_receipts", {
        org_id: f.orgId,
        bot_identity_id: f.bot.id,
        update_id: "42",
        generation: 1,
        request_fingerprint: "b".repeat(64),
        operation: "probe_start",
        outcome: "accepted",
      }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query("UPDATE telegram_update_receipts SET request_fingerprint = $2 WHERE id = $1", [
        f.replay.id,
        "b".repeat(64),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query("DELETE FROM telegram_update_receipts WHERE id = $1", [f.replay.id]);
    expect(
      (await pool.query("SELECT id FROM telegram_decision_audit WHERE id = $1", [f.audit.id]))
        .rowCount,
    ).toBe(1);
  });
  it("quarantines a real tenant's registry and physical unknown lane while cascading secrets and identity", async () => {
    const f = await fixture();
    const attemptId = randomUUID();
    await pool.query(
      "UPDATE telegram_bot_identities SET remote_state = 'attempted', remote_mutation = 'install', remote_generation = 1, request_fingerprint = $2, attempt_id = $3, unresolved_attempts = 1, attempted_at = now() WHERE id = $1",
      [f.bot.id, hash, attemptId],
    );
    await expect(
      insert("telegram_remote_attempts", {
        id: randomUUID(),
        bot_identity_id: f.bot.id,
        generation: 1,
        mutation: "install",
        request_fingerprint: hash,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await insert("telegram_remote_attempts", {
      id: attemptId,
      bot_identity_id: f.bot.id,
      generation: 1,
      mutation: "install",
      request_fingerprint: hash,
    });
    await pool.query("UPDATE telegram_remote_attempts SET outcome = 'unknown' WHERE id = $1", [
      attemptId,
    ]);
    await pool.query("UPDATE telegram_bot_identities SET remote_state = 'unknown' WHERE id = $1", [
      f.bot.id,
    ]);
    // Exact generation retry success never completes the prior physical attempt.
    const retryId = randomUUID();
    await pool.query(
      "UPDATE telegram_bot_identities SET attempt_id = $2, unresolved_attempts = 2 WHERE id = $1",
      [f.bot.id, retryId],
    );
    const retry = await insert("telegram_remote_attempts", {
      id: retryId,
      bot_identity_id: f.bot.id,
      generation: 1,
      mutation: "install",
      request_fingerprint: hash,
    });
    await pool.query(
      "UPDATE telegram_remote_attempts SET outcome = 'confirmed', completed_at = now() WHERE id = $1",
      [retry.id],
    );
    await pool.query("UPDATE telegram_bot_identities SET unresolved_attempts = 1 WHERE id = $1", [
      f.bot.id,
    ]);
    await expect(
      pool.query("UPDATE telegram_bot_identities SET generation = 2 WHERE id = $1", [f.bot.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE telegram_bot_identities SET unresolved_attempts = 0 WHERE id = $1", [
        f.bot.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM telegram_remote_attempts WHERE id = $1", [attemptId]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query("DELETE FROM organization WHERE id = $1", [f.orgId]);
    for (const table of [
      "telegram_decision_configs",
      "telegram_binding_challenges",
      "telegram_bindings",
      "telegram_initial_capabilities",
      "telegram_actor_confirmations",
      "telegram_update_receipts",
      "telegram_decision_audit",
    ])
      expect(
        (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [f.orgId]))
          .rows[0].n,
      ).toBe(0);
    const survivor = (
      await pool.query("SELECT * FROM telegram_bot_identities WHERE id = $1", [f.bot.id])
    ).rows[0];
    expect(survivor).toMatchObject({
      owner_org_id: null,
      enabled: false,
      quarantined: true,
      remote_state: "unknown",
      unresolved_attempts: 1,
    });
    expect(
      (await pool.query("SELECT outcome FROM telegram_remote_attempts WHERE id = $1", [attemptId]))
        .rows[0].outcome,
    ).toBe("unknown");
    await pool.query(
      "UPDATE telegram_remote_attempts SET outcome = 'confirmed', completed_at = now() WHERE id = $1",
      [attemptId],
    );
    await expect(
      pool.query("UPDATE telegram_bot_identities SET enabled = true WHERE id = $1", [f.bot.id]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(Object.keys(survivor).some((key) => /secret|credential|chat|user|name/.test(key))).toBe(
      false,
    );
  });
  it("serializes overlapping raw user and organization deletions without reverse parent waits", async () => {
    for (const first of ["user", "organization"] as const) {
      const f = await fixture();
      const left = await pool.connect();
      const right = await pool.connect();
      let pending: Promise<{ error?: unknown }> | undefined;
      try {
        await left.query("BEGIN");
        await right.query("BEGIN");
        const rightPid = (await right.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid as number;
        const deleteUser = ['DELETE FROM "user" WHERE id = $1', f.userId] as const;
        const deleteOrg = ["DELETE FROM organization WHERE id = $1", f.orgId] as const;
        const a = first === "user" ? deleteUser : deleteOrg;
        const b = first === "user" ? deleteOrg : deleteUser;
        await left.query(a[0], [a[1]]);
        pending = right.query(b[0], [b[1]]).then(
          () => ({}),
          (error: unknown) => ({ error }),
        );
        let waited = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await pool.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [rightPid],
          );
          if (result.rows[0]?.wait_event_type === "Lock") {
            waited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waited, "the second actual delete must wait on the first transaction").toBe(true);
        await left.query("COMMIT");
        expect(await pending).toEqual({});
        await right.query("COMMIT");
        expect(
          (await pool.query("SELECT * FROM telegram_bot_identities WHERE id = $1", [f.bot.id]))
            .rows[0],
        ).toMatchObject({ owner_org_id: null, enabled: false, quarantined: true });
        expect(
          (await pool.query("SELECT id FROM telegram_decision_audit WHERE id = $1", [f.audit.id]))
            .rowCount,
        ).toBe(0);
      } finally {
        await left.query("ROLLBACK");
        await right.query("ROLLBACK");
        await pending;
        left.release();
        right.release();
      }
    }
  });
});
