import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recover } from "./recovery.mjs";

test("disposable Compose database, queued jobs, media and encryption configuration survive recovery", {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Root Node script tests run outside Turbo caching.
  skip: process.env.PUBRICK_RECOVERY_DOCKER_TEST !== "1",
  timeout: 300_000,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pubrick-recovery-docker-"));
  const cwd = path.join(root, "checkout");
  mkdirSync(cwd);
  const source = `pubrick-recovery-source-${process.pid}`;
  const target = `pubrick-recovery-target-${process.pid}`;
  const compose = `services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: recovery
      POSTGRES_PASSWORD: disposable-only
      POSTGRES_DB: recovery
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: [CMD, pg_isready, -h, 127.0.0.1, -U, recovery]
      interval: 1s
      timeout: 2s
      retries: 30
  api:
    image: pgvector/pgvector:pg16
    entrypoint: [sh, -c, "trap 'exit 0' TERM; while :; do sleep 1; done"]
    environment:
      APP_ENCRYPTION_KEY: '\${APP_ENCRYPTION_KEY}'
      BETTER_AUTH_SECRET: '\${BETTER_AUTH_SECRET}'
    volumes: [media:/data/media]
  worker:
    image: pgvector/pgvector:pg16
    entrypoint: [sh, -c, "trap 'exit 0' TERM; while :; do sleep 1; done"]
  web:
    image: pgvector/pgvector:pg16
    entrypoint: [sh, -c, "trap 'exit 0' TERM; while :; do sleep 1; done"]
volumes:
  pgdata:
  media:
`;
  writeFileSync(path.join(cwd, "compose.yaml"), compose);
  writeFileSync(
    path.join(cwd, ".env"),
    "APP_ENCRYPTION_KEY=disposable-crypto-key\nBETTER_AUTH_SECRET=disposable-auth-key\n",
    { mode: 0o600 },
  );
  const run = (args) => {
    const result = spawnSync("docker", args, { cwd, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const dc = (project, args) => run(["compose", "--project-name", project, ...args]);
  const sql = (project, query) =>
    dc(project, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "recovery",
      "-d",
      "recovery",
      "-At",
      "-c",
      query,
    ]).trim();
  try {
    dc(source, ["up", "-d", "--wait"]);
    sql(
      source,
      "CREATE EXTENSION vector; CREATE TABLE drafts(id int primary key, body text); INSERT INTO drafts VALUES (1,'Human-reviewed draft'); CREATE SCHEMA pgboss; CREATE TABLE pgboss.job(id int, state text); INSERT INTO pgboss.job VALUES (1,'created');",
    );
    dc(source, ["exec", "-T", "api", "sh", "-c", "printf recovered-media > /data/media/image.jpg"]);
    const directory = path.join(root, "snapshot");
    recover({ action: "backup", project: source, directory, cwd });
    assert.ok(dc(source, ["ps", "--status", "running", "--services"]).includes("worker"));
    dc(target, ["up", "-d", "--wait", "postgres"]);
    run(["volume", "create", `${target}_media`]);
    recover({ action: "restore", project: target, directory, cwd });
    assert.equal(sql(target, "SELECT body FROM drafts"), "Human-reviewed draft");
    assert.equal(sql(target, "SELECT state FROM pgboss.job"), "created");
    assert.equal(
      run([
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=volume,src=${target}_media,dst=/media,readonly`,
        "--entrypoint",
        "cat",
        "pgvector/pgvector:pg16",
        "/media/image.jpg",
      ]).trim(),
      "recovered-media",
    );
    assert.equal(dc(target, ["ps", "--status", "running", "--services"]).trim(), "postgres");
    assert.equal(
      readFileSync(path.join(directory, "environment.env"), "utf8"),
      readFileSync(path.join(cwd, ".env"), "utf8"),
    );
    assert.throws(
      () => recover({ action: "restore", project: target, directory, cwd }),
      /fresh empty database/,
    );
  } finally {
    for (const project of [source, target]) {
      spawnSync(
        "docker",
        ["compose", "--project-name", project, "down", "--volumes", "--remove-orphans"],
        { cwd, encoding: "utf8", timeout: 60_000 },
      );
      spawnSync("docker", ["volume", "rm", `${project}_media`], {
        encoding: "utf8",
        timeout: 15_000,
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
