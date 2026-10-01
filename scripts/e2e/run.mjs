import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROWSER_POSTGRES_IMAGE,
  readBrowserSource,
  verifyBrowserSource,
} from "./browser-provenance.mjs";

// Never accept a target URL or inherited app secrets: this runner owns its stack.
// Resolve before allocating any temporary files, processes or containers.
const source = readBrowserSource();
const container = `pubrick-browser-${randomUUID()}`;
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
  const webPort = 31300;
  const apiPort = 31301;
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
    BROWSER_POSTGRES_IMAGE,
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
    "--concurrency=1",
  ]);
  const api = start(process.execPath, ["dist/main.js"], "apps/api");
  await ready(`${env.API_INTERNAL_URL}/api/health`, api);
  const standalone = "apps/web/.next/standalone/apps/web";
  await cp("apps/web/.next/static", `${standalone}/.next/static`, { recursive: true, force: true });
  await cp("apps/web/public", `${standalone}/public`, { recursive: true, force: true });
  Object.assign(env, { PORT: String(webPort), HOSTNAME: "127.0.0.1" });
  const web = start(process.execPath, ["server.js"], standalone);
  await ready(`${origin}/en/login`, web);
  command("pnpm", ["exec", "playwright", "test", "--config=scripts/e2e/playwright.config.ts"]);
  verifyBrowserSource(source);
  console.info(
    `Self-hosted acceptance passed: source ${source}; database ${BROWSER_POSTGRES_IMAGE}`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
