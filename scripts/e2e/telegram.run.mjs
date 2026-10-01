import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as proxyRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_POSTGRES_IMAGE,
  readBrowserSource,
  verifyBrowserSource,
} from "./browser-provenance.mjs";
import { refuseNextEnvironmentFiles } from "./evergreen-model-fixture.mjs";
import { startTelegramBotFixture } from "./telegram-bot-fixture.mjs";

// Require committed clean source before allocating an owned stack. No target URL accepted.
const source = readBrowserSource();
const container = `pubrick-browser-telegram-${randomUUID()}`;
const marker = `telegram-browser-${randomUUID()}`;
const temporary = await mkdtemp(join(tmpdir(), "pubrick-telegram-browser-"));
const media = join(temporary, "media");
const children = [];
let fixture;
let proxy;
let pool;
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CI: process.env.CI,
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SIGNUP_MODE: "open",
  PUBRICK_DEPLOYMENT_MODE: "self-hosted",
  AUTH_RATE_LIMIT_ENABLED: "false",
  MEDIA_STORAGE_DIR: media,
  WEB_ORIGIN: "https://127.0.0.1:31302",
  BETTER_AUTH_URL: "https://127.0.0.1:31302",
  API_PORT: "31301",
  API_INTERNAL_URL: "http://127.0.0.1:31301",
  TELEGRAM_API_BASE_URL: "http://127.0.0.1:31303",
  PUBRICK_E2E_ORIGIN: "https://127.0.0.1:31302",
  PUBRICK_E2E_DISPOSABLE: container,
  PUBRICK_E2E_JOURNEY_MARKER: marker,
  PUBRICK_E2E_TELEGRAM_FIXTURE: "http://127.0.0.1:31303",
};
function command(cmd, args) {
  const result = spawnSync(cmd, args, { env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd} failed (${result.status})`);
}
async function requireFreePort(port) {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  await new Promise((accept) => server.close(accept));
}
function start(cmd, args, cwd, capture = false) {
  const child = spawn(cmd, args, {
    cwd,
    env,
    detached: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
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
async function ready(url, child) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Compiled server exited before readiness");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await new Promise((accept) => setTimeout(accept, 500));
  }
  throw new Error("Compiled server readiness deadline");
}
async function startWorker() {
  const child = start(process.execPath, ["dist/main.cjs"], "apps/worker", true);
  await new Promise((accept, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Compiled worker readiness deadline")),
      180_000,
    );
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
      new Promise((accept) => child.once("exit", accept)),
      new Promise((accept) => setTimeout(accept, 5000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      signalGroup(child, "SIGKILL");
      await new Promise((accept) => child.once("exit", accept));
    }
  }
  await fixture?.close();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((accept) => proxy.close(accept));
  }
  await pool?.end();
  const removed = spawnSync("docker", ["rm", "-f", "-v", container], { encoding: "utf8" });
  if (removed.status !== 0 && !removed.stderr.includes("No such container")) {
    process.exitCode = 1;
    console.error("Could not remove owned Telegram browser database");
  }
  await rm(temporary, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    process.exitCode = 1;
    void cleanup().finally(() => process.exit(1));
  });
try {
  await mkdir(media, { recursive: true });
  refuseNextEnvironmentFiles("apps/web", "apps/web/.next/standalone/apps/web");
  command("pnpm", ["exec", "tsc", "--noEmit", "-p", "scripts/e2e"]);
  for (const port of [31300, 31301, 31302, 31303]) await requireFreePort(port);
  command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(temporary, "key.pem"),
    "-out",
    join(temporary, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  const cert = await readFile(join(temporary, "cert.pem"));
  const key = await readFile(join(temporary, "key.pem"));
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
    BROWSER_POSTGRES_IMAGE,
  ]);
  const mapping = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" });
  const databasePort = mapping.stdout.trim().split(":").at(-1);
  if (mapping.status !== 0 || !/^\d+$/.test(databasePort ?? ""))
    throw new Error("Cannot discover owned database port");
  env.DATABASE_URL = `postgres://postgres:browser@127.0.0.1:${databasePort}/pubrick_browser`;
  for (let index = 0; index < 60; index++) {
    if (
      spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { stdio: "ignore" })
        .status === 0
    )
      break;
    if (index === 59) throw new Error("Owned database readiness deadline");
    await new Promise((accept) => setTimeout(accept, 500));
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
  const dbRequire = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const { Pool } = dbRequire("pg");
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  fixture = await startTelegramBotFixture({
    marker,
    ca: cert,
    pool,
    databaseUrl: env.DATABASE_URL,
  });
  const api = start(process.execPath, ["dist/main.js"], "apps/api");
  await ready("http://127.0.0.1:31301/api/health", api);
  const journal = JSON.parse(await readFile("packages/db/migrations/meta/_journal.json", "utf8"));
  const migration = await pool.query(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  );
  if (Number(migration.rows[0]?.created_at) !== journal.entries.at(-1).when)
    throw new Error("Compiled Telegram stack migration mismatch");
  const worker = await startWorker();
  const standalone = "apps/web/.next/standalone/apps/web";
  refuseNextEnvironmentFiles("apps/web", standalone);
  await cp("apps/web/.next/static", `${standalone}/.next/static`, { recursive: true, force: true });
  await cp("apps/web/public", `${standalone}/public`, { recursive: true, force: true });
  Object.assign(env, { PORT: "31300", HOSTNAME: "127.0.0.1" });
  const web = start(process.execPath, ["server.js"], standalone);
  await ready("http://127.0.0.1:31300/en/login", web);
  proxy = createHttpsServer({ key, cert }, (request, response) => {
    const target = proxyRequest(
      {
        hostname: "127.0.0.1",
        port: 31300,
        path: request.url,
        method: request.method,
        headers: {
          ...request.headers,
          host: "127.0.0.1:31302",
          "x-forwarded-host": "127.0.0.1:31302",
          "x-forwarded-proto": "https",
        },
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      },
    );
    target.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(target);
  });
  await new Promise((accept, reject) => {
    proxy.once("error", reject);
    proxy.listen(31302, "127.0.0.1", accept);
  });
  const browser = start(
    "pnpm",
    ["exec", "playwright", "test", "--config=scripts/e2e/telegram.playwright.config.ts"],
    ".",
  );
  await new Promise((accept, reject) => {
    let checking = false;
    const deadline = Date.now() + 8 * 60_000;
    const monitor = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        if (
          Date.now() >= deadline ||
          [api, worker, web].some((child) => child.exitCode !== null || child.signalCode !== null)
        )
          throw new Error("Compiled Telegram acceptance stack failed or timed out");
        if (fixture.snapshot().unexpected.length)
          throw new Error("Unexpected model/publication/provider fixture operation");
        const evidence = await pool.query(
          "SELECT (SELECT count(*) FROM usage_ledger)::int AS ledger, (SELECT count(*) FROM publications)::int AS publications",
        );
        if (evidence.rows[0].ledger || evidence.rows[0].publications)
          throw new Error("Telegram acceptance performed a model/publication operation");
      } catch (error) {
        clearInterval(monitor);
        signalGroup(browser, "SIGTERM");
        reject(error);
      } finally {
        checking = false;
      }
    }, 500);
    browser.once("error", (error) => {
      clearInterval(monitor);
      reject(error);
    });
    browser.once("exit", (code) => {
      clearInterval(monitor);
      code === 0 ? accept() : reject(new Error(`Telegram Playwright failed (${code})`));
    });
  });
  if (fixture.snapshot().unexpected.length || fixture.snapshot().messages.length !== 6)
    throw new Error("Expected three initial notifications and three private confirmations only");
  verifyBrowserSource(source);
  console.info(`Telegram acceptance passed at committed source ${source}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
