import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never accept a target URL or inherited app secrets: this runner owns its stack.
const container = `pubrick-browser-hosted-${randomUUID()}`;
let fixtures;
const media = await mkdtemp(join(tmpdir(), "pubrick-browser-media-"));
const children = [];
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
async function runBrowserJourney() {
  // SMTP and fixture HTTP listeners share this process. A synchronous child
  // would block their event loop and deadlock verification mail/control calls.
  const child = start(
    "pnpm",
    ["exec", "playwright", "test", "--config=scripts/e2e/playwright.config.ts"],
    ".",
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Playwright failed (${code})`)),
    );
  });
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
    if (child?.exitCode !== null && child?.exitCode !== undefined)
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
  const child = spawn(cmd, args, { cwd, env, stdio: "inherit" });
  children.push(child);
  return child;
}
async function startWorker() {
  const child = spawn(process.execPath, ["dist/main.cjs"], {
    cwd: "apps/worker",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Compiled worker did not start")), 180_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-4096);
      if (output.includes("worker started")) {
        clearTimeout(timer);
        resolve();
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
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await fixtures?.close();
  spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
  await rm(media, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(1));
  });
}
try {
  command("pnpm", ["exec", "tsc", "--noEmit", "-p", "scripts/e2e"]);
  const webPort = 31310;
  const apiPort = 31311;
  const smtpPort = 31312;
  const controlPort = 31313;
  await requireFreePort(smtpPort);
  await requireFreePort(controlPort);
  await requireFreePort(webPort);
  await requireFreePort(apiPort);
  const origin = `http://127.0.0.1:${webPort}`;
  Object.assign(env, {
    PUBRICK_DEPLOYMENT_MODE: "hosted",
    PUBLIC_ORIGIN: origin,
    PUBRICK_E2E_HOSTED: "1",
    WEB_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    API_PORT: String(apiPort),
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    PUBRICK_E2E_ORIGIN: origin,
    PUBRICK_E2E_DISPOSABLE: container,
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
  const { startHostedFixtures } = await import("./hosted-fixtures.mjs");
  fixtures = await startHostedFixtures({
    databaseUrl: env.DATABASE_URL,
    origin,
    smtpPort,
    controlPort,
    marker: container,
  });
  Object.assign(env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpPort),
    SMTP_USER: "browser",
    SMTP_PASSWORD: fixtures.secret,
    SMTP_FROM: "pubrick@browser.example",
    SMTP_SECURE: "false",
    SMTP_REQUIRE_TLS: "false",
    BILLING_DRIVER: "fixture",
    BILLING_ACCOUNT_ID: "fixture_browser",
    BILLING_MAX_OWNED_WORKSPACES: "2",
    BILLING_MAX_CREATES_PER_DAY: "2",
    BILLING_CATALOG_JSON: JSON.stringify([
      {
        id: "browser-fixture",
        version: "1",
        priceId: "price_browser_fixture",
        limits: { seats: 2, brands: 1, channels: 1, mediaBytes: 1048576, concurrentJobs: 1 },
      },
    ]),
    BILLING_FIXTURE_PRICES_JSON: JSON.stringify([
      {
        priceId: "price_browser_fixture",
        productId: "prod_browser_fixture",
        active: true,
        currency: "usd",
        unitAmount: 0,
        interval: "month",
        intervalCount: 1,
      },
    ]),
    PUBRICK_E2E_CONTROL_ORIGIN: fixtures.controlOrigin,
    PUBRICK_E2E_CONTROL_SECRET: fixtures.secret,
  });
  // API/worker use compiled artifacts in test mode: the fixture driver must
  // refuse production. Next remains the production standalone artifact.
  env.NODE_ENV = "test";
  const api = start(process.execPath, ["dist/main.js"], "apps/api");
  await ready(`${env.API_INTERNAL_URL}/api/health`, api);
  const worker = await startWorker();
  const standalone = "apps/web/.next/standalone/apps/web";
  await cp("apps/web/.next/static", `${standalone}/.next/static`, { recursive: true, force: true });
  await cp("apps/web/public", `${standalone}/public`, { recursive: true, force: true });
  Object.assign(env, { PORT: String(webPort), HOSTNAME: "127.0.0.1" });
  env.NODE_ENV = "production";
  const web = start(process.execPath, ["server.js"], standalone);
  await ready(`${origin}/en/login`, web);
  await runBrowserJourney();
  if (worker.exitCode !== null) throw new Error("Compiled worker exited during journey");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
