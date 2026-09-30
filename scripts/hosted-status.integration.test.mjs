import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectStatus } from "./hosted-status.mjs";

// Explicit opt-in; never discover/reuse the developer installation or inherited DB credentials.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Native operator tier runs outside Turbo.
const enabled = process.env.PUBRICK_STATUS_TEST_DOCKER === "1";
test("reads sanitized operations facts from real migration124 and pg-boss in an owned tmpfs Compose project", {
  skip: !enabled,
  timeout: 120000,
}, async () => {
  const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
  const { runMigrations } = require("@pubrick/db");
  const { PgBoss } = require("pg-boss");
  const { Pool } = createRequire(require.resolve("@pubrick/db"))("pg");
  const checkout = mkdtempSync(path.join(os.tmpdir(), "pubrick-status-native-"));
  const project = `pubrick-status-native-${randomUUID()}`;
  const compose = [
    "compose",
    "--project-name",
    project,
    "--env-file",
    path.join(checkout, ".env"),
    "--file",
    path.join(checkout, "docker-compose.yml"),
  ];
  const command = (args) => {
    const result = spawnSync("docker", args, {
      cwd: checkout,
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, `Owned fixture Docker operation failed: ${args[0]}`);
    return result.stdout.trim();
  };
  writeFileSync(path.join(checkout, "package.json"), '{"name":"pubrick"}\n');
  writeFileSync(path.join(checkout, ".env"), "PRIVATE_FIXTURE=not-user-data\n", { mode: 0o600 });
  writeFileSync(
    path.join(checkout, "docker-compose.yml"),
    `services:
  postgres:
    image: pgvector/pgvector:pg16
    environment: {POSTGRES_USER: fixture, POSTGRES_PASSWORD: fixture, POSTGRES_DB: fixture}
    ports: ["127.0.0.1::5432"]
    tmpfs: [/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U fixture -d fixture"]
      interval: 1s
      timeout: 2s
      retries: 60
  api:
    image: pgvector/pgvector:pg16
    profiles: [not-started]
    environment:
      PUBRICK_DEPLOYMENT_MODE: hosted
      BILLING_DRIVER: fixture
      BILLING_ACCOUNT_ID: fixture_status
      DATABASE_URL: postgres://fixture:fixture@postgres:5432/fixture
  worker:
    image: pgvector/pgvector:pg16
    profiles: [not-started]
    environment:
      PUBRICK_DEPLOYMENT_MODE: hosted
      BILLING_DRIVER: fixture
      BILLING_ACCOUNT_ID: fixture_status
      DATABASE_URL: postgres://fixture:fixture@postgres:5432/fixture
`,
  );
  let pool, boss;
  try {
    command([...compose, "up", "-d", "--wait", "--wait-timeout", "60", "postgres"]);
    const port = command([...compose, "port", "postgres", "5432"])
      .split(":")
      .at(-1);
    const connectionString = `postgres://fixture:fixture@127.0.0.1:${port}/fixture`;
    await runMigrations(connectionString);
    pool = new Pool({ connectionString, max: 1 });
    boss = new PgBoss(connectionString);
    await boss.start();
    await boss.createQueue("auth-mail");
    await boss.createQueue("auth-mail-dlq");
    await boss.send("auth-mail", { ciphertext: "PRIVATE_CIPHERTEXT" });
    await boss.send("auth-mail-dlq", { ciphertext: "PRIVATE_CIPHERTEXT" });
    await pool.query(`INSERT INTO organization(id,name,slug,created_at) VALUES('status_org','PRIVATE_ORG_CONTENT','status-org',now());
INSERT INTO media_cleanup_work(asset_id,org_id,kind,state) VALUES('10000000-0000-4000-8000-000000000001','deleted_org','image','pending');
INSERT INTO media_cleanup_work(asset_id,org_id,kind,state,completed_at,byte_size) VALUES('10000000-0000-4000-8000-000000000002','deleted_org','image','completed',now(),12);
INSERT INTO hosted_ai_call_leases(org_id,kind,created_at,dispatch_deadline_at,lease_expires_at) VALUES('status_org','text',now()-interval '3 minutes',now()-interval '2 minutes',now()-interval '1 minute'),('status_org','image',now(),now()+interval '1 minute',now()+interval '2 minutes');
INSERT INTO billing_cleanup(org_id,provider,environment,account_id,kind,resource_id,idempotency_key,status,attempts) VALUES('deleted_org','fixture','sandbox','fixture_status','subscription','sub_fixture','PRIVATE_KEY','operator_action',12);`);
    const before = await pool.query(
      "SELECT count(*)::text AS count FROM pgboss.job WHERE name IN ('auth-mail','auth-mail-dlq')",
    );
    const report = inspectStatus({ checkout, project });
    const row = (component, state) =>
      report.rows.find((r) => r.component === component && r.state === state);
    assert.equal(row("mail", "created")?.count, "1");
    assert.equal(row("mail.deadletter", "created")?.count, "1");
    assert.equal(row("media.cleanup", "completed")?.count, "1");
    assert.equal(row("media.unknown_size", "unknown")?.count, "1");
    assert.equal(row("billing.cleanup", "operator_action")?.attempts, "12");
    assert.equal(row("billing.cleanup", "operator_action")?.scope, "configured");
    assert.equal(row("ai.leases", "expired")?.count, "1");
    assert.equal(row("ai.leases", "dispatch_live")?.count, "1");
    assert.doesNotMatch(
      JSON.stringify(report),
      /PRIVATE_|deleted_org|status_org|sub_fixture|fixture_status/,
    );
    const after = await pool.query(
      "SELECT count(*)::text AS count FROM pgboss.job WHERE name IN ('auth-mail','auth-mail-dlq')",
    );
    assert.deepEqual(after.rows, before.rows);
  } finally {
    await boss?.stop({ graceful: true, timeout: 5000 });
    await pool?.end();
    command([...compose, "down", "--volumes", "--remove-orphans"]);
    assert.equal(
      command([
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        "{{.ID}}",
      ]),
      "",
    );
    rmSync(checkout, { recursive: true, force: true });
  }
});
