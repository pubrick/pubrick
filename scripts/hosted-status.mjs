#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: node scripts/hosted-status.mjs --project NAME --checkout ABSOLUTE_PATH [--file COMPOSE_FILE]";
const fail = (code) => {
  throw new Error(code);
};
export function parseArguments(args) {
  const result = { composeFiles: [] };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith("--")) fail(usage);
    if (flag === "--file") result.composeFiles.push(value);
    else if (flag === "--project" && !result.project) result.project = value;
    else if (flag === "--checkout" && !result.checkout) result.checkout = value;
    else fail(usage);
  }
  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(result.project ?? "") ||
    !path.isAbsolute(result.checkout ?? "")
  )
    fail(usage);
  return result;
}
function identity(environment = {}) {
  const mode = environment.PUBRICK_DEPLOYMENT_MODE ?? "self-hosted";
  if (!["hosted", "self-hosted"].includes(mode)) fail("invalid_configuration");
  if (mode === "self-hosted") return { mode, provider: null, account: null };
  const driver = environment.BILLING_DRIVER;
  const account = environment.BILLING_ACCOUNT_ID;
  const provider = driver === "fixture" ? "fixture" : driver === "stripe-sandbox" ? "stripe" : null;
  if (
    !provider ||
    !new RegExp(provider === "fixture" ? "^fixture_[a-zA-Z0-9_]+$" : "^acct_[a-zA-Z0-9_]+$").test(
      account ?? "",
    )
  )
    fail("invalid_configuration");
  return { mode, provider, account };
}
export function statusSql(current) {
  // Account strings are closed server identifiers, validated before constructing SQL.
  if (!["hosted", "self-hosted"].includes(current.mode)) fail("invalid_configuration");
  if (current.mode === "hosted") {
    if (!["fixture", "stripe"].includes(current.provider)) fail("invalid_configuration");
    identity({
      PUBRICK_DEPLOYMENT_MODE: "hosted",
      BILLING_DRIVER: current.provider === "fixture" ? "fixture" : "stripe-sandbox",
      BILLING_ACCOUNT_ID: current.account,
    });
  }
  const scope =
    current.mode === "hosted"
      ? `CASE WHEN provider='${current.provider}' AND environment='sandbox' AND account_id='${current.account}' THEN 'configured' ELSE 'other_identity' END`
      : `'retained'`;
  const billing = [
    ["billing_checkout_attempts", "billing.checkout", "next_attempt_at", null],
    ["billing_receipts", "billing.receipts", "next_attempt_at", "attempts"],
    ["billing_cleanup", "billing.cleanup", "next_attempt_at", "attempts"],
  ].map(
    ([table, component, due, attempts]) =>
      `SELECT '${component}' AS component, ${scope} AS scope, status AS state, count(*)::text AS count, ${attempts ? `coalesce(max(${attempts}),0)::text` : "NULL::text"} AS attempts, coalesce(greatest(0,extract(epoch FROM now()-min(${due}) FILTER (WHERE status IN ('pending','retry','processing','ready'))))::bigint,0)::text AS due_seconds FROM ${table} GROUP BY 2,3`,
  );
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT json_build_object('observedAt',now(),'rows',coalesce(json_agg(row_to_json(metrics)),'[]'::json)) FROM (
${billing.join("\nUNION ALL\n")}
${["billing_checkout_attempts", "billing_receipts", "billing_cleanup"].map((table) => `UNION ALL SELECT '${table === "billing_checkout_attempts" ? "billing.checkout_leases" : table === "billing_receipts" ? "billing.receipt_leases" : "billing.cleanup_leases"}',${scope},CASE WHEN lease_expires_at<=now() THEN 'expired' ELSE 'lease_live' END,count(*)::text,NULL::text,coalesce(greatest(0,extract(epoch FROM now()-min(lease_expires_at)))::bigint,0)::text FROM ${table} WHERE lease_token IS NOT NULL GROUP BY 2,3`).join("\n")}
UNION ALL SELECT 'billing.subscriptions',${scope},'due',count(*)::text,coalesce(max(reconcile_attempts),0)::text,coalesce(greatest(0,extract(epoch FROM now()-min(next_reconcile_at)))::bigint,0)::text FROM billing_subscriptions WHERE NOT deleted AND next_reconcile_at<=now() GROUP BY 2
UNION ALL SELECT 'mail','instance',state::text,count(*)::text,NULL::text,coalesce(greatest(0,extract(epoch FROM now()-min(start_after) FILTER (WHERE state IN ('created','retry'))))::bigint,0)::text FROM pgboss.job WHERE name='auth-mail' GROUP BY state
UNION ALL SELECT 'mail.deadletter','instance',state::text,count(*)::text,NULL::text,'0' FROM pgboss.job WHERE name='auth-mail-dlq' GROUP BY state
UNION ALL SELECT 'media.cleanup','instance',state,count(*)::text,coalesce(max(attempts),0)::text,coalesce(greatest(0,extract(epoch FROM now()-min(next_attempt_at) FILTER (WHERE state='pending')))::bigint,0)::text FROM media_cleanup_work GROUP BY state
UNION ALL SELECT 'media.unknown_size','instance','unknown',count(*)::text,NULL::text,'0' FROM media_cleanup_work w WHERE w.state<>'completed' AND w.byte_size IS NULL AND NOT EXISTS (SELECT 1 FROM media_assets a WHERE a.id=w.asset_id AND a.org_id=w.org_id AND a.kind=w.kind AND a.byte_size>0)
UNION ALL SELECT 'ai.leases','instance',CASE WHEN lease_expires_at<=now() THEN 'expired' WHEN dispatch_deadline_at<=now() THEN 'settlement_grace' ELSE 'dispatch_live' END,count(*)::text,NULL::text,coalesce(greatest(0,extract(epoch FROM now()-min(lease_expires_at)))::bigint,0)::text FROM hosted_ai_call_leases GROUP BY 3
) metrics;
ROLLBACK;`;
}
const components = new Set([
  "billing.checkout",
  "billing.receipts",
  "billing.cleanup",
  "billing.subscriptions",
  "billing.checkout_leases",
  "billing.receipt_leases",
  "billing.cleanup_leases",
  "mail",
  "mail.deadletter",
  "media.cleanup",
  "media.unknown_size",
  "ai.leases",
]);
const states = new Set([
  "pending",
  "ready",
  "closed",
  "operator_action",
  "processing",
  "complete",
  "ignored",
  "retry",
  "due",
  "created",
  "active",
  "completed",
  "cancelled",
  "failed",
  "unknown",
  "expired",
  "settlement_grace",
  "dispatch_live",
  "lease_live",
]);
const scopes = new Set(["configured", "other_identity", "retained", "instance"]);
export function sanitizeSnapshot(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.rows) ||
    value.rows.length > 100 ||
    typeof value.observedAt !== "string" ||
    Number.isNaN(Date.parse(value.observedAt))
  )
    fail("invalid_status_response");
  const rows = value.rows.map((row) => {
    if (!components.has(row?.component) || !states.has(row?.state) || !scopes.has(row?.scope))
      fail("invalid_status_response");
    const output = { component: row.component, scope: row.scope, state: row.state };
    for (const key of ["count", "attempts", "due_seconds"]) {
      if (key === "attempts" && row[key] === null) {
        output[key] = null;
        continue;
      }
      if (typeof row[key] !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(row[key]))
        fail("invalid_status_response");
      output[key] = row[key];
    }
    return output;
  });
  return { observedAt: new Date(value.observedAt).toISOString(), rows };
}
function databaseTarget(value, db) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("database_identity_mismatch");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "postgres" ||
    (url.port && url.port !== "5432") ||
    decodeURIComponent(url.username) !== db.POSTGRES_USER ||
    decodeURIComponent(url.pathname.slice(1)) !== db.POSTGRES_DB
  )
    fail("database_identity_mismatch");
}
function inspectStatusInternal({ project, checkout, composeFiles = [], execute = spawnSync }) {
  parseArguments(["--project", project, "--checkout", checkout]);
  const cwd = realpathSync(checkout);
  if (JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).name !== "pubrick")
    fail("checkout_identity_mismatch");
  const files = composeFiles.length ? composeFiles : ["docker-compose.yml"];
  const resolvedFiles = files.map((file) => realpathSync(path.resolve(cwd, file)));
  const compose = [
    "compose",
    "--profile",
    "*",
    "--project-name",
    project,
    "--env-file",
    path.join(cwd, ".env"),
    ...resolvedFiles.flatMap((file) => ["--file", file]),
  ];
  const command = (args, input) => {
    const result = execute("docker", args, {
      cwd,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    // Docker/psql stderr and Compose environment may contain secrets; never forward them.
    if (result.error || result.status !== 0) fail("status_command_failed");
    return result.stdout ?? "";
  };
  const dc = (args, input) => command([...compose, ...args], input);
  const config = JSON.parse(dc(["config", "--format", "json"]));
  const db = config.services?.postgres?.environment;
  if (!db?.POSTGRES_USER || !db?.POSTGRES_DB) fail("unsupported_database_configuration");
  const current = identity(config.services?.api?.environment);
  for (const service of ["api", "worker"]) {
    if (config.services?.[service]) {
      databaseTarget(config.services[service].environment?.DATABASE_URL, db);
      if (
        JSON.stringify(identity(config.services[service].environment)) !== JSON.stringify(current)
      )
        fail("runtime_identity_mismatch");
    }
  }
  const services = {};
  for (const service of ["postgres", "api", "worker"]) {
    const ids = dc(["ps", "--all", "--quiet", service]).trim().split(/\s+/).filter(Boolean);
    if (ids.length > 100) fail("invalid_project_inventory");
    services[service] = { containers: ids.length, running: 0 };
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) fail("invalid_project_inventory");
      const [container] = JSON.parse(command(["inspect", id]));
      const labels = container?.Config?.Labels;
      if (
        labels?.["com.docker.compose.project"] !== project ||
        labels?.["com.docker.compose.service"] !== service ||
        realpathSync(labels?.["com.docker.compose.project.working_dir"] ?? "") !== cwd
      )
        fail("checkout_identity_mismatch");
      const actualFiles = (labels["com.docker.compose.project.config_files"] ?? "")
        .split(",")
        .map((file) => realpathSync(file));
      if (actualFiles.join("\n") !== resolvedFiles.join("\n")) fail("compose_files_mismatch");
      if (["postgres", "api", "worker"].includes(service)) {
        const environment = Object.fromEntries(
          (container.Config.Env ?? []).map((item) => {
            const split = item.indexOf("=");
            return [item.slice(0, split), item.slice(split + 1)];
          }),
        );
        if (service === "postgres") {
          if (
            environment.POSTGRES_USER !== db.POSTGRES_USER ||
            environment.POSTGRES_DB !== db.POSTGRES_DB
          )
            fail("database_identity_mismatch");
        } else {
          databaseTarget(environment.DATABASE_URL, db);
          if (JSON.stringify(identity(environment)) !== JSON.stringify(current))
            fail("runtime_identity_mismatch");
        }
      }
      if (container.State?.Running === true) services[service].running++;
    }
  }
  if (services.postgres.running !== 1) fail("database_not_running");
  const raw = dc(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-qAt",
      "--set=ON_ERROR_STOP=1",
      "--username",
      db.POSTGRES_USER,
      "--dbname",
      db.POSTGRES_DB,
    ],
    statusSql(current),
  );
  const snapshot = sanitizeSnapshot(JSON.parse(raw));
  return {
    version: 1,
    project,
    deploymentMode: current.mode,
    provider: current.provider,
    environment: current.mode === "hosted" ? "sandbox" : null,
    services,
    ...snapshot,
  };
}
export function inspectStatus(options) {
  try {
    return inspectStatusInternal(options);
  } catch (error) {
    const closed = new Set([
      usage,
      "invalid_configuration",
      "checkout_identity_mismatch",
      "compose_files_mismatch",
      "runtime_identity_mismatch",
      "database_identity_mismatch",
      "database_not_running",
      "unsupported_database_configuration",
      "invalid_project_inventory",
      "invalid_snapshot",
      "status_command_failed",
    ]);
    // Native JSON/URL/filesystem diagnostics can include configuration text or private paths.
    fail(closed.has(error?.message) ? error.message : "status_inspection_failed");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(inspectStatus(parseArguments(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(
      error.message === usage
        ? usage
        : "Status inspection refused; verify project, checkout, Compose files, runtime identity and database locally.",
    );
    process.exitCode = 1;
  }
}
