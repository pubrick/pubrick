import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectStatus, parseArguments, sanitizeSnapshot, statusSql } from "./hosted-status.mjs";

const snapshot = {
  observedAt: "2026-09-30T10:00:00+00:00",
  rows: [
    {
      component: "media.cleanup",
      scope: "instance",
      state: "operator_action",
      count: "2",
      attempts: "8",
      due_seconds: "0",
    },
  ],
};
function fixture(t, change = {}) {
  const checkout = mkdtempSync(path.join(os.tmpdir(), "pubrick-status-unit-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "pubrick" }));
  writeFileSync(path.join(checkout, ".env"), "PRIVATE_KEY=do-not-print\n");
  writeFileSync(path.join(checkout, "docker-compose.yml"), "services: {}\n");
  const project = "pubrick-status-unit";
  const calls = [];
  const environment = {
    PUBRICK_DEPLOYMENT_MODE: "hosted",
    BILLING_DRIVER: "fixture",
    BILLING_ACCOUNT_ID: "fixture_status",
    DATABASE_URL: "postgres://fixture:secret@postgres:5432/fixture",
  };
  const config = {
    services: {
      postgres: { environment: { POSTGRES_USER: "fixture", POSTGRES_DB: "fixture" } },
      api: { environment: { ...environment, SMTP_PASSWORD: "do-not-print" } },
    },
  };
  const container = {
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": "postgres",
        "com.docker.compose.project.working_dir": checkout,
        "com.docker.compose.project.config_files": path.join(checkout, "docker-compose.yml"),
      },
      Env: ["POSTGRES_USER=fixture", "POSTGRES_DB=fixture"],
    },
    State: { Running: true },
  };
  const execute = (_command, args, options) => {
    calls.push({ args, options });
    if (args.includes("config")) return { status: 0, stdout: JSON.stringify(config) };
    if (args.includes("inspect")) return { status: 0, stdout: JSON.stringify([container]) };
    if (args.includes("ps"))
      return { status: 0, stdout: args.at(-1) === "postgres" ? "a".repeat(64) : "" };
    if (args.includes("exec")) return { status: 0, stdout: JSON.stringify(snapshot) };
    return { status: 1, stderr: "PRIVATE_KEY=do-not-print" };
  };
  return { checkout, project, calls, config, container, execute, ...change };
}
test("requires explicit project and absolute checkout; rejects extra and duplicate arguments", () => {
  assert.deepEqual(
    parseArguments([
      "--project",
      "pubrick-status",
      "--checkout",
      "/repo",
      "--file",
      "docker-compose.yml",
    ]),
    { project: "pubrick-status", checkout: "/repo", composeFiles: ["docker-compose.yml"] },
  );
  for (const args of [
    [],
    ["--project", "x", "--checkout", "."],
    ["--project", "X", "--checkout", "/repo"],
    ["--project", "x", "--checkout", "/repo", "--sql", "DROP"],
    ["--project", "x", "--project", "x", "--checkout", "/repo"],
  ])
    assert.throws(() => parseArguments(args));
});
test("status SQL is a bounded read-only transaction with no payload/customer/tenant projections", () => {
  const sql = statusSql({ mode: "hosted", provider: "fixture", account: "fixture_status" });
  assert.match(sql, /BEGIN READ ONLY/);
  assert.match(sql, /statement_timeout = '5s'/);
  assert.match(sql, /lock_timeout = '1s'/);
  assert.match(sql, /ROLLBACK/);
  assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\b/i);
  assert.doesNotMatch(
    sql,
    /\b(ciphertext|customer_id|checkout_url|event_id|resource_id|idempotency_key|body|email|data|output)\b/i,
  );
  assert.match(sql, /dispatch_deadline_at/);
  assert.match(sql, /byte_size IS NULL/);
  assert.match(sql, /other_identity/);
  assert.throws(() =>
    statusSql({ mode: "hosted", provider: "fixture", account: "fixture_x';DROP TABLE user;--" }),
  );
  assert.throws(() => statusSql({ mode: "invalid" }));
  assert.throws(() =>
    statusSql({ mode: "hosted", provider: "stripe';DROP TABLE user;--", account: "acct_valid" }),
  );
});
test("sanitizer emits only declared aggregate fields, preserving decimal counts without precision loss", () => {
  const result = sanitizeSnapshot({
    ...snapshot,
    token: "do-not-print",
    rows: [
      {
        ...snapshot.rows[0],
        count: "18446744073709551615",
        email: "private@example.com",
        ciphertext: "do-not-print",
      },
    ],
  });
  assert.equal(result.rows[0].count, "18446744073709551615");
  assert.equal(JSON.stringify(result).includes("do-not-print"), false);
  assert.equal(JSON.stringify(result).includes("private@example.com"), false);
  for (const row of [
    { ...snapshot.rows[0], state: "do-not-print" },
    { ...snapshot.rows[0], count: "-1" },
    { ...snapshot.rows[0], attempts: 8 },
    { ...snapshot.rows[0], component: "users" },
  ])
    assert.throws(() => sanitizeSnapshot({ ...snapshot, rows: [row] }));
  assert.throws(() => sanitizeSnapshot({ ...snapshot, rows: Array(101).fill(snapshot.rows[0]) }));
});
test("attests selected checkout/project then delegates only fixed SQL to maintained psql", (t) => {
  const f = fixture(t);
  const result = inspectStatus(f);
  assert.equal(result.deploymentMode, "hosted");
  assert.equal(result.services.postgres.running, 1);
  assert.equal(JSON.stringify(result).includes("do-not-print"), false);
  const query = f.calls.find((c) => c.args.includes("exec"));
  assert.match(query.options.input, /BEGIN READ ONLY/);
  assert.equal(query.options.timeout, 15000);
  assert.equal(query.options.maxBuffer, 1048576);
  assert.deepEqual(query.args.slice(query.args.indexOf("exec")), [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-qAt",
    "--set=ON_ERROR_STOP=1",
    "--username",
    "fixture",
    "--dbname",
    "fixture",
  ]);
  assert.equal(
    f.calls.some((c) => c.args.includes("stop") || c.args.includes("up") || c.args.includes("run")),
    false,
  );
});
test("refuses another project/checkout/Compose overlay before querying", (t) => {
  for (const key of [
    "com.docker.compose.project",
    "com.docker.compose.service",
    "com.docker.compose.project.working_dir",
    "com.docker.compose.project.config_files",
  ]) {
    const f = fixture(t);
    f.container.Config.Labels[key] =
      key.endsWith("working_dir") || key.endsWith("config_files")
        ? "/missing-status-fixture"
        : "wrong";
    assert.throws(() => inspectStatus(f));
    assert.equal(
      f.calls.some((c) => c.args.includes("exec")),
      false,
    );
  }
});
test("refuses runtime billing identity mismatch and stopped database", (t) => {
  const f = fixture(t);
  const execute = f.execute;
  f.execute = (command, args, opts) => {
    if (args.includes("ps") && args.at(-1) === "api") return { status: 0, stdout: "b".repeat(64) };
    if (args.includes("inspect") && args.at(-1).startsWith("b"))
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            ...f.container,
            Config: {
              Labels: { ...f.container.Config.Labels, "com.docker.compose.service": "api" },
              Env: [
                "PUBRICK_DEPLOYMENT_MODE=hosted",
                "BILLING_DRIVER=fixture",
                "BILLING_ACCOUNT_ID=fixture_other",
                "DATABASE_URL=postgres://fixture:secret@postgres:5432/fixture",
              ],
            },
          },
        ]),
      };
    return execute(command, args, opts);
  };
  assert.throws(() => inspectStatus(f), /runtime_identity_mismatch/);
  const stopped = fixture(t);
  stopped.container.State.Running = false;
  assert.throws(() => inspectStatus(stopped), /database_not_running/);
});
test("does not expose Docker or PostgreSQL diagnostic secrets", (t) => {
  const f = fixture(t);
  f.execute = () => ({
    status: 1,
    stderr: "SMTP_PASSWORD=do-not-print",
    stdout: "APP_ENCRYPTION_KEY=do-not-print",
  });
  assert.throws(() => inspectStatus(f), /status_command_failed/);
});

test("refuses configured or running database target mismatch without exposing credentials", (t) => {
  for (const target of [
    "postgres://fixture:PRIVATE_PASSWORD@other:5432/fixture",
    "postgres://other:PRIVATE_PASSWORD@postgres:5432/fixture",
    "postgres://fixture:PRIVATE_PASSWORD@postgres:5432/other",
  ]) {
    const f = fixture(t);
    f.config.services.api.environment.DATABASE_URL = target;
    assert.throws(() => inspectStatus(f), /^Error: database_identity_mismatch$/);
    assert.ok(!f.calls.some((call) => call.args.includes("exec")));
  }
  const f = fixture(t);
  f.container.Config.Env = ["POSTGRES_USER=fixture", "POSTGRES_DB=other"];
  assert.throws(() => inspectStatus(f), /^Error: database_identity_mismatch$/);
});

test("preserves Compose overlay order when attesting the running project", (t) => {
  const f = fixture(t);
  const overlay = path.join(f.checkout, "overlay.yml");
  writeFileSync(overlay, "services: {}\n");
  f.composeFiles = ["docker-compose.yml", "overlay.yml"];
  f.container.Config.Labels["com.docker.compose.project.config_files"] =
    `${overlay},${path.join(f.checkout, "docker-compose.yml")}`;
  assert.throws(() => inspectStatus(f), /^Error: compose_files_mismatch$/);
  assert.ok(!f.calls.some((call) => call.args.includes("exec")));
});

test("refuses stale worker billing identity before querying the database", (t) => {
  const f = fixture(t);
  f.config.services.worker = { environment: { ...f.config.services.api.environment } };
  const execute = f.execute;
  f.execute = (command, args, opts) => {
    if (args.includes("ps") && args.at(-1) === "worker")
      return { status: 0, stdout: "c".repeat(64) };
    if (args.includes("inspect") && args.at(-1).startsWith("c"))
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            ...f.container,
            Config: {
              Labels: { ...f.container.Config.Labels, "com.docker.compose.service": "worker" },
              Env: [
                "PUBRICK_DEPLOYMENT_MODE=hosted",
                "BILLING_DRIVER=fixture",
                "BILLING_ACCOUNT_ID=fixture_old",
                "DATABASE_URL=postgres://fixture:secret@postgres:5432/fixture",
              ],
            },
          },
        ]),
      };
    return execute(command, args, opts);
  };
  assert.throws(() => inspectStatus(f), /^Error: runtime_identity_mismatch$/);
  assert.ok(!f.calls.some((call) => call.args.includes("exec")));
  const changed = fixture(t);
  changed.config.services.worker = {
    environment: { ...changed.config.services.api.environment, BILLING_ACCOUNT_ID: "fixture_old" },
  };
  assert.throws(() => inspectStatus(changed), /^Error: runtime_identity_mismatch$/);
});

test("closes malformed Compose JSON diagnostics without leaking configuration text", (t) => {
  const f = fixture(t);
  f.execute = () => ({ status: 0, stdout: '{"secret":"PRIVATE_SECRET" unexpected' });
  assert.throws(() => inspectStatus(f), /^Error: status_inspection_failed$/);
});
