import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readReceipts, refuseNextEnvironmentFiles } from "./evergreen-model-fixture.mjs";

// Never accept a target URL or inherited app secrets: this runner owns its stack.
const container = `pubrick-browser-evergreen-${randomUUID()}`;
const media = await mkdtemp(join(tmpdir(), "pubrick-browser-media-"));
const children = [];
const receiptDirectory = await mkdtemp(join(tmpdir(), "pubrick-evergreen-receipts-"));
const receipts = join(receiptDirectory, "receipts.ndjson");
await writeFile(receipts, "", { mode: 0o600 });
const channelContext = join(receiptDirectory, "channel.json");
await writeFile(channelContext, "{}", { mode: 0o600 });
const journeyMarker = `evergreen-browser-${randomUUID()}`;
let worker;
let observations;
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CI: process.env.CI,
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SIGNUP_MODE: "open",
  MEDIA_STORAGE_DIR: media,
};
function command(cmd, args) {
  const result = spawnSync(cmd, args, { env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd} failed (${result.status})`);
}
async function requireFreePort(value) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(value, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
async function ready(url, child) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(`Server exited: ${url}`);
    try {
      if (
        (
          await fetch(url, {
            signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))),
          })
        ).ok
      )
        return;
    } catch {}
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(500, deadline - Date.now()))),
    );
  }
  throw new Error(`Server not ready: ${url}`);
}
function start(cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env, stdio: "inherit", detached: true });
  children.push(child);
  return child;
}
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function startWorker() {
  const child = spawn(
    process.execPath,
    ["--import", resolve("scripts/e2e/evergreen-model-preload.mjs"), "dist/main.cjs"],
    { cwd: "apps/worker", env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Compiled worker not ready")), 180_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-4096);
      if (output.includes("worker started")) {
        clearTimeout(timer);
        accept();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Compiled worker exited"));
    });
  });
  return child;
}
let cleanupPromise;
function cleanup() {
  cleanupPromise ??= cleanupStack();
  return cleanupPromise;
}
async function cleanupStack() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    signalGroup(child, "SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      signalGroup(child, "SIGKILL");
      await new Promise((accept) => child.once("exit", accept));
    }
  }
  await observations?.end();
  const removed = spawnSync("docker", ["rm", "-f", "-v", container], { encoding: "utf8" });
  if (removed.status !== 0 && !removed.stderr.includes("No such container")) {
    process.exitCode = 1;
    console.error(`Could not remove owned container ${container}`);
  }
  await rm(media, { recursive: true, force: true });
  if (process.exitCode) console.info(`Sanitized fixture receipts retained: ${receipts}`);
  else await rm(receiptDirectory, { recursive: true, force: true });
  console.info(`Removed owned stack ${container} and temporary media.`);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.exitCode = 1;
    void cleanup().finally(() => process.exit(1));
  });
}
try {
  refuseNextEnvironmentFiles("apps/web", "apps/web/.next/standalone/apps/web");
  command("pnpm", ["exec", "tsc", "--noEmit", "-p", "scripts/e2e"]);
  const webPort = 31330;
  const apiPort = 31331;
  await requireFreePort(webPort);
  await requireFreePort(apiPort);
  const origin = `http://127.0.0.1:${webPort}`;
  Object.assign(env, {
    WEB_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    API_PORT: String(apiPort),
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    PUBRICK_E2E_ORIGIN: origin,
    PUBRICK_E2E_DISPOSABLE: container,
    PUBRICK_E2E_JOURNEY_MARKER: journeyMarker,
    PUBRICK_E2E_RECEIPTS: receipts,
    PUBRICK_E2E_CHANNEL_CONTEXT: channelContext,
  });
  console.info(
    `Disposable browser stack: ${container}; web ${origin}; API ${env.API_INTERNAL_URL}`,
  );
  command("docker", [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=browser",
    "-e",
    "POSTGRES_DB=pubrick_browser",
    "-p",
    "127.0.0.1::5432",
    "pgvector/pgvector:pg16",
  ]);
  const mapping = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" });
  if (mapping.status !== 0) throw new Error("Cannot discover disposable database port");
  const dbPort = mapping.stdout.trim().split(":").at(-1);
  env.DATABASE_URL = `postgres://postgres:browser@127.0.0.1:${dbPort}/pubrick_browser`;
  for (let i = 0; i < 60; i++) {
    if (
      spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { stdio: "ignore" })
        .status === 0
    )
      break;
    if (i === 59) throw new Error("Database not ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  command("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@pubrick/api...",
    "--filter=@pubrick/web...",
    "--filter=@pubrick/worker...",
    "--concurrency=1",
  ]);
  const api = start(process.execPath, ["dist/main.js"], "apps/api");
  await ready(`${env.API_INTERNAL_URL}/api/health`, api);
  const { createRequire } = await import("node:module");
  const dbRequire = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const { Pool } = dbRequire("pg");
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  observations = pool;
  {
    const journal = JSON.parse(await readFile("packages/db/migrations/meta/_journal.json", "utf8"));
    const result = await pool.query(
      "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
    );
    if (Number(result.rows[0]?.created_at) !== journal.entries.at(-1).when)
      throw new Error("Built stack migration mismatch");
  }
  refuseNextEnvironmentFiles("apps/web", "apps/web/.next/standalone/apps/web");
  worker = await startWorker();
  const standalone = "apps/web/.next/standalone/apps/web";
  await cp("apps/web/.next/static", `${standalone}/.next/static`, { recursive: true, force: true });
  await cp("apps/web/public", `${standalone}/public`, { recursive: true, force: true });
  Object.assign(env, { PORT: String(webPort), HOSTNAME: "127.0.0.1" });
  const web = start(process.execPath, ["server.js"], standalone);
  await ready(`${origin}/en/login`, web);
  const browser = start(
    "pnpm",
    ["exec", "playwright", "test", "--config=scripts/e2e/evergreen.playwright.config.ts"],
    ".",
  );
  const deadline = Date.now() + 5 * 60_000;
  await new Promise((accept, reject) => {
    let monitoring = false;
    const monitor = setInterval(async () => {
      if (monitoring) return;
      monitoring = true;
      try {
        if (Date.now() >= deadline) throw new Error("Evergreen journey exceeded five minutes");
        if (
          worker.exitCode !== null ||
          worker.signalCode !== null ||
          api.exitCode !== null ||
          api.signalCode !== null ||
          web.exitCode !== null ||
          web.signalCode !== null
        )
          throw new Error("Built application exited during journey");
        const failed = await observations.query(
          "SELECT id FROM pipeline_runs WHERE status IN ('failed','cancelled') LIMIT 1",
        );
        if (failed.rows.length) throw new Error("Reuse generation failed during journey");
        if (readReceipts(receipts).some((record) => record.kind === "unexpected"))
          throw new Error("Unexpected worker model request latched");
      } catch (error) {
        clearInterval(monitor);
        signalGroup(browser, "SIGTERM");
        reject(error);
      } finally {
        monitoring = false;
      }
    }, 250);
    browser.once("error", (error) => {
      clearInterval(monitor);
      reject(error);
    });
    browser.once("exit", (code) => {
      clearInterval(monitor);
      code === 0 ? accept() : reject(new Error(`Playwright failed (${code})`));
    });
  });
  const calls = readReceipts(receipts);
  if (calls.length !== 5 || calls.some((record) => record.kind !== "call"))
    throw new Error("Expected exactly five scripted model calls");
  console.info(
    `Evergreen acceptance passed: five scripted calls; source ${spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()}`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
