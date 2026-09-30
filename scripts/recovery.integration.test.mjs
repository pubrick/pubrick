import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recover } from "./recovery.mjs";

// The same executor owns fixture commands AND every injected recover() Docker call.
function fixtureDockerExecutor(environment, execute = spawnSync) {
  const isolated = { ...environment };
  for (const name of Object.keys(isolated)) {
    if (name.startsWith("COMPOSE_") || ["APP_ENCRYPTION_KEY", "BETTER_AUTH_SECRET"].includes(name))
      delete isolated[name];
  }
  return (command, args, options) => execute(command, args, { ...options, env: isolated });
}
test("native recovery executor isolates operator overrides without mutating environment or file-descriptor options", () => {
  const operator = {
    COMPOSE_FILE: "/operator/compose.yml",
    COMPOSE_ENV_FILES: "/operator/.env",
    COMPOSE_PROJECT_NAME: "operator",
    APP_ENCRYPTION_KEY: "operator-key",
    BETTER_AUTH_SECRET: "operator-secret",
    PATH: "/fixture/path",
    DOCKER_HOST: "unix:///fixture/docker.sock",
  };
  const before = { ...operator };
  const observed = [];
  const execute = fixtureDockerExecutor(operator, (command, args, options) => {
    observed.push({ command, args, options });
    return { status: 0, stdout: "fixture" };
  });
  for (const args of [
    ["compose", "config"],
    ["inspect", "fixture"],
    ["run", "--network", "none"],
  ])
    execute("docker", args, { encoding: undefined, stdio: [13, 14, "pipe"], env: operator });
  assert.equal(observed.length, 3);
  for (const call of observed) {
    assert.equal(call.command, "docker");
    assert.deepEqual(call.options.env, {
      PATH: "/fixture/path",
      DOCKER_HOST: "unix:///fixture/docker.sock",
    });
    assert.deepEqual(call.options.stdio, [13, 14, "pipe"]);
    assert.equal(call.options.encoding, undefined);
  }
  assert.deepEqual(operator, before);
});

test("current hosted schema, encrypted mail/credentials, retained media and paused writers survive native recovery", {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Root Node script tests run outside Turbo caching.
  skip: process.env.PUBRICK_RECOVERY_DOCKER_TEST !== "1",
  timeout: 300_000,
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pubrick-recovery-docker-"));
  const cwd = path.join(root, "checkout");
  mkdirSync(cwd);
  const suffix = randomUUID();
  const source = `pubrick-recovery-source-${suffix}`;
  const target = `pubrick-recovery-target-${suffix}`;
  const oldKey = randomBytes(32).toString("base64");
  const keyRing = `${randomBytes(32).toString("base64")},${oldKey}`;
  const authSecret = randomBytes(32).toString("base64");
  const environmentBytes = `APP_ENCRYPTION_KEY=${keyRing}\nBETTER_AUTH_SECRET=${authSecret}\n`;
  // Native prerequisites: pnpm install --frozen-lockfile;
  // pnpm --filter @pubrick/db... --filter @pubrick/mail... build.
  const { seedHostedRecovery, assertHostedRecovery } = await import(
    "./recovery.hosted-fixture.mjs"
  );
  const compose = `services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: recovery
      POSTGRES_PASSWORD: disposable-only
      POSTGRES_DB: recovery
    ports: ["127.0.0.1::5432"]
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
    environment:
      APP_ENCRYPTION_KEY: '\${APP_ENCRYPTION_KEY}'
      BETTER_AUTH_SECRET: '\${BETTER_AUTH_SECRET}'
    volumes: [media:/data/media]
    entrypoint: [sh, -c, "trap 'exit 0' TERM; while :; do sleep 1; done"]
  web:
    image: pgvector/pgvector:pg16
    entrypoint: [sh, -c, "trap 'exit 0' TERM; while :; do sleep 1; done"]
volumes:
  pgdata:
  media:
`;
  writeFileSync(path.join(cwd, "compose.yaml"), compose);
  writeFileSync(path.join(cwd, ".env"), environmentBytes, { mode: 0o600 });
  const executeDocker = fixtureDockerExecutor(process.env);
  const recoverFixture = (options) =>
    recover({ ...options, cwd, composeFiles: ["compose.yaml"], execute: executeDocker });
  const run = (args) => {
    const result = executeDocker("docker", args, { cwd, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const dc = (project, args) =>
    run([
      "compose",
      "--project-name",
      project,
      "--env-file",
      path.join(cwd, ".env"),
      "--file",
      "compose.yaml",
      ...args,
    ]);
  const databaseUrl = (project) => {
    const port = dc(project, ["port", "postgres", "5432"]).trim().split(":").at(-1);
    return `postgres://recovery:disposable-only@127.0.0.1:${port}/recovery`;
  };
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
      "-X",
      "--set=ON_ERROR_STOP=1",
      "-At",
      "-c",
      query,
    ]).trim();
  try {
    dc(source, ["up", "-d", "--wait"]);
    const fixture = await seedHostedRecovery(databaseUrl(source), {
      oldKey,
      authSecret,
      liveBytes: Buffer.byteLength("recovered-live-media"),
      retainedBytes: Buffer.byteLength("recovered-retained-media"),
    });
    dc(source, [
      "exec",
      "-T",
      "api",
      "sh",
      "-c",
      `printf recovered-live-media > /data/media/${fixture.liveAssetId}.jpg; printf recovered-retained-media > /data/media/${fixture.retainedAssetId}.jpg`,
    ]);
    const directory = path.join(root, "snapshot");
    recoverFixture({ action: "backup", project: source, directory, cwd });
    assert.deepEqual(
      dc(source, ["ps", "--status", "running", "--services"]).trim().split(/\s+/).sort(),
      ["api", "postgres", "web", "worker"],
    );
    dc(target, ["up", "-d", "--wait", "postgres"]);
    run(["volume", "create", `${target}_media`]);
    const targetEmpty = () => {
      assert.equal(
        sql(
          target,
          "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle','pgboss') AND c.relkind IN ('r','p')",
        ),
        "0",
      );
      assert.equal(dc(target, ["ps", "--status", "running", "--services"]).trim(), "postgres");
      assert.equal(
        run([
          "run",
          "--rm",
          "--pull=never",
          "--network",
          "none",
          "--mount",
          `type=volume,src=${target}_media,dst=/media,readonly`,
          "--entrypoint",
          "find",
          "pgvector/pgvector:pg16",
          "/media",
          "-mindepth",
          "1",
          "-print",
          "-quit",
        ]).trim(),
        "",
      );
    };
    writeFileSync(
      path.join(cwd, ".env"),
      `APP_ENCRYPTION_KEY=${keyRing.split(",")[0]}\nBETTER_AUTH_SECRET=${authSecret}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => recoverFixture({ action: "restore", project: target, directory, cwd }),
      /Target APP_ENCRYPTION_KEY must match/,
    );
    targetEmpty();
    writeFileSync(path.join(cwd, ".env"), environmentBytes, { mode: 0o600 });
    const mediaArchive = path.join(directory, "media.tar");
    renameSync(mediaArchive, `${mediaArchive}.held`);
    try {
      assert.throws(
        () => recoverFixture({ action: "restore", project: target, directory, cwd }),
        /ENOENT/,
      );
      targetEmpty();
    } finally {
      renameSync(`${mediaArchive}.held`, mediaArchive);
    }
    recoverFixture({ action: "restore", project: target, directory, cwd });
    await assertHostedRecovery(databaseUrl(target), fixture, keyRing, oldKey, authSecret);
    for (const [id, content] of [
      [fixture.liveAssetId, "recovered-live-media"],
      [fixture.retainedAssetId, "recovered-retained-media"],
    ]) {
      assert.equal(
        run([
          "run",
          "--rm",
          "--pull=never",
          "--network",
          "none",
          "--mount",
          `type=volume,src=${target}_media,dst=/media,readonly`,
          "--entrypoint",
          "cat",
          "pgvector/pgvector:pg16",
          `/media/${id}.jpg`,
        ]).trim(),
        content,
      );
    }
    assert.equal(dc(target, ["ps", "--status", "running", "--services"]).trim(), "postgres");
    assert.equal(
      readFileSync(path.join(directory, "environment.env"), "utf8"),
      readFileSync(path.join(cwd, ".env"), "utf8"),
    );
    assert.throws(
      () => recoverFixture({ action: "restore", project: target, directory, cwd }),
      /fresh empty database/,
    );
  } finally {
    const cleanupFailures = [];
    for (const project of [source, target]) {
      const removed = executeDocker(
        "docker",
        [
          "compose",
          "--project-name",
          project,
          "--env-file",
          path.join(cwd, ".env"),
          "--file",
          "compose.yaml",
          "down",
          "--volumes",
          "--remove-orphans",
        ],
        { cwd, encoding: "utf8", timeout: 60_000 },
      );
      if (removed.status !== 0) cleanupFailures.push(`${project}: Compose cleanup failed`);
      // The empty recovery target's media volume is created manually, before
      // any API container, so Compose may not own or remove it on down -v.
      executeDocker("docker", ["volume", "rm", `${project}_media`], {
        cwd,
        encoding: "utf8",
        timeout: 15000,
      });
      try {
        assert.equal(
          run([
            "ps",
            "-a",
            "--filter",
            `label=com.docker.compose.project=${project}`,
            "--format",
            "{{.ID}}",
          ]).trim(),
          "",
        );
        for (const volume of [`${project}_media`, `${project}_pgdata`]) {
          const inspected = executeDocker("docker", ["volume", "inspect", volume], {
            cwd,
            encoding: "utf8",
            timeout: 15000,
          });
          assert.equal(inspected.status, 1, "Owned recovery volume still exists");
          assert.match(inspected.stderr, /no such volume/);
        }
      } catch {
        cleanupFailures.push(`${project}: owned containers or volumes remain`);
      }
    }
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(cleanupFailures, [], "Owned recovery cleanup failed");
  }
});
